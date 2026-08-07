import * as vscode from 'vscode';
import { DebugSessionManager } from '../core/debugSessionManager';
import { readImageDataForDisplay } from '../core/imageDataReader';
import { ImageItem, DisplayOptions, DefaultDisplayOptions } from '../types';
import {
    ExtensionToWebviewMessage,
    WebviewToExtensionMessage,
    createDisplayImageMessage,
} from '../types/messages';

/**
 * Manager for image editor panels (separate tab windows)
 */
export class ImageEditorManager implements vscode.Disposable {
    private disposables: vscode.Disposable[] = [];
    private panels: Map<string, vscode.WebviewPanel> = new Map();
    private panelItems: Map<string, ImageItem> = new Map();
    private sessionManager: DebugSessionManager;
    private displayOptions: DisplayOptions;

    // For A/B comparison
    private previousImage?: ImageItem;
    private currentImage?: ImageItem;

    // Event for view state changes (for syncing between editors)
    private _onDidChangeViewState = new vscode.EventEmitter<{
        panelId: string;
        state: { zoom: number; panX: number; panY: number };
    }>();
    readonly onDidChangeViewState = this._onDidChangeViewState.event;

    constructor(private readonly extensionUri: vscode.Uri) {
        this.sessionManager = DebugSessionManager.getInstance();
        this.displayOptions = { ...DefaultDisplayOptions };
        this.loadDisplayOptions();
    }

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

    /** Reload workspace display settings and update all editor webviews. */
    reloadConfiguration(): void {
        this.loadDisplayOptions();
        for (const panel of this.panels.values()) {
            this.postMessage(panel, { command: 'updateOptions', options: this.displayOptions });
        }
    }

