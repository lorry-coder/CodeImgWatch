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
    channelFormat?: string;
    byteOrder: 'little' | 'big';
    name: string;
    typeName: string;
    preserveView: boolean;
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

interface RequestImageExportMessage {
    command: 'requestImageExport';
    requestId: string;
    imageId: string;
    format: 'png' | 'jpg';
    jpegQuality: number;
    maxBytes: number;
}

type ExtensionMessage =
    | DisplayImageMessage
    | ClearImageMessage
    | ShowErrorMessage
    | UpdateOptionsMessage
    | SyncViewMessage
    | SetLoadingMessage
    | RequestImageExportMessage;

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
            this.notifyOptionsChanged();
        });

        // A/B compare button (if exists)
        const btnCompare = document.getElementById('btn-compare');
        btnCompare?.addEventListener('click', () => {
            vscode.postMessage({ command: 'toggleCompare' });
        });

        // Export button (if exists)
        const btnExport = document.getElementById('btn-export');
        btnExport?.addEventListener('click', () => {
            vscode.postMessage({
                command: 'exportImage',
                imageId: this.currentImageInfo?.id,
                name: this.currentImageInfo?.name,
            });
        });

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => this.handleKeyDown(e));
    }

    /**
     * Handle keyboard shortcuts
     */
    private handleKeyDown(e: KeyboardEvent): void {
        if (this.isInteractiveKeyboardTarget(e.target)) {
            return;
        }

        // Ctrl+C / Cmd+C: Copy pixel value
        if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'c') {
            const pixelValue = this.pixelInspector.getCurrentPixelValue();
            if (pixelValue) {
                e.preventDefault();
                vscode.postMessage({ command: 'copyPixel', value: pixelValue });
            }
            return;
        }

        const hasCommandModifier = e.ctrlKey || e.metaKey || e.altKey;

        // 0: Actual size
        if (e.key === '0' && !hasCommandModifier) {
            e.preventDefault();
            this.zoomController.actualSize();
            return;
        }

        // F: Fit to window
        if (e.key.toLowerCase() === 'f' && !hasCommandModifier) {
            e.preventDefault();
            this.zoomController.fitToContainer();
            return;
        }

        // 1-4: Channel view
        if (['1', '2', '3', '4'].includes(e.key) && !hasCommandModifier) {
            const channelSelect = document.getElementById('channel-select') as HTMLSelectElement;
            const option = channelSelect
                ? Array.from(channelSelect.options).find(candidate => candidate.value === e.key)
                : undefined;
            if (channelSelect && option && !option.hidden && !option.disabled) {
                e.preventDefault();
                channelSelect.value = e.key;
                this.options.channelView = parseInt(e.key, 10);
                this.updateRender();
                this.notifyOptionsChanged();
            }
            return;
        }

        // Space: Toggle A/B compare only in editor views that provide the control.
        if (e.key === ' ' && !hasCommandModifier && document.getElementById('btn-compare')) {
            e.preventDefault();
            vscode.postMessage({ command: 'toggleCompare' });
        }
    }

    private isInteractiveKeyboardTarget(target: EventTarget | null): boolean {
        if (!(target instanceof HTMLElement)) {
            return false;
        }
        return target.isContentEditable || target.closest(
            'button, input, select, textarea, label, a, [role="button"], [contenteditable="true"]'
        ) !== null;
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
                this.updateZoomDisplay();
                this.pixelInspector.updatePixelOverlays();
                break;

            case 'setLoading':
                this.setLoading(message.loading);
                break;

            case 'requestImageExport':
                void this.exportRenderedImage(message);
                break;
        }
    }

    /** Encode exactly what is currently rendered, excluding zoom and inspector overlays. */
    private async exportRenderedImage(message: RequestImageExportMessage): Promise<void> {
        try {
            if (!this.currentImageInfo || this.currentImageId !== message.imageId) {
                throw new Error('The requested image is not currently rendered');
            }
            if (!Number.isSafeInteger(message.maxBytes) || message.maxBytes <= 0) {
                throw new Error('The image export size limit is invalid');
            }
            if (this.canvas.width === 0 || this.canvas.height === 0) {
                throw new Error('The rendered image is empty');
            }

            const mimeType = message.format === 'png' ? 'image/png' : 'image/jpeg';
            let exportCanvas = this.canvas;

            // JPEG has no alpha channel. Composite onto white explicitly instead of relying
            // on browser-specific transparent-pixel behavior.
            if (message.format === 'jpg') {
                const flattened = document.createElement('canvas');
                flattened.width = this.canvas.width;
                flattened.height = this.canvas.height;
                const context = flattened.getContext('2d');
                if (!context) {
                    throw new Error('Failed to create the JPEG export canvas');
                }
                context.fillStyle = '#ffffff';
                context.fillRect(0, 0, flattened.width, flattened.height);
                context.drawImage(this.canvas, 0, 0);
                exportCanvas = flattened;
            }

            const blob = await new Promise<Blob>((resolve, reject) => {
                exportCanvas.toBlob(
                    result => result ? resolve(result) : reject(new Error(`Browser failed to encode ${mimeType}`)),
                    mimeType,
                    message.format === 'jpg' ? message.jpegQuality : undefined
                );
            });
            if (blob.type && blob.type.toLowerCase() !== mimeType) {
                throw new Error(`Browser encoded ${blob.type} instead of ${mimeType}`);
            }
            if (blob.size === 0) {
                throw new Error(`Browser returned an empty ${mimeType} image`);
            }
            if (blob.size > message.maxBytes) {
                throw new Error(`Encoded image exceeds the ${message.maxBytes}-byte export limit`);
            }
            const data = await this.blobToBase64(blob);
            vscode.postMessage({
                command: 'exportImageData',
                requestId: message.requestId,
                format: message.format,
                data,
            });
        } catch (error) {
            vscode.postMessage({
                command: 'exportImageData',
                requestId: message.requestId,
                format: message.format,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    private blobToBase64(blob: Blob): Promise<string> {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onerror = () => reject(reader.error ?? new Error('Failed to read encoded image'));
            reader.onload = () => {
                const result = reader.result;
                if (typeof result !== 'string') {
                    reject(new Error('Encoded image was not returned as a data URL'));
                    return;
                }
                const separator = result.indexOf(',');
                if (separator < 0) {
                    reject(new Error('Encoded image data URL is malformed'));
                    return;
                }
                resolve(result.slice(separator + 1));
            };
            reader.readAsDataURL(blob);
        });
    }

    /**
     * Display an image
     */
    private displayImage(message: DisplayImageMessage): void {
        const previousViewState = message.preserveView && this.currentImageInfo
            ? this.zoomController.getViewState()
            : undefined;
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
            channelFormat: message.channelFormat,
            byteOrder: message.byteOrder,
            name: message.name,
            typeName: message.typeName,
        };

        this.currentImageId = message.id;
        this.currentImageInfo = imageInfo;

        const channelWasReset = this.updateChannelOptions(message.channels, message.channelFormat);

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
        if (previousViewState) {
            this.zoomController.setViewState(previousViewState);
            this.pixelInspector.updatePixelOverlays();
        } else {
            this.zoomController.fitToContainer();
        }

        // Update info display
        if (this.imageInfoElement) {
            this.imageInfoElement.textContent =
                `${message.name} - ${message.width}×${message.height} ${message.typeName}`;
        }

        if (channelWasReset) {
            this.notifyOptionsChanged();
        }

        this.updateZoomDisplay();
    }

    /** Keep channel controls and state consistent with the current image layout. */
    private updateChannelOptions(channels: number, channelFormat?: string): boolean {
        const availableViews = new Set<number>([0]);
        const isGrayAlpha = channels === 2 && channelFormat === 'gray-alpha';

        if (channels === 1 || isGrayAlpha) {
            availableViews.add(1);
        } else if (channels >= 3) {
            availableViews.add(1);
            availableViews.add(2);
            availableViews.add(3);
        }
        if (channels === 4 || isGrayAlpha) {
            availableViews.add(4);
        }

        const channelSelect = document.getElementById('channel-select') as HTMLSelectElement;
        if (channelSelect) {
            for (const option of Array.from(channelSelect.options)) {
                const view = parseInt(option.value, 10);
                const isAvailable = availableViews.has(view);
                option.hidden = !isAvailable;
                option.disabled = !isAvailable;
            }

            const firstChannelOption = Array.from(channelSelect.options)
                .find(option => option.value === '1');
            if (firstChannelOption) {
                firstChannelOption.textContent = channels === 1 || isGrayAlpha ? 'Gray' : 'Red';
            }
        }

        const channelWasReset = !availableViews.has(this.options.channelView);
        if (channelWasReset) {
            this.options.channelView = 0;
        }
        if (channelSelect) {
            channelSelect.value = this.options.channelView.toString();
        }
        return channelWasReset;
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
        this.resetRenderedImage();
        this.showNoImage();
    }

    private resetRenderedImage(): void {
        this.renderer.clear();
        this.currentImageId = '';
        this.currentImageInfo = null;
        this.container.classList.remove('has-image');
        this.zoomController.setImageSize(0, 0);
        this.zoomController.reset();
        this.pixelInspector.updateCursor(-1, -1, -1, -1);
        this.pixelInspector.updatePixelOverlays();
        this.updateZoomDisplay();
        if (this.imageInfoElement) {
            this.imageInfoElement.textContent = 'No image';
        }
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

        if (this.currentImageInfo) {
            this.updateChannelOptions(
                this.currentImageInfo.channels,
                this.currentImageInfo.channelFormat
            );
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
        this.resetRenderedImage();
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

function initializeViewer(): void {
    new ImageViewer();
}

// Choose exactly one initialization path. In particular, `interactive` can be
// observed before DOMContentLoaded fires, so registering and constructing at
// the same time would create two viewers and duplicate every event handler.
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeViewer, { once: true });
} else {
    initializeViewer();
}
