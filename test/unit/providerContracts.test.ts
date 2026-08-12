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
import { createUnavailableImageReference } from '../../src/utils/imageItem';

interface ImageEditorInternals {
    itemsMatch(first: ImageItem, second: ImageItem): boolean;
    findReplacement(item: ImageItem, candidates: readonly ImageItem[]): ImageItem | undefined;
}

interface TestEditorPanelState {
    id: string;
    panel: vscode.WebviewPanel;
    primary: ImageItem;
    alternate?: ImageItem;
    active: 'primary' | 'alternate';
    displayedItem?: ImageItem;
    displayedData?: DisplayImageData;
    displayValid: boolean;
    hasDisplayed: boolean;
    invalidated: boolean;
    ready: boolean;
    generation: number;
    displayRequestSequence: number;
    loadingGeneration?: number;
    displayInFlight?: {
        item: ImageItem;
        generation: number;
        promise: Promise<boolean>;
    };
}

interface ImageEditorUpdateInternals {
    panelStates: Map<string, TestEditorPanelState>;
    panelStatesByPanel: Map<vscode.WebviewPanel, TestEditorPanelState>;
    panelExporters: Map<vscode.WebviewPanel, { cancelPending(error: Error): void }>;
    lastOpenedItem?: ImageItem;
    sessionManager: {
        isPaused: boolean;
        readMemoryChunked(address: string, size: number): Promise<Uint8Array | undefined>;
    };
    displayImageInPanel(
        state: TestEditorPanelState,
        item: ImageItem,
        preserveView: boolean
    ): Promise<boolean>;
    deferPanelDisplay(state: TestEditorPanelState, error: Error): void;
    updateItems(items: readonly ImageItem[]): Promise<void>;
}

interface ImageViewerInternals {
    view?: vscode.WebviewView;
    webviewReady: boolean;
    currentImage?: ImageItem;
    displayedImage?: ImageItem;
    displayedData?: DisplayImageData;
    displayInFlight?: { promise: Promise<void> };
    sessionManager: {
        isPaused: boolean;
        readMemoryChunked(address: string, size: number): Promise<Uint8Array | undefined>;
    };
    getItemMetadata(item: ImageItem): ImageMetadata | undefined;
    clearFailedDisplay(error: Error): void;
}

interface DeferredRead {
    readonly promise: Promise<Uint8Array | undefined>;
    resolve(data: Uint8Array | undefined): void;
}

function createDeferredRead(): DeferredRead {
    let resolve!: (data: Uint8Array | undefined) => void;
    const promise = new Promise<Uint8Array | undefined>(accept => {
        resolve = accept;
    });
    return { promise, resolve };
}

