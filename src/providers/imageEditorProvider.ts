import * as vscode from 'vscode';
import { DebugSessionManager } from '../core/debugSessionManager';
import {
    DisplayImageData,
    readImageItemDataForDisplay,
} from '../core/imageDataReader';
import {
    formatExportLocation,
    promptForImageExport,
    WebviewImageExporter,
} from '../core/imageExporter';
import { ImageItem, DisplayOptions, DefaultDisplayOptions } from '../types';
import {
    ExtensionToWebviewMessage,
    ImageExportFormat,
    WebviewToExtensionMessage,
    createDisplayImageMessage,
} from '../types/messages';
import { createUnavailableImageReference } from '../utils/imageItem';

type ActiveImageSlot = 'primary' | 'alternate';

type ConfiguredDisplayOptions = Pick<
    DisplayOptions,
    'autoNormalize' | 'colormap' | 'showPixelGrid' | 'pixelGridZoomThreshold'
>;

interface EditorPanelState {
    readonly id: string;
    readonly panel: vscode.WebviewPanel;
    primary: ImageItem;
    alternate?: ImageItem;
    active: ActiveImageSlot;
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

/**
 * Manager for image editor panels (separate tab windows)
 */
export class ImageEditorManager implements vscode.Disposable {
    private disposables: vscode.Disposable[] = [];
    private panelStates: Map<string, EditorPanelState> = new Map();
    private panelStatesByPanel: Map<vscode.WebviewPanel, EditorPanelState> = new Map();
    private panelExporters: Map<vscode.WebviewPanel, WebviewImageExporter> = new Map();
    private sessionManager: DebugSessionManager;
    private displayOptions: DisplayOptions;
    private configuredDisplayOptions: ConfiguredDisplayOptions;
    private lastOpenedItem?: ImageItem;

    // Event for view state changes (for syncing between editors)
    private _onDidChangeViewState = new vscode.EventEmitter<{
        panelId: string;
        state: { zoom: number; panX: number; panY: number };
    }>();
    readonly onDidChangeViewState = this._onDidChangeViewState.event;

    constructor(private readonly extensionUri: vscode.Uri) {
        this.sessionManager = DebugSessionManager.getInstance();
        this.displayOptions = { ...DefaultDisplayOptions };
        this.configuredDisplayOptions = this.readConfiguredDisplayOptions();
        Object.assign(this.displayOptions, this.configuredDisplayOptions);
    }

    private readConfiguredDisplayOptions(): ConfiguredDisplayOptions {
        const config = vscode.workspace.getConfiguration('imview');
        return {
            autoNormalize: config.get('autoNormalize', true),
            colormap: config.get('defaultColormap', 'grayscale'),
            showPixelGrid: config.get('showPixelGrid', true),
            pixelGridZoomThreshold: config.get('pixelGridZoomThreshold', 8),
        };
    }

    /** Reload workspace display settings and update all editor webviews. */
    reloadConfiguration(): void {
        const nextOptions = this.readConfiguredDisplayOptions();
        const changedOptions: Partial<ConfiguredDisplayOptions> = {};
        for (const key of Object.keys(nextOptions) as Array<keyof ConfiguredDisplayOptions>) {
            if (nextOptions[key] !== this.configuredDisplayOptions[key]) {
                Object.assign(changedOptions, { [key]: nextOptions[key] });
            }
        }
        this.configuredDisplayOptions = nextOptions;

        if (Object.keys(changedOptions).length === 0) {
            return;
        }

        Object.assign(this.displayOptions, changedOptions);
        for (const state of this.panelStates.values()) {
            this.postMessage(state.panel, { command: 'updateOptions', options: changedOptions });
        }
    }

