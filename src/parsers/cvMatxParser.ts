import { DebugSessionManager, EvaluateResponse } from '../core/debugSessionManager';
import { BaseImageParser } from './baseParser';
import { ParseResult, ImageMetadata, PixelDepth, PixelDepthSize } from '../types';
import { calculateDataSize } from '../utils/imageTransform';

/**
 * Map type names to pixel depth for Matx template types
 */
const MATX_TYPE_MAP: Record<string, PixelDepth> = {
    'float': PixelDepth.CV_32F,
    'double': PixelDepth.CV_64F,
    'int': PixelDepth.CV_32S,
    'short': PixelDepth.CV_16S,
    'unsigned short': PixelDepth.CV_16U,
    'uchar': PixelDepth.CV_8U,
    'unsigned char': PixelDepth.CV_8U,
    'uint8_t': PixelDepth.CV_8U,
    'schar': PixelDepth.CV_8S,
    'signed char': PixelDepth.CV_8S,
    'int8_t': PixelDepth.CV_8S,
    'char': PixelDepth.CV_8S,
    'uint16_t': PixelDepth.CV_16U,
    'int16_t': PixelDepth.CV_16S,
    'int32_t': PixelDepth.CV_32S,
};

/**
 * Parser for cv::Matx<T, m, n> small matrix type
 *
 * cv::Matx is a fixed-size matrix with data stored inline (not on heap)
 */
export class CvMatxParser extends BaseImageParser {
    readonly name = 'cv::Matx';
    readonly priority = 120;

    canParse(typeName: string): boolean {
        const normalized = typeName.replace(/^(const\s+)?(class\s+|struct\s+)?/, '').trim();
        return /^cv::Matx(?:<|\d)/.test(normalized);
    }

    async parse(
        session: DebugSessionManager,
        expression: string,
        evaluateResult: EvaluateResponse
    ): Promise<ParseResult> {
        try {
            // Extract template parameters from type name
            const typeInfo = this.extractMatxType(evaluateResult.type ?? '');
            if (!typeInfo) {
                return this.errorResult('Failed to parse cv::Matx template parameters');
            }

            const { elementType, rows, cols } = typeInfo;
            const depth = MATX_TYPE_MAP[elementType];
            if (depth === undefined) {
                return this.errorResult(`Unknown cv::Matx element type: ${elementType}`);
            }

            // cv::Matx stores data inline in a 'val' array
            // Get the address of the val array
            let dataAddress: string | undefined;

            // Try to get address of val member
            const valueExpression = this.getMemberExpression(
                expression,
                evaluateResult.type ?? '',
                'val'
            );
            dataAddress = await this.evaluateAsPointer(session, `&(${valueExpression}[0])`);

            if (!dataAddress) {
                // Try alternative: some debuggers might expose it differently
                const result = await session.evaluate(valueExpression);
                if (result?.memoryReference) {
                    dataAddress = result.memoryReference;
                }
            }

            if (!dataAddress || this.isNullPointerValue(dataAddress)) {
                return this.errorResult('Failed to get cv::Matx data address');
            }

            const elementSize = PixelDepthSize[depth];
            const stride = cols * elementSize;
            // Treat as single-channel (Matx is typically used for transforms/vectors)
            const channels = 1;

            const validationError = this.getImageValidationError(cols, rows, channels, depth, stride);
            if (validationError) {
                return this.errorResult(validationError);
            }

            const metadata: ImageMetadata = {
                id: this.generateImageId(expression),
                name: expression,
                expression,
                typeName: `cv::Matx<${elementType}, ${rows}, ${cols}>`,
                depth,
                channels,
                width: cols,
                height: rows,
                stride,
                dataAddress,
                dataSize: 0,
                isContinuous: true, // Matx data is always continuous
                debuggerType: session.getDebuggerType(),
                frameId: session.currentFrameId,
                rawProperties: {
                    elementType,
                    isSmallMatrix: true,
                },
            };
            metadata.dataSize = calculateDataSize(metadata);

            const warnings: string[] = [];
            if (rows > 16 || cols > 16) {
                warnings.push('cv::Matx is intended for small matrices; consider using cv::Mat for larger data');
            }

            return this.successResult(metadata, warnings.length > 0 ? warnings : undefined);
        } catch (error) {
            return this.errorResult(`Failed to parse cv::Matx: ${error}`);
        }
    }

