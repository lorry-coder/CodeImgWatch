/**
 * View state for zoom and pan
 */
export interface ViewState {
    zoom: number;
    panX: number;
    panY: number;
}

/**
 * Controller for zoom and pan interactions
 */
export class ZoomController {
    private zoom: number = 1;
    private panX: number = 0;
    private panY: number = 0;

    private isDragging: boolean = false;
    private lastMouseX: number = 0;
    private lastMouseY: number = 0;

    private containerWidth: number = 0;
    private containerHeight: number = 0;
    private imageWidth: number = 0;
    private imageHeight: number = 0;

    private minZoom: number = 0.1;
    private maxZoom: number = 64;

    private canvas: HTMLCanvasElement;
    private container: HTMLElement;

    private onViewChange?: (state: ViewState) => void;
    private onCursorMove?: (x: number, y: number, imageX: number, imageY: number) => void;

    constructor(canvas: HTMLCanvasElement, container: HTMLElement) {
        this.canvas = canvas;
        this.container = container;
        this.setupEventListeners();
    }

    /**
     * Set callback for view state changes
     */
    setOnViewChange(callback: (state: ViewState) => void): void {
        this.onViewChange = callback;
    }

    /**
     * Set callback for cursor movement
     */
    setOnCursorMove(callback: (x: number, y: number, imageX: number, imageY: number) => void): void {
        this.onCursorMove = callback;
    }

    /**
     * Update image dimensions
     */
    setImageSize(width: number, height: number): void {
        this.imageWidth = width;
        this.imageHeight = height;
        this.updateContainerSize();
    }

    /**
     * Update container dimensions
     */
    updateContainerSize(): void {
        this.containerWidth = this.container.clientWidth;
        this.containerHeight = this.container.clientHeight;
    }

    /**
     * Get current zoom level
     */
    getZoom(): number {
        return this.zoom;
    }

    /**
     * Get current view state
     */
    getViewState(): ViewState {
        return {
            zoom: this.zoom,
            panX: this.panX,
            panY: this.panY,
        };
    }

    /**
     * Set view state (for syncing)
     */
    setViewState(state: ViewState): void {
        this.zoom = state.zoom;
        this.panX = state.panX;
        this.panY = state.panY;
        this.applyTransform();
    }

    /**
     * Fit image to container
     */
    fitToContainer(): void {
        if (this.imageWidth === 0 || this.imageHeight === 0) {
            return;
        }

        this.updateContainerSize();

        const scaleX = this.containerWidth / this.imageWidth;
        const scaleY = this.containerHeight / this.imageHeight;
        this.zoom = Math.min(scaleX, scaleY) * 0.95; // 95% to leave some margin
        this.zoom = Math.max(this.minZoom, Math.min(this.maxZoom, this.zoom));

        // Center the image
        this.panX = (this.containerWidth - this.imageWidth * this.zoom) / 2;
        this.panY = (this.containerHeight - this.imageHeight * this.zoom) / 2;

        this.applyTransform();
        this.notifyViewChange();
    }

    /**
     * Set zoom to actual size (100%)
     */
    actualSize(): void {
        this.zoom = 1;

        // Center the image
        this.updateContainerSize();
        this.panX = (this.containerWidth - this.imageWidth) / 2;
        this.panY = (this.containerHeight - this.imageHeight) / 2;

        this.applyTransform();
        this.notifyViewChange();
    }

    /**
     * Set zoom level
     */
    setZoom(zoom: number, centerX?: number, centerY?: number): void {
        const oldZoom = this.zoom;
        this.zoom = Math.max(this.minZoom, Math.min(this.maxZoom, zoom));

        if (centerX !== undefined && centerY !== undefined) {
            // Zoom around the specified point
            const scale = this.zoom / oldZoom;
            this.panX = centerX - (centerX - this.panX) * scale;
            this.panY = centerY - (centerY - this.panY) * scale;
        }

        this.applyTransform();
        this.notifyViewChange();
    }

