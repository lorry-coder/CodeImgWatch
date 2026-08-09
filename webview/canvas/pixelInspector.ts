import { ImageRenderer } from './imageRenderer';
import { ZoomController } from './zoomController';

const INTEGER_HEX_WIDTHS: Readonly<Record<string, number>> = {
    int8: 2,
    uint8: 2,
    int16: 4,
    uint16: 4,
    int32: 8,
};

/**
 * Format an integer pixel value using its storage width.
 * Negative signed values are represented using two's-complement notation.
 */
export function formatIntegerHex(value: number, pixelType: string): string {
    const width = INTEGER_HEX_WIDTHS[pixelType];
    const roundedValue = Math.round(value);

    if (width === undefined || !Number.isFinite(roundedValue)) {
        return roundedValue.toString(16).toUpperCase();
    }

    const modulus = 2 ** (width * 4);
    const unsignedValue = ((roundedValue % modulus) + modulus) % modulus;
    return unsignedValue.toString(16).padStart(width, '0').toUpperCase();
}

/**
 * Pixel inspector for displaying pixel values
 */
export class PixelInspector {
    private renderer: ImageRenderer;
    private zoomController: ZoomController;
    private container: HTMLElement;

    private cursorPosElement: HTMLElement | null = null;
    private pixelInfoElement: HTMLElement | null = null;

    private currentX: number = -1;
    private currentY: number = -1;
    private displayFormat: 'decimal' | 'hex' = 'decimal';

    private pixelOverlays: HTMLElement[] = [];
    private overlayContainer: HTMLElement | null = null;
    private pixelGridThreshold: number = 8;
    private showPixelGrid: boolean = true;

    constructor(
        renderer: ImageRenderer,
        zoomController: ZoomController,
        container: HTMLElement
    ) {
        this.renderer = renderer;
        this.zoomController = zoomController;
        this.container = container;

        this.cursorPosElement = document.getElementById('cursor-pos');
        this.pixelInfoElement = document.getElementById('pixel-info');

        this.createOverlayContainer();
    }

    /**
     * Create container for pixel value overlays
     */
    private createOverlayContainer(): void {
        this.overlayContainer = document.createElement('div');
        this.overlayContainer.style.position = 'absolute';
        this.overlayContainer.style.top = '0';
        this.overlayContainer.style.left = '0';
        this.overlayContainer.style.pointerEvents = 'none';
        this.overlayContainer.style.overflow = 'hidden';
        this.overlayContainer.style.width = '100%';
        this.overlayContainer.style.height = '100%';
        this.container.appendChild(this.overlayContainer);
    }

    /**
     * Update cursor position display
     */
    updateCursor(screenX: number, screenY: number, imageX: number, imageY: number): void {
        this.currentX = imageX;
        this.currentY = imageY;

        const imageInfo = this.renderer.getImageInfo();
        if (!imageInfo) {
            this.clearDisplay();
            return;
        }

        const { width, height } = imageInfo;

        if (imageX < 0 || imageX >= width || imageY < 0 || imageY >= height) {
            this.clearDisplay();
            return;
        }

        // Update cursor position
        if (this.cursorPosElement) {
            this.cursorPosElement.textContent = `(${imageX}, ${imageY})`;
        }

        // Get and display pixel value
        const values = this.renderer.getPixelValue(imageX, imageY);
        if (values && this.pixelInfoElement) {
            this.pixelInfoElement.textContent = this.formatPixelValue(
                values,
                imageInfo.pixelType,
                imageInfo.channelFormat
            );
        }
    }

    /**
     * Clear the display
     */
    clearDisplay(): void {
        if (this.cursorPosElement) {
            this.cursorPosElement.textContent = '';
        }
        if (this.pixelInfoElement) {
            this.pixelInfoElement.textContent = '';
        }
    }

    /**
     * Format pixel values for display
     */
    private formatPixelValue(values: number[], pixelType: string, channelFormat?: string): string {
        const isFloat = pixelType.startsWith('float');
        const channelNames = this.getChannelNames(values.length, channelFormat);

        const formatted = values.map((v, i) => {
            const channelName = channelNames[i] ?? `C${i}`;

            if (this.displayFormat === 'hex' && !isFloat) {
                const hex = formatIntegerHex(v, pixelType);
                return `${channelName}:0x${hex}`;
            } else if (isFloat) {
                return `${channelName}:${v.toFixed(4)}`;
            } else {
                return `${channelName}:${Math.round(v)}`;
            }
        });

        return formatted.join(' ');
    }

    /**
     * Format a single value
     */
    private formatValue(value: number, pixelType: string): string {
        const isFloat = pixelType.startsWith('float');

        if (this.displayFormat === 'hex' && !isFloat) {
            return formatIntegerHex(value, pixelType);
        } else if (isFloat) {
            return value.toFixed(2);
        } else {
            return Math.round(value).toString();
        }
    }

    /**
     * Set display format
     */
    setDisplayFormat(format: 'decimal' | 'hex'): void {
        this.displayFormat = format;
        this.updatePixelOverlays();
    }

