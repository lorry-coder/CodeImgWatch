/**
 * PIL (Pillow) Image parser for Python debugger (debugpy)
 */

import { DebugSessionManager, EvaluateResponse } from '../core/debugSessionManager';
import { ImageMetadata, ParseResult, ImageTypeName } from '../types';
import { PixelDepth, ChannelFormat } from '../types/pixelFormats';
import { BaseImageParser } from './baseParser';

/**
 * Map PIL mode to channels and depth
 */
interface PILModeInfo {
    channels: number;
    depth: PixelDepth;
    channelFormat?: ChannelFormat;
}

const PIL_MODE_MAP: Record<string, PILModeInfo> = {
    '1': { channels: 1, depth: PixelDepth.CV_8U, channelFormat: ChannelFormat.GRAY },      // 1-bit pixels, black and white
    'L': { channels: 1, depth: PixelDepth.CV_8U, channelFormat: ChannelFormat.GRAY },      // 8-bit grayscale
    'P': { channels: 1, depth: PixelDepth.CV_8U, channelFormat: ChannelFormat.GRAY },      // 8-bit palette
    'RGB': { channels: 3, depth: PixelDepth.CV_8U, channelFormat: ChannelFormat.RGB },     // 3x8-bit RGB
    'RGBA': { channels: 4, depth: PixelDepth.CV_8U, channelFormat: ChannelFormat.RGBA },   // 4x8-bit RGBA
    'CMYK': { channels: 4, depth: PixelDepth.CV_8U },                                       // 4x8-bit CMYK
    'YCbCr': { channels: 3, depth: PixelDepth.CV_8U },                                      // 3x8-bit YCbCr
    'LAB': { channels: 3, depth: PixelDepth.CV_8U, channelFormat: ChannelFormat.LAB },     // 3x8-bit LAB
    'HSV': { channels: 3, depth: PixelDepth.CV_8U, channelFormat: ChannelFormat.HSV },     // 3x8-bit HSV
    'I': { channels: 1, depth: PixelDepth.CV_32S, channelFormat: ChannelFormat.GRAY },     // 32-bit signed integer
    'F': { channels: 1, depth: PixelDepth.CV_32F, channelFormat: ChannelFormat.GRAY },     // 32-bit float
    'I;16': { channels: 1, depth: PixelDepth.CV_16U, channelFormat: ChannelFormat.GRAY },  // 16-bit unsigned integer
    'I;16L': { channels: 1, depth: PixelDepth.CV_16U, channelFormat: ChannelFormat.GRAY }, // 16-bit little-endian
    'I;16B': { channels: 1, depth: PixelDepth.CV_16U, channelFormat: ChannelFormat.GRAY }, // 16-bit big-endian
    'LA': { channels: 2, depth: PixelDepth.CV_8U },                                         // Grayscale + Alpha
    'PA': { channels: 2, depth: PixelDepth.CV_8U },                                         // Palette + Alpha
    'RGBa': { channels: 4, depth: PixelDepth.CV_8U, channelFormat: ChannelFormat.RGBA },   // Premultiplied RGBA
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
        expression: string,
        evaluateResult: EvaluateResponse
    ): Promise<ParseResult> {
        try {
            // Get image size (width, height)
            const size = await session.evaluatePythonAsTuple(`${expression}.size`);
            if (!size || size.length !== 2) {
                return this.errorResult('Failed to get image size');
            }

            const [width, height] = size;

            // Validate dimensions
            if (width <= 0 || height <= 0 || width > 16384 || height > 16384) {
                return this.errorResult(`Invalid dimensions: ${width}x${height}`);
            }

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

            const { channels, depth, channelFormat } = modeInfo;

            // Calculate stride and data size
            // PIL images are stored as HWC with no padding
            const bytesPerPixel = this.getBytesPerPixel(depth, channels);
            const stride = width * bytesPerPixel;
            const dataSize = stride * height;

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
                isContinuous: true, // PIL images are always contiguous
                dataLayout: 'HWC',
                debuggerType: 'debugpy',
                rawProperties: {
                    mode,
                    size,
                    isPIL: true,
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
        const bytesPerElement: Record<PixelDepth, number> = {
            [PixelDepth.CV_8U]: 1,
            [PixelDepth.CV_8S]: 1,
            [PixelDepth.CV_16U]: 2,
            [PixelDepth.CV_16S]: 2,
            [PixelDepth.CV_32S]: 4,
            [PixelDepth.CV_32F]: 4,
            [PixelDepth.CV_64F]: 8,
            [PixelDepth.CV_16F]: 2,
        };
        return bytesPerElement[depth] * channels;
    }
}
