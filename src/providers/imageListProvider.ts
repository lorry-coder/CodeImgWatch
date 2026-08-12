import * as vscode from 'vscode';
import { DebugSessionManager, EvaluateResponse, VariableInfo } from '../core/debugSessionManager';
import { resolveImageExpression } from '../core/imageResolver';
import { ImageParserRegistry, normalizeTypeName } from '../parsers/baseParser';
import { ImageItem } from '../types';

/**
 * Tree item representing an image in the list
 */
export class ImageTreeItem extends vscode.TreeItem {
    constructor(
        public readonly imageItem: ImageItem,
        collapsibleState: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.None
    ) {
        super(imageItem.label, collapsibleState);

        this.description = imageItem.description;
        this.tooltip = imageItem.tooltip;
        const isAvailable = Boolean(imageItem.metadata ?? imageItem.imageData?.metadata);
        this.contextValue = imageItem.isWatch
            ? isAvailable ? 'watchItem' : 'watchItemUnavailable'
            : isAvailable ? 'imageItem' : 'imageItemUnavailable';

        // Set icon based on state
        if (imageItem.error) {
            this.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('errorForeground'));
        } else if (imageItem.metadata) {
            this.iconPath = new vscode.ThemeIcon('file-media');
        } else if (imageItem.availability === 'inactive') {
            this.iconPath = new vscode.ThemeIcon('debug-disconnect');
        } else if (imageItem.availability === 'running') {
            this.iconPath = new vscode.ThemeIcon('debug-continue');
        } else if (imageItem.availability === 'paused') {
            this.iconPath = new vscode.ThemeIcon('debug-pause');
        } else {
            // Unknown entries should remain static. A spinning icon is reserved for
            // real background work, and list refreshes do not publish intermediate items.
            this.iconPath = new vscode.ThemeIcon('circle-outline');
        }

        this.accessibilityInformation = {
            label: `${imageItem.label}, ${imageItem.description}`,
        };

        // Unavailable placeholders are deliberately inert: selecting one cannot
        // produce an image and should never trigger debugger evaluation.
        if (imageItem.metadata || imageItem.error) {
            this.command = {
                command: 'imview.selectImage',
                title: 'Select Image',
                arguments: [this.imageItem],
            };
        }
    }
}

/**
 * Tree item for section headers (Locals, Watch)
 */
export class SectionTreeItem extends vscode.TreeItem {
    constructor(
        label: string,
        public readonly section: 'locals' | 'watch',
        childCount: number
    ) {
        super(label, vscode.TreeItemCollapsibleState.Expanded);
        this.contextValue = `section_${section}`;
        this.description = `(${childCount})`;
        this.iconPath = new vscode.ThemeIcon(section === 'locals' ? 'symbol-variable' : 'eye');
    }
}

type TreeItemType = ImageTreeItem | SectionTreeItem;

/**
 * Provider for the Image Watch tree view
 */
export class ImageListProvider implements vscode.TreeDataProvider<TreeItemType>, vscode.Disposable {
    private disposables: vscode.Disposable[] = [];
    private sessionManager: DebugSessionManager;
    private parserRegistry: ImageParserRegistry;

    private localImages: ImageItem[] = [];
    private watchExpressions: string[] = [];
    private watchImages: ImageItem[] = [];
    private stateEpoch = 0;
    private refreshInFlight?: Promise<void>;
    private refreshQueued = false;
    private watchResolutionInFlight = new Map<string, Promise<ImageItem | undefined>>();

    private _onDidChangeTreeData = new vscode.EventEmitter<TreeItemType | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    // Event fired when an image is selected
    private _onDidSelectImage = new vscode.EventEmitter<ImageItem>();
    readonly onDidSelectImage = this._onDidSelectImage.event;

    private _onDidRefreshImages = new vscode.EventEmitter<readonly ImageItem[]>();
    readonly onDidRefreshImages = this._onDidRefreshImages.event;

    constructor(private context: vscode.ExtensionContext) {
        this.sessionManager = DebugSessionManager.getInstance();
        this.parserRegistry = ImageParserRegistry.getInstance();

        // Load saved watch expressions
        this.watchExpressions = context.workspaceState.get<string[]>('imview.watchExpressions', []);
        this.watchImages = this.createWatchPlaceholders(this.getUnavailableState());

        this.setupEventListeners();
    }

