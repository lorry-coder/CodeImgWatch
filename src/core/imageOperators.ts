import { ImageData, PixelDepth, PixelDepthSize } from '../types';
import { ExpressionNode, OperatorNode } from './imageExpressionParser';
import { DebugSessionManager } from './debugSessionManager';

/**
 * Context for operator evaluation
 */
export interface OperatorContext {
    session: DebugSessionManager;
    getImageData: (expression: string) => Promise<ImageData | undefined>;
}

/**
 * Result of operator evaluation
 */
export interface OperatorResult {
    success: boolean;
    data?: ImageData;
    error?: string;
}

/**
 * Operator function signature
 */
type OperatorFn = (
    args: ExpressionNode[],
    context: OperatorContext
) => Promise<OperatorResult>;

/**
 * Registry of image operators
 */
const operators: Map<string, OperatorFn> = new Map();

/**
 * Register an operator
 */
export function registerOperator(name: string, fn: OperatorFn): void {
    operators.set(name.toLowerCase(), fn);
}

/**
 * Get an operator by name
 */
export function getOperator(name: string): OperatorFn | undefined {
    return operators.get(name.toLowerCase());
}

/**
 * Evaluate an operator expression
 */
export async function evaluateOperator(
    node: OperatorNode,
    context: OperatorContext
): Promise<OperatorResult> {
    const op = getOperator(node.name);
    if (!op) {
        return { success: false, error: `Unknown operator: @${node.name}` };
    }

    return op(node.args, context);
}

/**
 * Helper to evaluate an argument and get image data
 */
async function evaluateArg(
    arg: ExpressionNode,
    context: OperatorContext
): Promise<ImageData | undefined> {
    if (arg.type === 'variable') {
        return context.getImageData(arg.name);
    } else if (arg.type === 'operator') {
        const result = await evaluateOperator(arg, context);
        return result.data;
    }
    return undefined;
}

/**
 * Helper to get numeric argument
 */
function getNumberArg(arg: ExpressionNode): number | undefined {
    if (arg.type === 'number') {
        return arg.value;
    }
    return undefined;
}

/**
 * Create a copy of image data with transformed pixels
 */
function transformPixels(
    source: ImageData,
    transform: (values: number[], x: number, y: number) => number[],
    outputDepth: PixelDepth = source.metadata.depth
): ImageData {
    const meta = source.metadata;
    const sourcePixelSize = PixelDepthSize[meta.depth];
    const outputPixelSize = PixelDepthSize[outputDepth];
    const newStride = meta.width * meta.channels * outputPixelSize;
    const newData = new Uint8Array(newStride * meta.height);
    const littleEndian = meta.byteOrder !== 'big';

    for (let y = 0; y < meta.height; y++) {
        for (let x = 0; x < meta.width; x++) {
            const sourceOffset = y * meta.stride + x * meta.channels * sourcePixelSize;
            const outputOffset = y * newStride + x * meta.channels * outputPixelSize;

            // Read pixel values
            const values: number[] = [];
            for (let c = 0; c < meta.channels; c++) {
                values.push(readPixelValue(
                    source.data,
                    sourceOffset + c * sourcePixelSize,
                    meta.depth,
                    littleEndian
                ));
            }

            // Transform
            const newValues = transform(values, x, y);

            // Write pixel values
            for (let c = 0; c < meta.channels; c++) {
                writePixelValue(
                    newData,
                    outputOffset + c * outputPixelSize,
                    outputDepth,
                    newValues[c] ?? 0,
                    littleEndian
                );
            }
        }
    }

    return {
        metadata: {
            ...meta,
            id: `${meta.id}_transformed`,
            depth: outputDepth,
            stride: newStride,
            dataSize: newData.length,
            isContinuous: true,
            dataLayout: 'HWC',
        },
        data: newData,
        timestamp: Date.now(),
    };
}

/**
 * Read pixel value from buffer
 */
function readPixelValue(
    data: Uint8Array,
    offset: number,
    depth: PixelDepth,
    littleEndian: boolean = true
): number {
    const view = new DataView(data.buffer, data.byteOffset + offset, PixelDepthSize[depth]);
    switch (depth) {
        case PixelDepth.CV_8U:
            return view.getUint8(0);
        case PixelDepth.CV_8S:
            return view.getInt8(0);
        case PixelDepth.CV_16U:
            return view.getUint16(0, littleEndian);
        case PixelDepth.CV_16S:
            return view.getInt16(0, littleEndian);
        case PixelDepth.CV_32S:
            return view.getInt32(0, littleEndian);
        case PixelDepth.CV_32F:
            return view.getFloat32(0, littleEndian);
        case PixelDepth.CV_64F:
            return view.getFloat64(0, littleEndian);
        case PixelDepth.CV_16F:
            return halfToNumber(view.getUint16(0, littleEndian));
        default:
            return 0;
    }
}

