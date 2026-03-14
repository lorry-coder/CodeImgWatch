import { ImageRenderer, ImageInfo, RenderOptions } from './canvas/imageRenderer';
import { ZoomController, ViewState } from './canvas/zoomController';
import { PixelInspector } from './canvas/pixelInspector';

// VS Code webview API
declare function acquireVsCodeApi(): {
    postMessage(message: unknown): void;
    getState(): unknown;
    setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();

/**
 * Display options
 */
interface DisplayOptions {
    autoNormalize: boolean;
    colormap: string;
    ignoreAlpha: boolean;
    channelView: number;
    showPixelGrid: boolean;
    pixelGridZoomThreshold: number;
    pixelFormat: 'decimal' | 'hex';
}

/**
 * Messages from extension
 */
interface DisplayImageMessage {
    command: 'displayImage';
    id: string;
    data: string;
    width: number;
    height: number;
    channels: number;
    pixelType: string;
    stride: number;
    name: string;
    typeName: string;
}

interface ClearImageMessage {
    command: 'clearImage';
}

interface ShowErrorMessage {
    command: 'showError';
    message: string;
}

interface UpdateOptionsMessage {
    command: 'updateOptions';
    options: Partial<DisplayOptions>;
}

interface SyncViewMessage {
    command: 'syncView';
    state: ViewState;
}

interface SetLoadingMessage {
    command: 'setLoading';
    loading: boolean;
}

type ExtensionMessage =
    | DisplayImageMessage
    | ClearImageMessage
    | ShowErrorMessage
    | UpdateOptionsMessage
    | SyncViewMessage
    | SetLoadingMessage;

/**
 * Main viewer application
 */
class ImageViewer {
    private canvas: HTMLCanvasElement;
    private container: HTMLElement;
    private renderer: ImageRenderer;
    private zoomController: ZoomController;
    private pixelInspector: PixelInspector;

    private options: DisplayOptions = {
        autoNormalize: true,
        colormap: 'grayscale',
        ignoreAlpha: false,
        channelView: 0,
        showPixelGrid: true,
        pixelGridZoomThreshold: 8,
        pixelFormat: 'decimal',
    };

    private currentImageId: string = '';
    private currentImageInfo: ImageInfo | null = null;

    // UI Elements
    private loadingElement: HTMLElement | null;
    private errorElement: HTMLElement | null;
    private noImageElement: HTMLElement | null;
    private imageInfoElement: HTMLElement | null;
    private zoomLevelElement: HTMLElement | null;

    constructor() {
        // Get DOM elements
        this.canvas = document.getElementById('image-canvas') as HTMLCanvasElement;
        this.container = document.getElementById('canvas-container') as HTMLElement;
        this.loadingElement = document.getElementById('loading');
        this.errorElement = document.getElementById('error-message');
        this.noImageElement = document.getElementById('no-image');
        this.imageInfoElement = document.getElementById('image-info');
        this.zoomLevelElement = document.getElementById('zoom-level');

        if (!this.canvas || !this.container) {
            throw new Error('Required DOM elements not found');
        }

        // Initialize components
        this.renderer = new ImageRenderer(this.canvas);
        this.zoomController = new ZoomController(this.canvas, this.container);
        this.pixelInspector = new PixelInspector(this.renderer, this.zoomController, this.container);

        // Set up callbacks
        this.zoomController.setOnViewChange((state) => {
            this.updateZoomDisplay();
            this.pixelInspector.updatePixelOverlays();
            vscode.postMessage({ command: 'viewStateChanged', state });
        });

        this.zoomController.setOnCursorMove((screenX, screenY, imageX, imageY) => {
            this.pixelInspector.updateCursor(screenX, screenY, imageX, imageY);
        });

        // Set up UI controls
        this.setupControls();

        // Listen for messages from extension
        window.addEventListener('message', (event) => this.handleMessage(event.data));

        // Notify extension that we're ready
        vscode.postMessage({ command: 'ready' });

        // Show placeholder
        this.showNoImage();
    }

    /**
     * Set up UI controls
     */
    private setupControls(): void {
        // Fit button
        const btnFit = document.getElementById('btn-fit');
        btnFit?.addEventListener('click', () => this.zoomController.fitToContainer());

        // Actual size button
        const btnActual = document.getElementById('btn-actual');
        btnActual?.addEventListener('click', () => this.zoomController.actualSize());

        // Channel select
        const channelSelect = document.getElementById('channel-select') as HTMLSelectElement;
        channelSelect?.addEventListener('change', () => {
            this.options.channelView = parseInt(channelSelect.value, 10);
            this.updateRender();
            this.notifyOptionsChanged();
        });

        // Colormap select (if exists - only in editor mode)
        const colormapSelect = document.getElementById('colormap-select') as HTMLSelectElement;
        colormapSelect?.addEventListener('change', () => {
            this.options.colormap = colormapSelect.value;
            this.updateRender();
            this.notifyOptionsChanged();
        });

        // Auto normalize checkbox
        const autoNormalize = document.getElementById('auto-normalize') as HTMLInputElement;
        autoNormalize?.addEventListener('change', () => {
            this.options.autoNormalize = autoNormalize.checked;
            this.updateRender();
            this.notifyOptionsChanged();
        });

        // Show grid checkbox (if exists)
        const showGrid = document.getElementById('show-grid') as HTMLInputElement;
        showGrid?.addEventListener('change', () => {
            this.options.showPixelGrid = showGrid.checked;
            this.pixelInspector.setShowPixelGrid(showGrid.checked);
        });

        // A/B compare button (if exists)
        const btnCompare = document.getElementById('btn-compare');
        btnCompare?.addEventListener('click', () => {
            vscode.postMessage({ command: 'toggleCompare' });
        });

        // Export button (if exists)
        const btnExport = document.getElementById('btn-export');
        btnExport?.addEventListener('click', () => {
            vscode.postMessage({ command: 'exportImage', format: 'png' });
        });

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => this.handleKeyDown(e));
    }

    /**
     * Handle keyboard shortcuts
     */
    private handleKeyDown(e: KeyboardEvent): void {
        // Ctrl+C: Copy pixel value
        if (e.ctrlKey && e.key === 'c') {
            const pixelValue = this.pixelInspector.getCurrentPixelValue();
            if (pixelValue) {
                vscode.postMessage({ command: 'copyPixel', value: pixelValue });
            }
        }

        // 0: Actual size
        if (e.key === '0' && !e.ctrlKey && !e.altKey) {
            this.zoomController.actualSize();
        }

        // F: Fit to window
        if (e.key === 'f' && !e.ctrlKey && !e.altKey) {
            this.zoomController.fitToContainer();
        }

        // 1-4: Channel view
        if (['1', '2', '3', '4'].includes(e.key) && !e.ctrlKey && !e.altKey) {
            const channelSelect = document.getElementById('channel-select') as HTMLSelectElement;
            if (channelSelect) {
                channelSelect.value = e.key;
                this.options.channelView = parseInt(e.key, 10);
                this.updateRender();
            }
        }

        // Space: Toggle A/B compare
        if (e.key === ' ') {
            e.preventDefault();
            vscode.postMessage({ command: 'toggleCompare' });
        }
    }

    /**
     * Handle messages from extension
     */
    private handleMessage(message: ExtensionMessage): void {
        switch (message.command) {
            case 'displayImage':
                this.displayImage(message);
                break;

            case 'clearImage':
                this.clearImage();
                break;

            case 'showError':
                this.showError(message.message);
                break;

            case 'updateOptions':
                this.updateOptions(message.options);
                break;

            case 'syncView':
                this.zoomController.setViewState(message.state);
                this.pixelInspector.updatePixelOverlays();
                break;

            case 'setLoading':
                this.setLoading(message.loading);
                break;
        }
    }

    /**
     * Display an image
     */
    private displayImage(message: DisplayImageMessage): void {
        this.hideAllOverlays();
        this.container.classList.add('has-image');

        // Decode base64 data
        const binaryString = atob(message.data);
        const data = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
            data[i] = binaryString.charCodeAt(i);
        }

        // Create image info
        const imageInfo: ImageInfo = {
            id: message.id,
            data,
            width: message.width,
            height: message.height,
            channels: message.channels,
            pixelType: message.pixelType,
            stride: message.stride,
            name: message.name,
            typeName: message.typeName,
        };

        this.currentImageId = message.id;
        this.currentImageInfo = imageInfo;

        // Render
        const renderOptions: RenderOptions = {
            autoNormalize: this.options.autoNormalize,
            colormap: this.options.colormap,
            channelView: this.options.channelView,
            ignoreAlpha: this.options.ignoreAlpha,
        };

        this.renderer.render(imageInfo, renderOptions);

        // Update zoom controller
        this.zoomController.setImageSize(message.width, message.height);
        this.zoomController.fitToContainer();

        // Update info display
        if (this.imageInfoElement) {
            this.imageInfoElement.textContent =
                `${message.name} - ${message.width}×${message.height} ${message.typeName}`;
        }

        // Update channel select visibility
        const channelSelect = document.getElementById('channel-select') as HTMLSelectElement;
        if (channelSelect) {
            // Show/hide alpha option based on channel count
            const alphaOption = channelSelect.querySelector('option[value="4"]');
            if (alphaOption) {
                (alphaOption as HTMLOptionElement).hidden = message.channels < 4;
            }
        }

        this.updateZoomDisplay();
    }

    /**
     * Update rendering with current options
     */
    private updateRender(): void {
        if (!this.currentImageInfo) {
            return;
        }

        const renderOptions: RenderOptions = {
            autoNormalize: this.options.autoNormalize,
            colormap: this.options.colormap,
            channelView: this.options.channelView,
            ignoreAlpha: this.options.ignoreAlpha,
        };

        this.renderer.updateRender(renderOptions);
        this.pixelInspector.updatePixelOverlays();
    }

    /**
     * Clear the current image
     */
    private clearImage(): void {
        this.renderer.clear();
        this.currentImageId = '';
        this.currentImageInfo = null;
        this.container.classList.remove('has-image');
        this.showNoImage();
    }

    /**
     * Update display options
     */
    private updateOptions(options: Partial<DisplayOptions>): void {
        Object.assign(this.options, options);

        // Update UI controls
        const autoNormalize = document.getElementById('auto-normalize') as HTMLInputElement;
        if (autoNormalize && options.autoNormalize !== undefined) {
            autoNormalize.checked = options.autoNormalize;
        }

        const channelSelect = document.getElementById('channel-select') as HTMLSelectElement;
        if (channelSelect && options.channelView !== undefined) {
            channelSelect.value = options.channelView.toString();
        }

        const colormapSelect = document.getElementById('colormap-select') as HTMLSelectElement;
        if (colormapSelect && options.colormap !== undefined) {
            colormapSelect.value = options.colormap;
        }

        const showGrid = document.getElementById('show-grid') as HTMLInputElement;
        if (showGrid && options.showPixelGrid !== undefined) {
            showGrid.checked = options.showPixelGrid;
        }

        // Update pixel inspector
        if (options.pixelFormat !== undefined) {
            this.pixelInspector.setDisplayFormat(options.pixelFormat);
        }
        if (options.showPixelGrid !== undefined) {
            this.pixelInspector.setShowPixelGrid(options.showPixelGrid);
        }
        if (options.pixelGridZoomThreshold !== undefined) {
            this.pixelInspector.setPixelGridThreshold(options.pixelGridZoomThreshold);
        }

        // Re-render if we have an image
        this.updateRender();
    }

    /**
     * Notify extension of options change
     */
    private notifyOptionsChanged(): void {
        vscode.postMessage({ command: 'optionsChanged', options: this.options });
    }

    /**
     * Show loading overlay
     */
    private setLoading(loading: boolean): void {
        if (this.loadingElement) {
            this.loadingElement.classList.toggle('hidden', !loading);
        }
    }

    /**
     * Show error message
     */
    private showError(message: string): void {
        this.hideAllOverlays();
        if (this.errorElement) {
            this.errorElement.textContent = message;
            this.errorElement.classList.remove('hidden');
        }
    }

    /**
     * Show no image placeholder
     */
    private showNoImage(): void {
        this.hideAllOverlays();
        if (this.noImageElement) {
            this.noImageElement.classList.remove('hidden');
        }
        if (this.imageInfoElement) {
            this.imageInfoElement.textContent = 'No image';
        }
    }

    /**
     * Hide all overlays
     */
    private hideAllOverlays(): void {
        this.loadingElement?.classList.add('hidden');
        this.errorElement?.classList.add('hidden');
        this.noImageElement?.classList.add('hidden');
    }

    /**
     * Update zoom level display
     */
    private updateZoomDisplay(): void {
        if (this.zoomLevelElement) {
            const zoom = this.zoomController.getZoom();
            const percent = Math.round(zoom * 100);
            this.zoomLevelElement.textContent = `${percent}%`;
        }
    }
}

// Initialize viewer when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    new ImageViewer();
});

// Also try to initialize immediately if DOM is already loaded
if (document.readyState === 'complete' || document.readyState === 'interactive') {
    new ImageViewer();
}
