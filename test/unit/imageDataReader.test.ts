import * as assert from 'assert';
import { DebugSessionManager } from '../../src/core/debugSessionManager';
import {
    getPythonDataExpression,
    readImageDataForDisplay,
    readImageItemDataForDisplay,
} from '../../src/core/imageDataReader';
import { ImageItem, ImageMetadata, ImageTypeName, PixelDepth, ChannelFormat } from '../../src/types';
import { calculateDataSize } from '../../src/utils/imageTransform';

function metadata(overrides: Partial<ImageMetadata> = {}): ImageMetadata {
    return {
        id: 'test',
        name: 'image',
        expression: 'image',
        typeName: ImageTypeName.NUMPY_NDARRAY,
        depth: PixelDepth.CV_8U,
        channels: 1,
        width: 2,
        height: 2,
        stride: 2,
        dataAddress: 'image',
        dataSize: 4,
        debuggerType: 'debugpy',
        ...overrides,
    };
}

describe('Image data preparation', () => {
    it('calculates the exact cv::Mat ROI byte range', () => {
        const roi = metadata({ width: 2, height: 3, channels: 3, stride: 8 });
        assert.strictEqual(calculateDataSize(roi), 22);
    });

    it('builds dependency-free Pillow conversion expressions', () => {
        const image = metadata({
            expression: 'palette_image',
            typeName: ImageTypeName.PIL_IMAGE,
            rawProperties: { pilConversionMode: 'RGBA' },
        });
        const expression = getPythonDataExpression(image);
        assert.strictEqual(expression, "(palette_image).convert('RGBA')");
        assert.ok(!expression.includes('numpy'));
    });

    it('reads detached torch storage without using the NumPy ABI', () => {
        const tensor = metadata({
            expression: 'tensor[0]',
            typeName: ImageTypeName.TORCH_TENSOR,
            rawProperties: { torchConversionDtype: 'int32' },
        });
        const expression = getPythonDataExpression(tensor);

        assert.ok(expression.includes("(tensor[0]).detach().cpu().to(dtype=__import__('torch').int32).contiguous()"));
        assert.ok(expression.includes("__import__('ctypes').string_at"));
        assert.ok(expression.includes("__import__('builtins').memoryview"));
        assert.ok(!expression.includes('.numpy()'));
    });

    it('converts CHW bytes without mutating reusable metadata', async () => {
        const tensor = metadata({
            expression: 'tensor',
            typeName: ImageTypeName.TORCH_TENSOR,
            channels: 3,
            width: 2,
            height: 1,
            stride: 2,
            dataSize: 6,
            dataLayout: 'CHW',
            channelFormat: ChannelFormat.RGB,
        });
        const fakeSession = {
            readPythonArrayData: async () => Uint8Array.from([10, 20, 30, 40, 50, 60]),
        } as unknown as DebugSessionManager;

        const first = await readImageDataForDisplay(fakeSession, tensor);
        const second = await readImageDataForDisplay(fakeSession, tensor);

        assert.deepStrictEqual(Array.from(first?.data ?? []), [10, 30, 50, 20, 40, 60]);
        assert.deepStrictEqual(Array.from(second?.data ?? []), [10, 30, 50, 20, 40, 60]);
        assert.strictEqual(first?.metadata.dataLayout, 'HWC');
        assert.strictEqual(tensor.dataLayout, 'CHW');
    });

    it('rejects Python buffers whose packed size does not match metadata', async () => {
        const fakeSession = {
            readPythonArrayData: async () => Uint8Array.from([1, 2, 3, 4, 5]),
        } as unknown as DebugSessionManager;

        const result = await readImageDataForDisplay(fakeSession, metadata());
        assert.strictEqual(result, undefined);
    });

    it('does not redisplay a materialized operator snapshot while the debugger is running', async () => {
        const imageMetadata = metadata();
        const item: ImageItem = {
            id: 'derived',
            label: 'derived',
            description: '',
            tooltip: '',
            expression: '@abs(image)',
            isWatch: true,
            metadata: imageMetadata,
            imageData: {
                metadata: imageMetadata,
                data: Uint8Array.from([1, 2, 3, 4]),
                timestamp: 1,
            },
        };
        const runningSession = { isPaused: false } as DebugSessionManager;

        assert.strictEqual(await readImageItemDataForDisplay(runningSession, item), undefined);
    });
});