/**
 * Write pixel value to buffer
 */
function writePixelValue(
    data: Uint8Array,
    offset: number,
    depth: PixelDepth,
    value: number,
    littleEndian: boolean = true
): void {
    const view = new DataView(data.buffer, data.byteOffset + offset, PixelDepthSize[depth]);
    switch (depth) {
        case PixelDepth.CV_8U:
            view.setUint8(0, Math.max(0, Math.min(255, Math.round(value))));
            break;
        case PixelDepth.CV_8S:
            view.setInt8(0, Math.max(-128, Math.min(127, Math.round(value))));
            break;
        case PixelDepth.CV_16U:
            view.setUint16(0, Math.max(0, Math.min(65535, Math.round(value))), littleEndian);
            break;
        case PixelDepth.CV_16S:
            view.setInt16(0, Math.max(-32768, Math.min(32767, Math.round(value))), littleEndian);
            break;
        case PixelDepth.CV_32S:
            view.setInt32(0, Math.max(-2147483648, Math.min(2147483647, Math.round(value))), littleEndian);
            break;
        case PixelDepth.CV_32F:
            view.setFloat32(0, value, littleEndian);
            break;
        case PixelDepth.CV_64F:
            view.setFloat64(0, value, littleEndian);
            break;
        case PixelDepth.CV_16F:
            view.setUint16(0, numberToHalf(value), littleEndian);
            break;
    }
}

function halfToNumber(bits: number): number {
    const sign = (bits & 0x8000) ? -1 : 1;
    const exponent = (bits >> 10) & 0x1F;
    const fraction = bits & 0x03FF;
    if (exponent === 0) {
        return sign * Math.pow(2, -14) * (fraction / 1024);
    }
    if (exponent === 0x1F) {
        return fraction === 0 ? sign * Infinity : NaN;
    }
    return sign * Math.pow(2, exponent - 15) * (1 + fraction / 1024);
}

function numberToHalf(value: number): number {
    if (Number.isNaN(value)) {
        return 0x7E00;
    }
    const sign = value < 0 || Object.is(value, -0) ? 0x8000 : 0;
    const absolute = Math.abs(value);
    if (absolute === Infinity) {
        return sign | 0x7C00;
    }
    if (absolute === 0) {
        return sign;
    }

    const exponent = Math.floor(Math.log2(absolute));
    if (exponent < -14) {
        return sign | Math.round(absolute / Math.pow(2, -24));
    }
    if (exponent > 15) {
        return sign | 0x7C00;
    }
    const encodedExponent = exponent + 15;
    let fraction = Math.round((absolute / Math.pow(2, exponent) - 1) * 1024);
    if (fraction === 1024) {
        if (encodedExponent + 1 >= 31) {
            return sign | 0x7C00;
        }
        return sign | ((encodedExponent + 1) << 10);
    }
    fraction = Math.max(0, Math.min(1023, fraction));
    return sign | (encodedExponent << 10) | fraction;
}

// =====================================
// Register built-in operators
// =====================================

/**
 * @band(img, n) - Extract channel n
 */
registerOperator('band', async (args, context) => {
    if (args.length !== 2) {
        return { success: false, error: '@band requires 2 arguments: (image, channel)' };
    }

    const imageData = await evaluateArg(args[0], context);
    if (!imageData) {
        return { success: false, error: 'Failed to get image for @band' };
    }

    const channel = getNumberArg(args[1]);
    if (channel === undefined || !Number.isInteger(channel)) {
        return { success: false, error: '@band channel argument must be an integer' };
    }

    const meta = imageData.metadata;
    if (channel < 0 || channel >= meta.channels) {
        return { success: false, error: `Channel ${channel} out of range (0-${meta.channels - 1})` };
    }

    const pixelSize = PixelDepthSize[meta.depth];
    const newStride = meta.width * pixelSize;
    const newData = new Uint8Array(newStride * meta.height);

    for (let y = 0; y < meta.height; y++) {
        for (let x = 0; x < meta.width; x++) {
            const srcOffset = y * meta.stride + x * meta.channels * pixelSize + channel * pixelSize;
            const dstOffset = y * newStride + x * pixelSize;

            for (let i = 0; i < pixelSize; i++) {
                newData[dstOffset + i] = imageData.data[srcOffset + i];
            }
        }
    }

    return {
        success: true,
        data: {
            metadata: {
                ...meta,
                id: `${meta.id}_band${channel}`,
                channels: 1,
                stride: newStride,
                dataSize: newData.length,
            },
            data: newData,
            timestamp: Date.now(),
        },
    };
});

