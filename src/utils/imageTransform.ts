/**
 * Image transformation utilities
 */

import { ImageMetadata, PixelDepth, PixelDepthSize } from '../types';

/**
 * Calculate actual data size for an image
 */
export function calculateDataSize(metadata: ImageMetadata): number {
    if (metadata.height <= 0) {
        return 0;
    }

    const rowSize = calculateMinStride(metadata.width, metadata.channels, metadata.depth);
    return (metadata.height - 1) * metadata.stride + rowSize;
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

/**
 * Convert CHW (Channel, Height, Width) data layout to HWC (Height, Width, Channel)
 * This is commonly needed for PyTorch tensors which use CHW format
 *
 * @param data - The input data in CHW format
 * @param channels - Number of channels
 * @param height - Image height
 * @param width - Image width
 * @param bytesPerElement - Bytes per pixel element (1 for uint8, 4 for float32, etc.)
 * @returns New Uint8Array with data in HWC format
 */
export function chwToHwc(
    data: Uint8Array,
    channels: number,
    height: number,
    width: number,
    bytesPerElement: number
): Uint8Array {
    if (channels === 1) {
        // Single channel - no conversion needed
        return data;
    }

    const hwcData = new Uint8Array(data.length);

    for (let h = 0; h < height; h++) {
        for (let w = 0; w < width; w++) {
            for (let c = 0; c < channels; c++) {
                // CHW index: c * (H * W) + h * W + w
                const chwOffset = (c * height * width + h * width + w) * bytesPerElement;
                // HWC index: h * (W * C) + w * C + c
                const hwcOffset = (h * width * channels + w * channels + c) * bytesPerElement;

                // Copy bytesPerElement bytes
                for (let b = 0; b < bytesPerElement; b++) {
                    hwcData[hwcOffset + b] = data[chwOffset + b];
                }
            }
        }
    }

    return hwcData;
}

/**
 * Convert HWC (Height, Width, Channel) data layout to CHW (Channel, Height, Width)
 * This can be useful for exporting data back to PyTorch format
 *
 * @param data - The input data in HWC format
 * @param channels - Number of channels
 * @param height - Image height
 * @param width - Image width
 * @param bytesPerElement - Bytes per pixel element
 * @returns New Uint8Array with data in CHW format
 */
export function hwcToChw(
    data: Uint8Array,
    channels: number,
    height: number,
    width: number,
    bytesPerElement: number
): Uint8Array {
    if (channels === 1) {
        // Single channel - no conversion needed
        return data;
    }

    const chwData = new Uint8Array(data.length);

    for (let h = 0; h < height; h++) {
        for (let w = 0; w < width; w++) {
            for (let c = 0; c < channels; c++) {
                // HWC index: h * (W * C) + w * C + c
                const hwcOffset = (h * width * channels + w * channels + c) * bytesPerElement;
                // CHW index: c * (H * W) + h * W + w
                const chwOffset = (c * height * width + h * width + w) * bytesPerElement;

                // Copy bytesPerElement bytes
                for (let b = 0; b < bytesPerElement; b++) {
                    chwData[chwOffset + b] = data[hwcOffset + b];
                }
            }
        }
    }

    return chwData;
}
