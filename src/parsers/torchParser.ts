/**
 * PyTorch Tensor parser for Python debugger (debugpy)
 */

import { DebugSessionManager, EvaluateResponse } from '../core/debugSessionManager';
import { ImageMetadata, ParseResult, ImageTypeName } from '../types';
import { PixelDepth, ChannelFormat } from '../types/pixelFormats';
import { BaseImageParser } from './baseParser';

/**
 * Map PyTorch dtype strings to PixelDepth
 */
const TORCH_DTYPE_MAP: Record<string, PixelDepth> = {
    'torch.uint8': PixelDepth.CV_8U,
    'torch.int8': PixelDepth.CV_8S,
    'torch.int16': PixelDepth.CV_16S,
    'torch.short': PixelDepth.CV_16S,
    'torch.int32': PixelDepth.CV_32S,
    'torch.int': PixelDepth.CV_32S,
    'torch.int64': PixelDepth.CV_32S, // Truncate to 32-bit for display
    'torch.long': PixelDepth.CV_32S,
    'torch.float16': PixelDepth.CV_16F,
    'torch.half': PixelDepth.CV_16F,
    'torch.bfloat16': PixelDepth.CV_16F,
    'torch.float32': PixelDepth.CV_32F,
    'torch.float': PixelDepth.CV_32F,
    'torch.float64': PixelDepth.CV_64F,
    'torch.double': PixelDepth.CV_64F,
};

/**
 * Parser for torch.Tensor images
 */
export class TorchTensorParser extends BaseImageParser {
    readonly name = 'TorchTensor';
    readonly priority = 95; // Between numpy and PIL

    canParse(typeName: string): boolean {
        return /\bTensor\b/.test(typeName) || /torch\.Tensor/.test(typeName);
    }

    async parse(
        session: DebugSessionManager,
        expression: string,
        evaluateResult: EvaluateResponse
    ): Promise<ParseResult> {
        try {
            // Check if tensor is on CPU
            const deviceStr = await session.evaluatePythonAsString(`str(${expression}.device)`);
            if (!deviceStr) {
                return this.errorResult('Failed to get tensor device');
            }

            if (!deviceStr.startsWith('cpu')) {
                return this.errorResult(`Tensor is on ${deviceStr}. Use .cpu() to move it to CPU for visualization.`);
            }

            // Get shape
            const shapeResult = await session.evaluatePythonAsTuple(`tuple(${expression}.shape)`);
            if (!shapeResult || shapeResult.length === 0) {
                return this.errorResult('Failed to get tensor shape');
            }

            // Determine dimensions
            // PyTorch uses CHW format for images (Channels, Height, Width)
            // Also support NCHW (batch, channels, height, width) - take first element
            let height: number;
            let width: number;
            let channels: number;
            let actualExpression = expression;
            let dataLayout: 'HWC' | 'CHW' = 'CHW';

            if (shapeResult.length === 2) {
                // 2D tensor (H, W) - grayscale
                [height, width] = shapeResult;
                channels = 1;
                dataLayout = 'HWC'; // Already in HW format
            } else if (shapeResult.length === 3) {
                // 3D tensor - could be CHW or HWC
                // PyTorch convention is CHW
                [channels, height, width] = shapeResult;

                // Heuristic: if first dim is 1, 3, or 4, treat as CHW
                // Otherwise, it might be HWC
                if (channels > 4 && shapeResult[2] <= 4) {
                    // Likely HWC format (H, W, C)
                    [height, width, channels] = shapeResult;
                    dataLayout = 'HWC';
                }
            } else if (shapeResult.length === 4) {
                // 4D tensor NCHW - take first batch element
                const [batch, c, h, w] = shapeResult;
                channels = c;
                height = h;
                width = w;
                actualExpression = `${expression}[0]`;
            } else if (shapeResult.length === 1) {
                // 1D tensor - treat as single row
                width = shapeResult[0];
                height = 1;
                channels = 1;
                dataLayout = 'HWC';
            } else {
                return this.errorResult(`Unsupported tensor dimensions: ${shapeResult.length}D`);
            }

            // Validate dimensions
            if (width <= 0 || height <= 0 || width > 16384 || height > 16384) {
                return this.errorResult(`Invalid dimensions: ${width}x${height}`);
            }

            if (channels < 1 || channels > 4) {
                return this.errorResult(`Unsupported channel count: ${channels}`);
            }

            // Get dtype
            const dtypeResult = await session.evaluatePythonAsString(`str(${expression}.dtype)`);
            if (!dtypeResult) {
                return this.errorResult('Failed to get tensor dtype');
            }

            // Parse dtype to PixelDepth
            const depth = this.parseTorchDtype(dtypeResult);
            if (depth === undefined) {
                return this.errorResult(`Unsupported dtype: ${dtypeResult}`);
            }

            // Check if tensor is contiguous
            const isContiguousStr = await session.evaluatePythonAsString(`str(${actualExpression}.is_contiguous())`);
            const isContinuous = isContiguousStr === 'True';

            // Calculate stride and data size
            const bytesPerElement = this.getBytesPerElement(depth);
            let stride: number;
            let dataSize: number;

            if (dataLayout === 'CHW') {
                // For CHW format, stride is width * bytesPerElement for each channel plane
                stride = width * bytesPerElement;
                dataSize = channels * height * width * bytesPerElement;
            } else {
                // For HWC format
                stride = width * channels * bytesPerElement;
                dataSize = stride * height;
            }

            // For torch tensors, we need to convert to numpy for data reading
            const dataAddress = actualExpression;

            // Determine channel format
            let channelFormat: ChannelFormat | undefined;
            if (channels === 1) {
                channelFormat = ChannelFormat.GRAY;
            } else if (channels === 3) {
                // PyTorch typically uses RGB
                channelFormat = ChannelFormat.RGB;
            } else if (channels === 4) {
                channelFormat = ChannelFormat.RGBA;
            }

            const metadata: ImageMetadata = {
                id: this.generateImageId(expression),
                name: expression,
                expression: actualExpression,
                typeName: ImageTypeName.TORCH_TENSOR,
                depth,
                channels,
                width,
                height,
                stride,
                dataAddress,
                dataSize,
                channelFormat,
                isContinuous,
                dataLayout,
                debuggerType: 'debugpy',
                rawProperties: {
                    shape: shapeResult,
                    dtype: dtypeResult,
                    device: deviceStr,
                    originalExpression: expression,
                },
            };

            const warnings: string[] = [];
            if (!isContinuous) {
                warnings.push('Tensor is not contiguous; data will be copied');
            }
            if (dataLayout === 'CHW') {
                warnings.push('Tensor is in CHW format; will be converted to HWC for display');
            }

            return this.successResult(metadata, warnings.length > 0 ? warnings : undefined);
        } catch (error) {
            return this.errorResult(`Failed to parse torch tensor: ${error}`);
        }
    }

    /**
     * Parse PyTorch dtype string to PixelDepth
     */
    private parseTorchDtype(dtype: string): PixelDepth | undefined {
        // Direct match
        if (dtype in TORCH_DTYPE_MAP) {
            return TORCH_DTYPE_MAP[dtype];
        }

        // Normalize and try again
        const normalized = dtype.toLowerCase();
        for (const [key, value] of Object.entries(TORCH_DTYPE_MAP)) {
            if (normalized === key.toLowerCase() || normalized.includes(key.replace('torch.', ''))) {
                return value;
            }
        }

        return undefined;
    }

    /**
     * Get bytes per element for a given depth
     */
    private getBytesPerElement(depth: PixelDepth): number {
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
        return bytesPerElement[depth];
    }
}