    /**
     * Open an image in a new editor tab
     */
    async openInEditor(item: ImageItem): Promise<void> {
        const previousItem = this.lastOpenedItem && !this.itemsMatch(this.lastOpenedItem, item)
            ? this.lastOpenedItem
            : undefined;
        const existingState = this.findPanelStateForPrimary(item);
        if (existingState) {
            const wasInvalidated = existingState.invalidated;
            existingState.primary = item;
            existingState.active = 'primary';
            if (!existingState.alternate && previousItem) {
                existingState.alternate = previousItem;
            }
            this.lastOpenedItem = item;
            existingState.panel.title = `Image: ${item.label}`;
            if (existingState.ready) {
                // Prevent the reveal listener and this explicit open from issuing
                // two reads for the same item.
                existingState.invalidated = false;
            }
            existingState.panel.reveal();
            if (existingState.ready) {
                if (!wasInvalidated && existingState.displayValid &&
                    existingState.displayedItem &&
                    this.itemsMatch(existingState.displayedItem, item)) {
                    return;
                }
                if (wasInvalidated) {
                    this.postMessage(existingState.panel, { command: 'clearImage' });
                }
                await this.displayImageInPanel(existingState, item, true);
            }
            return;
        }

        // Create new panel
        const panel = vscode.window.createWebviewPanel(
            'imview.editor',
            `Image: ${item.label}`,
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [this.extensionUri],
            }
        );

        panel.webview.html = this.getHtmlForWebview(panel.webview, item);

        const state: EditorPanelState = {
            id: item.id,
            panel,
            primary: item,
            alternate: previousItem,
            active: 'primary',
            displayValid: false,
            hasDisplayed: false,
            invalidated: false,
            ready: false,
            generation: 0,
            displayRequestSequence: 0,
        };

        this.panelStates.set(state.id, state);
        this.panelStatesByPanel.set(panel, state);
        this.panelExporters.set(panel, new WebviewImageExporter());
        this.lastOpenedItem = item;

        if (previousItem) {
            const previousState = this.findPanelStateForPrimary(previousItem);
            if (previousState && !previousState.alternate) {
                previousState.alternate = item;
            }
        }

        // Handle panel disposal
        panel.onDidDispose(() => {
            state.generation++;
            state.displayRequestSequence++;
            this.panelStates.delete(state.id);
            this.panelStatesByPanel.delete(panel);
            this.panelExporters.get(panel)?.dispose();
            this.panelExporters.delete(panel);
        });

        panel.onDidChangeViewState(({ webviewPanel }) => {
            if (!webviewPanel.visible) {
                this.deferPanelDisplay(
                    state,
                    new Error('Image editor is waiting to become visible')
                );
                return;
            }
            if (state.ready && state.invalidated) {
                // Hidden webviews may not receive clearImage. Clear once visible
                // so old-frame pixels cannot flash during the lazy debugger read.
                this.postMessage(state.panel, { command: 'clearImage' });
                if (this.getItemMetadata(this.getActiveItem(state))) {
                    state.invalidated = false;
                    void this.displayImageInPanel(state, this.getActiveItem(state), true);
                }
            }
        });

        // Handle messages from webview
        panel.webview.onDidReceiveMessage((message: WebviewToExtensionMessage) => {
            void this.handleWebviewMessage(panel, message);
        });

        // Initial image display happens when webview sends 'ready' message
    }

