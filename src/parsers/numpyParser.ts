/**
 * NumPy ndarray parser for Python debugger (debugpy)
 */

import * as vscode from 'vscode';
import { DebugSessionManager } from '../core/debugSessionManager';
import { ImageMetadata, ParseResult, ImageTypeName } from '../types';
import { PixelDepth, PixelDepthSize, ChannelFormat, ByteOrder } from '../types/pixelFormats';
import { BaseImageParser } from './baseParser';

/**
 * Map NumPy dtype strings to PixelDepth
 */
const NUMPY_DTYPE_MAP: Record<string, PixelDepth> = {
    'uint8': PixelDepth.CV_8U,
    'int8': PixelDepth.CV_8S,
    'uint16': PixelDepth.CV_16U,
    'int16': PixelDepth.CV_16S,
    'int32': PixelDepth.CV_32S,
    'float32': PixelDepth.CV_32F,
    'float64': PixelDepth.CV_64F,
    'float16': PixelDepth.CV_16F,
    // Alternative dtype names
    'u1': PixelDepth.CV_8U,
    'i1': PixelDepth.CV_8S,
    'u2': PixelDepth.CV_16U,
    'i2': PixelDepth.CV_16S,
    'i4': PixelDepth.CV_32S,
    'f4': PixelDepth.CV_32F,
    'f8': PixelDepth.CV_64F,
    'f2': PixelDepth.CV_16F,
};

/**
 * Parser for numpy.ndarray images
 */
export class NumpyArrayParser extends BaseImageParser {
    readonly name = 'NumpyArray';
    readonly priority = 100; // High priority for Python images

    canParse(typeName: string): boolean {
        return /\bndarray\b/.test(typeName) ||
               /numpy\.ndarray/.test(typeName) ||
               /^(?:cv2\.)?Mat$/.test(typeName);
    }

    async parse(
        session: DebugSessionManager,
        expression: string
    ): Promise<ParseResult> {
        try {
            const sourceExpression = `(${expression})`;

            // Get shape
            const shape = await session.evaluatePythonAsTuple(`${sourceExpression}.shape`);
            if (!shape || shape.length === 0) {
                return this.errorResult('Failed to get array shape');
            }

            // Determine dimensions
            let height: number;
            let width: number;
            let channels: number;

            if (shape.length === 2) {
                // Grayscale image (H, W)
                [height, width] = shape;
                channels = 1;
            } else if (shape.length === 3) {
                // Color image (H, W, C) - standard NumPy/OpenCV format
                [height, width, channels] = shape;
            } else if (shape.length === 1) {
                // 1D array - treat as single row
                width = shape[0];
                height = 1;
                channels = 1;
            } else {
                return this.errorResult(`Unsupported array dimensions: ${shape.length}D (expected 2D or 3D)`);
            }

            // Get dtype
            const dtypeResult = await session.evaluatePythonAsString(`str(${sourceExpression}.dtype)`);
            if (!dtypeResult) {
                return this.errorResult('Failed to get array dtype');
            }

            // Parse dtype to PixelDepth
            const depth = this.parseNumpyDtype(dtypeResult);
            if (depth === undefined) {
                return this.errorResult(`Unsupported dtype: ${dtypeResult}`);
            }

            // Check if array is contiguous
            const isCContiguous = await session.evaluatePythonAsString(
                `str(${sourceExpression}.flags['C_CONTIGUOUS'])`
            );
            const isContinuous = isCContiguous === 'True';

            // Calculate stride and data size
            const bytesPerElement = PixelDepthSize[depth];
            const stride = width * channels * bytesPerElement;
            const dataSize = stride * height;
            const validationError = this.getImageValidationError(width, height, channels, depth, stride);
            if (validationError) {
                return this.errorResult(validationError);
            }

            // For numpy arrays, we use expression-based data reading
            // The dataAddress will be the expression itself for Python
            const dataAddress = expression;

            // Determine channel format based on channels count
            let channelFormat: ChannelFormat | undefined;
            if (channels === 1) {
                channelFormat = ChannelFormat.GRAY;
            } else if (channels === 3) {
                const order = vscode.workspace
                    .getConfiguration('imview')
                    .get<'bgr' | 'rgb'>('numpyChannelOrder', 'bgr');
                channelFormat = order === 'rgb' ? ChannelFormat.RGB : ChannelFormat.BGR;
            } else if (channels === 4) {
                const order = vscode.workspace
                    .getConfiguration('imview')
                    .get<'bgr' | 'rgb'>('numpyChannelOrder', 'bgr');
                channelFormat = order === 'rgb' ? ChannelFormat.RGBA : ChannelFormat.BGRA;
            }

            const metadata: ImageMetadata = {
                id: this.generateImageId(expression),
                name: expression,
                expression,
                typeName: ImageTypeName.NUMPY_NDARRAY,
                depth,
                channels,
                width,
                height,
                stride,
                dataAddress,
                dataSize,
                channelFormat,
                byteOrder: this.getNumpyByteOrder(dtypeResult),
                isContinuous,
                dataLayout: 'HWC',
                debuggerType: 'debugpy',
                rawProperties: {
                    shape,
                    dtype: dtypeResult,
                },
            };

            const warnings: string[] = [];
            if (!isContinuous) {
                warnings.push('Array is not contiguous; data will be copied');
            }

            return this.successResult(metadata, warnings.length > 0 ? warnings : undefined);
        } catch (error) {
            return this.errorResult(`Failed to parse numpy array: ${error}`);
        }
    }

    /**
     * Parse NumPy dtype string to PixelDepth
     */
    private parseNumpyDtype(dtype: string): PixelDepth | undefined {
        // NumPy prefixes scalar dtype strings with a byte-order marker. Match
        // the remaining name exactly so structured dtypes containing strings
        // such as "u1" are not silently treated as scalar pixel buffers.
        const normalized = dtype.trim().toLowerCase().replace(/^[<>|=]/, '');
        return NUMPY_DTYPE_MAP[normalized];
    }

    private getNumpyByteOrder(dtype: string): ByteOrder {
        return dtype.trim().startsWith('>') ? 'big' : 'little';
    }
}
