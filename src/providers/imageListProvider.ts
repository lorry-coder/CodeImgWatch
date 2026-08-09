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
        this.contextValue = imageItem.isWatch ? 'watchItem' : 'imageItem';

        // Set icon based on state
        if (imageItem.error) {
            this.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('errorForeground'));
        } else if (imageItem.metadata) {
            this.iconPath = new vscode.ThemeIcon('file-media');
        } else {
            this.iconPath = new vscode.ThemeIcon('loading~spin');
        }

        // Make it clickable
        this.command = {
            command: 'imview.selectImage',
            title: 'Select Image',
            arguments: [this.imageItem],
        };
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
    private refreshGeneration = 0;

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
        this.watchImages = this.createWatchPlaceholders('Waiting for debugger...');

        this.setupEventListeners();
    }

    private setupEventListeners(): void {
        // Refresh when debugger stops
        this.disposables.push(
            this.sessionManager.onDidStopOnBreakpoint(() => {
                const autoRefresh = vscode.workspace.getConfiguration('imview').get('autoRefresh', true);
                if (autoRefresh) {
                    void this.refresh();
                }
            })
        );

        // Clear when session ends
        this.disposables.push(
            this.sessionManager.onDidChangeSession(session => {
                this.localImages = [];
                this.watchImages = this.createWatchPlaceholders(
                    session ? 'Waiting for debugger to pause...' : 'Waiting for debugger...'
                );
                this.refreshGeneration++;
                this._onDidChangeTreeData.fire();
            })
        );

        // Clear when continuing execution
        this.disposables.push(
            this.sessionManager.onDidContinue(() => {
                // Keep watch expressions but clear data
                this.localImages = [];
                this.watchImages = this.createWatchPlaceholders('Running...');
                this.refreshGeneration++;
                this._onDidChangeTreeData.fire();
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
            return;
        }

        const generation = ++this.refreshGeneration;

        // Scan local variables
        const localImages = await this.scanLocalVariables();

        // Evaluate watch expressions
        const watchImages = await this.evaluateWatchExpressions();

        if (generation !== this.refreshGeneration) {
            return;
        }

        this.localImages = localImages;
        this.watchImages = watchImages;

        this._onDidChangeTreeData.fire();
        this._onDidRefreshImages.fire(this.getAllImages());
    }

    /**
     * Scan local variables for image types
     */
    private async scanLocalVariables(): Promise<ImageItem[]> {
        const images: ImageItem[] = [];

        try {
            const locals = await this.sessionManager.getLocalVariables();

            for (const variable of locals) {
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
    private async evaluateWatchExpressions(): Promise<ImageItem[]> {
        const images: ImageItem[] = [];

        for (const expr of this.watchExpressions) {
            images.push(await this.resolveImageItem(expr, true));
        }
        return images;
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

    private createWatchPlaceholders(description: string): ImageItem[] {
        return this.watchExpressions.map(expression => ({
            id: `watch_${expression}`,
            label: expression,
            description,
            tooltip: expression,
            expression,
            isWatch: true,
        }));
    }

    /**
     * Add a watch expression
     */
    async addWatch(expression?: string): Promise<void> {
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
            return;
        }

        this.watchExpressions.push(expression);
        await this.context.workspaceState.update('imview.watchExpressions', this.watchExpressions);

        // Evaluate and add to list if debugger is paused
        if (this.sessionManager.activeSession && this.sessionManager.isPaused) {
            const item = await this.resolveImageItem(expression, true);
            this.watchImages.push(item);
        } else {
            // Add placeholder item
            this.watchImages.push({
                id: `watch_${expression}`,
                label: expression,
                description: 'Waiting for debugger...',
                tooltip: expression,
                expression,
                isWatch: true,
            });
        }

        this._onDidChangeTreeData.fire();
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
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
        this.disposables = [];
        this._onDidChangeTreeData.dispose();
        this._onDidSelectImage.dispose();
        this._onDidRefreshImages.dispose();
    }
}