    /**
     * Handle messages from editor webview
     */
    private async handleWebviewMessage(
        panel: vscode.WebviewPanel,
        message: WebviewToExtensionMessage
    ): Promise<void> {
        const state = this.panelStatesByPanel.get(panel);
        if (!state) {
            return;
        }

        switch (message.command) {
            case 'ready':
                state.ready = true;
                this.postMessage(panel, { command: 'updateOptions', options: this.displayOptions });
                if (panel.visible && this.getItemMetadata(this.getActiveItem(state))) {
                    state.invalidated = false;
                    await this.displayImageInPanel(
                        state,
                        this.getActiveItem(state),
                        state.hasDisplayed
                    );
                } else if (!panel.visible) {
                    state.invalidated = true;
                }
                break;

            case 'viewStateChanged':
                this._onDidChangeViewState.fire({ panelId: state.id, state: message.state });
                break;

            case 'copyPixel':
                await vscode.env.clipboard.writeText(message.value);
                vscode.window.showInformationMessage(`Copied: ${message.value}`);
                break;

            case 'exportImage':
                {
                    const displayedMetadata = state.displayedData?.metadata;
                    const displayedItem = message.imageId && displayedMetadata?.id === message.imageId
                        ? state.displayedItem
                        : !message.imageId && state.displayValid ? state.displayedItem : undefined;
                    if (displayedItem) {
                        await this.exportImage(state, displayedItem, message.format, message.name);
                    } else {
                        vscode.window.showWarningMessage('The displayed image changed; try exporting again');
                    }
                }
                break;

            case 'exportImageData':
                this.panelExporters.get(panel)?.handleResponse(message);
                break;

            case 'refresh':
                await this.displayImageInPanel(state, this.getActiveItem(state), true);
                break;

            case 'toggleCompare':
                await this.toggleABCompare(state);
                break;

            case 'optionsChanged':
                Object.assign(this.displayOptions, message.options);
                // Sync to all panels
                for (const targetState of this.panelStates.values()) {
                    this.postMessage(targetState.panel, {
                        command: 'updateOptions',
                        options: message.options,
                    });
                }
                break;
        }
    }

    /**
     * Display image data in a panel
     */
    private async displayImageInPanel(
        state: EditorPanelState,
        item: ImageItem,
        preserveView: boolean
    ): Promise<boolean> {
        const { panel } = state;
        const inFlight = state.displayInFlight;
        if (inFlight && inFlight.item === item &&
            inFlight.generation === state.generation && !state.invalidated) {
            return inFlight.promise;
        }

        const requestSequence = ++state.displayRequestSequence;
        if (inFlight) {
            if (inFlight.generation === state.generation) {
                state.generation++;
            }
            await inFlight.promise;
            if (this.panelStatesByPanel.get(panel) !== state ||
                state.displayRequestSequence !== requestSequence) {
                return false;
            }
        }

        if (!panel.visible) {
            this.deferPanelDisplay(
                state,
                new Error('Image editor is waiting to become visible')
            );
            return false;
        }

        const generation = ++state.generation;
        const promise = this.displayImageInPanelNow(
            state,
            item,
            generation,
            preserveView
        ).finally(() => {
            if (state.displayInFlight?.promise === promise) {
                state.displayInFlight = undefined;
            }
        });
        state.displayInFlight = { item, generation, promise };
        return promise;
    }

    private async displayImageInPanelNow(
        state: EditorPanelState,
        item: ImageItem,
        generation: number,
        preserveView: boolean
    ): Promise<boolean> {
        const { panel } = state;
        state.loadingGeneration = generation;
        const isCurrent = (): boolean =>
            this.panelStatesByPanel.get(panel) === state && state.generation === generation;

        this.postMessage(panel, { command: 'setLoading', loading: true });
        panel.title = `Image: ${item.label}`;

        try {
            if (!this.getItemMetadata(item)) {
                if (isCurrent()) {
                    this.clearDisplayedSnapshot(state);
                    this.postMessage(panel, {
                        command: 'showError',
                        message: item.error ?? 'No image metadata available',
                    });
                }
                return false;
            }

            const image = await readImageItemDataForDisplay(this.sessionManager, item);
            if (!image) {
                if (isCurrent()) {
                    this.clearDisplayedSnapshot(state);
                    this.postMessage(panel, {
                        command: 'showError',
                        message: 'Failed to read image data from memory',
                    });
                }
                return false;
            }
            if (!isCurrent()) {
                return false;
            }

            const base64 = this.arrayToBase64(image.data);
            const message = createDisplayImageMessage(image.metadata, base64, preserveView);
            const delivered = await this.postMessage(panel, message);
            if (delivered && isCurrent()) {
                state.displayedItem = item;
                state.displayedData = image;
                state.displayValid = true;
                state.hasDisplayed = true;
                state.invalidated = false;
                return true;
            }
            if (isCurrent()) {
                this.clearDisplayedSnapshot(state);
                state.invalidated = true;
            }
        } catch (error) {
            if (isCurrent()) {
                this.clearDisplayedSnapshot(state);
                this.postMessage(panel, {
                    command: 'showError',
                    message: `Error loading image: ${error}`,
                });
            }
        } finally {
            if (isCurrent()) {
                state.loadingGeneration = undefined;
                this.postMessage(panel, { command: 'setLoading', loading: false });
            }
        }
        return false;
    }

