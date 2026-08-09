/**
 * Pixel depth types matching OpenCV CV_* constants
 */
export enum PixelDepth {
    CV_8U = 0,   // unsigned 8-bit
    CV_8S = 1,   // signed 8-bit
    CV_16U = 2,  // unsigned 16-bit
    CV_16S = 3,  // signed 16-bit
    CV_32S = 4,  // signed 32-bit
    CV_32F = 5,  // 32-bit float
    CV_64F = 6,  // 64-bit float
    CV_16F = 7,  // 16-bit float (half)
}

/**
 * Map pixel depth to byte size
 */
export const PixelDepthSize: Record<PixelDepth, number> = {
    [PixelDepth.CV_8U]: 1,
    [PixelDepth.CV_8S]: 1,
    [PixelDepth.CV_16U]: 2,
    [PixelDepth.CV_16S]: 2,
    [PixelDepth.CV_32S]: 4,
    [PixelDepth.CV_32F]: 4,
    [PixelDepth.CV_64F]: 8,
    [PixelDepth.CV_16F]: 2,
};

/**
 * Human-readable names for pixel depths
 */
export const PixelDepthName: Record<PixelDepth, string> = {
    [PixelDepth.CV_8U]: 'uint8',
    [PixelDepth.CV_8S]: 'int8',
    [PixelDepth.CV_16U]: 'uint16',
    [PixelDepth.CV_16S]: 'int16',
    [PixelDepth.CV_32S]: 'int32',
    [PixelDepth.CV_32F]: 'float32',
    [PixelDepth.CV_64F]: 'float64',
    [PixelDepth.CV_16F]: 'float16',
};

/**
 * Channel layout formats
 */
export enum ChannelFormat {
    GRAY = 'gray',
    GRAY_ALPHA = 'gray-alpha',
    BGR = 'bgr',
    RGB = 'rgb',
    BGRA = 'bgra',
    RGBA = 'rgba',
    YUV = 'yuv',
    HSV = 'hsv',
    HLS = 'hls',
    LAB = 'lab',
    LUV = 'luv',
}

/** Byte order used by multi-byte pixel values. */
export type ByteOrder = 'little' | 'big';

/**
 * OpenCV type encoding/decoding utilities
 */
export const CV_CN_SHIFT = 3;
export const CV_CN_MAX = 512;
export const CV_DEPTH_MASK = 7;
export const CV_MAT_DEPTH_MASK = CV_DEPTH_MASK;
export const CV_MAT_CN_MASK = (CV_CN_MAX - 1) << CV_CN_SHIFT;

/**
 * Decode OpenCV type field into depth and channel count
 */
export function decodeCvType(type: number): { depth: PixelDepth; channels: number } {
    const depth = (type & CV_DEPTH_MASK) as PixelDepth;
    const channels = ((type & CV_MAT_CN_MASK) >> CV_CN_SHIFT) + 1;
    return { depth, channels };
}

/**
 * Encode depth and channels into OpenCV type
 */
export function encodeCvType(depth: PixelDepth, channels: number): number {
    return depth | ((channels - 1) << CV_CN_SHIFT);
}

/**
 * Get pixel size in bytes for a given depth and channel count
 */
export function getPixelSize(depth: PixelDepth, channels: number): number {
    return PixelDepthSize[depth] * channels;
}

/**
 * Format type string for display (e.g., "CV_8UC3")
 */
export function formatCvType(depth: PixelDepth, channels: number): string {
    const depthNames = ['8U', '8S', '16U', '16S', '32S', '32F', '64F', '16F'];
    const depthStr = depthNames[depth] ?? 'UNKNOWN';
    return `CV_${depthStr}C${channels}`;
}

/**
 * Convert string type name to PixelDepth
 */
export function parsePixelDepthName(name: string): PixelDepth | undefined {
    const normalized = name.toLowerCase();
    for (const [depth, depthName] of Object.entries(PixelDepthName)) {
        if (depthName === normalized) {
            return parseInt(depth) as PixelDepth;
        }
    }
    return undefined;
}