    private setupEventListeners(): void {
        // Refresh when debugger stops
        this.disposables.push(
            this.sessionManager.onDidStopOnBreakpoint(() => {
                const autoRefresh = vscode.workspace.getConfiguration('imview').get('autoRefresh', true);
                this.showUnavailableState('paused');
                if (autoRefresh) {
                    void this.refresh();
                }
            })
        );

        // Clear when session ends
        this.disposables.push(
            this.sessionManager.onDidChangeSession(session => {
                this.showUnavailableState(session ? 'running' : 'inactive');
            })
        );

        // Clear when continuing execution
        this.disposables.push(
            this.sessionManager.onDidContinue(() => {
                this.showUnavailableState('running');
            })
        );
    }

    getTreeItem(element: TreeItemType): vscode.TreeItem {
        return element;
    }

    getChildren(element?: TreeItemType): Thenable<TreeItemType[]> {
        if (!element) {
            // Root level: return sections
            const sections: TreeItemType[] = [];

            // Show Locals section if we have images or debugger is active
            if (this.localImages.length > 0 || (this.sessionManager.activeSession && this.sessionManager.isPaused)) {
                sections.push(new SectionTreeItem('Locals', 'locals', this.localImages.length));
            }

            // Always show watch section if there are expressions OR watch images
            if (this.watchExpressions.length > 0 || this.watchImages.length > 0) {
                sections.push(new SectionTreeItem('Watch', 'watch', this.watchImages.length));
            }

            return Promise.resolve(sections);
        }

        if (element instanceof SectionTreeItem) {
            if (element.section === 'locals') {
                return Promise.resolve(this.localImages.map(item => new ImageTreeItem(item)));
            } else {
                return Promise.resolve(this.watchImages.map(item => new ImageTreeItem(item)));
            }
        }

        return Promise.resolve([]);
    }

    /**
     * Refresh the image list
     */
    async refresh(): Promise<void> {
        if (!this.sessionManager.activeSession || !this.sessionManager.isPaused) {
            this.refreshQueued = false;
            this.showUnavailableState(this.getUnavailableState(), false);
            return;
        }

        if (this.refreshInFlight) {
            // Coalesce any number of overlapping requests into one latest-state pass.
            this.refreshQueued = true;
            return this.refreshInFlight;
        }

        const refresh = this.runRefreshLoop();
        this.refreshInFlight = refresh;
        try {
            await refresh;
        } finally {
            if (this.refreshInFlight === refresh) {
                this.refreshInFlight = undefined;
            }
        }
    }

    private async runRefreshLoop(): Promise<void> {
        do {
            this.refreshQueued = false;
            await this.performRefresh();
        } while (this.refreshQueued &&
            Boolean(this.sessionManager.activeSession) &&
            this.sessionManager.isPaused);
    }

    private async performRefresh(): Promise<void> {
        if (!this.sessionManager.activeSession || !this.sessionManager.isPaused) {
            return;
        }

        const epoch = this.stateEpoch;
        const watchExpressions = [...this.watchExpressions];
        const pendingAtStart = [...this.watchResolutionInFlight.entries()]
            .filter(([expression]) => watchExpressions.includes(expression));
        const resolvedOnDemand = new Map<string, ImageItem>();

        // Only await tasks that predate this refresh. An ensure request that starts
        // later observes refreshInFlight and waits for this pass instead.
        await Promise.all(pendingAtStart.map(async ([expression, pending]) => {
            try {
                const item = await pending;
                if (item?.metadata || item?.error) {
                    resolvedOnDemand.set(expression, item);
                }
            } catch {
                // The regular refresh path below can retry a failed on-demand task.
            }
        }));
        if (!this.isRefreshCurrent(epoch)) {
            return;
        }

        // Scan local variables
        const localImages = await this.scanLocalVariables(epoch);
        if (!this.isRefreshCurrent(epoch)) {
            return;
        }

        // Evaluate watch expressions
        const watchImages = await this.evaluateWatchExpressions(
            watchExpressions,
            localImages,
            resolvedOnDemand,
            epoch
        );

        if (!this.isRefreshCurrent(epoch)) {
            return;
        }

        this.localImages = localImages;
        // A watch can be removed while a debugger request is in flight.
        this.watchImages = watchImages.filter(item =>
            this.watchExpressions.includes(item.expression)
        );

        this._onDidChangeTreeData.fire();
        this._onDidRefreshImages.fire(this.getAllImages());
    }

