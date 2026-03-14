/**
 * Image transformation utilities
 */

import { ImageMetadata, PixelDepth, PixelDepthSize } from '../types';

/**
 * Calculate actual data size for an image
 */
export function calculateDataSize(metadata: ImageMetadata): number {
    return metadata.stride * metadata.height;
}

/**
 * Calculate minimum stride for continuous data
 */
export function calculateMinStride(width: number, channels: number, depth: PixelDepth): number {
    return width * channels * PixelDepthSize[depth];
}

/**
 * Check if image data is continuous
 */
export function isContinuous(metadata: ImageMetadata): boolean {
    const minStride = calculateMinStride(metadata.width, metadata.channels, metadata.depth);
    return metadata.stride === minStride;
}

/**
 * Get pixel offset in buffer
 */
export function getPixelOffset(
    x: number,
    y: number,
    stride: number,
    channels: number,
    depth: PixelDepth
): number {
    const pixelSize = PixelDepthSize[depth] * channels;
    return y * stride + x * pixelSize;
}

/**
 * Get channel offset within a pixel
 */
export function getChannelOffset(channel: number, depth: PixelDepth): number {
    return channel * PixelDepthSize[depth];
}

/**
 * Validate image dimensions
 */
export function validateDimensions(width: number, height: number, maxSize: number = 16384): boolean {
    return width > 0 && width <= maxSize && height > 0 && height <= maxSize;
}

/**
 * Validate channel count
 */
export function validateChannels(channels: number): boolean {
    return channels >= 1 && channels <= 4;
}

/**
 * Validate depth
 */
export function validateDepth(depth: number): depth is PixelDepth {
    return depth >= 0 && depth <= 7;
}
