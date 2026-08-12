import * as vscode from 'vscode';
import { DebugSessionManager } from '../core/debugSessionManager';
import { DisplayImageData, readImageItemDataForDisplay } from '../core/imageDataReader';
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

/**
 * Provider for the Image Viewer sidebar panel
 */
export class ImageViewerProvider implements vscode.WebviewViewProvider, vscode.Disposable {
    public static readonly viewType = 'imview.imageViewer';

    private disposables: vscode.Disposable[] = [];
    private view?: vscode.WebviewView;
    private sessionManager: DebugSessionManager;
    private currentImage?: ImageItem;
    private displayedImage?: ImageItem;
    private displayedData?: DisplayImageData;
    private displayOptions: DisplayOptions;
    private readonly imageExporter = new WebviewImageExporter();
    private webviewReady = false;
    private readonly webviewReadyWaiters = new Set<(error?: Error) => void>();
    private displayInFlight?: {
        item: ImageItem;
        view: vscode.WebviewView;
        generation: number;
        promise: Promise<void>;
    };
    private displayGeneration = 0;

    // Event for view state changes (for syncing)
    private _onDidChangeViewState = new vscode.EventEmitter<{ zoom: number; panX: number; panY: number }>();
    readonly onDidChangeViewState = this._onDidChangeViewState.event;

    constructor(private readonly extensionUri: vscode.Uri) {
        this.sessionManager = DebugSessionManager.getInstance();
        this.displayOptions = { ...DefaultDisplayOptions };
        this.loadDisplayOptions();
    }

    /**
     * Load display options from settings
     */
    private loadDisplayOptions(): void {
        const config = vscode.workspace.getConfiguration('imview');
        Object.assign(this.displayOptions, {
            autoNormalize: config.get('autoNormalize', true),
            colormap: config.get('defaultColormap', 'grayscale'),
            showPixelGrid: config.get('showPixelGrid', true),
            pixelGridZoomThreshold: config.get('pixelGridZoomThreshold', 8),
        });
    }

