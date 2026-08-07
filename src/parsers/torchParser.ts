/**
 * PyTorch Tensor parser for Python debugger (debugpy)
 */

import { DebugSessionManager } from '../core/debugSessionManager';
import { ImageMetadata, ParseResult, ImageTypeName } from '../types';
import { PixelDepth, PixelDepthSize, ChannelFormat } from '../types/pixelFormats';
import { BaseImageParser } from './baseParser';

/**
 * Map PyTorch dtype strings to PixelDepth
 */
interface TorchDtypeInfo {
    depth: PixelDepth;
    conversionDtype?: string;
    warning?: string;
}

const TORCH_DTYPE_MAP: Record<string, TorchDtypeInfo> = {
    'torch.uint8': { depth: PixelDepth.CV_8U },
    'torch.int8': { depth: PixelDepth.CV_8S },
    'torch.int16': { depth: PixelDepth.CV_16S },
    'torch.short': { depth: PixelDepth.CV_16S },
    'torch.int32': { depth: PixelDepth.CV_32S },
    'torch.int': { depth: PixelDepth.CV_32S },
    'torch.int64': {
        depth: PixelDepth.CV_32S,
        conversionDtype: 'int32',
        warning: 'int64 tensor values are converted to int32 for display',
    },
    'torch.long': {
        depth: PixelDepth.CV_32S,
        conversionDtype: 'int32',
        warning: 'int64 tensor values are converted to int32 for display',
    },
    'torch.float16': { depth: PixelDepth.CV_16F },
    'torch.half': { depth: PixelDepth.CV_16F },
    'torch.bfloat16': {
        depth: PixelDepth.CV_32F,
        conversionDtype: 'float32',
        warning: 'bfloat16 tensor values are converted to float32 for display',
    },
    'torch.float32': { depth: PixelDepth.CV_32F },
    'torch.float': { depth: PixelDepth.CV_32F },
    'torch.float64': { depth: PixelDepth.CV_64F },
    'torch.double': { depth: PixelDepth.CV_64F },
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
        expression: string
    ): Promise<ParseResult> {
        try {
            // Check if tensor is on CPU
            const deviceStr = await session.evaluatePythonAsString(`str(${expression}.device)`);
            if (!deviceStr) {
                return this.errorResult('Failed to get tensor device');
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
                if (shapeResult[0] <= 4) {
                    [channels, height, width] = shapeResult;
                } else if (shapeResult[2] <= 4) {
                    [height, width, channels] = shapeResult;
                    dataLayout = 'HWC';
                } else {
                    return this.errorResult(`Cannot infer channel axis from tensor shape (${shapeResult.join(', ')})`);
                }
            } else if (shapeResult.length === 4) {
                const [, first, second, third] = shapeResult;
                actualExpression = `${expression}[0]`;
                if (first <= 4) {
                    channels = first;
                    height = second;
                    width = third;
                } else if (third <= 4) {
                    height = first;
                    width = second;
                    channels = third;
                    dataLayout = 'HWC';
                } else {
                    return this.errorResult(`Cannot infer channel axis from batched tensor shape (${shapeResult.join(', ')})`);
                }
            } else if (shapeResult.length === 1) {
                // 1D tensor - treat as single row
                width = shapeResult[0];
                height = 1;
                channels = 1;
                dataLayout = 'HWC';
            } else {
                return this.errorResult(`Unsupported tensor dimensions: ${shapeResult.length}D`);
            }

            // Get dtype
            const dtypeResult = await session.evaluatePythonAsString(`str(${expression}.dtype)`);
            if (!dtypeResult) {
                return this.errorResult('Failed to get tensor dtype');
            }

            // Parse dtype to PixelDepth
            const dtypeInfo = this.parseTorchDtype(dtypeResult);
            if (!dtypeInfo) {
                return this.errorResult(`Unsupported dtype: ${dtypeResult}`);
            }
            const { depth } = dtypeInfo;

            // Check if tensor is contiguous
            const isContiguousStr = await session.evaluatePythonAsString(`str(${actualExpression}.is_contiguous())`);
            const isContinuous = isContiguousStr === 'True';

            // Calculate stride and data size
            const bytesPerElement = PixelDepthSize[depth];
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
            const displayStride = width * channels * bytesPerElement;
            const validationError = this.getImageValidationError(width, height, channels, depth, displayStride);
            if (validationError) {
                return this.errorResult(validationError);
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
                    torchConversionDtype: dtypeInfo.conversionDtype,
                },
            };

            const warnings: string[] = [];
            if (!deviceStr.startsWith('cpu')) {
                warnings.push(`Tensor is on ${deviceStr}; data will be copied to CPU for display`);
            }
            if (!isContinuous) {
                warnings.push('Tensor is not contiguous; data will be copied');
            }
            if (dataLayout === 'CHW') {
                warnings.push('Tensor is in CHW format; will be converted to HWC for display');
            }
            if (shapeResult.length === 4) {
                warnings.push('Batched tensor: displaying the first image only');
            }
            if (dtypeInfo.warning) {
                warnings.push(dtypeInfo.warning);
            }

            return this.successResult(metadata, warnings.length > 0 ? warnings : undefined);
        } catch (error) {
            return this.errorResult(`Failed to parse torch tensor: ${error}`);
        }
    }

    /**
     * Parse PyTorch dtype string to PixelDepth
     */
    private parseTorchDtype(dtype: string): TorchDtypeInfo | undefined {
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
}
