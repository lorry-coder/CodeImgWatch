import { DebugSessionManager, EvaluateResponse } from '../core/debugSessionManager';
import { BaseImageParser } from './baseParser';
import { ParseResult, ImageMetadata, PixelDepth, PixelDepthSize, PixelDepthName } from '../types';

/**
 * Raw memory image specification for @mem operator
 */
export interface RawImageSpec {
    address: string;
    pixelType: PixelDepth;
    channels: number;
    width: number;
    height: number;
    stride?: number;
}

/**
 * Parser for raw memory arrays using @mem operator
 *
 * Syntax: @mem(address, type, channels, width, height [, stride])
 * Example: @mem(0x12345678, uint8, 3, 640, 480)
 */
export class RawArrayParser extends BaseImageParser {
    readonly name = 'RawArray';
    readonly priority = 10; // Low priority, only for explicit @mem

    canParse(typeName: string): boolean {
        // This parser is invoked directly, not by type matching
        return false;
    }

    /**
     * Parse a @mem specification string
     */
    static parseMemSpec(spec: string): RawImageSpec | { error: string } {
        // @mem(address, type, channels, width, height [, stride])
        const match = spec.match(/@mem\s*\(\s*(.+)\s*\)/);
        if (!match) {
            return { error: 'Invalid @mem syntax. Expected: @mem(address, type, channels, width, height [, stride])' };
        }

        const args = match[1].split(',').map(s => s.trim());
        if (args.length < 5 || args.length > 6) {
            return { error: `@mem requires 5-6 arguments, got ${args.length}` };
        }

        const [addressStr, typeStr, channelsStr, widthStr, heightStr, strideStr] = args;

        // Parse address
        let address: string;
        if (addressStr.startsWith('0x') || addressStr.startsWith('0X')) {
            address = addressStr;
        } else if (/^[0-9a-fA-F]+$/.test(addressStr)) {
            address = '0x' + addressStr;
        } else {
            return { error: `Invalid address: ${addressStr}` };
        }

        // Parse pixel type
        const pixelType = this.parsePixelType(typeStr);
        if (pixelType === undefined) {
            return { error: `Unknown pixel type: ${typeStr}. Valid types: ${Object.values(PixelDepthName).join(', ')}` };
        }

        // Parse channels
        const channels = parseInt(channelsStr, 10);
        if (isNaN(channels) || channels < 1 || channels > 4) {
            return { error: `Invalid channel count: ${channelsStr}. Must be 1-4` };
        }

        // Parse width
        const width = parseInt(widthStr, 10);
        if (isNaN(width) || width <= 0) {
            return { error: `Invalid width: ${widthStr}` };
        }

        // Parse height
        const height = parseInt(heightStr, 10);
        if (isNaN(height) || height <= 0) {
            return { error: `Invalid height: ${heightStr}` };
        }

        // Parse optional stride
        let stride: number | undefined;
        if (strideStr) {
            stride = parseInt(strideStr, 10);
            if (isNaN(stride) || stride <= 0) {
                return { error: `Invalid stride: ${strideStr}` };
            }
        }

        return { address, pixelType, channels, width, height, stride };
    }

    /**
     * Parse pixel type string to PixelDepth
     */
    private static parsePixelType(typeStr: string): PixelDepth | undefined {
        const normalized = typeStr.toLowerCase().trim();

        const typeMap: Record<string, PixelDepth> = {
            'uint8': PixelDepth.CV_8U,
            'u8': PixelDepth.CV_8U,
            'uchar': PixelDepth.CV_8U,
            'int8': PixelDepth.CV_8S,
            'i8': PixelDepth.CV_8S,
            'schar': PixelDepth.CV_8S,
            'char': PixelDepth.CV_8S,
            'uint16': PixelDepth.CV_16U,
            'u16': PixelDepth.CV_16U,
            'ushort': PixelDepth.CV_16U,
            'int16': PixelDepth.CV_16S,
            'i16': PixelDepth.CV_16S,
            'short': PixelDepth.CV_16S,
            'int32': PixelDepth.CV_32S,
            'i32': PixelDepth.CV_32S,
            'int': PixelDepth.CV_32S,
            'float32': PixelDepth.CV_32F,
            'f32': PixelDepth.CV_32F,
            'float': PixelDepth.CV_32F,
            'float64': PixelDepth.CV_64F,
            'f64': PixelDepth.CV_64F,
            'double': PixelDepth.CV_64F,
            'float16': PixelDepth.CV_16F,
            'f16': PixelDepth.CV_16F,
            'half': PixelDepth.CV_16F,
        };

        return typeMap[normalized];
    }

    async parse(
        session: DebugSessionManager,
        expression: string,
        evaluateResult: EvaluateResponse
    ): Promise<ParseResult> {
        // This method is called when we need to create metadata from a RawImageSpec
        return this.errorResult('RawArrayParser.parse should not be called directly');
    }

    /**
     * Create ImageMetadata from a RawImageSpec
     */
    static createMetadata(spec: RawImageSpec, expression: string): ImageMetadata {
        const pixelSize = PixelDepthSize[spec.pixelType] * spec.channels;
        const stride = spec.stride ?? (spec.width * pixelSize);
        const dataSize = stride * spec.height;

        return {
            id: `raw_${Date.now()}_${spec.address}`,
            name: expression,
            expression,
            typeName: `RawArray<${PixelDepthName[spec.pixelType]}, ${spec.channels}>`,
            depth: spec.pixelType,
            channels: spec.channels,
            width: spec.width,
            height: spec.height,
            stride,
            dataAddress: spec.address,
            dataSize,
            isContinuous: stride === spec.width * pixelSize,
            rawProperties: {
                isRawMemory: true,
            },
        };
    }
}