    /**
     * Extract template parameters from cv::Matx<T, m, n>
     */
    private extractMatxType(typeName: string): { elementType: string; rows: number; cols: number } | undefined {
        // Match cv::Matx<type, rows, cols>
        const match = typeName.match(/cv::Matx<\s*(.+?)\s*,\s*(\d+)\s*,\s*(\d+)\s*>/);
        if (match) {
            return {
                elementType: match[1].trim(),
                rows: parseInt(match[2], 10),
                cols: parseInt(match[3], 10),
            };
        }
        // GDB commonly preserves OpenCV's official typedef spelling (for example,
        // cv::Matx33f) instead of returning the expanded template type.
        const typedefMatch = typeName.match(/cv::Matx(\d)(\d)([fd])\b/i);
        if (typedefMatch) {
            return {
                elementType: typedefMatch[3].toLowerCase() === 'f' ? 'float' : 'double',
                rows: parseInt(typedefMatch[1], 10),
                cols: parseInt(typedefMatch[2], 10),
            };
        }
        return undefined;
    }
}

/**
 * Parser for cv::Vec<T, n> vector type (special case of Matx)
 */
export class CvVecParser extends BaseImageParser {
    readonly name = 'cv::Vec';
    readonly priority = 125;

    canParse(typeName: string): boolean {
        const normalized = typeName.replace(/^(const\s+)?(class\s+|struct\s+)?/, '').trim();
        // Match cv::Vec<T, n> or cv::Vec3b, cv::Vec4f, etc.
        return /^cv::Vec[<\d]/.test(normalized);
    }

    async parse(
        session: DebugSessionManager,
        expression: string,
        evaluateResult: EvaluateResponse
    ): Promise<ParseResult> {
        try {
            const typeInfo = this.extractVecType(evaluateResult.type ?? '');
            if (!typeInfo) {
                return this.errorResult('Failed to parse cv::Vec type parameters');
            }

            const { depth, length } = typeInfo;

            // Get address of val array
            const valueExpression = this.getMemberExpression(
                expression,
                evaluateResult.type ?? '',
                'val'
            );
            let dataAddress = await this.evaluateAsPointer(session, `&(${valueExpression}[0])`);

            if (!dataAddress) {
                const result = await session.evaluate(valueExpression);
                if (result?.memoryReference) {
                    dataAddress = result.memoryReference;
                }
            }

            if (!dataAddress || this.isNullPointerValue(dataAddress)) {
                return this.errorResult('Failed to get cv::Vec data address');
            }

            const elementSize = PixelDepthSize[depth];
            const stride = length * elementSize;
            const validationError = this.getImageValidationError(
                length,
                1,
                1,
                depth,
                stride
            );
            if (validationError) {
                return this.errorResult(validationError);
            }

            // Represent as 1 x length image with 1 channel
            const metadata: ImageMetadata = {
                id: this.generateImageId(expression),
                name: expression,
                expression,
                typeName: `cv::Vec (${length} elements)`,
                depth,
                channels: 1,
                width: length,
                height: 1,
                stride,
                dataAddress,
                dataSize: 0,
                isContinuous: true,
                debuggerType: session.getDebuggerType(),
                frameId: session.currentFrameId,
                rawProperties: {
                    isVector: true,
                    vectorLength: length,
                },
            };
            metadata.dataSize = calculateDataSize(metadata);

            return this.successResult(metadata);
        } catch (error) {
            return this.errorResult(`Failed to parse cv::Vec: ${error}`);
        }
    }

    /**
     * Extract type info from cv::Vec
     */
    private extractVecType(typeName: string): { depth: PixelDepth; length: number } | undefined {
        // Try cv::Vec<type, n> format
        const templateMatch = typeName.match(/cv::Vec<\s*(.+?)\s*,\s*(\d+)\s*>/);
        if (templateMatch) {
            const elementType = templateMatch[1].trim();
            const depth = MATX_TYPE_MAP[elementType];
            if (depth !== undefined) {
                return { depth, length: parseInt(templateMatch[2], 10) };
            }
        }

        // Try cv::Vec3b style format
        const shortMatch = typeName.match(/cv::Vec(\d+)([bsifwd])/i);
        if (shortMatch) {
            const length = parseInt(shortMatch[1], 10);
            const typeChar = shortMatch[2].toLowerCase();
            const charToDepth: Record<string, PixelDepth> = {
                'b': PixelDepth.CV_8U,
                's': PixelDepth.CV_16S,
                'i': PixelDepth.CV_32S,
                'f': PixelDepth.CV_32F,
                'd': PixelDepth.CV_64F,
                'w': PixelDepth.CV_16U,
            };
            const depth = charToDepth[typeChar];
            if (depth !== undefined) {
                return { depth, length };
            }
        }

        return undefined;
    }
}