/**
 * @abs(img) - Absolute value
 */
registerOperator('abs', async (args, context) => {
    if (args.length !== 1) {
        return { success: false, error: '@abs requires 1 argument' };
    }

    const imageData = await evaluateArg(args[0], context);
    if (!imageData) {
        return { success: false, error: 'Failed to get image for @abs' };
    }

    const result = transformPixels(imageData, (values) => values.map(v => Math.abs(v)));
    return { success: true, data: result };
});

/**
 * @scale(img, factor) - Scale pixel values
 */
registerOperator('scale', async (args, context) => {
    if (args.length !== 2) {
        return { success: false, error: '@scale requires 2 arguments: (image, factor)' };
    }

    const imageData = await evaluateArg(args[0], context);
    if (!imageData) {
        return { success: false, error: 'Failed to get image for @scale' };
    }

    const factor = getNumberArg(args[1]);
    if (factor === undefined) {
        return { success: false, error: '@scale factor must be a number' };
    }

    const result = transformPixels(imageData, (values) => values.map(v => v * factor));
    return { success: true, data: result };
});

/**
 * @thresh(img, threshold) - Binary threshold
 */
registerOperator('thresh', async (args, context) => {
    if (args.length !== 2) {
        return { success: false, error: '@thresh requires 2 arguments: (image, threshold)' };
    }

    const imageData = await evaluateArg(args[0], context);
    if (!imageData) {
        return { success: false, error: 'Failed to get image for @thresh' };
    }

    const threshold = getNumberArg(args[1]);
    if (threshold === undefined) {
        return { success: false, error: '@thresh threshold must be a number' };
    }

    const maxValues: Partial<Record<PixelDepth, number>> = {
        [PixelDepth.CV_8U]: 255,
        [PixelDepth.CV_8S]: 127,
        [PixelDepth.CV_16U]: 65535,
        [PixelDepth.CV_16S]: 32767,
        [PixelDepth.CV_32S]: 2147483647,
    };
    const maxVal = maxValues[imageData.metadata.depth] ?? 1;
    const result = transformPixels(imageData, (values) =>
        values.map(v => (v >= threshold ? maxVal : 0))
    );
    return { success: true, data: result };
});

/**
 * @clamp(img, min, max) - Clamp values to range
 */
registerOperator('clamp', async (args, context) => {
    if (args.length !== 3) {
        return { success: false, error: '@clamp requires 3 arguments: (image, min, max)' };
    }

    const imageData = await evaluateArg(args[0], context);
    if (!imageData) {
        return { success: false, error: 'Failed to get image for @clamp' };
    }

    const minVal = getNumberArg(args[1]);
    const maxVal = getNumberArg(args[2]);
    if (minVal === undefined || maxVal === undefined) {
        return { success: false, error: '@clamp min/max must be numbers' };
    }
    if (minVal > maxVal) {
        return { success: false, error: '@clamp requires min to be less than or equal to max' };
    }

    const result = transformPixels(imageData, (values) =>
        values.map(v => Math.max(minVal, Math.min(maxVal, v)))
    );
    return { success: true, data: result };
});

/**
 * @norm8(img) - Normalize uint8-style values to floating point 0-1
 */
registerOperator('norm8', async (args, context) => {
    if (args.length !== 1) {
        return { success: false, error: '@norm8 requires 1 argument' };
    }

    const imageData = await evaluateArg(args[0], context);
    if (!imageData) {
        return { success: false, error: 'Failed to get image for @norm8' };
    }

    const result = transformPixels(
        imageData,
        (values) => values.map(v => v / 255),
        PixelDepth.CV_32F
    );
    return { success: true, data: result };
});

/**
 * @norm16(img) - Normalize to 0-1 range (divide by 65535)
 */
registerOperator('norm16', async (args, context) => {
    if (args.length !== 1) {
        return { success: false, error: '@norm16 requires 1 argument' };
    }

    const imageData = await evaluateArg(args[0], context);
    if (!imageData) {
        return { success: false, error: 'Failed to get image for @norm16' };
    }

    const result = transformPixels(
        imageData,
        (values) => values.map(v => v / 65535),
        PixelDepth.CV_32F
    );
    return { success: true, data: result };
});

/**
 * @diff(img1, img2) - Absolute difference
 */
