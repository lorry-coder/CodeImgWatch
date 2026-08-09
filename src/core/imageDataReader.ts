import { DebugSessionManager } from './debugSessionManager';
import { ImageItem, ImageMetadata, ImageTypeName, PixelDepthSize } from '../types';
import { calculateDataSize, chwToHwc } from '../utils/imageTransform';

export interface DisplayImageData {
    data: Uint8Array;
    metadata: ImageMetadata;
}

/** Build the side-effect-free conversion expression evaluated by debugpy. */
export function getPythonDataExpression(metadata: ImageMetadata): string {
    const expression = `(${metadata.expression})`;

    if (metadata.typeName === ImageTypeName.PIL_IMAGE) {
        const conversionMode = metadata.rawProperties?.pilConversionMode;
        if (typeof conversionMode === 'string' && conversionMode.length > 0) {
            return `${expression}.convert('${conversionMode}')`;
        }
        return expression;
    }

    if (metadata.typeName === ImageTypeName.TORCH_TENSOR) {
        let tensorExpression = `${expression}.detach().cpu()`;
        const conversionDtype = metadata.rawProperties?.torchConversionDtype;
        if (typeof conversionDtype === 'string' && conversionDtype.length > 0) {
            tensorExpression += `.to(dtype=__import__('torch').${conversionDtype})`;
        }
        tensorExpression += '.contiguous()';

        // Avoid Tensor.numpy(): older PyTorch wheels can be ABI-incompatible
        // with newer NumPy releases even though the tensor itself is usable.
        // string_at copies the contiguous CPU storage while the lambda keeps
        // the tensor alive; memoryview retains the existing .tobytes() transfer
        // contract used by DebugSessionManager.
        return `((lambda _imview_tensor: __import__('builtins').memoryview(` +
            `__import__('ctypes').string_at(_imview_tensor.data_ptr(), ` +
            `_imview_tensor.numel() * _imview_tensor.element_size())))(` +
            `${tensorExpression}))`;
    }

    return `__import__('numpy').ascontiguousarray(${expression})`;
}

/** Read bytes from either DAP memory or debugpy and normalize them for the webview. */
export async function readImageDataForDisplay(
    session: DebugSessionManager,
    metadata: ImageMetadata
): Promise<DisplayImageData | undefined> {
    const displayMetadata: ImageMetadata = {
        ...metadata,
        rawProperties: metadata.rawProperties ? { ...metadata.rawProperties } : undefined,
    };

    let data: Uint8Array | undefined;
    if (metadata.debuggerType === 'debugpy') {
        data = await session.readPythonArrayData(getPythonDataExpression(metadata), false);
    } else {
        data = await session.readMemoryChunked(metadata.dataAddress, metadata.dataSize);
    }

    if (!data) {
        return undefined;
    }

    if (metadata.debuggerType === 'debugpy') {
        const expectedTransferSize = metadata.width * metadata.height *
            metadata.channels * PixelDepthSize[metadata.depth];
        if (!Number.isSafeInteger(expectedTransferSize) ||
            expectedTransferSize <= 0 ||
            data.length !== expectedTransferSize) {
            console.error(
                `[ImView] Python pixel buffer size mismatch for ${metadata.expression}: ` +
                `expected ${expectedTransferSize}, got ${data.length}`
            );
            return undefined;
        }
    }

    if (metadata.dataLayout === 'CHW' && metadata.channels > 1) {
        data = chwToHwc(
            data,
            metadata.channels,
            metadata.height,
            metadata.width,
            PixelDepthSize[metadata.depth]
        );
        displayMetadata.dataLayout = 'HWC';
        displayMetadata.stride = metadata.width * metadata.channels * PixelDepthSize[metadata.depth];
        displayMetadata.dataSize = calculateDataSize(displayMetadata);
    }

    const expectedSize = calculateDataSize(displayMetadata);
    if (!Number.isSafeInteger(expectedSize) || expectedSize <= 0 || data.length < expectedSize) {
        console.error(
            `[ImView] Pixel buffer is truncated for ${metadata.expression}: expected ${expectedSize}, got ${data.length}`
        );
        return undefined;
    }
    if (data.length > expectedSize) {
        data = data.slice(0, expectedSize);
    }

    return { data, metadata: displayMetadata };
}

/** Return materialized operator pixels or read the item's current debuggee buffer. */
export async function readImageItemDataForDisplay(
    session: DebugSessionManager,
    item: ImageItem
): Promise<DisplayImageData | undefined> {
    if (!session.isPaused) {
        return undefined;
    }
    if (item.imageData) {
        return {
            metadata: item.imageData.metadata,
            data: item.imageData.data,
        };
    }
    return item.metadata ? readImageDataForDisplay(session, item.metadata) : undefined;
}
