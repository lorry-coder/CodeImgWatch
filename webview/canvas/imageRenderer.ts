import { colorMaps } from './colormap';

/**
 * Image data received from extension
 */
export interface ImageInfo {
    id: string;
    data: Uint8Array;
    width: number;
    height: number;
    channels: number;
    pixelType: string;
    stride: number;
    name: string;
    typeName: string;
}

/**
 * Display options for rendering
 */
export interface RenderOptions {
    autoNormalize: boolean;
    colormap: string;
    channelView: number; // 0=all, 1=R, 2=G, 3=B, 4=A
    ignoreAlpha: boolean;
}

/**
 * Renders image data to a canvas
 */
export class ImageRenderer {
    private canvas: HTMLCanvasElement;
    private ctx: CanvasRenderingContext2D;
    private imageData: ImageData | null = null;
    private currentInfo: ImageInfo | null = null;
    private rawData: Uint8Array | null = null;

    constructor(canvas: HTMLCanvasElement) {
        this.canvas = canvas;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) {
            throw new Error('Failed to get 2D context');
        }
        this.ctx = ctx;
    }

    /**
     * Render image data with given options
     */
    render(info: ImageInfo, options: RenderOptions): void {
        this.currentInfo = info;
        this.rawData = info.data;

        // Set canvas size
        this.canvas.width = info.width;
        this.canvas.height = info.height;

        // Create ImageData
        this.imageData = this.ctx.createImageData(info.width, info.height);

        // Convert pixel data based on type and options
        this.convertPixelData(info, options);

        // Draw to canvas
        this.ctx.putImageData(this.imageData, 0, 0);
    }

    /**
     * Update rendering with new options (without re-reading data)
     */
    updateRender(options: RenderOptions): void {
        if (!this.currentInfo || !this.rawData) {
            return;
        }

        const info = { ...this.currentInfo, data: this.rawData };
        this.render(info, options);
    }

    /**
     * Convert raw pixel data to RGBA ImageData
     */
    private convertPixelData(info: ImageInfo, options: RenderOptions): void {
        if (!this.imageData) {
            return;
        }

        const { width, height, channels, pixelType, stride, data } = info;
        const output = this.imageData.data;

        // Get pixel size in bytes
        const pixelSize = this.getPixelSize(pixelType);
        const rowSize = width * channels * pixelSize;

        // Calculate normalization range if needed
        let minVal = 0;
        let maxVal = 255;
        if (options.autoNormalize && pixelType !== 'uint8') {
            const range = this.findValueRange(data, width, height, channels, pixelType, stride);
            minVal = range.min;
            maxVal = range.max;
            if (maxVal === minVal) {
                maxVal = minVal + 1; // Avoid division by zero
            }
        } else if (pixelType === 'uint8') {
            minVal = 0;
            maxVal = 255;
        } else if (pixelType === 'uint16') {
            minVal = 0;
            maxVal = 65535;
        } else if (pixelType === 'float32' || pixelType === 'float64') {
            minVal = 0;
            maxVal = 1;
        }

        // Single channel view?
        const singleChannel = options.channelView > 0 ? options.channelView - 1 : -1;

        for (let y = 0; y < height; y++) {
            const rowOffset = y * stride;

            for (let x = 0; x < width; x++) {
                const pixelOffset = rowOffset + x * channels * pixelSize;
                const outOffset = (y * width + x) * 4;

                // Read pixel values
                const values: number[] = [];
                for (let c = 0; c < channels; c++) {
                    const byteOffset = pixelOffset + c * pixelSize;
                    let value = this.readPixelValue(data, byteOffset, pixelType);

                    // Normalize
                    value = ((value - minVal) / (maxVal - minVal)) * 255;
                    value = Math.max(0, Math.min(255, value));
                    values.push(value);
                }

                // Convert to RGBA based on channel count and options
                if (singleChannel >= 0 && singleChannel < channels) {
                    // Single channel view - grayscale
                    const v = values[singleChannel];
                    if (channels === 1 && options.colormap !== 'grayscale') {
                        const color = this.applyColormap(v / 255, options.colormap);
                        output[outOffset] = color[0];
                        output[outOffset + 1] = color[1];
                        output[outOffset + 2] = color[2];
                    } else {
                        output[outOffset] = v;
                        output[outOffset + 1] = v;
                        output[outOffset + 2] = v;
                    }
                    output[outOffset + 3] = 255;
                } else if (channels === 1) {
                    // Grayscale
                    const v = values[0];
                    if (options.colormap !== 'grayscale') {
                        const color = this.applyColormap(v / 255, options.colormap);
                        output[outOffset] = color[0];
                        output[outOffset + 1] = color[1];
                        output[outOffset + 2] = color[2];
                    } else {
                        output[outOffset] = v;
                        output[outOffset + 1] = v;
                        output[outOffset + 2] = v;
                    }
                    output[outOffset + 3] = 255;
                } else if (channels === 3) {
                    // BGR -> RGB
                    output[outOffset] = values[2];     // R
                    output[outOffset + 1] = values[1]; // G
                    output[outOffset + 2] = values[0]; // B
                    output[outOffset + 3] = 255;
                } else if (channels === 4) {
                    // BGRA -> RGBA
                    output[outOffset] = values[2];     // R
                    output[outOffset + 1] = values[1]; // G
                    output[outOffset + 2] = values[0]; // B
                    output[outOffset + 3] = options.ignoreAlpha ? 255 : values[3]; // A
                } else {
                    // Other channel counts - just use first 3
                    output[outOffset] = values[0] ?? 0;
                    output[outOffset + 1] = values[1] ?? 0;
                    output[outOffset + 2] = values[2] ?? 0;
                    output[outOffset + 3] = 255;
                }
            }
        }
    }

    /**
     * Read a pixel value from the buffer
     */
    private readPixelValue(data: Uint8Array, offset: number, pixelType: string): number {
        if (offset < 0 || offset >= data.length) {
            return 0;
        }

        switch (pixelType) {
            case 'uint8':
                return data[offset];

            case 'int8': {
                const v = data[offset];
                return v > 127 ? v - 256 : v;
            }

            case 'uint16':
                return data[offset] | (data[offset + 1] << 8);

            case 'int16': {
                const v = data[offset] | (data[offset + 1] << 8);
                return v > 32767 ? v - 65536 : v;
            }

            case 'int32': {
                const v = data[offset] | (data[offset + 1] << 8) |
                    (data[offset + 2] << 16) | (data[offset + 3] << 24);
                return v;
            }

            case 'float32': {
                const buffer = new ArrayBuffer(4);
                const view = new DataView(buffer);
                for (let i = 0; i < 4; i++) {
                    view.setUint8(i, data[offset + i]);
                }
                return view.getFloat32(0, true);
            }

            case 'float64': {
                const buffer = new ArrayBuffer(8);
                const view = new DataView(buffer);
                for (let i = 0; i < 8; i++) {
                    view.setUint8(i, data[offset + i]);
                }
                return view.getFloat64(0, true);
            }

            default:
                return data[offset];
        }
    }

    /**
     * Get pixel size in bytes
     */
    private getPixelSize(pixelType: string): number {
        switch (pixelType) {
            case 'uint8':
            case 'int8':
                return 1;
            case 'uint16':
            case 'int16':
            case 'float16':
                return 2;
            case 'int32':
            case 'float32':
                return 4;
            case 'float64':
                return 8;
            default:
                return 1;
        }
    }

    /**
     * Find min/max values for normalization
     */
    private findValueRange(
        data: Uint8Array,
        width: number,
        height: number,
        channels: number,
        pixelType: string,
        stride: number
    ): { min: number; max: number } {
        const pixelSize = this.getPixelSize(pixelType);
        let min = Infinity;
        let max = -Infinity;

        // Sample every nth pixel for performance on large images
        const sampleStep = Math.max(1, Math.floor(width * height / 10000));
        let count = 0;

        for (let y = 0; y < height; y++) {
            const rowOffset = y * stride;
            for (let x = 0; x < width; x++) {
                count++;
                if (count % sampleStep !== 0) continue;

                const pixelOffset = rowOffset + x * channels * pixelSize;
                for (let c = 0; c < channels; c++) {
                    const byteOffset = pixelOffset + c * pixelSize;
                    const value = this.readPixelValue(data, byteOffset, pixelType);
                    if (isFinite(value)) {
                        min = Math.min(min, value);
                        max = Math.max(max, value);
                    }
                }
            }
        }

        if (!isFinite(min)) min = 0;
        if (!isFinite(max)) max = 1;

        return { min, max };
    }

    /**
     * Apply colormap to a normalized value [0, 1]
     */
    private applyColormap(value: number, mapName: string): [number, number, number] {
        const map = colorMaps[mapName] ?? colorMaps.grayscale;
        value = Math.max(0, Math.min(1, value));

        const index = Math.floor(value * (map.length - 1));
        return map[index];
    }

    /**
     * Get pixel value at coordinates
     */
    getPixelValue(x: number, y: number): number[] | null {
        if (!this.currentInfo || !this.rawData) {
            return null;
        }

        const { width, height, channels, pixelType, stride } = this.currentInfo;
        if (x < 0 || x >= width || y < 0 || y >= height) {
            return null;
        }

        const pixelSize = this.getPixelSize(pixelType);
        const pixelOffset = y * stride + x * channels * pixelSize;

        const values: number[] = [];
        for (let c = 0; c < channels; c++) {
            const byteOffset = pixelOffset + c * pixelSize;
            values.push(this.readPixelValue(this.rawData, byteOffset, pixelType));
        }

        return values;
    }

    /**
     * Get current image info
     */
    getImageInfo(): ImageInfo | null {
        return this.currentInfo;
    }

    /**
     * Clear the canvas
     */
    clear(): void {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.imageData = null;
        this.currentInfo = null;
        this.rawData = null;
    }
}