    /**
     * Toggle A/B comparison (switch to previous image)
     */
    private async toggleABCompare(state: EditorPanelState): Promise<void> {
        if (state.active === 'primary' &&
            (!state.alternate || !this.getItemMetadata(state.alternate))) {
            vscode.window.showInformationMessage('No previous image for comparison');
            return;
        }

        state.active = state.active === 'primary' ? 'alternate' : 'primary';
        await this.displayImageInPanel(state, this.getActiveItem(state), true);
    }

    /**
     * Export image to file
     */
    private async exportImage(
        state: EditorPanelState,
        item: ImageItem,
        requestedFormat?: ImageExportFormat,
        suggestedName?: string
    ): Promise<void> {
        const meta = this.getItemMetadata(item);
        if (!meta) {
            vscode.window.showErrorMessage('No image metadata');
            return;
        }

        const target = await promptForImageExport(suggestedName ?? meta.name, requestedFormat);
        if (!target) {
            return;
        }

        try {
            const snapshot = await this.ensureItemDisplayed(state, item);
            if (!snapshot) {
                throw new Error('Failed to display the requested image for export');
            }

            let data: Uint8Array;
            if (target.format === 'bin') {
                data = snapshot.data;
            } else {
                const encodedFormat = target.format;
                const exporter = this.panelExporters.get(state.panel);
                if (!exporter) {
                    throw new Error('Image editor was closed');
                }
                const quality = vscode.workspace.getConfiguration('imview').get('jpegQuality', 0.92);
                data = await vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: `Encoding ${encodedFormat === 'png' ? 'PNG' : 'JPEG'} image`,
                        cancellable: false,
                    },
                    () => exporter.request(
                        message => state.panel.webview.postMessage(message),
                        snapshot.metadata.id,
                        encodedFormat,
                        quality
                    )
                );
            }

