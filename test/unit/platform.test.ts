import * as assert from 'assert';
import {
    parseAddress,
    addAddressOffset,
    formatAddress,
    getPointerSize,
} from '../../src/utils/platform';

describe('Platform Utils', () => {
    describe('getPointerSize', () => {
        it('should treat x64 and arm64 as 64-bit architectures', () => {
            assert.strictEqual(getPointerSize('x64'), 8);
            assert.strictEqual(getPointerSize('arm64'), 8);
        });

        it('should treat ia32 and arm as 32-bit architectures', () => {
            assert.strictEqual(getPointerSize('ia32'), 4);
            assert.strictEqual(getPointerSize('arm'), 4);
        });
    });

    describe('parseAddress', () => {
        it('should parse hex address with 0x prefix', () => {
            const addr = parseAddress('0x12345678');
            assert.strictEqual(addr, BigInt(0x12345678));
        });

        it('should parse hex address with 0X prefix', () => {
            const addr = parseAddress('0X12345678');
            assert.strictEqual(addr, BigInt(0x12345678));
        });

        it('should parse hex address without prefix', () => {
            const addr = parseAddress('12345678');
            assert.strictEqual(addr, BigInt(0x12345678));
        });

        it('should parse 64-bit address', () => {
            const addr = parseAddress('0x7fff12345678');
            assert.strictEqual(addr, BigInt('0x7fff12345678'));
        });
    });

    describe('addAddressOffset', () => {
        it('should add positive offset', () => {
            const result = addAddressOffset('0x1000', 256);
            assert.strictEqual(result, '0x1100');
        });

        it('should handle zero offset', () => {
            const result = addAddressOffset('0x1000', 0);
            assert.strictEqual(result, '0x1000');
        });

        it('should handle large offsets', () => {
            const result = addAddressOffset('0x1000', 0x10000);
            assert.strictEqual(result, '0x11000');
        });
    });

    describe('formatAddress', () => {
        it('should format address with lowercase', () => {
            const result = formatAddress('0xABCD');
            assert.ok(result.startsWith('0x'));
            assert.ok(result.includes('abcd'));
        });

        it('should add 0x prefix if missing', () => {
            const result = formatAddress('1234');
            assert.ok(result.startsWith('0x'));
        });
    });
});
