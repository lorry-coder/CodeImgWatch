import * as assert from 'assert';
import {
    createImageExportFileName,
    decodeEncodedImage,
    exportTargetNeedsConfirmation,
    inferImageExportFormat,
    resolveImageExportTarget,
    sanitizeExportBaseName,
    WebviewImageExporter,
} from '../../src/core/imageExporter';
import * as vscode from 'vscode';
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

    describe('export target selection', () => {
        it('infers PNG, JPEG, and raw formats case-insensitively', () => {
            assert.strictEqual(inferImageExportFormat('/tmp/frame.PNG'), 'png');
            assert.strictEqual(inferImageExportFormat('C:\\images\\frame.JPEG'), 'jpg');
            assert.strictEqual(inferImageExportFormat('/tmp/frame.bin'), 'bin');
            assert.strictEqual(inferImageExportFormat('/tmp/frame.webp'), undefined);
        });

        it('does not duplicate an existing supported extension in suggestions', () => {
            assert.strictEqual(createImageExportFileName('frame.png', 'png'), 'frame.png');
            assert.strictEqual(createImageExportFileName('frame.jpeg', 'jpg'), 'frame.jpg');
            assert.strictEqual(createImageExportFileName('frame.bin', 'png'), 'frame.png');
        });

        it('keeps the explicitly selected format authoritative', () => {
            const target = resolveImageExportTarget(vscode.Uri.file('/tmp/frame.jpeg'), 'png');
            assert.strictEqual(target?.format, 'png');
            assert.strictEqual(target?.uri.fsPath, vscode.Uri.file('/tmp/frame.png').fsPath);
        });

        it('adds the selected extension when the platform omits it', () => {
            const target = resolveImageExportTarget(vscode.Uri.file('/tmp/frame'), 'bin');
            assert.strictEqual(target?.format, 'bin');
            assert.strictEqual(target?.uri.fsPath, vscode.Uri.file('/tmp/frame.bin').fsPath);
        });

        it('replaces unsupported suffixes but preserves an equivalent JPEG suffix', () => {
            const rawTarget = resolveImageExportTarget(vscode.Uri.file('/tmp/frame.webp'), 'bin');
            const jpegTarget = resolveImageExportTarget(vscode.Uri.file('/tmp/frame.jpeg'), 'jpg');
            assert.strictEqual(rawTarget?.uri.fsPath, vscode.Uri.file('/tmp/frame.bin').fsPath);
            assert.strictEqual(jpegTarget?.uri.fsPath, vscode.Uri.file('/tmp/frame.jpeg').fsPath);
        });

        it('preserves cancellation without creating an export target', () => {
            assert.strictEqual(resolveImageExportTarget(undefined, 'png'), undefined);
        });

        it('requires native overwrite confirmation when suffix normalization changes the URI', () => {
            const selected = vscode.Uri.file('/tmp/frame.jpg');
            const normalized = resolveImageExportTarget(selected, 'png');
            assert.ok(normalized);
            assert.strictEqual(exportTargetNeedsConfirmation(selected, normalized), true);

            const confirmed = vscode.Uri.file('/tmp/frame.png');
            const unchanged = resolveImageExportTarget(confirmed, 'png');
            assert.ok(unchanged);
            assert.strictEqual(exportTargetNeedsConfirmation(confirmed, unchanged), false);
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
