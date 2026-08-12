import * as vscode from 'vscode';
import {
    EncodedImageExportFormat,
    ExportImageDataMessage,
    ImageExportFormat,
    RequestImageExportMessage,
} from '../types/messages';

const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const DEFAULT_EXPORT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_ENCODED_BYTES = 512 * 1024 * 1024;
const MAX_EXPORT_BASENAME_UNITS = 240;
const DEFAULT_EXPORT_FORMAT: ImageExportFormat = 'png';

const EXPORT_FORMAT_OPTIONS: ReadonlyArray<{
    format: ImageExportFormat;
    extension: string;
    label: string;
    filterLabel: string;
    extensions: string[];
    description: string;
    detail: string;
    icon: string;
}> = [
    {
        format: 'png',
        extension: 'png',
        label: 'PNG',
        filterLabel: 'PNG Image',
        extensions: ['png'],
        description: '.png · Lossless',
        detail: 'Rendered pixels with transparency; recommended for exact image output.',
        icon: 'file-media',
    },
    {
        format: 'jpg',
        extension: 'jpg',
        label: 'JPEG',
        filterLabel: 'JPEG Image',
        extensions: ['jpg', 'jpeg'],
        description: '.jpg / .jpeg · Smaller file',
        detail: 'Rendered pixels with transparency composited onto a white background.',
        icon: 'file-media',
    },
    {
        format: 'bin',
        extension: 'bin',
        label: 'Raw Binary',
        filterLabel: 'Raw Display Buffer',
        extensions: ['bin'],
        description: '.bin · Unencoded bytes',
        detail: 'Unencoded display-buffer bytes; row padding may remain, and metadata is not embedded.',
        icon: 'file-binary',
    },
];

let lastExportDirectory: vscode.Uri | undefined;
let lastExportFormat: ImageExportFormat | undefined;

interface PendingExport {
    format: EncodedImageExportFormat;
    maxBytes: number;
    resolve: (data: Uint8Array) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}

export interface ImageExportTarget {
    format: ImageExportFormat;
    uri: vscode.Uri;
}

interface ImageExportQuickPickItem extends vscode.QuickPickItem {
    format: ImageExportFormat;
}

function exportFormatOption(format: ImageExportFormat): typeof EXPORT_FORMAT_OPTIONS[number] {
    return EXPORT_FORMAT_OPTIONS.find(option => option.format === format) ?? EXPORT_FORMAT_OPTIONS[0];
}