            await vscode.workspace.fs.writeFile(target.uri, data);
            vscode.window.showInformationMessage(`Image exported to ${formatExportLocation(target.uri)}`);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to export: ${error}`);
        }
    }

    /**
     * Sync view state to all other panels
     */
    syncViewState(excludePanelId: string, state: { zoom: number; panX: number; panY: number }): void {
        for (const targetState of this.panelStates.values()) {
            if (targetState.id !== excludePanelId) {
                this.postMessage(targetState.panel, { command: 'syncView', state });
            }
        }
    }

    /**
     * Refresh all panels
     */
    async refreshAll(): Promise<void> {
        for (const state of this.panelStates.values()) {
            if (state.ready && state.panel.visible) {
                await this.displayImageInPanel(state, this.getActiveItem(state), true);
            }
        }
    }

    /** Replace panel item references after a debugger refresh and redraw active images. */
    async updateItems(items: readonly ImageItem[]): Promise<void> {
        const refreshes: Array<{ state: EditorPanelState; item: ImageItem }> = [];

        for (const state of this.panelStates.values()) {
            const primaryReplacement = this.findReplacement(state.primary, items);
            const alternateReplacement = state.alternate
                ? this.findReplacement(state.alternate, items)
                : undefined;

            if (primaryReplacement) {
                state.primary = primaryReplacement;
            }
            if (alternateReplacement) {
                state.alternate = alternateReplacement;
            }

            const activeReplacement = state.active === 'primary'
                ? primaryReplacement
                : alternateReplacement;
            if (activeReplacement) {
                if (state.ready && state.panel.visible) {
                    state.invalidated = false;
                    refreshes.push({ state, item: activeReplacement });
                } else {
                    // Hidden panels retain only lightweight item references and
                    // render lazily when revealed.
                    this.deferPanelDisplay(
                        state,
                        new Error('Image editor is waiting to become visible')
                    );
                }
            }
        }

        if (this.lastOpenedItem) {
            this.lastOpenedItem = this.findReplacement(this.lastOpenedItem, items)
                ?? this.lastOpenedItem;
        }

        for (const refresh of refreshes) {
            if (this.panelStatesByPanel.get(refresh.state.panel) !== refresh.state) {
                continue;
            }
            if (!refresh.state.ready || !refresh.state.panel.visible) {
                this.deferPanelDisplay(
                    refresh.state,
                    new Error('Image editor became hidden before it could refresh')
                );
                continue;
            }
            await this.displayImageInPanel(refresh.state, refresh.item, true);
        }
    }

    /** Clear stale canvases while keeping panel and A/B state for the next debugger stop. */
    invalidateDisplays(): void {
        for (const state of this.panelStates.values()) {
            state.generation++;
            state.displayRequestSequence++;
            state.loadingGeneration = undefined;
            state.invalidated = true;
            this.clearDisplayedSnapshot(state);
            state.primary = createUnavailableImageReference(state.primary);
            if (state.alternate) {
                state.alternate = createUnavailableImageReference(state.alternate);
            }
            this.panelExporters.get(state.panel)?.cancelPending(
                new Error('Image display was invalidated because the debugger resumed')
            );
            this.postMessage(state.panel, { command: 'setLoading', loading: false });
            this.postMessage(state.panel, { command: 'clearImage' });
        }
        if (this.lastOpenedItem) {
            this.lastOpenedItem = createUnavailableImageReference(this.lastOpenedItem);
        }
    }

    /**
     * Close all panels
     */
    closeAll(): void {
        for (const state of [...this.panelStates.values()]) {
            state.panel.dispose();
        }
        this.panelStates.clear();
        this.panelStatesByPanel.clear();
        for (const exporter of this.panelExporters.values()) {
            exporter.dispose();
        }
        this.panelExporters.clear();
        this.lastOpenedItem = undefined;
    }

    private async ensureItemDisplayed(
        state: EditorPanelState,
        item: ImageItem
    ): Promise<DisplayImageData | undefined> {
        const metadata = this.getItemMetadata(item);
        if (!metadata) {
            return undefined;
        }

        if (state.displayValid &&
            state.displayedData?.metadata.id === metadata.id &&
            state.displayedItem && this.itemsMatch(state.displayedItem, item)) {
            return state.displayedData;
        }

        const displayed = await this.displayImageInPanel(state, item, true);
        return displayed ? state.displayedData : undefined;
    }

    private getActiveItem(state: EditorPanelState): ImageItem {
        return state.active === 'alternate' && state.alternate
            ? state.alternate
            : state.primary;
    }

    private clearDisplayedSnapshot(state: EditorPanelState): void {
        state.displayedItem = undefined;
        state.displayedData = undefined;
        state.displayValid = false;
    }

    private deferPanelDisplay(state: EditorPanelState, error: Error): void {
        state.generation++;
        state.displayRequestSequence++;
        state.loadingGeneration = undefined;
        state.invalidated = true;
        this.clearDisplayedSnapshot(state);
        this.panelExporters.get(state.panel)?.cancelPending(error);
        this.postMessage(state.panel, { command: 'setLoading', loading: false });
        this.postMessage(state.panel, { command: 'clearImage' });
    }

    private getItemMetadata(item: ImageItem): ImageItem['metadata'] {
        return item.imageData?.metadata ?? item.metadata;
    }

    private itemsMatch(first: ImageItem, second: ImageItem): boolean {
        return first.isWatch === second.isWatch &&
            (first.id === second.id || first.expression === second.expression);
    }

    private findReplacement(
        item: ImageItem,
        candidates: readonly ImageItem[]
    ): ImageItem | undefined {
        return candidates.find(candidate =>
            candidate.isWatch === item.isWatch && candidate.id === item.id
        ) ?? candidates.find(candidate =>
            candidate.isWatch === item.isWatch && candidate.expression === item.expression
        );
    }

    private findPanelStateForPrimary(item: ImageItem): EditorPanelState | undefined {
        return [...this.panelStates.values()].find(state => this.itemsMatch(state.primary, item));
    }

    /** Update a panel's primary item while retaining its independent comparison state. */
    setItemForPanel(id: string, item: ImageItem): void {
        const state = this.panelStates.get(id);
        if (state) {
            state.primary = item;
        }
    }

    private postMessage(panel: vscode.WebviewPanel, message: ExtensionToWebviewMessage): Thenable<boolean> {
        return panel.webview.postMessage(message);
    }

    private arrayToBase64(data: Uint8Array): string {
        return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64');
    }

    private getHtmlForWebview(webview: vscode.Webview, item: ImageItem): string {
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'viewer.js')
        );

        const styleUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'webview', 'styles', 'viewer.css')
        );

        const nonce = getNonce();
        const escapedLabel = escapeHtml(item.label);

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:;">
    <link href="${styleUri}" rel="stylesheet">
    <title>Image: ${escapedLabel}</title>
</head>
<body>
    <div id="app" class="editor-mode">
        <div id="toolbar">
            <div class="toolbar-group">
                <button id="btn-fit" title="Fit to Window">Fit</button>
                <button id="btn-actual" title="Actual Size (100%)">1:1</button>
                <span id="zoom-level">100%</span>
            </div>
            <div class="toolbar-group">
                <select id="channel-select" title="Channel View">
                    <option value="0">All Channels</option>
                    <option value="1">Red</option>
                    <option value="2">Green</option>
                    <option value="3">Blue</option>
                    <option value="4">Alpha</option>
                </select>
                <select id="colormap-select" title="Colormap">
                    <option value="grayscale">Grayscale</option>
                    <option value="jet">Jet</option>
                    <option value="hot">Hot</option>
                    <option value="cool">Cool</option>
                    <option value="viridis">Viridis</option>
                    <option value="plasma">Plasma</option>
                </select>
            </div>
            <div class="toolbar-group">
                <label><input type="checkbox" id="auto-normalize" checked> Normalize</label>
                <label><input type="checkbox" id="show-grid"> Grid</label>
            </div>
            <div class="toolbar-group">
                <button id="btn-compare" title="Toggle A/B Compare">A/B</button>
                <button id="btn-export" title="Export Image">Export</button>
            </div>
        </div>
        <div id="canvas-container">
            <canvas id="image-canvas"></canvas>
            <div id="loading" class="hidden">
                <div class="spinner"></div>
                <span>Loading...</span>
            </div>
            <div id="error-message" class="hidden"></div>
        </div>
        <div id="status-bar">
            <span id="image-info">${escapedLabel}</span>
            <span id="pixel-info"></span>
            <span id="cursor-pos"></span>
        </div>
    </div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }

    dispose(): void {
        this.closeAll();
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
        this._onDidChangeViewState.dispose();
    }
}

function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, character => {
        switch (character) {
            case '&': return '&amp;';
            case '<': return '&lt;';
            case '>': return '&gt;';
            case '"': return '&quot;';
            case '\'': return '&#39;';
            default: return character;
        }
    });
}