    /** Reload workspace display settings and update an already-open webview. */
    reloadConfiguration(): void {
        this.loadDisplayOptions();
        this.postMessage({ command: 'updateOptions', options: this.displayOptions });
    }

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this.view = webviewView;
        this.webviewReady = false;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.extensionUri],
        };

        webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);

        // Handle messages from webview
        this.disposables.push(
            webviewView.webview.onDidReceiveMessage((message: WebviewToExtensionMessage) => {
                this.handleWebviewMessage(message);
            })
        );

        webviewView.onDidDispose(() => {
            if (this.view === webviewView) {
                this.view = undefined;
                this.webviewReady = false;
                this.displayedImage = undefined;
                this.displayedData = undefined;
                this.displayGeneration++;
                this.imageExporter.cancelPending(new Error('Image Viewer was closed'));
                this.rejectWebviewReadyWaiters(new Error('Image Viewer was closed'));
            }
        });

        webviewView.onDidChangeVisibility(() => {
            if (this.view !== webviewView) {
                return;
            }
            if (!webviewView.visible) {
                // A debugger read cannot be cancelled. Invalidate its presentation,
                // but keep its promise so a quick reveal waits instead of rereading
                // the same large buffer concurrently.
                this.displayGeneration++;
                this.displayedImage = undefined;
                this.displayedData = undefined;
                this.imageExporter.cancelPending(new Error('Image Viewer is hidden'));
                return;
            }
            if (this.webviewReady && !this.displayedData) {
                // Messages sent while a webview is hidden may be dropped. Clear
                // stale pixels only after it is visible, before any lazy read.
                this.postMessage({ command: 'clearImage' });
                if (this.currentImage && this.getItemMetadata(this.currentImage)) {
                    void this.displayImage(this.currentImage, true);
                }
            }
        });
    }

    /**
     * Handle messages from the webview
     */
    private async handleWebviewMessage(message: WebviewToExtensionMessage): Promise<void> {
        switch (message.command) {
            case 'ready':
                // Mark startup separately from debugger memory reads. Export callers can
                // now share the same in-flight display instead of timing out or rereading.
                this.postMessage({ command: 'updateOptions', options: this.displayOptions });
                this.markWebviewReady();
                if (this.currentImage) {
                    await this.displayImage(this.currentImage);
                }
                break;

            case 'viewStateChanged':
                this._onDidChangeViewState.fire(message.state);
                break;

            case 'copyPixel':
                await vscode.env.clipboard.writeText(message.value);
                vscode.window.showInformationMessage(`Copied: ${message.value}`);
                break;

            case 'exportImage':
                {
                    const displayedImage = message.imageId &&
                        this.displayedData?.metadata.id === message.imageId
                        ? this.displayedImage
                        : !message.imageId ? this.currentImage : undefined;
                    if (displayedImage) {
                        await this.exportImage(displayedImage, message.format, message.name);
                    } else {
                        vscode.window.showWarningMessage('The displayed image changed; try exporting again');
                    }
                }
                break;

            case 'exportImageData':
                this.imageExporter.handleResponse(message);
                break;

            case 'refresh':
                if (this.currentImage) {
                    await this.displayImage(this.currentImage);
                }
                break;

            case 'openInEditor':
                if (this.currentImage) {
                    vscode.commands.executeCommand('imview.openInEditor', this.currentImage);
                }
                break;

            case 'optionsChanged':
                Object.assign(this.displayOptions, message.options);
                break;
        }
    }

    /**
     * Display an image in the viewer
     */
    async displayImage(item: ImageItem, preserveView: boolean = false): Promise<void> {
        this.currentImage = item;

        const view = this.view;
        if (!view || !this.webviewReady) {
            return;
        }
        if (this.displayedImage === item && this.displayedData && !this.displayInFlight) {
            return;
        }
        if (!view.visible) {
            // Keep only the selected item. The next visibility event performs one
            // current-state read instead of refreshing a hidden webview eagerly.
            this.displayGeneration++;
            this.displayedImage = undefined;
            this.displayedData = undefined;
            this.imageExporter.cancelPending(new Error('Image Viewer is hidden'));
            this.postMessage({ command: 'clearImage' });
            return;
        }

        const inFlight = this.displayInFlight;
        if (inFlight) {
            if (inFlight.item === item && inFlight.view === view &&
                inFlight.generation === this.displayGeneration) {
                return inFlight.promise;
            }

            // Supersede the presentation immediately, but serialize the underlying
            // debugger reads because DAP readMemory/evaluate requests are not cancellable.
            if (inFlight.generation === this.displayGeneration) {
                this.displayGeneration++;
            }
            await inFlight.promise;
            if (this.view !== view || this.currentImage !== item || !view.visible) {
                return;
            }
            return this.displayImage(item, preserveView);
        }

        const generation = ++this.displayGeneration;
        const promise = this.displayImageInView(view, item, generation, preserveView).finally(() => {
            if (this.displayInFlight?.promise === promise) {
                this.displayInFlight = undefined;
            }
        });
        this.displayInFlight = { item, view, generation, promise };
        return promise;
    }

    private async displayImageInView(
        view: vscode.WebviewView,
        item: ImageItem,
        generation: number,
        preserveView: boolean
    ): Promise<void> {
        const postMessage = (message: ExtensionToWebviewMessage): Thenable<boolean> =>
            view.webview.postMessage(message);
        const isCurrent = (): boolean =>
            this.view === view && this.displayGeneration === generation;

        // Show loading state
        postMessage({ command: 'setLoading', loading: true });

        try {
            if (!this.getItemMetadata(item)) {
                if (isCurrent()) {
                    this.clearFailedDisplay(new Error('No image metadata available'));
                    if (item.availability) {
                        postMessage({ command: 'clearImage' });
                    } else {
                        postMessage({
                            command: 'showError',
                            message: item.error ?? 'No image metadata available',
                        });
                    }
                }
                return;
            }

            const image = await readImageItemDataForDisplay(this.sessionManager, item);
            if (!image) {
                if (isCurrent()) {
                    this.clearFailedDisplay(new Error('Failed to read image data from memory'));
                    postMessage({
                        command: 'showError',
                        message: 'Failed to read image data from memory',
                    });
                }
                return;
            }
            if (!isCurrent()) {
                return;
            }

            // Convert to base64
            const base64 = this.arrayToBase64(image.data);

            // Send to webview
            const message = createDisplayImageMessage(image.metadata, base64, preserveView);
            const delivered = await postMessage(message);
            if (isCurrent()) {
                if (delivered) {
                    this.displayedImage = item;
                    this.displayedData = image;
                } else {
                    this.clearFailedDisplay(new Error('Image webview is not available'));
                }
            }
        } catch (error) {
            if (isCurrent()) {
                const displayError = error instanceof Error ? error : new Error(String(error));
                this.clearFailedDisplay(displayError);
                postMessage({
                    command: 'showError',
                    message: `Error loading image: ${error}`,
                });
            }
        } finally {
            if (isCurrent()) {
                postMessage({ command: 'setLoading', loading: false });
            }
        }
    }

    /**
     * Clear the current display
     */
    clearDisplay(): void {
        this.currentImage = undefined;
        this.displayedImage = undefined;
        this.displayedData = undefined;
        this.displayGeneration++;
        this.postMessage({ command: 'clearImage' });
    }

    /** Clear stale pixels while retaining the selected expression for the next stop. */
    invalidateDisplay(): void {
        if (this.currentImage) {
            this.currentImage = createUnavailableImageReference(this.currentImage);
        }
        this.displayedImage = undefined;
        this.displayedData = undefined;
        this.displayGeneration++;
        this.imageExporter.cancelPending(new Error('Debugger is running'));
        this.postMessage({ command: 'clearImage' });
    }

    /** Replace a selected list item with its freshly parsed version and redraw it. */
    async updateImages(items: readonly ImageItem[]): Promise<void> {
        if (!this.currentImage) {
            return;
        }
        const updated = items.find(item =>
            item.id === this.currentImage?.id ||
            (item.expression === this.currentImage?.expression && item.isWatch === this.currentImage?.isWatch)
        );
        if (!updated) {
            this.clearDisplay();
            return;
        }
        this.currentImage = updated;
        await this.displayImage(updated, true);
    }

    /**
     * Update display options
     */
    updateOptions(options: Partial<DisplayOptions>): void {
        Object.assign(this.displayOptions, options);
        this.postMessage({ command: 'updateOptions', options });
    }

    /**
     * Sync view state from another viewer
     */
    syncViewState(state: { zoom: number; panX: number; panY: number }): void {
        this.postMessage({ command: 'syncView', state });
    }

    /**
     * Export current image to file
     */
    async exportCurrentImage(): Promise<void> {
        const item = this.displayedImage ?? this.currentImage;
        if (!item || !this.getItemMetadata(item)) {
            vscode.window.showWarningMessage('No image to export');
            return;
        }
        await this.exportImage(item);
    }

    async exportImage(
        item: ImageItem,
        requestedFormat?: ImageExportFormat,
        suggestedName?: string
    ): Promise<void> {
        const metadata = this.getItemMetadata(item);
        if (!metadata) {
            vscode.window.showErrorMessage('No image to export');
            return;
        }

        const target = await promptForImageExport(suggestedName ?? metadata.name, requestedFormat);
        if (!target) {
            return;
        }

        try {
            await this.ensureDisplayed(item);
            if (!this.displayedData || this.displayedImage !== item) {
                throw new Error('The displayed image is no longer available');
            }
            const displayedData = this.displayedData;

            let data: Uint8Array;
            if (target.format === 'bin') {
                data = displayedData.data;
            } else {
                const encodedFormat = target.format;

                const quality = vscode.workspace.getConfiguration('imview').get('jpegQuality', 0.92);
                data = await vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: `Encoding ${encodedFormat === 'png' ? 'PNG' : 'JPEG'} image`,
                        cancellable: false,
                    },
                    () => this.imageExporter.request(
                        message => this.postMessage(message),
                        displayedData.metadata.id,
                        encodedFormat,
                        quality
                    )
                );
            }

            await vscode.workspace.fs.writeFile(target.uri, data);
            vscode.window.showInformationMessage(`Image exported to ${formatExportLocation(target.uri)}`);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to export image: ${error}`);
        }
    }

    private async ensureDisplayed(item: ImageItem): Promise<void> {
        this.currentImage = item;
        await vscode.commands.executeCommand('imview.imageViewer.focus');
        await this.waitForWebviewReady();
        if (this.displayedImage !== item || this.displayInFlight) {
            await this.displayImage(item, this.displayedImage?.id === item.id);
        }
    }

    private getItemMetadata(item: ImageItem): ImageItem['metadata'] {
        return item.imageData?.metadata ?? item.metadata;
    }

    private clearFailedDisplay(error: Error): void {
        this.displayedImage = undefined;
        this.displayedData = undefined;
        this.imageExporter.cancelPending(error);
    }

    private waitForWebviewReady(): Promise<void> {
        if (this.webviewReady && this.view) {
            return Promise.resolve();
        }

        return new Promise((resolve, reject) => {
            const waiter = (error?: Error): void => {
                clearTimeout(timer);
                this.webviewReadyWaiters.delete(waiter);
                error ? reject(error) : resolve();
            };
            const timer = setTimeout(
                () => waiter(new Error('Image Viewer did not become ready for export')),
                10_000
            );
            this.webviewReadyWaiters.add(waiter);
        });
    }

    private markWebviewReady(): void {
        this.webviewReady = true;
        for (const waiter of [...this.webviewReadyWaiters]) {
            waiter();
        }
    }

    private rejectWebviewReadyWaiters(error: Error): void {
        for (const waiter of [...this.webviewReadyWaiters]) {
            waiter(error);
        }
    }

    /**
     * Post a message to the webview
     */
    private postMessage(message: ExtensionToWebviewMessage): Thenable<boolean> {
        return this.view?.webview.postMessage(message) ?? Promise.resolve(false);
    }

    /**
     * Convert Uint8Array to base64
     */
    private arrayToBase64(data: Uint8Array): string {
        return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64');
    }

    /**
     * Generate HTML for the webview
     */
    private getHtmlForWebview(webview: vscode.Webview): string {
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'viewer.js')
        );

        const styleUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'webview', 'styles', 'viewer.css')
        );

        const nonce = getNonce();

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:;">
    <link href="${styleUri}" rel="stylesheet">
    <title>ImView</title>
</head>
<body>
    <div id="app">
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
            </div>
            <div class="toolbar-group">
                <label><input type="checkbox" id="auto-normalize" checked> Normalize</label>
                <button id="btn-export" title="Export PNG, JPEG, or raw data">Export</button>
            </div>
        </div>
        <div id="canvas-container">
            <canvas id="image-canvas"></canvas>
            <div id="loading" class="hidden">
                <div class="spinner"></div>
                <span>Loading...</span>
            </div>
            <div id="error-message" class="hidden"></div>
            <div id="no-image" class="hidden">
                <span>Select an image from the list to view</span>
            </div>
        </div>
        <div id="status-bar">
            <span id="image-info">No image</span>
            <span id="pixel-info"></span>
            <span id="cursor-pos"></span>
        </div>
    </div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }

    dispose(): void {
        this.imageExporter.dispose();
        this.rejectWebviewReadyWaiters(new Error('Image Viewer was disposed'));
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
        this.disposables = [];
        this._onDidChangeViewState.dispose();
    }
}

/**
 * Generate a random nonce for CSP
 */
function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
