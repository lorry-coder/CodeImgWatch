/**
 * NumPy ndarray parser for Python debugger (debugpy)
 */

import { DebugSessionManager, EvaluateResponse } from '../core/debugSessionManager';
import { ImageMetadata, ParseResult, ImageTypeName } from '../types';
import { PixelDepth, PixelDepthSize, ChannelFormat } from '../types/pixelFormats';
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
        // debugpy often shows numpy arrays as just "array"
        return /\bndarray\b/.test(typeName) ||
               /numpy\.ndarray/.test(typeName) ||
               /\barray\b/.test(typeName);
    }

    async parse(
        session: DebugSessionManager,
        expression: string,
        evaluateResult: EvaluateResponse
    ): Promise<ParseResult> {
        try {
            // Get shape
            const shape = await session.evaluatePythonAsTuple(`${expression}.shape`);
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
                return this.errorResult('Failed to get array dtype');
            }

            // Parse dtype to PixelDepth
            const depth = this.parseNumpyDtype(dtypeResult);
            if (depth === undefined) {
                return this.errorResult(`Unsupported dtype: ${dtypeResult}`);
            }

            // Check if array is contiguous
            const isCContiguous = await session.evaluatePythonAsString(`str(${expression}.flags['C_CONTIGUOUS'])`);
            const isContinuous = isCContiguous === 'True';

            // Calculate stride and data size
            const bytesPerElement = PixelDepthSize[depth];
            const stride = width * channels * bytesPerElement;
            const dataSize = stride * height;

            // For numpy arrays, we use expression-based data reading
            // The dataAddress will be the expression itself for Python
            const dataAddress = expression;

            // Determine channel format based on channels count
            let channelFormat: ChannelFormat | undefined;
            if (channels === 1) {
                channelFormat = ChannelFormat.GRAY;
            } else if (channels === 3) {
                // NumPy arrays from OpenCV are BGR, from others typically RGB
                // We'll default to BGR as that's more common in image processing
                channelFormat = ChannelFormat.BGR;
            } else if (channels === 4) {
                channelFormat = ChannelFormat.BGRA;
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
        // Normalize dtype string
        const normalized = dtype.toLowerCase().replace(/[<>|=]/g, '');

        // Direct match
        if (normalized in NUMPY_DTYPE_MAP) {
            return NUMPY_DTYPE_MAP[normalized];
        }

        // Check for common patterns like 'float64', 'int32', etc.
        for (const [key, value] of Object.entries(NUMPY_DTYPE_MAP)) {
            if (normalized.includes(key)) {
                return value;
            }
        }

        return undefined;
    }
}