    /**
     * Set pixel grid display threshold
     */
    setPixelGridThreshold(threshold: number): void {
        this.pixelGridThreshold = threshold;
        this.updatePixelOverlays();
    }

    /**
     * Set whether to show pixel grid
     */
    setShowPixelGrid(show: boolean): void {
        this.showPixelGrid = show;
        this.updatePixelOverlays();
    }

    /**
     * Update pixel value overlays based on zoom level
     */
    updatePixelOverlays(): void {
        if (!this.overlayContainer) {
            return;
        }

        // Clear existing overlays
        this.overlayContainer.innerHTML = '';
        this.pixelOverlays = [];

        const zoom = this.zoomController.getZoom();
        const imageInfo = this.renderer.getImageInfo();

        if (!this.showPixelGrid || zoom < this.pixelGridThreshold || !imageInfo) {
            return;
        }

        const viewState = this.zoomController.getViewState();
        const { width, height, pixelType, channels } = imageInfo;

        // Calculate visible area in image coordinates
        const containerWidth = this.container.clientWidth;
        const containerHeight = this.container.clientHeight;

        const startX = Math.max(0, Math.floor(-viewState.panX / zoom));
        const startY = Math.max(0, Math.floor(-viewState.panY / zoom));
        const endX = Math.min(width, Math.ceil((containerWidth - viewState.panX) / zoom));
        const endY = Math.min(height, Math.ceil((containerHeight - viewState.panY) / zoom));

        // Limit number of overlays for performance
        const maxOverlays = 2500;
        const visiblePixels = (endX - startX) * (endY - startY);

        if (visiblePixels > maxOverlays) {
            return; // Too many pixels, skip overlay
        }

        // Create overlay for each visible pixel
        for (let y = startY; y < endY; y++) {
            for (let x = startX; x < endX; x++) {
                const values = this.renderer.getPixelValue(x, y);
                if (!values) {
                    continue;
                }

                const overlay = document.createElement('div');
                overlay.className = 'pixel-value-overlay';

                // Position
                const screenX = x * zoom + viewState.panX;
                const screenY = y * zoom + viewState.panY;
                overlay.style.left = `${screenX}px`;
                overlay.style.top = `${screenY}px`;
                overlay.style.width = `${zoom}px`;
                overlay.style.height = `${zoom}px`;
                overlay.style.lineHeight = `${zoom}px`;

                // Adjust font size based on zoom
                const fontSize = Math.max(8, Math.min(12, zoom / (channels > 1 ? 4 : 2)));
                overlay.style.fontSize = `${fontSize}px`;

                // Format value(s)
                let text: string;
                if (channels === 1) {
                    text = this.formatValue(values[0], pixelType);
                } else if (zoom >= 32) {
                    // Show all channels if zoomed in enough
                    text = values.map(v => this.formatValue(v, pixelType)).join('\n');
                    overlay.style.lineHeight = `${zoom / channels}px`;
                } else {
                    // Show abbreviated
                    text = values.map(v => this.formatValue(v, pixelType)).join(',');
                }

                overlay.textContent = text;

                // Determine text color based on brightness
                const brightness = this.calculateBrightness(values, channels, imageInfo.channelFormat);
                overlay.style.color = brightness > 128 ? 'black' : 'white';
                overlay.style.textShadow = brightness > 128
                    ? '0 0 2px white, 0 0 2px white'
                    : '0 0 2px black, 0 0 2px black';

                this.overlayContainer.appendChild(overlay);
                this.pixelOverlays.push(overlay);
            }
        }
    }

    /**
     * Calculate brightness for text color selection
     */
    private calculateBrightness(values: number[], channels: number, channelFormat?: string): number {
        if (channels === 1) {
            return values[0];
        } else if (channelFormat === 'gray-alpha') {
            return values[0];
        } else if (channels >= 3) {
            const isRgb = channelFormat === 'rgb' || channelFormat === 'rgba';
            return isRgb
                ? 0.299 * values[0] + 0.587 * values[1] + 0.114 * values[2]
                : 0.114 * values[0] + 0.587 * values[1] + 0.299 * values[2];
        } else {
            return values.reduce((a, b) => a + b, 0) / values.length;
        }
    }

    private getChannelNames(channels: number, channelFormat?: string): string[] {
        if (channels === 1) {
            return ['Y'];
        }
        if (channelFormat === 'gray-alpha') {
            return ['Y', 'A'];
        }
        if (channelFormat === 'rgb' || channelFormat === 'rgba') {
            return ['R', 'G', 'B', 'A'];
        }
        return ['B', 'G', 'R', 'A'];
    }

    /**
     * Get pixel value at current cursor position (for copying)
     */
    getCurrentPixelValue(): string | null {
        if (this.currentX < 0 || this.currentY < 0) {
            return null;
        }

        const imageInfo = this.renderer.getImageInfo();
        if (!imageInfo) {
            return null;
        }

        const values = this.renderer.getPixelValue(this.currentX, this.currentY);
        if (!values) {
            return null;
        }

        return `(${this.currentX}, ${this.currentY}): ${values.join(', ')}`;
    }
}
