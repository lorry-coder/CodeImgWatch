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

/** Ask for a format when needed and then select the destination URI. */
export async function promptForImageExport(
    imageName: string,
    requestedFormat?: ImageExportFormat
): Promise<ImageExportTarget | undefined> {
    let format = requestedFormat;
    let label: string;

    if (!format) {
        const selection = await vscode.window.showQuickPick(
            [
                { label: 'PNG', description: 'Lossless rendered image', value: 'png' as const },
                { label: 'JPEG', description: 'Rendered image with white background', value: 'jpg' as const },
                { label: 'Raw Binary', description: 'Display buffer without image encoding', value: 'bin' as const },
            ],
            { placeHolder: 'Select export format' }
        );
        if (!selection) {
            return undefined;
        }
        format = selection.value;
        label = selection.label;
    } else {
        label = format === 'png' ? 'PNG' : format === 'jpg' ? 'JPEG' : 'Raw Binary';
    }

    const extension = format === 'jpg' ? 'jpg' : format;
    const filename = `${sanitizeExportBaseName(imageName)}.${extension}`;
    const workspaceUri = vscode.workspace.workspaceFolders?.[0]?.uri;
    const activeDocumentUri = vscode.window.activeTextEditor?.document.uri;
    const defaultUri = workspaceUri
        ? vscode.Uri.joinPath(workspaceUri, filename)
        : activeDocumentUri && activeDocumentUri.scheme !== 'untitled'
            ? vscode.Uri.joinPath(activeDocumentUri, '..', filename)
            : undefined;
    const extensions = format === 'jpg' ? ['jpg', 'jpeg'] : [extension];
    const uri = await vscode.window.showSaveDialog({
        ...(defaultUri ? { defaultUri } : {}),
        filters: { [label]: extensions },
    });

    return uri ? { format, uri } : undefined;
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
