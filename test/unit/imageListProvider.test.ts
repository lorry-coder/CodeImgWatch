import * as assert from 'assert';
import * as vscode from 'vscode';
import { ImageListProvider, ImageTreeItem } from '../../src/providers/imageListProvider';
import { ImageItem } from '../../src/types';

type Availability = NonNullable<ImageItem['availability']>;

interface PlaceholderInternals {
    watchExpressions: string[];
    createWatchPlaceholders(availability: Availability): ImageItem[];
}

interface RefreshInternals {
    sessionManager: {
        activeSession: object | undefined;
        isPaused: boolean;
    };
    stateEpoch: number;
    refreshInFlight?: Promise<void>;
    refreshQueued: boolean;
    performRefresh(): Promise<void>;
    refresh(): Promise<void>;
}

interface ReuseInternals {
    watchExpressions: string[];
    isRefreshCurrent(generation: number): boolean;
    resolveImageItem(expression: string, isWatch: boolean): Promise<ImageItem>;
    evaluateWatchExpressions(
        expressions: readonly string[],
        localImages: readonly ImageItem[],
        resolvedOnDemand: ReadonlyMap<string, ImageItem>,
        epoch: number
    ): Promise<ImageItem[]>;
}

interface AddWatchInternals {
    context: {
        workspaceState: {
            update(key: string, value: string[]): Promise<void>;
        };
    };
    sessionManager: {
        activeSession: object | undefined;
        isPaused: boolean;
    };
    localImages: ImageItem[];
    watchExpressions: string[];
    watchImages: ImageItem[];
    stateEpoch: number;
    refreshInFlight?: Promise<void>;
    refreshQueued: boolean;
    watchResolutionInFlight: Map<string, Promise<ImageItem | undefined>>;
    _onDidChangeTreeData: { fire(): void };
    _onDidRefreshImages: { fire(items: readonly ImageItem[]): void };
    resolveImageItem(expression: string, isWatch: boolean): Promise<ImageItem>;
    ensureWatchImage(expression: string): Promise<ImageItem | undefined>;
    showUnavailableState(availability: Availability): void;
    addWatch(expression?: string): Promise<ImageItem | undefined>;
    removeWatch(item: ImageItem | string): Promise<void>;
}

interface FullRefreshInternals extends AddWatchInternals {
    scanLocalVariables(epoch: number): Promise<ImageItem[]>;
    refresh(): Promise<void>;
}

function createPlaceholders(
    expressions: string[],
    availability: Availability
): ImageItem[] {
    const prototype = ImageListProvider.prototype as unknown as PlaceholderInternals;
    const receiver = Object.create(ImageListProvider.prototype) as PlaceholderInternals;
    receiver.watchExpressions = expressions;
    return prototype.createWatchPlaceholders.call(
        receiver,
        availability
    );
}

function getIconId(item: ImageTreeItem): string | undefined {
    return item.iconPath instanceof vscode.ThemeIcon ? item.iconPath.id : undefined;
}

function createResolvedLocal(): ImageItem {
    const metadata = {
        id: 'frame',
        name: 'frame',
        expression: 'frame',
        typeName: 'cv::Mat' as const,
        depth: 0,
        channels: 1,
        width: 1,
        height: 1,
        stride: 1,
        dataAddress: '0x1000',
        dataSize: 1,
    };
    return {
        id: 'local_frame',
        label: 'frame',
        description: '1×1 cv::Mat',
        tooltip: 'frame',
        expression: 'frame',
        isWatch: false,
        metadata,
        imageData: {
            metadata,
            data: new Uint8Array([42]),
            timestamp: 1,
        },
    };
}

function createWatchHarness(): AddWatchInternals {
    const receiver = Object.create(ImageListProvider.prototype) as AddWatchInternals;
    receiver.context = {
        workspaceState: {
            update: async () => undefined,
        },
    };
    receiver.sessionManager = {
        activeSession: { id: 'session' },
        isPaused: true,
    };
    receiver.localImages = [];
    receiver.watchExpressions = ['frame'];
    receiver.watchImages = createPlaceholders(['frame'], 'paused');
    receiver.stateEpoch = 1;
    receiver.refreshQueued = false;
    receiver.watchResolutionInFlight = new Map();
    receiver._onDidChangeTreeData = { fire: () => undefined };
    receiver._onDidRefreshImages = { fire: () => undefined };
    return receiver;
}

