import * as assert from 'assert';
import {
    decodeEncodedImage,
    sanitizeExportBaseName,
    WebviewImageExporter,
} from '../../src/core/imageExporter';
import { RequestImageExportMessage } from '../../src/types/messages';

const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_BYTES = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);

function toBase64(data: Uint8Array): string {
    return Buffer.from(data).toString('base64');
}

describe('Image exporter', () => {
    describe('sanitizeExportBaseName', () => {
        it('preserves Unicode while replacing cross-platform filename characters', () => {
            assert.strictEqual(sanitizeExportBaseName('帧:01/左* '), '帧_01_左_');
        });

        it('uses a safe fallback for an empty name', () => {
            assert.strictEqual(sanitizeExportBaseName('...'), 'image');
        });

        it('avoids Windows reserved device names', () => {
            assert.strictEqual(sanitizeExportBaseName('CON'), '_CON');
            assert.strictEqual(sanitizeExportBaseName('lpt1.frame'), '_lpt1.frame');
            assert.strictEqual(sanitizeExportBaseName('CON .frame'), '_CON .frame');
        });

        it('stays within common UTF-8 and UTF-16 filename component limits', () => {
            const sanitized = sanitizeExportBaseName('🖼️'.repeat(200));
            assert.ok(Buffer.byteLength(sanitized, 'utf8') <= 240);
            assert.ok(sanitized.length <= 240);
        });
    });

    describe('decodeEncodedImage', () => {
        it('accepts PNG and complete JPEG signatures', () => {
            assert.deepStrictEqual(
                Array.from(decodeEncodedImage(toBase64(PNG_BYTES), 'png')),
                Array.from(PNG_BYTES)
            );
            assert.deepStrictEqual(
                Array.from(decodeEncodedImage(toBase64(JPEG_BYTES), 'jpg')),
                Array.from(JPEG_BYTES)
            );
        });

        it('rejects malformed, mismatched, and oversized data', () => {
            assert.throws(() => decodeEncodedImage('not base64', 'png'), /invalid base64/);
            assert.throws(() => decodeEncodedImage(toBase64(JPEG_BYTES), 'png'), /PNG signature/);
            assert.throws(() => decodeEncodedImage(toBase64(PNG_BYTES), 'png', 4), /export limit/);
        });
    });

    it('matches an asynchronous webview response to its request', async () => {
        const exporter = new WebviewImageExporter();
        let request: RequestImageExportMessage | undefined;
        const resultPromise = exporter.request(
            async message => {
                request = message;
                return true;
            },
            'image-id',
            'png',
            0.92,
            1024,
            1000
        );

        await Promise.resolve();
        assert.ok(request);
        assert.strictEqual(request.imageId, 'image-id');
        assert.strictEqual(request.jpegQuality, 0.92);
        assert.strictEqual(exporter.handleResponse({
            command: 'exportImageData',
            requestId: request.requestId,
            format: 'png',
            data: toBase64(PNG_BYTES),
        }), true);
        assert.deepStrictEqual(Array.from(await resultPromise), Array.from(PNG_BYTES));
        exporter.dispose();
    });

    it('rejects a request that cannot be delivered', async () => {
        const exporter = new WebviewImageExporter();
        let request: RequestImageExportMessage | undefined;
        await assert.rejects(
            exporter.request(async message => {
                request = message;
                return false;
            }, 'image-id', 'jpg', 2, 1024, 1000),
            /not available/
        );
        assert.strictEqual(request?.jpegQuality, 1);
        exporter.dispose();
    });

    it('rejects a response whose format does not match the request', async () => {
        const exporter = new WebviewImageExporter();
        let request: RequestImageExportMessage | undefined;
        const resultPromise = exporter.request(
            async message => {
                request = message;
                return true;
            },
            'image-id',
            'png',
            Number.NaN,
            1024,
            1000
        );

        await Promise.resolve();
        assert.ok(request);
        assert.strictEqual(request.jpegQuality, 0.92);
        exporter.handleResponse({
            command: 'exportImageData',
            requestId: request.requestId,
            format: 'jpg',
            data: toBase64(JPEG_BYTES),
        });
        await assert.rejects(resultPromise, /mismatched/);
        exporter.dispose();
    });

    it('cancels pending webview requests immediately', async () => {
        const exporter = new WebviewImageExporter();
        const resultPromise = exporter.request(
            async () => true,
            'image-id',
            'png',
            0.92,
            1024,
            1000
        );

        await Promise.resolve();
        exporter.cancelPending(new Error('Panel closed'));
        await assert.rejects(resultPromise, /Panel closed/);
        exporter.dispose();
    });
});