    /**
     * Open an image in a new editor tab
     */
    async openInEditor(item: ImageItem): Promise<void> {
        // Track for A/B comparison
        this.previousImage = this.currentImage;
        this.currentImage = item;
        this.panelItems.set(item.id, item);

        // Check if panel already exists
        const existingPanel = this.panels.get(item.id);
        if (existingPanel) {
            existingPanel.reveal();
            await this.displayImageInPanel(existingPanel, item);
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

        // Store panel
        this.panels.set(item.id, panel);

        // Handle panel disposal
        panel.onDidDispose(() => {
            this.panels.delete(item.id);
            this.panelItems.delete(item.id);
        });

        // Handle messages from webview
        panel.webview.onDidReceiveMessage((message: WebviewToExtensionMessage) => {
            this.handleWebviewMessage(panel, item.id, message);
        });

        // Initial image display happens when webview sends 'ready' message
    }

    /**
     * Handle messages from editor webview
     */
    private async handleWebviewMessage(
        panel: vscode.WebviewPanel,
        panelId: string,
        message: WebviewToExtensionMessage
    ): Promise<void> {
        const item = this.findItemById(panelId);

        switch (message.command) {
            case 'ready':
                if (item) {
                    await this.displayImageInPanel(panel, item);
                }
                this.postMessage(panel, { command: 'updateOptions', options: this.displayOptions });
                break;

            case 'viewStateChanged':
                this._onDidChangeViewState.fire({ panelId, state: message.state });
                break;

            case 'copyPixel':
                await vscode.env.clipboard.writeText(message.value);
                vscode.window.showInformationMessage(`Copied: ${message.value}`);
                break;

            case 'exportImage':
                if (item) {
                    await this.exportImage(item, message.format);
                }
                break;

            case 'refresh':
                if (item) {
                    await this.displayImageInPanel(panel, item);
                }
                break;

            case 'toggleCompare':
                this.toggleABCompare(panel);
                break;

            case 'optionsChanged':
                Object.assign(this.displayOptions, message.options);
                // Sync to all panels
                for (const [, p] of this.panels) {
                    this.postMessage(p, { command: 'updateOptions', options: message.options });
                }
                break;
        }
    }

    /**
     * Display image data in a panel
     */
    private async displayImageInPanel(panel: vscode.WebviewPanel, item: ImageItem): Promise<void> {
        this.postMessage(panel, { command: 'setLoading', loading: true });

        try {
            if (!item.metadata) {
                this.postMessage(panel, {
                    command: 'showError',
                    message: item.error ?? 'No image metadata available',
                });
                return;
            }

            const image = await readImageDataForDisplay(this.sessionManager, item.metadata);
            if (!image) {
                this.postMessage(panel, {
                    command: 'showError',
                    message: 'Failed to read image data from memory',
                });
                return;
            }

            const base64 = this.arrayToBase64(image.data);
            const message = createDisplayImageMessage(image.metadata, base64);
            this.postMessage(panel, message);
        } catch (error) {
            this.postMessage(panel, {
                command: 'showError',
                message: `Error loading image: ${error}`,
            });
        } finally {
            this.postMessage(panel, { command: 'setLoading', loading: false });
        }
    }

    /**
     * Toggle A/B comparison (switch to previous image)
     */
    private async toggleABCompare(panel: vscode.WebviewPanel): Promise<void> {
        if (!this.previousImage || !this.previousImage.metadata) {
            vscode.window.showInformationMessage('No previous image for comparison');
            return;
        }

        // Swap current and previous
        const temp = this.currentImage;
        this.currentImage = this.previousImage;
        this.previousImage = temp;

        await this.displayImageInPanel(panel, this.currentImage);

        // Update panel title
        panel.title = `Image: ${this.currentImage.label}`;
    }

    /**
     * Export image to file
     */
    private async exportImage(item: ImageItem, format: 'png' | 'jpg' | 'bin'): Promise<void> {
        if (!item.metadata) {
            vscode.window.showErrorMessage('No image metadata');
            return;
        }

        const meta = item.metadata;
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
            const image = await readImageDataForDisplay(this.sessionManager, meta);
            if (!image) {
                throw new Error('Failed to read image data');
            }

            if (format === 'bin') {
                await vscode.workspace.fs.writeFile(uri, image.data);
                vscode.window.showInformationMessage(`Image exported to ${uri.fsPath}`);
            } else {
                vscode.window.showWarningMessage('PNG/JPG export requires webview rendering');
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to export: ${error}`);
        }
    }

    /**
     * Sync view state to all other panels
     */
    syncViewState(excludePanelId: string, state: { zoom: number; panX: number; panY: number }): void {
        for (const [id, panel] of this.panels) {
            if (id !== excludePanelId) {
                this.postMessage(panel, { command: 'syncView', state });
            }
        }
    }

    /**
     * Refresh all panels
     */
    async refreshAll(): Promise<void> {
        for (const [id, panel] of this.panels) {
            const item = this.findItemById(id);
            if (item) {
                await this.displayImageInPanel(panel, item);
            }
        }
    }

    /**
     * Close all panels
     */
    closeAll(): void {
        for (const [, panel] of this.panels) {
            panel.dispose();
        }
        this.panels.clear();
        this.panelItems.clear();
    }

    /**
     * Find item by panel ID
     */
    private findItemById(id: string): ImageItem | undefined {
        return this.panelItems.get(id);
    }

    /**
     * Set item reference for a panel
     */
    setItemForPanel(id: string, item: ImageItem): void {
        this.panelItems.set(id, item);
        if (this.currentImage?.id === id) {
            this.currentImage = item;
        }
    }

    private postMessage(panel: vscode.WebviewPanel, message: ExtensionToWebviewMessage): void {
        panel.webview.postMessage(message);
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

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:;">
    <link href="${styleUri}" rel="stylesheet">
    <title>Image: ${item.label}</title>
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
                </select>
            </div>
            <div class="toolbar-group">
                <label><input type="checkbox" id="auto-normalize" checked> Normalize</label>
                <label><input type="checkbox" id="show-grid"> Grid</label>
            </div>
            <div class="toolbar-group">
                <button id="btn-compare" title="Toggle A/B Compare (Ctrl+Click)">A/B</button>
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
            <span id="image-info">${item.label}</span>
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
