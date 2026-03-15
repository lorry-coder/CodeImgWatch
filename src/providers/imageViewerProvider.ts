import * as vscode from 'vscode';
import { DebugSessionManager } from '../core/debugSessionManager';
import { ImageItem, ImageMetadata, DisplayOptions, DefaultDisplayOptions, ImageTypeName } from '../types';
import {
    ExtensionToWebviewMessage,
    WebviewToExtensionMessage,
    createDisplayImageMessage,
} from '../types/messages';
import { chwToHwc } from '../utils/imageTransform';

/**
 * Provider for the Image Viewer sidebar panel
 */
export class ImageViewerProvider implements vscode.WebviewViewProvider, vscode.Disposable {
    public static readonly viewType = 'imview.imageViewer';

    private disposables: vscode.Disposable[] = [];
    private view?: vscode.WebviewView;
    private sessionManager: DebugSessionManager;
    private currentImage?: ImageItem;
    private displayOptions: DisplayOptions;

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
        this.displayOptions = {
            autoNormalize: config.get('autoNormalize', true),
            colormap: config.get('defaultColormap', 'grayscale'),
            ignoreAlpha: false,
            channelView: 0,
            showPixelGrid: config.get('showPixelGrid', true),
            pixelGridZoomThreshold: config.get('pixelGridZoomThreshold', 8),
            pixelFormat: 'decimal',
        };
    }

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void {
        this.view = webviewView;

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

        // Re-display current image when view becomes visible
        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible && this.currentImage) {
                this.displayImage(this.currentImage);
            }
        });
    }

    /**
     * Handle messages from the webview
     */
    private async handleWebviewMessage(message: WebviewToExtensionMessage): Promise<void> {
        switch (message.command) {
            case 'ready':
                // Webview is ready, send current image if any
                if (this.currentImage) {
                    await this.displayImage(this.currentImage);
                }
                // Send display options
                this.postMessage({ command: 'updateOptions', options: this.displayOptions });
                break;

            case 'viewStateChanged':
                this._onDidChangeViewState.fire(message.state);
                break;

            case 'copyPixel':
                await vscode.env.clipboard.writeText(message.value);
                vscode.window.showInformationMessage(`Copied: ${message.value}`);
                break;

            case 'exportImage':
                await this.exportCurrentImage(message.format);
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
    async displayImage(item: ImageItem): Promise<void> {
        this.currentImage = item;

        if (!this.view) {
            return;
        }

        // Show loading state
        this.postMessage({ command: 'setLoading', loading: true });

        try {
            if (!item.metadata) {
                this.postMessage({
                    command: 'showError',
                    message: item.error ?? 'No image metadata available',
                });
                return;
            }

            // Read image data based on debugger type
            let data: Uint8Array | undefined;

            if (item.metadata.debuggerType === 'debugpy') {
                data = await this.readPythonImageData(item.metadata);
            } else {
                data = await this.sessionManager.readMemoryChunked(
                    item.metadata.dataAddress,
                    item.metadata.dataSize
                );
            }

            if (!data) {
                this.postMessage({
                    command: 'showError',
                    message: 'Failed to read image data from memory',
                });
                return;
            }

            // Handle CHW to HWC conversion for PyTorch tensors
            if (item.metadata.dataLayout === 'CHW' && item.metadata.channels > 1) {
                data = chwToHwc(
                    data,
                    item.metadata.channels,
                    item.metadata.height,
                    item.metadata.width,
                    this.getBytesPerElement(item.metadata.depth)
                );
                // Update metadata to reflect the conversion
                item.metadata.dataLayout = 'HWC';
                item.metadata.stride = item.metadata.width * item.metadata.channels * this.getBytesPerElement(item.metadata.depth);
            }

            // Convert to base64
            const base64 = this.arrayToBase64(data);

            // Send to webview
            const message = createDisplayImageMessage(item.metadata, base64);
            this.postMessage(message);
        } catch (error) {
            this.postMessage({
                command: 'showError',
                message: `Error loading image: ${error}`,
            });
        } finally {
            this.postMessage({ command: 'setLoading', loading: false });
        }
    }

    /**
     * Read image data from Python debugger (debugpy)
     */
    private async readPythonImageData(metadata: ImageMetadata): Promise<Uint8Array | undefined> {
        const expression = metadata.expression;

        // Build the appropriate expression based on image type
        let dataExpression: string;

        if (metadata.typeName === ImageTypeName.PIL_IMAGE) {
            // Convert PIL image to numpy array first
            dataExpression = `__import__('numpy').array(${expression})`;
        } else if (metadata.typeName === ImageTypeName.TORCH_TENSOR) {
            // Convert torch tensor to numpy
            // Need to handle CHW format and ensure contiguous
            if (metadata.dataLayout === 'CHW' && metadata.channels > 1) {
                // Permute CHW to HWC, then convert to numpy
                dataExpression = `${expression}.permute(1, 2, 0).contiguous().numpy()`;
            } else {
                dataExpression = `${expression}.contiguous().numpy()`;
            }
            // Mark that we've already done the conversion
            metadata.dataLayout = 'HWC';
        } else {
            // numpy array - ensure contiguous
            dataExpression = `__import__('numpy').ascontiguousarray(${expression})`;
        }

        return this.sessionManager.readPythonArrayData(dataExpression, false);
    }

    /**
     * Get bytes per element for a given depth
     */
    private getBytesPerElement(depth: number): number {
        const sizes = [1, 1, 2, 2, 4, 4, 8, 2]; // CV_8U, CV_8S, CV_16U, CV_16S, CV_32S, CV_32F, CV_64F, CV_16F
        return sizes[depth] ?? 1;
    }

    /**
     * Clear the current display
     */
    clearDisplay(): void {
        this.currentImage = undefined;
        this.postMessage({ command: 'clearImage' });
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
    private async exportCurrentImage(format: 'png' | 'jpg' | 'bin'): Promise<void> {
        if (!this.currentImage?.metadata) {
            vscode.window.showErrorMessage('No image to export');
            return;
        }

        const meta = this.currentImage.metadata;
        const defaultName = `${meta.name.replace(/[^a-zA-Z0-9]/g, '_')}.${format}`;

        const uri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(defaultName),
            filters:
                format === 'bin'
                    ? { 'Binary': ['bin'] }
                    : format === 'png'
                        ? { 'PNG Image': ['png'] }
                        : { 'JPEG Image': ['jpg', 'jpeg'] },
        });

        if (!uri) {
            return;
        }

        try {
            const data = await this.sessionManager.readMemoryChunked(meta.dataAddress, meta.dataSize);

            if (!data) {
                throw new Error('Failed to read image data');
            }

            if (format === 'bin') {
                // Write raw binary
                await vscode.workspace.fs.writeFile(uri, data);
            } else {
                // For PNG/JPG, the webview will handle the conversion
                // This is a simplified implementation - full version would use canvas in webview
                vscode.window.showWarningMessage('PNG/JPG export requires webview rendering (not yet implemented)');
                return;
            }

            vscode.window.showInformationMessage(`Image exported to ${uri.fsPath}`);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to export image: ${error}`);
        }
    }

    /**
     * Post a message to the webview
     */
    private postMessage(message: ExtensionToWebviewMessage): void {
        this.view?.webview.postMessage(message);
    }

    /**
     * Convert Uint8Array to base64
     */
    private arrayToBase64(data: Uint8Array): string {
        let binary = '';
        for (let i = 0; i < data.length; i++) {
            binary += String.fromCharCode(data[i]);
        }
        return btoa(binary);
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
