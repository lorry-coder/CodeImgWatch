import * as assert from 'assert';
import { DebugSessionManager } from '../../src/core/debugSessionManager';
import {
    getPythonDataExpression,
    readImageDataForDisplay,
} from '../../src/core/imageDataReader';
import { ImageMetadata, ImageTypeName, PixelDepth, ChannelFormat } from '../../src/types';
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

    it('detaches and converts unsupported torch storage dtypes', () => {
        const tensor = metadata({
            expression: 'tensor[0]',
            typeName: ImageTypeName.TORCH_TENSOR,
            rawProperties: { torchConversionDtype: 'int32' },
        });
        assert.strictEqual(
            getPythonDataExpression(tensor),
            "(tensor[0]).detach().cpu().to(dtype=__import__('torch').int32).contiguous().numpy()"
        );
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
});