/** Create a filename that is valid on Windows, macOS, and Linux. */
export function sanitizeExportBaseName(name: string): string {
    const withoutControlCharacters = [...name]
        .map(character => character.charCodeAt(0) < 32 ? '_' : character)
        .join('');
    const sanitized = withoutControlCharacters
        .replace(/[<>:"/\\|?*]/g, '_')
        .replace(/[. ]+$/g, '')
        .trim();
    let truncated = '';
    let utf8Bytes = 0;
    let utf16Units = 0;
    for (const character of sanitized) {
        const characterUtf8Bytes = Buffer.byteLength(character, 'utf8');
        const characterUtf16Units = character.length;
        if (
            utf8Bytes + characterUtf8Bytes > MAX_EXPORT_BASENAME_UNITS ||
            utf16Units + characterUtf16Units > MAX_EXPORT_BASENAME_UNITS
        ) {
            break;
        }
        truncated += character;
        utf8Bytes += characterUtf8Bytes;
        utf16Units += characterUtf16Units;
    }
    if (!truncated) {
        return 'image';
    }
    return /^(con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])(?:[ .]|$)/i.test(truncated)
        ? `_${truncated}`
        : truncated;
}

export function formatExportLocation(uri: vscode.Uri): string {
    return uri.scheme === 'file' ? uri.fsPath : uri.toString(true);
}

/** Infer the export encoding from a filename. */
export function inferImageExportFormat(path: string): ImageExportFormat | undefined {
    const extension = /\.([^.\\/]+)$/.exec(path)?.[1]?.toLowerCase();
    switch (extension) {
        case 'png':
            return 'png';
        case 'jpg':
        case 'jpeg':
            return 'jpg';
        case 'bin':
            return 'bin';
        default:
            return undefined;
    }
}

/** Build a concise suggested filename without duplicating a known image suffix. */
export function createImageExportFileName(
    imageName: string,
    format: ImageExportFormat = DEFAULT_EXPORT_FORMAT
): string {
    const option = exportFormatOption(format);
    const baseName = sanitizeExportBaseName(imageName)
        .replace(/\.(?:png|jpe?g|bin)$/i, '') || 'image';
    return `${baseName}.${option.extension}`;
}

/**
 * Keep the selected encoding authoritative and normalize the destination suffix.
 * This avoids relying on platform-specific save-dialog filter behavior.
 */
export function resolveImageExportTarget(
    uri: vscode.Uri | undefined,
    selectedFormat: ImageExportFormat = DEFAULT_EXPORT_FORMAT
): ImageExportTarget | undefined {
    if (!uri) {
        return undefined;
    }

    const inferredFormat = inferImageExportFormat(uri.path);
    if (inferredFormat === selectedFormat) {
        return { format: selectedFormat, uri };
    }

    const option = exportFormatOption(selectedFormat);
    const cleanPath = uri.path.replace(/[. ]+$/g, '');
    const fileNameStart = cleanPath.lastIndexOf('/') + 1;
    const suffixStart = cleanPath.lastIndexOf('.');
    const pathWithoutSuffix = suffixStart > fileNameStart
        ? cleanPath.slice(0, suffixStart)
        : cleanPath;
    return {
        format: selectedFormat,
        uri: uri.with({ path: `${pathWithoutSuffix}.${option.extension}` }),
    };
}

/** Whether suffix normalization changed the path that received native overwrite confirmation. */
export function exportTargetNeedsConfirmation(
    selectedUri: vscode.Uri,
    target: ImageExportTarget
): boolean {
    return selectedUri.toString() !== target.uri.toString();
}

function orderedExportFormatOptions(
    preferredFormat: ImageExportFormat
): typeof EXPORT_FORMAT_OPTIONS {
    const preferred = exportFormatOption(preferredFormat);
    return [preferred, ...EXPORT_FORMAT_OPTIONS.filter(option => option !== preferred)];
}

/** Select an explicit encoding, then choose its destination. */
export async function promptForImageExport(
    imageName: string,
    requestedFormat?: ImageExportFormat
): Promise<ImageExportTarget | undefined> {
    let selectedFormat = requestedFormat;
    if (!selectedFormat) {
        const preferredFormat = lastExportFormat ?? DEFAULT_EXPORT_FORMAT;
        const formatItems: ImageExportQuickPickItem[] = orderedExportFormatOptions(preferredFormat)
            .map(option => ({
                label: option.label,
                description: lastExportFormat === option.format
                    ? `${option.description} · Last used`
                    : option.description,
                detail: option.detail,
                iconPath: new vscode.ThemeIcon(option.icon),
                format: option.format,
            }));
        const selectedItem = await vscode.window.showQuickPick(formatItems, {
            title: 'Export Image',
            placeHolder: 'Choose an output format',
            matchOnDescription: true,
            matchOnDetail: true,
        });
        if (!selectedItem) {
            return undefined;
        }
        selectedFormat = selectedItem.format;
    }

    const selectedOption = exportFormatOption(selectedFormat);
    const filename = createImageExportFileName(imageName, selectedFormat);
    const workspaceUri = vscode.workspace.workspaceFolders?.[0]?.uri;
    const activeDocumentUri = vscode.window.activeTextEditor?.document.uri;
    const activeWorkspaceUri = activeDocumentUri
        ? vscode.workspace.getWorkspaceFolder(activeDocumentUri)?.uri
        : undefined;
    const defaultDirectory = lastExportDirectory
        ?? activeWorkspaceUri
        ?? workspaceUri
        ?? (activeDocumentUri && activeDocumentUri.scheme !== 'untitled'
            ? vscode.Uri.joinPath(activeDocumentUri, '..')
            : undefined);
    const defaultUri = defaultDirectory
        ? vscode.Uri.joinPath(defaultDirectory, filename)
        : undefined;
    let suggestedUri = defaultUri;
    let target: ImageExportTarget | undefined;
    let needsNormalizedConfirmation = false;
    while (!target) {
        const selectedUri = await vscode.window.showSaveDialog({
            ...(suggestedUri ? { defaultUri: suggestedUri } : {}),
            title: needsNormalizedConfirmation
                ? `Confirm ${selectedOption.label} Filename`
                : `Export ${selectedOption.label}`,
            saveLabel: `Export ${selectedOption.label}`,
            filters: { [selectedOption.filterLabel]: selectedOption.extensions },
        });
        const resolvedTarget = resolveImageExportTarget(selectedUri, selectedFormat);
        if (!selectedUri || !resolvedTarget) {
            return undefined;
        }
        if (exportTargetNeedsConfirmation(selectedUri, resolvedTarget)) {
            // The first dialog only confirmed the path the user entered. Reopen it
            // on the normalized path so an existing real target is never overwritten
            // without the platform's native confirmation.
            suggestedUri = resolvedTarget.uri;
            needsNormalizedConfirmation = true;
            continue;
        }
        target = resolvedTarget;
    }
    if (target) {
        lastExportDirectory = vscode.Uri.joinPath(target.uri, '..');
        lastExportFormat = target.format;
    }

    return target;
}

/** Decode and validate bytes returned by canvas.toBlob(). */
export function decodeEncodedImage(
    base64: string,
    format: EncodedImageExportFormat,
    maxBytes: number = DEFAULT_MAX_ENCODED_BYTES
): Uint8Array {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
        throw new Error('Invalid encoded image size limit');
    }
    const maxBase64Length = Math.ceil(maxBytes / 3) * 4;
    if (!base64 || base64.length > maxBase64Length) {
        throw new Error(`Encoded image exceeds the ${maxBytes}-byte export limit`);
    }
    if (base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
        throw new Error('Webview returned invalid base64 image data');
    }

    const bytes = new Uint8Array(Buffer.from(base64, 'base64'));
    if (bytes.length === 0 || bytes.length > maxBytes) {
        throw new Error(`Encoded image exceeds the ${maxBytes}-byte export limit`);
    }

    if (format === 'png') {
        const validPng = bytes.length >= PNG_SIGNATURE.length &&
            PNG_SIGNATURE.every((value, index) => bytes[index] === value);
        if (!validPng) {
            throw new Error('Webview returned data without a PNG signature');
        }
    } else {
        const validJpeg = bytes.length >= 4 &&
            bytes[0] === 0xff && bytes[1] === 0xd8 &&
            bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;
        if (!validJpeg) {
            throw new Error('Webview returned data without a complete JPEG signature');
        }
    }

    return bytes;
}

