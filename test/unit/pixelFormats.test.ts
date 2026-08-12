import * as assert from 'assert';
import {
    PixelDepth,
    PixelDepthSize,
    decodeCvType,
    encodeCvType,
    formatCvType,
    getPixelSize,
} from '../../src/types/pixelFormats';

describe('PixelFormats', () => {
    describe('PixelDepthSize', () => {
        it('should return correct size for CV_8U', () => {
            assert.strictEqual(PixelDepthSize[PixelDepth.CV_8U], 1);
        });

        it('should return correct size for CV_16U', () => {
            assert.strictEqual(PixelDepthSize[PixelDepth.CV_16U], 2);
        });

        it('should return correct size for CV_32F', () => {
            assert.strictEqual(PixelDepthSize[PixelDepth.CV_32F], 4);
        });

        it('should return correct size for CV_64F', () => {
            assert.strictEqual(PixelDepthSize[PixelDepth.CV_64F], 8);
        });
    });

    describe('decodeCvType', () => {
        it('should decode CV_8UC1 correctly', () => {
            const type = encodeCvType(PixelDepth.CV_8U, 1);
            const result = decodeCvType(type);
            assert.strictEqual(result.depth, PixelDepth.CV_8U);
            assert.strictEqual(result.channels, 1);
        });

        it('should decode CV_8UC3 correctly', () => {
            const type = encodeCvType(PixelDepth.CV_8U, 3);
            const result = decodeCvType(type);
            assert.strictEqual(result.depth, PixelDepth.CV_8U);
            assert.strictEqual(result.channels, 3);
        });

        it('should decode CV_32FC1 correctly', () => {
            const type = encodeCvType(PixelDepth.CV_32F, 1);
            const result = decodeCvType(type);
            assert.strictEqual(result.depth, PixelDepth.CV_32F);
            assert.strictEqual(result.channels, 1);
        });

        it('should decode CV_64FC4 correctly', () => {
            const type = encodeCvType(PixelDepth.CV_64F, 4);
            const result = decodeCvType(type);
            assert.strictEqual(result.depth, PixelDepth.CV_64F);
            assert.strictEqual(result.channels, 4);
        });

        it('should preserve OpenCV channel counts above 64 for validation', () => {
            assert.strictEqual(decodeCvType(encodeCvType(PixelDepth.CV_8U, 65)).channels, 65);
            assert.strictEqual(decodeCvType(encodeCvType(PixelDepth.CV_8U, 512)).channels, 512);
        });
    });

    describe('encodeCvType', () => {
        it('should encode CV_8UC1 as 0', () => {
            const type = encodeCvType(PixelDepth.CV_8U, 1);
            assert.strictEqual(type, 0);
        });

        it('should encode CV_8UC3 as 16', () => {
            const type = encodeCvType(PixelDepth.CV_8U, 3);
            assert.strictEqual(type, 16);
        });

        it('should encode CV_32FC1 as 5', () => {
            const type = encodeCvType(PixelDepth.CV_32F, 1);
            assert.strictEqual(type, 5);
        });
    });

    describe('formatCvType', () => {
        it('should format CV_8UC1 correctly', () => {
            assert.strictEqual(formatCvType(PixelDepth.CV_8U, 1), 'CV_8UC1');
        });

        it('should format CV_8UC3 correctly', () => {
            assert.strictEqual(formatCvType(PixelDepth.CV_8U, 3), 'CV_8UC3');
        });

        it('should format CV_32FC1 correctly', () => {
            assert.strictEqual(formatCvType(PixelDepth.CV_32F, 1), 'CV_32FC1');
        });
    });

    describe('getPixelSize', () => {
        it('should calculate correct pixel size for single channel', () => {
            assert.strictEqual(getPixelSize(PixelDepth.CV_8U, 1), 1);
            assert.strictEqual(getPixelSize(PixelDepth.CV_32F, 1), 4);
        });

        it('should calculate correct pixel size for multiple channels', () => {
            assert.strictEqual(getPixelSize(PixelDepth.CV_8U, 3), 3);
            assert.strictEqual(getPixelSize(PixelDepth.CV_32F, 3), 12);
        });
    });
});