    /**
     * Apply CSS transform to canvas
     */
    private applyTransform(): void {
        this.canvas.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.zoom})`;
        this.canvas.style.transformOrigin = '0 0';
    }

    /**
     * Convert screen coordinates to image coordinates
     */
    screenToImage(screenX: number, screenY: number): { x: number; y: number } {
        const rect = this.container.getBoundingClientRect();
        const x = (screenX - rect.left - this.panX) / this.zoom;
        const y = (screenY - rect.top - this.panY) / this.zoom;
        return {
            x: Math.floor(x),
            y: Math.floor(y),
        };
    }

    /**
     * Convert image coordinates to screen coordinates
     */
    imageToScreen(imageX: number, imageY: number): { x: number; y: number } {
        const rect = this.container.getBoundingClientRect();
        return {
            x: imageX * this.zoom + this.panX + rect.left,
            y: imageY * this.zoom + this.panY + rect.top,
        };
    }

    /**
     * Set up event listeners
     */
    private setupEventListeners(): void {
        // Mouse wheel for zoom
        this.container.addEventListener('wheel', (e) => this.handleWheel(e), { passive: false });

        // Mouse drag for pan
        this.container.addEventListener('mousedown', (e) => this.handleMouseDown(e));
        document.addEventListener('mousemove', (e) => this.handleMouseMove(e));
        document.addEventListener('mouseup', () => this.handleMouseUp());

        // Double click to reset
        this.container.addEventListener('dblclick', () => this.fitToContainer());

        // Track mouse position
        this.container.addEventListener('mousemove', (e) => this.handleCursorMove(e));
        this.container.addEventListener('mouseleave', () => this.handleCursorLeave());

        // Resize observer
        const resizeObserver = new ResizeObserver(() => {
            this.updateContainerSize();
        });
        resizeObserver.observe(this.container);
    }

    /**
     * Handle mouse wheel for zooming
     */
    private handleWheel(e: WheelEvent): void {
        e.preventDefault();

        const rect = this.container.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
        const newZoom = this.zoom * zoomFactor;

        this.setZoom(newZoom, mouseX, mouseY);
    }

    /**
     * Handle mouse down for panning
     */
    private handleMouseDown(e: MouseEvent): void {
        if (e.button === 0) { // Left button
            this.isDragging = true;
            this.lastMouseX = e.clientX;
            this.lastMouseY = e.clientY;
            this.container.classList.add('dragging');
        }
    }

    /**
     * Handle mouse move for panning
     */
    private handleMouseMove(e: MouseEvent): void {
        if (!this.isDragging) {
            return;
        }

        const dx = e.clientX - this.lastMouseX;
        const dy = e.clientY - this.lastMouseY;

        this.panX += dx;
        this.panY += dy;

        this.lastMouseX = e.clientX;
        this.lastMouseY = e.clientY;

        this.applyTransform();
        this.notifyViewChange();
    }

    /**
     * Handle mouse up
     */
    private handleMouseUp(): void {
        this.isDragging = false;
        this.container.classList.remove('dragging');
    }

    /**
     * Handle cursor movement for position tracking
     */
    private handleCursorMove(e: MouseEvent): void {
        if (this.isDragging || !this.onCursorMove) {
            return;
        }

        const rect = this.container.getBoundingClientRect();
        const screenX = e.clientX;
        const screenY = e.clientY;
        const imagePos = this.screenToImage(screenX, screenY);

        this.onCursorMove(screenX - rect.left, screenY - rect.top, imagePos.x, imagePos.y);
    }

    /**
     * Handle cursor leaving the container
     */
    private handleCursorLeave(): void {
        if (this.onCursorMove) {
            this.onCursorMove(-1, -1, -1, -1);
        }
    }

    /**
     * Notify view change callback
     */
    private notifyViewChange(): void {
        if (this.onViewChange) {
            this.onViewChange(this.getViewState());
        }
    }

    /**
     * Reset view state
     */
    reset(): void {
        this.zoom = 1;
        this.panX = 0;
        this.panY = 0;
        this.applyTransform();
    }
}