registerOperator('diff', async (args, context) => {
    if (args.length !== 2) {
        return { success: false, error: '@diff requires 2 arguments: (image1, image2)' };
    }

    const img1 = await evaluateArg(args[0], context);
    const img2 = await evaluateArg(args[1], context);

    if (!img1 || !img2) {
        return { success: false, error: 'Failed to get images for @diff' };
    }

    const meta1 = img1.metadata;
    const meta2 = img2.metadata;

    if (meta1.width !== meta2.width || meta1.height !== meta2.height) {
        return { success: false, error: '@diff requires images of same size' };
    }

    if (meta1.channels !== meta2.channels) {
        return { success: false, error: '@diff requires images with same number of channels' };
    }

    if (meta1.depth !== meta2.depth) {
        return { success: false, error: '@diff requires images with the same pixel depth' };
    }

    const defaultChannelFormat = (metadata: ImageData['metadata']): string | undefined => {
        if (metadata.channelFormat) {
            return metadata.channelFormat;
        }
        return metadata.channels === 3 ? 'bgr' : metadata.channels === 4 ? 'bgra' : undefined;
    };
    if (defaultChannelFormat(meta1) !== defaultChannelFormat(meta2)) {
        return { success: false, error: '@diff requires images with the same channel order' };
    }

    const pixelSize = PixelDepthSize[meta1.depth];
    const newStride = meta1.width * meta1.channels * pixelSize;
    const newData = new Uint8Array(newStride * meta1.height);
    const littleEndian1 = meta1.byteOrder !== 'big';
    const littleEndian2 = meta2.byteOrder !== 'big';

    for (let y = 0; y < meta1.height; y++) {
        for (let x = 0; x < meta1.width; x++) {
            for (let c = 0; c < meta1.channels; c++) {
                const offset1 = y * meta1.stride + x * meta1.channels * pixelSize + c * pixelSize;
                const offset2 = y * meta2.stride + x * meta2.channels * pixelSize + c * pixelSize;
                const outputOffset = y * newStride + x * meta1.channels * pixelSize + c * pixelSize;

                const v1 = readPixelValue(img1.data, offset1, meta1.depth, littleEndian1);
                const v2 = readPixelValue(img2.data, offset2, meta2.depth, littleEndian2);

                writePixelValue(newData, outputOffset, meta1.depth, Math.abs(v1 - v2), littleEndian1);
            }
        }
    }

    return {
        success: true,
        data: {
            metadata: {
                ...meta1,
                id: `diff_${meta1.id}_${meta2.id}`,
                stride: newStride,
                dataSize: newData.length,
                isContinuous: true,
                dataLayout: 'HWC',
            },
            data: newData,
            timestamp: Date.now(),
        },
    };
});

/**
 * @fliph(img) - Flip horizontally
 */
registerOperator('fliph', async (args, context) => {
    if (args.length !== 1) {
        return { success: false, error: '@fliph requires 1 argument' };
    }

    const imageData = await evaluateArg(args[0], context);
    if (!imageData) {
        return { success: false, error: 'Failed to get image for @fliph' };
    }

    const meta = imageData.metadata;
    const pixelSize = PixelDepthSize[meta.depth];
    const bytesPerPixel = meta.channels * pixelSize;
    const newData = new Uint8Array(imageData.data.length);

    for (let y = 0; y < meta.height; y++) {
        for (let x = 0; x < meta.width; x++) {
            const srcOffset = y * meta.stride + x * bytesPerPixel;
            const dstOffset = y * meta.stride + (meta.width - 1 - x) * bytesPerPixel;

            for (let i = 0; i < bytesPerPixel; i++) {
                newData[dstOffset + i] = imageData.data[srcOffset + i];
            }
        }
    }

    return {
        success: true,
        data: {
            metadata: { ...meta, id: `${meta.id}_fliph` },
            data: newData,
            timestamp: Date.now(),
        },
    };
});

/**
 * @flipv(img) - Flip vertically
 */
registerOperator('flipv', async (args, context) => {
    if (args.length !== 1) {
        return { success: false, error: '@flipv requires 1 argument' };
    }

    const imageData = await evaluateArg(args[0], context);
    if (!imageData) {
        return { success: false, error: 'Failed to get image for @flipv' };
    }

    const meta = imageData.metadata;
    const rowSize = meta.width * meta.channels * PixelDepthSize[meta.depth];
    const newData = new Uint8Array(imageData.data.length);

    for (let y = 0; y < meta.height; y++) {
        const srcRowStart = y * meta.stride;
        const dstRowStart = (meta.height - 1 - y) * meta.stride;
        newData.set(imageData.data.subarray(srcRowStart, srcRowStart + rowSize), dstRowStart);
    }

    return {
        success: true,
        data: {
            metadata: { ...meta, id: `${meta.id}_flipv` },
            data: newData,
            timestamp: Date.now(),
        },
    };
});

