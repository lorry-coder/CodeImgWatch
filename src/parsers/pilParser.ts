/**
 * PIL (Pillow) Image parser for Python debugger (debugpy)
 */

import { DebugSessionManager } from '../core/debugSessionManager';
import { ImageMetadata, ParseResult, ImageTypeName } from '../types';
import { PixelDepth, PixelDepthSize, ChannelFormat, ByteOrder } from '../types/pixelFormats';
import { BaseImageParser } from './baseParser';

/**
 * Map PIL mode to channels and depth
 */
interface PILModeInfo {
    channels: number;
    depth: PixelDepth;
    channelFormat?: ChannelFormat;
    conversionMode?: string;
    byteOrder?: ByteOrder;
}

const PIL_MODE_MAP: Record<string, PILModeInfo> = {
    '1': { channels: 1, depth: PixelDepth.CV_8U, channelFormat: ChannelFormat.GRAY, conversionMode: 'L' },
    'L': { channels: 1, depth: PixelDepth.CV_8U, channelFormat: ChannelFormat.GRAY },      // 8-bit grayscale
    'P': { channels: 4, depth: PixelDepth.CV_8U, channelFormat: ChannelFormat.RGBA, conversionMode: 'RGBA' },
    'RGB': { channels: 3, depth: PixelDepth.CV_8U, channelFormat: ChannelFormat.RGB },     // 3x8-bit RGB
    'RGBA': { channels: 4, depth: PixelDepth.CV_8U, channelFormat: ChannelFormat.RGBA },   // 4x8-bit RGBA
    'CMYK': { channels: 3, depth: PixelDepth.CV_8U, channelFormat: ChannelFormat.RGB, conversionMode: 'RGB' },
    'YCbCr': { channels: 3, depth: PixelDepth.CV_8U, channelFormat: ChannelFormat.RGB, conversionMode: 'RGB' },
    'LAB': { channels: 3, depth: PixelDepth.CV_8U, channelFormat: ChannelFormat.RGB, conversionMode: 'RGB' },
    'HSV': { channels: 3, depth: PixelDepth.CV_8U, channelFormat: ChannelFormat.RGB, conversionMode: 'RGB' },
    'I': { channels: 1, depth: PixelDepth.CV_32S, channelFormat: ChannelFormat.GRAY },     // 32-bit signed integer
    'F': { channels: 1, depth: PixelDepth.CV_32F, channelFormat: ChannelFormat.GRAY },     // 32-bit float
    'I;16': { channels: 1, depth: PixelDepth.CV_16U, channelFormat: ChannelFormat.GRAY, byteOrder: 'little' },
    'I;16L': { channels: 1, depth: PixelDepth.CV_16U, channelFormat: ChannelFormat.GRAY, byteOrder: 'little' },
    'I;16B': { channels: 1, depth: PixelDepth.CV_16U, channelFormat: ChannelFormat.GRAY, byteOrder: 'big' },
    'I;16N': { channels: 1, depth: PixelDepth.CV_16U, channelFormat: ChannelFormat.GRAY, byteOrder: 'little' },
    'LA': { channels: 2, depth: PixelDepth.CV_8U, channelFormat: ChannelFormat.GRAY_ALPHA },
    'PA': { channels: 4, depth: PixelDepth.CV_8U, channelFormat: ChannelFormat.RGBA, conversionMode: 'RGBA' },
    'RGBa': { channels: 4, depth: PixelDepth.CV_8U, channelFormat: ChannelFormat.RGBA, conversionMode: 'RGBA' },
};

/**
 * Parser for PIL.Image.Image
 */
export class PILImageParser extends BaseImageParser {
    readonly name = 'PILImage';
    readonly priority = 90; // Slightly lower than numpy

    canParse(typeName: string): boolean {
        return /\bImage\b/.test(typeName) || /PIL\.Image/.test(typeName);
    }

    async parse(
        session: DebugSessionManager,
        expression: string
    ): Promise<ParseResult> {
        try {
            // Get image size (width, height)
            const size = await session.evaluatePythonAsTuple(`${expression}.size`);
            if (!size || size.length !== 2) {
                return this.errorResult('Failed to get image size');
            }

            const [width, height] = size;

            // Get image mode
            const mode = await session.evaluatePythonAsString(`${expression}.mode`);
            if (!mode) {
                return this.errorResult('Failed to get image mode');
            }

            // Get mode info
            const modeInfo = PIL_MODE_MAP[mode];
            if (!modeInfo) {
                return this.errorResult(`Unsupported PIL mode: ${mode}`);
            }

            const { channels, depth, channelFormat, conversionMode, byteOrder } = modeInfo;

            // Calculate stride and data size
            // PIL images are stored as HWC with no padding
            const bytesPerPixel = this.getBytesPerPixel(depth, channels);
            const stride = width * bytesPerPixel;
            const dataSize = stride * height;
            const validationError = this.getImageValidationError(width, height, channels, depth, stride);
            if (validationError) {
                return this.errorResult(validationError);
            }

            // For PIL images, we need to convert to numpy to get raw bytes
            // The expression for data reading will convert PIL to numpy
            const dataAddress = expression;

            const metadata: ImageMetadata = {
                id: this.generateImageId(expression),
                name: expression,
                expression,
                typeName: ImageTypeName.PIL_IMAGE,
                depth,
                channels,
                width,
                height,
                stride,
                dataAddress,
                dataSize,
                channelFormat,
                byteOrder,
                isContinuous: true, // PIL images are always contiguous
                dataLayout: 'HWC',
                debuggerType: 'debugpy',
                rawProperties: {
                    mode,
                    size,
                    isPIL: true,
                    pilConversionMode: conversionMode,
                },
            };

            return this.successResult(metadata);
        } catch (error) {
            return this.errorResult(`Failed to parse PIL image: ${error}`);
        }
    }

    /**
     * Get bytes per pixel for a given depth and channel count
     */
    private getBytesPerPixel(depth: PixelDepth, channels: number): number {
        return PixelDepthSize[depth] * channels;
    }
}
