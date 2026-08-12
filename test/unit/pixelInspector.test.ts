/// <reference lib="dom" />

import * as assert from 'assert';
import { formatIntegerHex } from '../../webview/canvas/pixelInspector';

describe('PixelInspector integer hex formatting', () => {
    it('formats 8-bit values with two hex digits', () => {
        assert.strictEqual(formatIntegerHex(0, 'uint8'), '00');
        assert.strictEqual(formatIntegerHex(255, 'uint8'), 'FF');
        assert.strictEqual(formatIntegerHex(-1, 'int8'), 'FF');
        assert.strictEqual(formatIntegerHex(-128, 'int8'), '80');
        assert.strictEqual(formatIntegerHex(127, 'int8'), '7F');
    });

    it('formats 16-bit values without clamping them to 8 bits', () => {
        assert.strictEqual(formatIntegerHex(1, 'uint16'), '0001');
        assert.strictEqual(formatIntegerHex(0x1234, 'uint16'), '1234');
        assert.strictEqual(formatIntegerHex(0xFFFF, 'uint16'), 'FFFF');
        assert.strictEqual(formatIntegerHex(-1, 'int16'), 'FFFF');
        assert.strictEqual(formatIntegerHex(-32768, 'int16'), '8000');
        assert.strictEqual(formatIntegerHex(32767, 'int16'), '7FFF');
    });

    it('formats 32-bit signed values as eight-digit two\'s complement', () => {
        assert.strictEqual(formatIntegerHex(1, 'int32'), '00000001');
        assert.strictEqual(formatIntegerHex(0x12345678, 'int32'), '12345678');
        assert.strictEqual(formatIntegerHex(-1, 'int32'), 'FFFFFFFF');
        assert.strictEqual(formatIntegerHex(-2147483648, 'int32'), '80000000');
        assert.strictEqual(formatIntegerHex(2147483647, 'int32'), '7FFFFFFF');
    });
});