describe('Image list provider', () => {
    it('coalesces overlapping refresh requests into one follow-up pass', async () => {
        const receiver = Object.create(ImageListProvider.prototype) as RefreshInternals;
        let releaseFirstPass: (() => void) | undefined;
        const firstPass = new Promise<void>(resolve => {
            releaseFirstPass = resolve;
        });
        let passes = 0;

        receiver.sessionManager = {
            activeSession: {},
            isPaused: true,
        };
        receiver.stateEpoch = 0;
        receiver.refreshQueued = false;
        receiver.performRefresh = async () => {
            passes++;
            if (passes === 1) {
                await firstPass;
            }
        };

        const first = receiver.refresh();
        const overlaps = [receiver.refresh(), receiver.refresh(), receiver.refresh()];
        assert.strictEqual(passes, 1);

        releaseFirstPass?.();
        await Promise.all([first, ...overlaps]);

        assert.strictEqual(passes, 2);
        assert.strictEqual(receiver.refreshInFlight, undefined);
        assert.strictEqual(receiver.refreshQueued, false);
    });

    it('reuses a matching local without resolving the watch expression again', async () => {
        const receiver = Object.create(ImageListProvider.prototype) as ReuseInternals;
        const local = createResolvedLocal();
        let resolveCalls = 0;
        receiver.watchExpressions = ['frame'];
        receiver.isRefreshCurrent = () => true;
        receiver.resolveImageItem = async () => {
            resolveCalls++;
            throw new Error('A matching local must not be evaluated again');
        };

        const [watch] = await receiver.evaluateWatchExpressions(
            ['frame'],
            [local],
            new Map(),
            1
        );

        assert.strictEqual(resolveCalls, 0);
        assert.notStrictEqual(watch, local);
        assert.strictEqual(watch.id, 'watch_frame');
        assert.strictEqual(watch.label, 'frame');
        assert.strictEqual(watch.expression, local.expression);
        assert.strictEqual(watch.isWatch, true);
        assert.strictEqual(watch.metadata, local.metadata);
        assert.strictEqual(watch.imageData, local.imageData);
        assert.strictEqual(local.id, 'local_frame');
        assert.strictEqual(local.isWatch, false);
    });

    it('prefers a successful Local result over a failed on-demand evaluation', async () => {
        const receiver = Object.create(ImageListProvider.prototype) as ReuseInternals;
        const local = createResolvedLocal();
        const failedWatch: ImageItem = {
            id: 'watch_frame',
            label: 'frame',
            description: 'Failed to evaluate',
            tooltip: 'frame',
            expression: 'frame',
            isWatch: true,
            error: 'Failed to evaluate',
        };
        receiver.watchExpressions = ['frame'];
        receiver.isRefreshCurrent = () => true;
        receiver.resolveImageItem = async () => {
            throw new Error('A successful Local result must be preferred');
        };

        const [watch] = await receiver.evaluateWatchExpressions(
            ['frame'],
            [local],
            new Map([['frame', failedWatch]]),
            1
        );

        assert.strictEqual(watch.error, undefined);
        assert.strictEqual(watch.metadata, local.metadata);
        assert.strictEqual(watch.id, 'watch_frame');
        assert.strictEqual(watch.isWatch, true);
    });

    it('reuses a current local when adding the same expression to Watch', async () => {
        const receiver = Object.create(ImageListProvider.prototype) as AddWatchInternals;
        const local = createResolvedLocal();
        let resolveCalls = 0;
        let changeEvents = 0;
        let persisted: string[] | undefined;
        receiver.context = {
            workspaceState: {
                update: async (_key, value) => {
                    persisted = [...value];
                },
            },
        };
        receiver.sessionManager = {
            activeSession: { id: 'session' },
            isPaused: true,
        };
        receiver.localImages = [local];
        receiver.watchExpressions = [];
        receiver.watchImages = [];
        receiver.stateEpoch = 1;
        receiver.refreshQueued = false;
        receiver.watchResolutionInFlight = new Map();
        receiver._onDidChangeTreeData = {
            fire: () => {
                changeEvents++;
            },
        };
        receiver._onDidRefreshImages = { fire: () => undefined };
        receiver.resolveImageItem = async () => {
            resolveCalls++;
            throw new Error('A matching local must not be evaluated again');
        };

        const watch = await receiver.addWatch(' frame ');

        assert.strictEqual(resolveCalls, 0);
        assert.deepStrictEqual(persisted, ['frame']);
        assert.strictEqual(changeEvents, 1);
        assert.strictEqual(receiver.watchImages.length, 1);
        assert.strictEqual(watch, receiver.watchImages[0]);
        assert.notStrictEqual(watch, local);
        assert.strictEqual(watch?.id, 'watch_frame');
        assert.strictEqual(watch?.isWatch, true);
        assert.strictEqual(watch?.metadata, local.metadata);
        assert.strictEqual(watch?.imageData, local.imageData);
    });

    it('resolves a paused placeholder once and replaces it in place', async () => {
        const receiver = createWatchHarness();
        const resolved = {
            ...createResolvedLocal(),
            id: 'watch_frame',
            isWatch: true,
        };
        let resolveCalls = 0;
        receiver.resolveImageItem = async () => {
            resolveCalls++;
            return resolved;
        };

        const result = await receiver.ensureWatchImage('frame');

        assert.strictEqual(resolveCalls, 1);
        assert.strictEqual(result, resolved);
        assert.strictEqual(receiver.watchImages.length, 1);
        assert.strictEqual(receiver.watchImages[0], resolved);
    });

    it('waits for an active refresh without requesting a follow-up scan', async () => {
        const receiver = createWatchHarness();
        let releaseRefresh: (() => void) | undefined;
        receiver.refreshInFlight = new Promise<void>(resolve => {
            releaseRefresh = resolve;
        });
        let resolveCalls = 0;
        receiver.resolveImageItem = async () => {
            resolveCalls++;
            throw new Error('The completed refresh result should be reused');
        };

        const pending = receiver.ensureWatchImage('frame');
        const refreshed = {
            ...createResolvedLocal(),
            id: 'watch_frame',
            isWatch: true,
        };
        receiver.watchImages = [refreshed];
        releaseRefresh?.();

        assert.strictEqual(await pending, refreshed);
        assert.strictEqual(resolveCalls, 0);
        assert.strictEqual(receiver.refreshQueued, false);
    });

    it('lets a later full refresh reuse an active on-demand resolution', async () => {
        const receiver = createWatchHarness() as FullRefreshInternals;
        let releaseResolve: ((item: ImageItem) => void) | undefined;
        let resolveCalls = 0;
        receiver.scanLocalVariables = async () => [];
        receiver.resolveImageItem = () => {
            resolveCalls++;
            return new Promise<ImageItem>(resolve => {
                releaseResolve = resolve;
            });
        };

        const view = receiver.ensureWatchImage('frame');
        const epoch = receiver.stateEpoch;
        const fullRefresh = receiver.refresh();
        assert.strictEqual(resolveCalls, 1);

        releaseResolve?.({
            ...createResolvedLocal(),
            id: 'watch_frame',
            isWatch: true,
        });

        const [viewResult] = await Promise.all([view, fullRefresh]);
        assert.ok(viewResult?.metadata);
        assert.strictEqual(receiver.watchImages[0].metadata, viewResult.metadata);
        assert.strictEqual(resolveCalls, 1);
        assert.strictEqual(receiver.stateEpoch, epoch);
        assert.strictEqual(receiver.refreshInFlight, undefined);
    });

    it('does not restore stale data after continuing during an on-demand resolve', async () => {
        const receiver = createWatchHarness();
        let releaseResolve: ((item: ImageItem) => void) | undefined;
        receiver.resolveImageItem = () => new Promise<ImageItem>(resolve => {
            releaseResolve = resolve;
        });

        const pending = receiver.ensureWatchImage('frame');
        receiver.sessionManager.isPaused = false;
        receiver.showUnavailableState('running');
        releaseResolve?.({
            ...createResolvedLocal(),
            id: 'watch_frame',
            isWatch: true,
        });

        const result = await pending;
        assert.strictEqual(result?.availability, 'running');
        assert.strictEqual(receiver.watchImages[0].availability, 'running');
        assert.strictEqual(receiver.watchImages[0].metadata, undefined);
        assert.strictEqual(receiver.watchImages[0].error, undefined);
    });

    it('does not restore stale data after changing sessions during an on-demand resolve', async () => {
        const receiver = createWatchHarness();
        let releaseResolve: ((item: ImageItem) => void) | undefined;
        receiver.resolveImageItem = () => new Promise<ImageItem>(resolve => {
            releaseResolve = resolve;
        });

        const pending = receiver.ensureWatchImage('frame');
        receiver.sessionManager.activeSession = { id: 'replacement-session' };
        receiver.sessionManager.isPaused = false;
        receiver.showUnavailableState('running');
        releaseResolve?.({
            ...createResolvedLocal(),
            id: 'watch_frame',
            isWatch: true,
        });

        const result = await pending;
        assert.strictEqual(result?.availability, 'running');
        assert.strictEqual(receiver.watchImages[0].availability, 'running');
        assert.strictEqual(receiver.watchImages[0].metadata, undefined);
        assert.strictEqual(receiver.watchImages[0].error, undefined);
    });

    it('does not resurrect a Watch removed during an on-demand resolve', async () => {
        const receiver = createWatchHarness();
        let releaseResolve: ((item: ImageItem) => void) | undefined;
        receiver.resolveImageItem = () => new Promise<ImageItem>(resolve => {
            releaseResolve = resolve;
        });

        const pending = receiver.ensureWatchImage('frame');
        await receiver.removeWatch('frame');
        releaseResolve?.({
            ...createResolvedLocal(),
            id: 'watch_frame',
            isWatch: true,
        });

        assert.strictEqual(await pending, undefined);
        assert.deepStrictEqual(receiver.watchExpressions, []);
        assert.deepStrictEqual(receiver.watchImages, []);
    });

    it('represents persisted watches as static, actionable debugger states', () => {
        const inactive = createPlaceholders(['frame'], 'inactive')[0];
        const running = createPlaceholders(['frame'], 'running')[0];
        const paused = createPlaceholders(['frame'], 'paused')[0];

        assert.strictEqual(inactive.description, 'Not debugging');
        assert.match(inactive.tooltip, /Start a supported debug session/);
        assert.strictEqual(running.description, 'Running — pause to inspect');
        assert.match(running.tooltip, /Pause the debugger/);
        assert.strictEqual(paused.description, 'Paused — refresh to inspect');
        assert.match(paused.tooltip, /Refresh the image list/);

        assert.strictEqual(getIconId(new ImageTreeItem(inactive)), 'debug-disconnect');
        assert.strictEqual(getIconId(new ImageTreeItem(running)), 'debug-continue');
        assert.strictEqual(getIconId(new ImageTreeItem(paused)), 'debug-pause');
        assert.strictEqual(new ImageTreeItem(inactive).contextValue, 'watchItemUnavailable');
        assert.strictEqual(new ImageTreeItem(inactive).command, undefined);
        assert.strictEqual(new ImageTreeItem(running).command, undefined);
        assert.strictEqual(new ImageTreeItem(paused).command, undefined);
    });

    it('never implies background activity for an unresolved tree item', () => {
        const unresolved: ImageItem = {
            id: 'watch_frame',
            label: 'frame',
            description: 'Unavailable',
            tooltip: 'frame',
            expression: 'frame',
            isWatch: true,
        };

        const treeItem = new ImageTreeItem(unresolved);
        assert.strictEqual(getIconId(treeItem), 'circle-outline');
        assert.ok(!getIconId(treeItem)?.includes('spin'));
        assert.strictEqual(treeItem.command, undefined);
    });

    it('keeps resolved and failed items interactive', () => {
        const resolved: ImageItem = {
            ...createResolvedLocal(),
            id: 'watch_frame',
            isWatch: true,
        };
        const failed: ImageItem = {
            ...resolved,
            metadata: undefined,
            imageData: undefined,
            error: 'Unsupported image type',
        };

        assert.strictEqual(getIconId(new ImageTreeItem(resolved)), 'file-media');
        assert.strictEqual(new ImageTreeItem(resolved).contextValue, 'watchItem');
        assert.strictEqual(new ImageTreeItem(resolved).command?.command, 'imview.selectImage');
        assert.strictEqual(getIconId(new ImageTreeItem(failed)), 'warning');
        assert.strictEqual(new ImageTreeItem(failed).contextValue, 'watchItemUnavailable');
        assert.strictEqual(new ImageTreeItem(failed).command?.command, 'imview.selectImage');
    });
});