function createPanel(visible: boolean, messages: unknown[] = []): vscode.WebviewPanel {
    return {
        visible,
        title: '',
        webview: {
            postMessage: async (message: unknown) => {
                messages.push(message);
                return true;
            },
        },
        dispose: () => undefined,
    } as unknown as vscode.WebviewPanel;
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
    it('drops stale metadata and materialized pixels while preserving refresh identity', () => {
        const item: ImageItem = {
            ...createItem('watch-derived', '@abs(frame)', true),
            metadata: createMetadata('watch-derived'),
            imageData: {
                metadata: createMetadata('watch-derived-data'),
                data: new Uint8Array([1, 2, 3]),
                timestamp: 1,
            },
            thumbnail: 'data:image/png;base64,AA==',
            error: 'stale error',
        };

        const reference = createUnavailableImageReference(item);

        assert.strictEqual(reference.id, item.id);
        assert.strictEqual(reference.expression, item.expression);
        assert.strictEqual(reference.isWatch, item.isWatch);
        assert.strictEqual(reference.availability, 'running');
        assert.strictEqual(reference.metadata, undefined);
        assert.strictEqual(reference.imageData, undefined);
        assert.strictEqual(reference.thumbnail, undefined);
        assert.strictEqual(reference.error, undefined);
    });

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

    it('defers hidden sidebar rendering and releases its previous snapshot', async () => {
        const provider = new ImageViewerProvider(vscode.Uri.file(process.cwd()));
        const internals = provider as unknown as ImageViewerInternals;
        const previous = createItem('previous', 'previous', true);
        const next = {
            ...createItem('next', 'next', true),
            metadata: createMetadata('next'),
        };
        const messages: unknown[] = [];
        internals.view = {
            visible: false,
            webview: {
                postMessage: async (message: unknown) => {
                    messages.push(message);
                    return true;
                },
            },
        } as unknown as vscode.WebviewView;
        internals.webviewReady = true;
        internals.displayedImage = previous;
        internals.displayedData = {
            metadata: createMetadata('previous'),
            data: new Uint8Array([1]),
        };

        try {
            await provider.displayImage(next);
            assert.strictEqual(internals.currentImage, next);
            assert.strictEqual(internals.displayedImage, undefined);
            assert.strictEqual(internals.displayedData, undefined);
            assert.deepStrictEqual(messages, [{ command: 'clearImage' }]);
        } finally {
            provider.dispose();
        }
    });

    it('serializes sidebar reads across duplicate requests, visibility, and recreation', async () => {
        const provider = new ImageViewerProvider(vscode.Uri.file(process.cwd()));
        const internals = provider as unknown as ImageViewerInternals;
        const reads: DeferredRead[] = [];
        let activeReads = 0;
        let maxActiveReads = 0;
        internals.sessionManager = {
            isPaused: true,
            readMemoryChunked: async () => {
                activeReads++;
                maxActiveReads = Math.max(maxActiveReads, activeReads);
                const read = createDeferredRead();
                reads.push(read);
                const data = await read.promise;
                activeReads--;
                return data;
            },
        };

        let visible = true;
        let visibilityListener = (): void => undefined;
        let disposeListener = (): void => undefined;
        const webview = {
            options: {},
            html: '',
            cspSource: 'test-webview',
            asWebviewUri: (uri: vscode.Uri) => uri,
            postMessage: async () => true,
            onDidReceiveMessage: () => ({ dispose: () => undefined }),
        } as unknown as vscode.Webview;
        const view = {
            get visible(): boolean {
                return visible;
            },
            webview,
            onDidDispose: (listener: () => void) => {
                disposeListener = listener;
                return { dispose: () => undefined };
            },
            onDidChangeVisibility: (listener: () => void) => {
                visibilityListener = listener;
                return { dispose: () => undefined };
            },
        } as unknown as vscode.WebviewView;
        provider.resolveWebviewView(view);
        internals.webviewReady = true;

        const item: ImageItem = {
            ...createItem('serial', 'serial', true),
            metadata: createMetadata('serial'),
        };
        internals.displayedImage = createItem('previous', 'previous', true);
        internals.displayedData = {
            metadata: createMetadata('previous'),
            data: new Uint8Array([1]),
        };

        try {
            const first = provider.displayImage(item);
            const duplicate = provider.displayImage(item);
            assert.strictEqual(reads.length, 1);

            visible = false;
            visibilityListener();
            assert.strictEqual(internals.displayedImage, undefined);
            assert.strictEqual(internals.displayedData, undefined);

            visible = true;
            visibilityListener();
            assert.strictEqual(reads.length, 1);
            assert.strictEqual(maxActiveReads, 1);

            reads[0].resolve(new Uint8Array([2]));
            await Promise.all([first, duplicate]);
            await Promise.resolve();
            await Promise.resolve();
            assert.strictEqual(reads.length, 2);
            assert.strictEqual(maxActiveReads, 1);

            reads[1].resolve(new Uint8Array([3]));
            await internals.displayInFlight?.promise;
            assert.strictEqual(internals.displayedImage, item);
            assert.strictEqual(maxActiveReads, 1);

            const nextItem: ImageItem = {
                ...createItem('recreated', 'recreated', true),
                metadata: createMetadata('recreated'),
            };
            const closingRead = provider.displayImage(nextItem);
            assert.strictEqual(reads.length, 3);
            disposeListener();
            provider.resolveWebviewView(view);
            internals.webviewReady = true;
            const recreated = provider.displayImage(nextItem);
            assert.strictEqual(reads.length, 3);

            reads[2].resolve(new Uint8Array([4]));
            await closingRead;
            await Promise.resolve();
            assert.strictEqual(reads.length, 4);
            assert.strictEqual(maxActiveReads, 1);

            reads[3].resolve(new Uint8Array([5]));
            await recreated;
            assert.strictEqual(internals.displayedImage, nextItem);
            assert.strictEqual(maxActiveReads, 1);
        } finally {
            for (const read of reads) {
                read.resolve(undefined);
            }
            provider.dispose();
        }
    });

    it('updates hidden editor panels lazily without reading image pixels', async () => {
        const manager = new ImageEditorManager(vscode.Uri.file(process.cwd()));
        const internals = manager as unknown as ImageEditorUpdateInternals;
        const oldItem: ImageItem = {
            ...createItem('watch-image', 'image', true),
            metadata: createMetadata('old'),
        };
        const replacement: ImageItem = {
            ...createItem('watch-image', 'image', true),
            metadata: createMetadata('new'),
        };
        const messages: unknown[] = [];
        const panel = {
            visible: false,
            webview: {
                postMessage: async (message: unknown) => {
                    messages.push(message);
                    return true;
                },
            },
            dispose: () => undefined,
        } as unknown as vscode.WebviewPanel;
        const state: TestEditorPanelState = {
            id: oldItem.id,
            panel,
            primary: oldItem,
            active: 'primary',
            displayedItem: oldItem,
            displayedData: {
                metadata: oldItem.metadata!,
                data: new Uint8Array([1]),
            },
            displayValid: true,
            hasDisplayed: true,
            invalidated: false,
            ready: true,
            generation: 0,
            displayRequestSequence: 0,
        };
        let displayCalls = 0;
        internals.panelStates = new Map([[state.id, state]]);
        internals.panelExporters = new Map<
            vscode.WebviewPanel,
            { cancelPending(error: Error): void }
        >();
        internals.lastOpenedItem = oldItem;
        internals.displayImageInPanel = async () => {
            displayCalls++;
            return true;
        };

        try {
            await internals.updateItems([replacement]);
            assert.strictEqual(displayCalls, 0);
            assert.strictEqual(state.primary, replacement);
            assert.strictEqual(state.invalidated, true);
            assert.strictEqual(state.displayedItem, undefined);
            assert.strictEqual(state.displayedData, undefined);
            assert.strictEqual(state.displayValid, false);
            assert.deepStrictEqual(messages, [
                { command: 'setLoading', loading: false },
                { command: 'clearImage' },
            ]);
        } finally {
            internals.panelStates.clear();
            manager.dispose();
        }
    });

    it('serializes editor reads across duplicate requests and hide/reveal', async () => {
        const manager = new ImageEditorManager(vscode.Uri.file(process.cwd()));
        const internals = manager as unknown as ImageEditorUpdateInternals;
        const reads: DeferredRead[] = [];
        let activeReads = 0;
        let maxActiveReads = 0;
        internals.sessionManager = {
            isPaused: true,
            readMemoryChunked: async () => {
                activeReads++;
                maxActiveReads = Math.max(maxActiveReads, activeReads);
                const read = createDeferredRead();
                reads.push(read);
                const data = await read.promise;
                activeReads--;
                return data;
            },
        };

        const item: ImageItem = {
            ...createItem('editor-serial', 'editorSerial', true),
            metadata: createMetadata('editor-serial'),
        };
        const panel = createPanel(true);
        const state: TestEditorPanelState = {
            id: item.id,
            panel,
            primary: item,
            active: 'primary',
            displayedItem: createItem('previous', 'previous', true),
            displayedData: {
                metadata: createMetadata('previous'),
                data: new Uint8Array([1]),
            },
            displayValid: true,
            hasDisplayed: true,
            invalidated: false,
            ready: true,
            generation: 0,
            displayRequestSequence: 0,
        };
        internals.panelStates = new Map([[state.id, state]]);
        internals.panelStatesByPanel = new Map([[panel, state]]);
        internals.panelExporters = new Map();

        try {
            const first = internals.displayImageInPanel(state, item, true);
            const duplicate = internals.displayImageInPanel(state, item, true);
            assert.strictEqual(reads.length, 1);

            (panel as unknown as { visible: boolean }).visible = false;
            internals.deferPanelDisplay(state, new Error('hidden'));
            assert.strictEqual(state.displayedItem, undefined);
            assert.strictEqual(state.displayedData, undefined);

            (panel as unknown as { visible: boolean }).visible = true;
            state.invalidated = false;
            const revealed = internals.displayImageInPanel(state, item, true);
            assert.strictEqual(reads.length, 1);
            assert.strictEqual(maxActiveReads, 1);

            reads[0].resolve(new Uint8Array([2]));
            await Promise.all([first, duplicate]);
            await Promise.resolve();
            assert.strictEqual(reads.length, 2);
            assert.strictEqual(maxActiveReads, 1);

            reads[1].resolve(new Uint8Array([3]));
            assert.strictEqual(await revealed, true);
            assert.strictEqual(state.displayedItem, item);
            assert.strictEqual(maxActiveReads, 1);
        } finally {
            for (const read of reads) {
                read.resolve(undefined);
            }
            internals.panelStates.clear();
            internals.panelStatesByPanel.clear();
            manager.dispose();
        }
    });

    it('rechecks editor visibility before dequeuing each refresh', async () => {
        const manager = new ImageEditorManager(vscode.Uri.file(process.cwd()));
        const internals = manager as unknown as ImageEditorUpdateInternals;
        const firstOld = { ...createItem('first', 'first', true), metadata: createMetadata('first-old') };
        const secondOld = { ...createItem('second', 'second', true), metadata: createMetadata('second-old') };
        const firstNew = { ...createItem('first', 'first', true), metadata: createMetadata('first-new') };
        const secondNew = { ...createItem('second', 'second', true), metadata: createMetadata('second-new') };
        const firstPanel = createPanel(true);
        const secondPanel = createPanel(true);
        const createState = (item: ImageItem, panel: vscode.WebviewPanel): TestEditorPanelState => ({
            id: item.id,
            panel,
            primary: item,
            active: 'primary',
            displayedItem: item,
            displayedData: { metadata: item.metadata!, data: new Uint8Array([1]) },
            displayValid: true,
            hasDisplayed: true,
            invalidated: false,
            ready: true,
            generation: 0,
            displayRequestSequence: 0,
        });
        const firstState = createState(firstOld, firstPanel);
        const secondState = createState(secondOld, secondPanel);
        internals.panelStates = new Map([
            [firstState.id, firstState],
            [secondState.id, secondState],
        ]);
        internals.panelStatesByPanel = new Map([
            [firstPanel, firstState],
            [secondPanel, secondState],
        ]);
        internals.panelExporters = new Map();

        let releaseFirst!: () => void;
        const firstRefresh = new Promise<void>(resolve => {
            releaseFirst = resolve;
        });
        const displayCalls: string[] = [];
        internals.displayImageInPanel = async (state) => {
            displayCalls.push(state.id);
            if (state === firstState) {
                await firstRefresh;
            }
            return true;
        };

        try {
            const update = internals.updateItems([firstNew, secondNew]);
            assert.deepStrictEqual(displayCalls, ['first']);
            (secondPanel as unknown as { visible: boolean }).visible = false;
            releaseFirst();
            await update;

            assert.deepStrictEqual(displayCalls, ['first']);
            assert.strictEqual(secondState.invalidated, true);
            assert.strictEqual(secondState.displayedItem, undefined);
            assert.strictEqual(secondState.displayedData, undefined);
            assert.strictEqual(secondState.displayValid, false);
        } finally {
            releaseFirst();
            internals.panelStates.clear();
            internals.panelStatesByPanel.clear();
            manager.dispose();
        }
    });
});