    private isRefreshCurrent(epoch: number): boolean {
        return epoch === this.stateEpoch &&
            Boolean(this.sessionManager.activeSession) &&
            this.sessionManager.isPaused;
    }

    /**
     * Scan local variables for image types
     */
    private async scanLocalVariables(epoch: number): Promise<ImageItem[]> {
        const images: ImageItem[] = [];

        try {
            const locals = await this.sessionManager.getLocalVariables();

            for (const variable of locals) {
                if (!this.isRefreshCurrent(epoch)) {
                    break;
                }
                const typeName = variable.type ?? '';
                const normalizedType = normalizeTypeName(typeName);

                if (this.parserRegistry.findParser(normalizedType)) {
                    const expression = variable.evaluateName ?? variable.name;
                    const item = await this.resolveImageItem(
                        expression,
                        false,
                        variable.name,
                        this.toEvaluateResponse(variable)
                    );
                    images.push(item);
                }
            }
        } catch (error) {
            console.error('Failed to scan local variables:', error);
        }
        return images;
    }

    /**
     * Evaluate all watch expressions
     */
    private async evaluateWatchExpressions(
        expressions: readonly string[],
        localImages: readonly ImageItem[],
        resolvedOnDemand: ReadonlyMap<string, ImageItem>,
        epoch: number
    ): Promise<ImageItem[]> {
        const images: ImageItem[] = [];
        const localsByExpression = new Map<string, ImageItem>();
        for (const local of localImages) {
            if (!localsByExpression.has(local.expression)) {
                localsByExpression.set(local.expression, local);
            }
        }

        for (const expr of expressions) {
            if (!this.isRefreshCurrent(epoch)) {
                break;
            }
            if (!this.watchExpressions.includes(expr)) {
                continue;
            }
            const onDemand = resolvedOnDemand.get(expr);
            const matchingLocal = localsByExpression.get(expr);
            if (onDemand?.metadata ?? onDemand?.imageData?.metadata) {
                images.push(onDemand);
            } else if (matchingLocal?.metadata ?? matchingLocal?.imageData?.metadata) {
                images.push(this.createWatchItemFromLocal(matchingLocal, expr));
            } else if (onDemand?.error) {
                images.push(onDemand);
            } else if (matchingLocal) {
                images.push(this.createWatchItemFromLocal(matchingLocal, expr));
            } else {
                images.push(await this.resolveImageItem(expr, true));
            }
        }
        return images;
    }

    private createWatchItemFromLocal(local: ImageItem, expression: string): ImageItem {
        return {
            ...local,
            id: `watch_${expression}`,
            label: expression,
            expression,
            isWatch: true,
        };
    }

    /**
     * Resolve a persisted Watch item on demand without forcing a full list scan.
     */
    async ensureWatchImage(expression: string): Promise<ImageItem | undefined> {
        expression = expression.trim();
        if (!expression || !this.watchExpressions.includes(expression)) {
            return undefined;
        }

        const pending = this.watchResolutionInFlight.get(expression);
        if (pending) {
            return pending;
        }

        const existing = this.watchImages.find(item => item.expression === expression);
        if (existing?.metadata || existing?.error) {
            return existing;
        }

        // A refresh that registered first owns debugger access. Wait before adding
        // this request to watchResolutionInFlight so the refresh never awaits us.
        const currentRefresh = this.refreshInFlight;
        if (currentRefresh) {
            await currentRefresh;
            if (!this.watchExpressions.includes(expression)) {
                return undefined;
            }
            const refreshed = this.watchImages.find(item => item.expression === expression);
            if (refreshed?.metadata || refreshed?.error ||
                !this.sessionManager.activeSession || !this.sessionManager.isPaused) {
                return refreshed;
            }
            const newlyPending = this.watchResolutionInFlight.get(expression);
            if (newlyPending) {
                return newlyPending;
            }
        }

        const resolution = this.resolveWatchOnDemand(expression);
        this.watchResolutionInFlight.set(expression, resolution);
        try {
            return await resolution;
        } finally {
            if (this.watchResolutionInFlight.get(expression) === resolution) {
                this.watchResolutionInFlight.delete(expression);
            }
        }
    }

