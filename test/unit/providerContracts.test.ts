import * as assert from 'assert';
import * as vscode from 'vscode';
import { DisplayImageData } from '../../src/core/imageDataReader';
import { ImageEditorManager } from '../../src/providers/imageEditorProvider';
import { ImageViewerProvider } from '../../src/providers/imageViewerProvider';
import {
    ImageItem,
    ImageMetadata,
    ImageTypeName,
    PixelDepth,
} from '../../src/types';

interface ImageEditorInternals {
    itemsMatch(first: ImageItem, second: ImageItem): boolean;
    findReplacement(item: ImageItem, candidates: readonly ImageItem[]): ImageItem | undefined;
}

interface ImageViewerInternals {
    displayedImage?: ImageItem;
    displayedData?: DisplayImageData;
    getItemMetadata(item: ImageItem): ImageMetadata | undefined;
    clearFailedDisplay(error: Error): void;
}

function createItem(id: string, expression: string, isWatch: boolean): ImageItem {
    return {
        id,
        label: expression,
        description: '',
        tooltip: expression,
        expression,
        isWatch,
    };
}

function createMetadata(id: string): ImageMetadata {
    return {
        id,
        name: id,
        expression: id,
        typeName: ImageTypeName.CV_MAT,
        depth: PixelDepth.CV_8U,
        channels: 1,
        width: 1,
        height: 1,
        stride: 1,
        dataAddress: '0x1000',
        dataSize: 1,
    };
}

describe('Provider contracts', () => {
    it('keeps local and watch items separate when IDs or expressions collide', () => {
        const manager = new ImageEditorManager(vscode.Uri.file(process.cwd()));
        const internals = manager as unknown as ImageEditorInternals;
        const local = createItem('shared-id', 'image', false);
        const watch = createItem('shared-id', 'image', true);
        const refreshedLocal = createItem('new-local-id', 'image', false);

        try {
            assert.strictEqual(internals.itemsMatch(local, watch), false);
            assert.strictEqual(
                internals.findReplacement(local, [watch, refreshedLocal]),
                refreshedLocal
            );
        } finally {
            manager.dispose();
        }
    });

    it('uses materialized metadata and clears failed display snapshots', () => {
        const provider = new ImageViewerProvider(vscode.Uri.file(process.cwd()));
        const internals = provider as unknown as ImageViewerInternals;
        const metadata = createMetadata('derived');
        const item: ImageItem = {
            ...createItem('derived', '@normalize(image)', true),
            imageData: {
                metadata,
                data: new Uint8Array([1]),
                timestamp: 0,
            },
        };

        try {
            assert.strictEqual(internals.getItemMetadata(item), metadata);
            internals.displayedImage = item;
            internals.displayedData = { metadata, data: new Uint8Array([1]) };
            internals.clearFailedDisplay(new Error('read failed'));
            assert.strictEqual(internals.displayedImage, undefined);
            assert.strictEqual(internals.displayedData, undefined);
        } finally {
            provider.dispose();
        }
    });
});
