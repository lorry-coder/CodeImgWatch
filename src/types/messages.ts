import { ImageMetadata, DisplayOptions, ViewState } from './imageTypes';

export type ImageExportFormat = 'png' | 'jpg' | 'bin';
export type EncodedImageExportFormat = Exclude<ImageExportFormat, 'bin'>;

/**
 * Base message interface
 */
export interface BaseMessage {
    command: string;
}

// ============================================
// Extension -> Webview Messages
// ============================================

/**
 * Display an image in the viewer
 */
export interface DisplayImageMessage extends BaseMessage {
    command: 'displayImage';
    /** Unique image ID */
    id: string;
    /** Base64-encoded pixel data */
    data: string;
    /** Image width */
    width: number;
    /** Image height */
    height: number;
    /** Number of channels */
    channels: number;
    /** Pixel type name (uint8, float32, etc.) */
    pixelType: string;
    /** Row stride in bytes */
    stride: number;
    /** Raw channel order */
    channelFormat?: string;
    /** Byte order for multi-byte values */
    byteOrder: 'little' | 'big';
    /** Image name for display */
    name: string;
    /** Full type name */
    typeName: string;
}

/**
 * Clear the current image display
 */
export interface ClearImageMessage extends BaseMessage {
    command: 'clearImage';
}

/**
 * Display an error message
 */
export interface ShowErrorMessage extends BaseMessage {
    command: 'showError';
    message: string;
}

/**
 * Update display options
 */
export interface UpdateOptionsMessage extends BaseMessage {
    command: 'updateOptions';
    options: Partial<DisplayOptions>;
}

/**
 * Sync view state from another viewer
 */
export interface SyncViewMessage extends BaseMessage {
    command: 'syncView';
    state: ViewState;
}

/**
 * Set loading state
 */
export interface SetLoadingMessage extends BaseMessage {
    command: 'setLoading';
    loading: boolean;
}

/** Request that the webview encode its rendered canvas. */
export interface RequestImageExportMessage extends BaseMessage {
    command: 'requestImageExport';
    requestId: string;
    imageId: string;
    format: EncodedImageExportFormat;
    jpegQuality: number;
    maxBytes: number;
}

/**
 * Union of all extension -> webview messages
 */
export type ExtensionToWebviewMessage =
    | DisplayImageMessage
    | ClearImageMessage
    | ShowErrorMessage
    | UpdateOptionsMessage
    | SyncViewMessage
    | SetLoadingMessage
    | RequestImageExportMessage;

// ============================================
// Webview -> Extension Messages
// ============================================

/**
 * Request pixel value at coordinates
 */
export interface QueryPixelMessage extends BaseMessage {
    command: 'queryPixel';
    x: number;
    y: number;
}

/**
 * Copy pixel value to clipboard
 */
export interface CopyPixelMessage extends BaseMessage {
    command: 'copyPixel';
    value: string;
}

/**
 * Export image to file
 */
export interface ExportImageMessage extends BaseMessage {
    command: 'exportImage';
    format?: ImageExportFormat;
    imageId?: string;
    name?: string;
}

/** Encoded canvas bytes returned by the webview. */
export interface ExportImageDataMessage extends BaseMessage {
    command: 'exportImageData';
    requestId: string;
    format: EncodedImageExportFormat;
    data?: string;
    error?: string;
}

/**
 * View state changed (for syncing)
 */
export interface ViewStateChangedMessage extends BaseMessage {
    command: 'viewStateChanged';
    state: ViewState;
}

/**
 * Request refresh
 */
export interface RefreshRequestMessage extends BaseMessage {
    command: 'refresh';
}

/**
 * Open in editor tab
 */
export interface OpenInEditorMessage extends BaseMessage {
    command: 'openInEditor';
    imageId: string;
}

/**
 * Toggle A/B comparison
 */
export interface ToggleCompareMessage extends BaseMessage {
    command: 'toggleCompare';
}

/**
 * Options changed in webview
 */
export interface OptionsChangedMessage extends BaseMessage {
    command: 'optionsChanged';
    options: Partial<DisplayOptions>;
}

/**
 * Webview ready
 */
export interface WebviewReadyMessage extends BaseMessage {
    command: 'ready';
}

/**
 * Union of all webview -> extension messages
 */
export type WebviewToExtensionMessage =
    | QueryPixelMessage
    | CopyPixelMessage
    | ExportImageMessage
    | ExportImageDataMessage
    | ViewStateChangedMessage
    | RefreshRequestMessage
    | OpenInEditorMessage
    | ToggleCompareMessage
    | OptionsChangedMessage
    | WebviewReadyMessage;

/**
 * Type guard for extension messages
 */
export function isExtensionMessage(msg: unknown): msg is ExtensionToWebviewMessage {
    return typeof msg === 'object' && msg !== null && 'command' in msg;
}

/**
 * Type guard for webview messages
 */
export function isWebviewMessage(msg: unknown): msg is WebviewToExtensionMessage {
    return typeof msg === 'object' && msg !== null && 'command' in msg;
}

/**
 * Helper to create a display image message
 */
export function createDisplayImageMessage(
    metadata: ImageMetadata,
    dataBase64: string
): DisplayImageMessage {
    return {
        command: 'displayImage',
        id: metadata.id,
        data: dataBase64,
        width: metadata.width,
        height: metadata.height,
        channels: metadata.channels,
        pixelType: getPixelTypeName(metadata.depth),
        stride: metadata.stride,
        channelFormat: metadata.channelFormat,
        byteOrder: metadata.byteOrder ?? 'little',
        name: metadata.name,
        typeName: metadata.typeName,
    };
}

/**
 * Get pixel type name from depth
 */
function getPixelTypeName(depth: number): string {
    const names = ['uint8', 'int8', 'uint16', 'int16', 'int32', 'float32', 'float64', 'float16'];
    return names[depth] ?? 'unknown';
}