    private async resolveWatchOnDemand(expression: string): Promise<ImageItem | undefined> {
        const existing = this.watchImages.find(item => item.expression === expression);
        if (existing?.metadata || existing?.error) {
            return existing;
        }

        if (!this.sessionManager.activeSession || !this.sessionManager.isPaused) {
            return existing;
        }

        const matchingLocal = this.localImages.find(local => local.expression === expression);
        if (matchingLocal) {
            return this.replaceWatchImage(
                expression,
                this.createWatchItemFromLocal(matchingLocal, expression)
            );
        }

        const epoch = this.stateEpoch;
        const sessionId = this.sessionManager.activeSession.id;
        const resolved = await this.resolveImageItem(expression, true);
        if (epoch !== this.stateEpoch ||
            this.sessionManager.activeSession?.id !== sessionId ||
            !this.sessionManager.isPaused) {
            return this.watchImages.find(item => item.expression === expression);
        }

        return this.replaceWatchImage(expression, resolved);
    }

    private replaceWatchImage(expression: string, replacement: ImageItem): ImageItem | undefined {
        const expressionIndex = this.watchExpressions.indexOf(expression);
        if (expressionIndex === -1) {
            return undefined;
        }

        const index = this.watchImages.findIndex(item => item.expression === expression);
        if (index === -1) {
            this.watchImages.splice(
                Math.min(expressionIndex, this.watchImages.length),
                0,
                replacement
            );
        } else {
            this.watchImages[index] = replacement;
        }
        this._onDidChangeTreeData.fire();
        this._onDidRefreshImages.fire(this.getAllImages());
        return replacement;
    }

    /**
     * Create an ImageItem from an expression
     */
    async resolveImageItem(
        expression: string,
        isWatch: boolean,
        displayName: string = expression,
        evaluateResult?: EvaluateResponse
    ): Promise<ImageItem> {
        const id = `${isWatch ? 'watch' : 'local'}_${expression}`;
        try {
            const resolved = await resolveImageExpression(this.sessionManager, expression, evaluateResult);
            if (!resolved.success || !resolved.metadata) {
                return {
                    id,
                    label: displayName,
                    description: resolved.error ?? 'Parse failed',
                    tooltip: `${expression}\n${resolved.error ?? 'Parse failed'}`,
                    expression,
                    isWatch,
                    error: resolved.error,
                };
            }

            const meta = resolved.metadata;
            const description = `${meta.width}×${meta.height} ${meta.typeName}`;
            const tooltip = [
                `${expression}`,
                `Size: ${meta.width}×${meta.height}`,
                `Type: ${meta.typeName}`,
                `Channels: ${meta.channels}`,
                `Address: ${meta.dataAddress}`,
                resolved.warnings?.map(w => `⚠ ${w}`).join('\n'),
            ]
                .filter(Boolean)
                .join('\n');

            return {
                id,
                label: displayName,
                description,
                tooltip,
                expression,
                isWatch,
                metadata: meta,
                imageData: resolved.data,
            };
        } catch (error) {
            return {
                id,
                label: displayName,
                description: 'Error',
                tooltip: `${expression}\nError: ${error}`,
                expression,
                isWatch,
                error: String(error),
            };
        }
    }

    private toEvaluateResponse(variable: VariableInfo): EvaluateResponse {
        return {
            result: variable.value,
            type: variable.type,
            variablesReference: variable.variablesReference,
            memoryReference: variable.memoryReference,
        };
    }

    private createWatchPlaceholders(availability: 'inactive' | 'running' | 'paused'): ImageItem[] {
        return this.watchExpressions.map(expression =>
            this.createWatchPlaceholder(expression, availability)
        );
    }