/** Coordinates request/response canvas exports without sharing filesystem access with the webview. */
export class WebviewImageExporter implements vscode.Disposable {
    private readonly pending = new Map<string, PendingExport>();

    async request(
        postMessage: (message: RequestImageExportMessage) => Thenable<boolean>,
        imageId: string,
        format: EncodedImageExportFormat,
        jpegQuality: number,
        maxBytes: number = DEFAULT_MAX_ENCODED_BYTES,
        timeoutMs: number = DEFAULT_EXPORT_TIMEOUT_MS
    ): Promise<Uint8Array> {
        const encodedSizeLimit = Number.isSafeInteger(maxBytes) && maxBytes > 0
            ? maxBytes
            : DEFAULT_MAX_ENCODED_BYTES;
        const requestId = `export_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        let resolveResponse!: (data: Uint8Array) => void;
        let rejectResponse!: (error: Error) => void;
        const response = new Promise<Uint8Array>((resolve, reject) => {
            resolveResponse = resolve;
            rejectResponse = reject;
        });
        const timer = setTimeout(() => {
            this.rejectPending(requestId, new Error('Timed out while encoding the image'));
        }, timeoutMs);

        this.pending.set(requestId, {
            format,
            maxBytes: encodedSizeLimit,
            resolve: resolveResponse,
            reject: rejectResponse,
            timer,
        });

        try {
            const normalizedQuality = Number.isFinite(jpegQuality)
                ? Math.max(0.1, Math.min(1, jpegQuality))
                : 0.92;
            const delivered = await postMessage({
                command: 'requestImageExport',
                requestId,
                imageId,
                format,
                jpegQuality: normalizedQuality,
                maxBytes: encodedSizeLimit,
            });
            if (!delivered) {
                this.rejectPending(requestId, new Error('Image webview is not available'));
            }
        } catch (error) {
            this.rejectPending(requestId, error instanceof Error ? error : new Error(String(error)));
        }

        return response;
    }

    handleResponse(message: ExportImageDataMessage): boolean {
        const pending = this.pending.get(message.requestId);
        if (!pending) {
            return false;
        }

        clearTimeout(pending.timer);
        this.pending.delete(message.requestId);

        if (message.error) {
            pending.reject(new Error(message.error));
            return true;
        }
        if (message.format !== pending.format || !message.data) {
            pending.reject(new Error('Webview returned a mismatched image export response'));
            return true;
        }

        try {
            pending.resolve(decodeEncodedImage(message.data, message.format, pending.maxBytes));
        } catch (error) {
            pending.reject(error instanceof Error ? error : new Error(String(error)));
        }
        return true;
    }

    private rejectPending(requestId: string, error: Error): void {
        const pending = this.pending.get(requestId);
        if (!pending) {
            return;
        }
        clearTimeout(pending.timer);
        this.pending.delete(requestId);
        pending.reject(error);
    }

    cancelPending(error: Error = new Error('Image export was cancelled')): void {
        for (const requestId of [...this.pending.keys()]) {
            this.rejectPending(requestId, error);
        }
    }

    dispose(): void {
        this.cancelPending(new Error('Image exporter was disposed'));
    }
}