/**
 * @rot90(img) - Rotate 90 degrees clockwise
 */
registerOperator('rot90', async (args, context) => {
    if (args.length !== 1) {
        return { success: false, error: '@rot90 requires 1 argument' };
    }

    const imageData = await evaluateArg(args[0], context);
    if (!imageData) {
        return { success: false, error: 'Failed to get image for @rot90' };
    }

    const meta = imageData.metadata;
    const pixelSize = PixelDepthSize[meta.depth];
    const bytesPerPixel = meta.channels * pixelSize;

    // New dimensions swapped
    const newWidth = meta.height;
    const newHeight = meta.width;
    const newStride = newWidth * bytesPerPixel;
    const newData = new Uint8Array(newStride * newHeight);

    for (let y = 0; y < meta.height; y++) {
        for (let x = 0; x < meta.width; x++) {
            const srcOffset = y * meta.stride + x * bytesPerPixel;
            // 90 CW: (x, y) -> (height-1-y, x)
            const dstX = meta.height - 1 - y;
            const dstY = x;
            const dstOffset = dstY * newStride + dstX * bytesPerPixel;

            for (let i = 0; i < bytesPerPixel; i++) {
                newData[dstOffset + i] = imageData.data[srcOffset + i];
            }
        }
    }

    return {
        success: true,
        data: {
            metadata: {
                ...meta,
                id: `${meta.id}_rot90`,
                width: newWidth,
                height: newHeight,
                stride: newStride,
                dataSize: newData.length,
            },
            data: newData,
            timestamp: Date.now(),
        },
    };
});

/**
 * @rot180(img) - Rotate 180 degrees
 */
registerOperator('rot180', async (args, context) => {
    if (args.length !== 1) {
        return { success: false, error: '@rot180 requires 1 argument' };
    }

    const imageData = await evaluateArg(args[0], context);
    if (!imageData) {
        return { success: false, error: 'Failed to get image for @rot180' };
    }

    const meta = imageData.metadata;
    const pixelSize = PixelDepthSize[meta.depth];
    const bytesPerPixel = meta.channels * pixelSize;
    const newData = new Uint8Array(imageData.data.length);

    for (let y = 0; y < meta.height; y++) {
        for (let x = 0; x < meta.width; x++) {
            const srcOffset = y * meta.stride + x * bytesPerPixel;
            const dstOffset = (meta.height - 1 - y) * meta.stride + (meta.width - 1 - x) * bytesPerPixel;

            for (let i = 0; i < bytesPerPixel; i++) {
                newData[dstOffset + i] = imageData.data[srcOffset + i];
            }
        }
    }

    return {
        success: true,
        data: {
            metadata: { ...meta, id: `${meta.id}_rot180` },
            data: newData,
            timestamp: Date.now(),
        },
    };
});

/**
 * @rot270(img) - Rotate 270 degrees clockwise (90 CCW)
 */
registerOperator('rot270', async (args, context) => {
    if (args.length !== 1) {
        return { success: false, error: '@rot270 requires 1 argument' };
    }

    const imageData = await evaluateArg(args[0], context);
    if (!imageData) {
        return { success: false, error: 'Failed to get image for @rot270' };
    }

    const meta = imageData.metadata;
    const pixelSize = PixelDepthSize[meta.depth];
    const bytesPerPixel = meta.channels * pixelSize;

    const newWidth = meta.height;
    const newHeight = meta.width;
    const newStride = newWidth * bytesPerPixel;
    const newData = new Uint8Array(newStride * newHeight);

    for (let y = 0; y < meta.height; y++) {
        for (let x = 0; x < meta.width; x++) {
            const srcOffset = y * meta.stride + x * bytesPerPixel;
            // 270 CW (90 CCW): (x, y) -> (y, width-1-x)
            const dstX = y;
            const dstY = meta.width - 1 - x;
            const dstOffset = dstY * newStride + dstX * bytesPerPixel;

            for (let i = 0; i < bytesPerPixel; i++) {
                newData[dstOffset + i] = imageData.data[srcOffset + i];
            }
        }
    }

    return {
        success: true,
        data: {
            metadata: {
                ...meta,
                id: `${meta.id}_rot270`,
                width: newWidth,
                height: newHeight,
                stride: newStride,
                dataSize: newData.length,
            },
            data: newData,
            timestamp: Date.now(),
        },
    };
});