    private createWatchPlaceholder(
        expression: string,
        availability: 'inactive' | 'running' | 'paused'
    ): ImageItem {
        const copy = {
            inactive: {
                description: 'Not debugging',
                detail: 'Start a supported debug session and pause to evaluate this expression.',
            },
            running: {
                description: 'Running — pause to inspect',
                detail: 'Pause the debugger to evaluate this expression.',
            },
            paused: {
                description: 'Paused — refresh to inspect',
                detail: 'Refresh the image list to evaluate this expression.',
            },
        }[availability];

        return {
            id: `watch_${expression}`,
            label: expression,
            description: copy.description,
            tooltip: `${expression}\n${copy.detail}`,
            expression,
            isWatch: true,
            availability,
        };
    }

    private getUnavailableState(): 'inactive' | 'running' | 'paused' {
        if (!this.sessionManager.activeSession) {
            return 'inactive';
        }
        return this.sessionManager.isPaused ? 'paused' : 'running';
    }

    private showUnavailableState(
        availability: 'inactive' | 'running' | 'paused',
        invalidateContext: boolean = true
    ): void {
        const alreadyShown = this.localImages.length === 0 &&
            this.watchImages.length === this.watchExpressions.length &&
            this.watchImages.every((item, index) =>
                item.expression === this.watchExpressions[index] && item.availability === availability
            );

        if (invalidateContext) {
            // Only debugger lifecycle transitions invalidate work for this frame.
            this.stateEpoch++;
            this.refreshQueued = false;
            this.watchResolutionInFlight.clear();
        }
        if (alreadyShown) {
            return;
        }

        // Drop parsed metadata and materialized pixels immediately while running.
        this.localImages = [];
        this.watchImages = this.createWatchPlaceholders(availability);
        this._onDidChangeTreeData.fire();
    }

    /**
     * Add a watch expression
     */
    async addWatch(expression?: string): Promise<ImageItem | undefined> {
        if (!expression) {
            expression = await vscode.window.showInputBox({
                prompt: 'Enter expression to watch',
                placeHolder: 'e.g., myImage, ptr->data, @mem(0x1234, uint8, 3, 640, 480)',
            });
        }

        if (!expression) {
            return;
        }

        expression = expression.trim();
        if (!expression) {
            return;
        }

        if (this.watchExpressions.includes(expression)) {
            vscode.window.showInformationMessage(`"${expression}" is already in the watch list`);
            return this.watchImages.find(item => item.expression === expression);
        }

        this.watchExpressions.push(expression);
        this.watchImages.push(this.createWatchPlaceholder(expression, this.getUnavailableState()));
        await this.context.workspaceState.update('imview.watchExpressions', this.watchExpressions);

        if (this.sessionManager.activeSession && this.sessionManager.isPaused) {
            return this.ensureWatchImage(expression);
        }

        this._onDidChangeTreeData.fire();
        return this.watchImages.find(item => item.expression === expression);
    }

    /**
     * Remove a watch expression
     */
    async removeWatch(item: ImageItem | string): Promise<void> {
        const expression = typeof item === 'string' ? item : item.expression;
        const index = this.watchExpressions.indexOf(expression);

        if (index !== -1) {
            this.watchExpressions.splice(index, 1);
            await this.context.workspaceState.update('imview.watchExpressions', this.watchExpressions);

            this.watchImages = this.watchImages.filter(i => i.expression !== expression);
            this._onDidChangeTreeData.fire();
        }
    }

    /**
     * Select an image item
     */
    selectImage(item: ImageItem): void {
        this._onDidSelectImage.fire(item);
    }

    /**
     * Get an image item by ID
     */
    getImageById(id: string): ImageItem | undefined {
        return this.localImages.find(i => i.id === id) ?? this.watchImages.find(i => i.id === id);
    }

    /**
     * Get all image items
     */
    getAllImages(): ImageItem[] {
        return [...this.localImages, ...this.watchImages];
    }

    dispose(): void {
        this.stateEpoch++;
        this.refreshQueued = false;
        this.watchResolutionInFlight.clear();
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
        this.disposables = [];
        this._onDidChangeTreeData.dispose();
        this._onDidSelectImage.dispose();
        this._onDidRefreshImages.dispose();
    }
}
