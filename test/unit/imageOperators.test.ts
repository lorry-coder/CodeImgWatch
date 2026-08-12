import * as assert from 'assert';
import { DebugSessionManager } from '../../src/core/debugSessionManager';
import { ImageExpressionParser, OperatorNode } from '../../src/core/imageExpressionParser';
import { evaluateOperator } from '../../src/core/imageOperators';
import { ChannelFormat, ImageData, PixelDepth } from '../../src/types';

function image(
    values: number[],
    depth: PixelDepth = PixelDepth.CV_8U,
    byteOrder: 'little' | 'big' = 'little'
): ImageData {
    let data: Uint8Array;
    if (depth === PixelDepth.CV_16U) {
        const buffer = new ArrayBuffer(values.length * 2);
        const view = new DataView(buffer);
        values.forEach((value, index) => view.setUint16(index * 2, value, byteOrder === 'little'));
        data = new Uint8Array(buffer);
    } else {
        data = Uint8Array.from(values);
    }
    return {
        metadata: {
            id: 'source',
            name: 'source',
            expression: 'source',
            typeName: 'test',
            depth,
            channels: 1,
            width: values.length,
            height: 1,
            stride: data.length,
            dataAddress: '0x1000',
            dataSize: data.length,
            byteOrder,
        },
        data,
        timestamp: 1,
    };
}

async function run(expression: string, images: Record<string, ImageData>) {
    const parsed = new ImageExpressionParser().parse(expression);
    assert.strictEqual(parsed.success, true, parsed.error);
    assert.strictEqual(parsed.ast?.type, 'operator');
    return evaluateOperator(parsed.ast as OperatorNode, {
        session: {} as DebugSessionManager,
        getImageData: async name => images[name],
    });
}

describe('Image operators', () => {
    it('normalizes integer inputs into packed float32 output', async () => {
        const result = await run('@norm8(source)', { source: image([0, 127, 255]) });
        assert.strictEqual(result.success, true, result.error);
        assert.strictEqual(result.data?.metadata.depth, PixelDepth.CV_32F);
        assert.strictEqual(result.data?.metadata.stride, 12);
        assert.strictEqual(result.data?.data.length, 12);
        const view = new DataView(
            result.data!.data.buffer,
            result.data!.data.byteOffset,
            result.data!.data.byteLength
        );
        assert.ok(Math.abs(view.getFloat32(4, true) - 127 / 255) < 1e-6);
        assert.strictEqual(view.getFloat32(8, true), 1);
    });

    it('honors big-endian multi-byte input', async () => {
        const result = await run('@scale(source, 2)', {
            source: image([0x1234], PixelDepth.CV_16U, 'big'),
        });
        assert.strictEqual(result.success, true, result.error);
        const bytes = result.data?.data;
        assert.deepStrictEqual(Array.from(bytes ?? []), [0x24, 0x68]);
    });

    it('requires an integer band and an ordered clamp range', async () => {
        const source = image([1, 2]);
        assert.match((await run('@band(source, 0.5)', { source })).error ?? '', /integer/i);
        assert.match((await run('@clamp(source, 10, 2)', { source })).error ?? '', /min/i);
    });

    it('rejects differing depths in diff', async () => {
        const result = await run('@diff(first, second)', {
            first: image([1]),
            second: image([1], PixelDepth.CV_16U),
        });
        assert.strictEqual(result.success, false);
        assert.match(result.error ?? '', /pixel depth/i);
    });

    it('rejects differing color channel orders in diff', async () => {
        const first = image([1, 2, 3]);
        const second = image([1, 2, 3]);
        Object.assign(first.metadata, {
            channels: 3,
            width: 1,
            stride: 3,
            channelFormat: ChannelFormat.RGB,
        });
        Object.assign(second.metadata, {
            channels: 3,
            width: 1,
            stride: 3,
            channelFormat: ChannelFormat.BGR,
        });

        const result = await run('@diff(first, second)', { first, second });
        assert.strictEqual(result.success, false);
        assert.match(result.error ?? '', /channel order/i);
    });

    it('flips padded images vertically without reading beyond the final row', async () => {
        const source = image([1, 99, 98, 2]);
        Object.assign(source.metadata, {
            width: 1,
            height: 2,
            stride: 3,
            dataSize: 4,
        });

        const result = await run('@flipv(source)', { source });
        assert.strictEqual(result.success, true, result.error);
        assert.deepStrictEqual(Array.from(result.data?.data ?? []), [2, 0, 0, 1]);
    });
});
