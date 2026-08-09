import { PixelDepth, ChannelFormat, ByteOrder } from './pixelFormats';

/**
 * Supported debugger types
 */
export type DebuggerType = 'cppdbg' | 'cppvsdbg' | 'lldb' | 'debugpy' | 'unknown';

/**
 * Known image type names
 */
export enum ImageTypeName {
    CV_MAT = 'cv::Mat',
    CV_MAT_TEMPLATE = 'cv::Mat_',
    CV_MATX = 'cv::Matx',
    CV_MAT_LEGACY = 'CvMat',
    IPL_IMAGE = 'IplImage',
    RAW_ARRAY = 'RawArray',
    CUSTOM = 'Custom',
    // Python image types
    NUMPY_NDARRAY = 'numpy.ndarray',
    PIL_IMAGE = 'PIL.Image.Image',
    TORCH_TENSOR = 'torch.Tensor',
}

/**
 * Core metadata for an image
 */
export interface ImageMetadata {
    /** Unique identifier for the image */
    id: string;

    /** Display name (variable name or expression) */
    name: string;

    /** Full expression to access the image */
    expression: string;

    /** Detected type name */
    typeName: string;

    /** Pixel depth (e.g., CV_8U, CV_32F) */
    depth: PixelDepth;

    /** Number of channels */
    channels: number;

    /** Image width in pixels */
    width: number;

    /** Image height in pixels */
    height: number;

    /** Row stride in bytes */
    stride: number;

    /** Data pointer address as hex string */
    dataAddress: string;

    /** Total data size in bytes */
    dataSize: number;

    /** Channel format hint */
    channelFormat?: ChannelFormat;

    /** Byte order for multi-byte values (supported desktop targets are little-endian by default) */
    byteOrder?: ByteOrder;

    /** Whether data is continuous in memory */
    isContinuous?: boolean;

    /** Data layout for tensor data (HWC or CHW) */
    dataLayout?: 'HWC' | 'CHW';

    /** Source debugger type */
    debuggerType?: DebuggerType;

    /** Frame ID where this image was captured */
    frameId?: number;

    /** Additional properties from parsed structure */
    rawProperties?: Record<string, unknown>;
}

/**
 * Image data with pixel buffer
 */
export interface ImageData {
    /** Associated metadata */
    metadata: ImageMetadata;

    /** Raw pixel data */
    data: Uint8Array;

    /** Timestamp when data was fetched */
    timestamp: number;
}

/**
 * Image item for display in tree view
 */
export interface ImageItem {
    /** Unique identifier */
    id: string;

    /** Display label */
    label: string;

    /** Detailed description */
    description: string;

    /** Tooltip text */
    tooltip: string;

    /** Expression to evaluate */
    expression: string;

    /** Whether this is a watch expression (vs local variable) */
    isWatch: boolean;

    /** Associated metadata if available */
    metadata?: ImageMetadata;

    /** Materialized pixels for derived expressions that do not map to debuggee memory */
    imageData?: ImageData;

    /** Thumbnail data URL if available */
    thumbnail?: string;

    /** Error message if parsing failed */
    error?: string;
}

/**
 * View state for synchronized views
 */
export interface ViewState {
    /** Zoom level */
    zoom: number;

    /** Pan offset X */
    panX: number;

    /** Pan offset Y */
    panY: number;
}

/**
 * Display options for image rendering
 */
export interface DisplayOptions {
    /** Auto-normalize values for display */
    autoNormalize: boolean;

    /** Colormap for single-channel images */
    colormap: string;

    /** Ignore alpha channel in 4-channel images */
    ignoreAlpha: boolean;

    /** Which channel to display (0=all, 1=R, 2=G, 3=B, 4=A) */
    channelView: number;

    /** Show pixel grid when zoomed in */
    showPixelGrid: boolean;

    /** Pixel grid zoom threshold */
    pixelGridZoomThreshold: number;

    /** Pixel value display format */
    pixelFormat: 'decimal' | 'hex';
}

/**
 * Default display options
 */
export const DefaultDisplayOptions: DisplayOptions = {
    autoNormalize: true,
    colormap: 'grayscale',
    ignoreAlpha: false,
    channelView: 0,
    showPixelGrid: true,
    pixelGridZoomThreshold: 8,
    pixelFormat: 'decimal',
};

/**
 * Result of parsing an image expression
 */
export interface ParseResult {
    /** Whether parsing was successful */
    success: boolean;

    /** Parsed metadata if successful */
    metadata?: ImageMetadata;

    /** Error message if failed */
    error?: string;

    /** Warnings (non-fatal issues) */
    warnings?: string[];
}

/**
 * Result of reading image data
 */
export interface ReadResult {
    /** Whether reading was successful */
    success: boolean;

    /** Image data if successful */
    data?: ImageData;

    /** Error message if failed */
    error?: string;
}
