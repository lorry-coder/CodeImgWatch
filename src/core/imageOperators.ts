import { ImageMetadata, ImageData, PixelDepth, PixelDepthSize } from '../types';
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
    transform: (values: number[], x: number, y: number) => number[]
): ImageData {
    const meta = source.metadata;
    const pixelSize = PixelDepthSize[meta.depth];
    const newData = new Uint8Array(source.data.length);

    for (let y = 0; y < meta.height; y++) {
        for (let x = 0; x < meta.width; x++) {
            const offset = y * meta.stride + x * meta.channels * pixelSize;

            // Read pixel values
            const values: number[] = [];
            for (let c = 0; c < meta.channels; c++) {
                values.push(readPixelValue(source.data, offset + c * pixelSize, meta.depth));
            }

            // Transform
            const newValues = transform(values, x, y);

            // Write pixel values
            for (let c = 0; c < meta.channels; c++) {
                writePixelValue(newData, offset + c * pixelSize, meta.depth, newValues[c] ?? 0);
            }
        }
    }

    return {
        metadata: { ...meta, id: `${meta.id}_transformed` },
        data: newData,
        timestamp: Date.now(),
    };
}

/**
 * Read pixel value from buffer
 */
function readPixelValue(data: Uint8Array, offset: number, depth: PixelDepth): number {
    switch (depth) {
        case PixelDepth.CV_8U:
            return data[offset];
        case PixelDepth.CV_8S:
            return data[offset] > 127 ? data[offset] - 256 : data[offset];
        case PixelDepth.CV_16U:
            return data[offset] | (data[offset + 1] << 8);
        case PixelDepth.CV_16S: {
            const v = data[offset] | (data[offset + 1] << 8);
            return v > 32767 ? v - 65536 : v;
        }
        case PixelDepth.CV_32S: {
            return data[offset] | (data[offset + 1] << 8) |
                (data[offset + 2] << 16) | (data[offset + 3] << 24);
        }
        case PixelDepth.CV_32F: {
            const buffer = new ArrayBuffer(4);
            const view = new DataView(buffer);
            for (let i = 0; i < 4; i++) {
                view.setUint8(i, data[offset + i]);
            }
            return view.getFloat32(0, true);
        }
        case PixelDepth.CV_64F: {
            const buffer = new ArrayBuffer(8);
            const view = new DataView(buffer);
            for (let i = 0; i < 8; i++) {
                view.setUint8(i, data[offset + i]);
            }
            return view.getFloat64(0, true);
        }
        default:
            return data[offset];
    }
}

/**
 * Write pixel value to buffer
 */
function writePixelValue(data: Uint8Array, offset: number, depth: PixelDepth, value: number): void {
    switch (depth) {
        case PixelDepth.CV_8U:
            data[offset] = Math.max(0, Math.min(255, Math.round(value)));
            break;
        case PixelDepth.CV_8S:
            data[offset] = Math.max(-128, Math.min(127, Math.round(value))) & 0xFF;
            break;
        case PixelDepth.CV_16U: {
            const v = Math.max(0, Math.min(65535, Math.round(value)));
            data[offset] = v & 0xFF;
            data[offset + 1] = (v >> 8) & 0xFF;
            break;
        }
        case PixelDepth.CV_16S: {
            const v = Math.max(-32768, Math.min(32767, Math.round(value)));
            const u = v < 0 ? v + 65536 : v;
            data[offset] = u & 0xFF;
            data[offset + 1] = (u >> 8) & 0xFF;
            break;
        }
        case PixelDepth.CV_32S: {
            const v = Math.round(value);
            data[offset] = v & 0xFF;
            data[offset + 1] = (v >> 8) & 0xFF;
            data[offset + 2] = (v >> 16) & 0xFF;
            data[offset + 3] = (v >> 24) & 0xFF;
            break;
        }
        case PixelDepth.CV_32F: {
            const buffer = new ArrayBuffer(4);
            const view = new DataView(buffer);
            view.setFloat32(0, value, true);
            for (let i = 0; i < 4; i++) {
                data[offset + i] = view.getUint8(i);
            }
            break;
        }
        case PixelDepth.CV_64F: {
            const buffer = new ArrayBuffer(8);
            const view = new DataView(buffer);
            view.setFloat64(0, value, true);
            for (let i = 0; i < 8; i++) {
                data[offset + i] = view.getUint8(i);
            }
            break;
        }
    }
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
    if (channel === undefined) {
        return { success: false, error: '@band channel argument must be a number' };
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

    const maxVal = imageData.metadata.depth === PixelDepth.CV_8U ? 255 : 1;
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

    const result = transformPixels(imageData, (values) =>
        values.map(v => Math.max(minVal, Math.min(maxVal, v)))
    );
    return { success: true, data: result };
});

/**
 * @norm8(img) - Normalize to 0-255 range (divide by 255)
 */
registerOperator('norm8', async (args, context) => {
    if (args.length !== 1) {
        return { success: false, error: '@norm8 requires 1 argument' };
    }

    const imageData = await evaluateArg(args[0], context);
    if (!imageData) {
        return { success: false, error: 'Failed to get image for @norm8' };
    }

    const result = transformPixels(imageData, (values) => values.map(v => v / 255));
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

    const result = transformPixels(imageData, (values) => values.map(v => v / 65535));
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

    const pixelSize = PixelDepthSize[meta1.depth];
    const newData = new Uint8Array(img1.data.length);

    for (let y = 0; y < meta1.height; y++) {
        for (let x = 0; x < meta1.width; x++) {
            for (let c = 0; c < meta1.channels; c++) {
                const offset1 = y * meta1.stride + x * meta1.channels * pixelSize + c * pixelSize;
                const offset2 = y * meta2.stride + x * meta2.channels * pixelSize + c * pixelSize;

                const v1 = readPixelValue(img1.data, offset1, meta1.depth);
                const v2 = readPixelValue(img2.data, offset2, meta2.depth);

                writePixelValue(newData, offset1, meta1.depth, Math.abs(v1 - v2));
            }
        }
    }

    return {
        success: true,
        data: {
            metadata: { ...meta1, id: `diff_${meta1.id}_${meta2.id}` },
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
    const newData = new Uint8Array(imageData.data.length);

    for (let y = 0; y < meta.height; y++) {
        const srcRowStart = y * meta.stride;
        const dstRowStart = (meta.height - 1 - y) * meta.stride;

        for (let i = 0; i < meta.stride; i++) {
            newData[dstRowStart + i] = imageData.data[srcRowStart + i];
        }
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
