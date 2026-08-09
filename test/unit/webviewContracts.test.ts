/// <reference lib="dom" />

import * as assert from 'assert';
import { normalizeViewState } from '../../webview/canvas/zoomController';
import { createDisplayImageMessage } from '../../src/types/messages';
import { ImageMetadata, ImageTypeName, PixelDepth } from '../../src/types';

describe('Webview contracts', () => {
    it('carries the preserve-view flag in display messages', () => {
        const metadata: ImageMetadata = {
            id: 'image-id',
            name: 'image',
            expression: 'image',
            typeName: ImageTypeName.CV_MAT,
            depth: PixelDepth.CV_8U,
            channels: 1,
            width: 2,
            height: 2,
            stride: 2,
            dataAddress: '0x1000',
            dataSize: 4,
        };

        assert.strictEqual(createDisplayImageMessage(metadata, 'AA==').preserveView, false);
        assert.strictEqual(createDisplayImageMessage(metadata, 'AA==', true).preserveView, true);
    });

    it('normalizes untrusted zoom and pan values', () => {
        const fallback = { zoom: 2, panX: 3, panY: 4 };

        assert.deepStrictEqual(
            normalizeViewState({ zoom: Number.NaN, panX: Infinity, panY: -Infinity }, fallback),
            fallback
        );
        assert.deepStrictEqual(
            normalizeViewState({ zoom: 100, panX: 20_000_000, panY: -20_000_000 }, fallback),
            { zoom: 64, panX: 10_000_000, panY: -10_000_000 }
        );
        assert.deepStrictEqual(
            normalizeViewState({ zoom: 0, panX: 10, panY: -10 }, fallback),
            { zoom: 0.1, panX: 10, panY: -10 }
        );
    });
});
