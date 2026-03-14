import * as vscode from 'vscode';
import { DebugSessionManager, StackFrameChangedEvent } from '../core/debugSessionManager';
import { ImageParserRegistry, isKnownImageType, normalizeTypeName } from '../parsers/baseParser';
import { ImageItem, ImageMetadata, ParseResult } from '../types';

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

    private _onDidChangeTreeData = new vscode.EventEmitter<TreeItemType | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    // Event fired when an image is selected
    private _onDidSelectImage = new vscode.EventEmitter<ImageItem>();
    readonly onDidSelectImage = this._onDidSelectImage.event;

    constructor(private context: vscode.ExtensionContext) {
        this.sessionManager = DebugSessionManager.getInstance();
        this.parserRegistry = ImageParserRegistry.getInstance();

        // Load saved watch expressions
        this.watchExpressions = context.workspaceState.get<string[]>('imview.watchExpressions', []);

        this.setupEventListeners();
    }

    private setupEventListeners(): void {
        // Refresh when debugger stops
        this.disposables.push(
            this.sessionManager.onDidStopOnBreakpoint(event => {
                this.refresh();
            })
        );

        // Clear when session ends
        this.disposables.push(
            this.sessionManager.onDidChangeSession(session => {
                if (!session) {
                    this.localImages = [];
                    this.watchImages = [];
                    this._onDidChangeTreeData.fire();
                }
            })
        );

        // Clear when continuing execution
        this.disposables.push(
            this.sessionManager.onDidContinue(() => {
                // Keep watch expressions but clear data
                this.localImages = [];
                this.watchImages = this.watchExpressions.map(expr => ({
                    id: `watch_${expr}`,
                    label: expr,
                    description: 'Running...',
                    tooltip: expr,
                    expression: expr,
                    isWatch: true,
                }));
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

        // Scan local variables
        await this.scanLocalVariables();

        // Evaluate watch expressions
        await this.evaluateWatchExpressions();

        this._onDidChangeTreeData.fire();
    }

    /**
     * Scan local variables for image types
     */
    private async scanLocalVariables(): Promise<void> {
        this.localImages = [];

        try {
            const locals = await this.sessionManager.getLocalVariables();

            for (const variable of locals) {
                const typeName = variable.type ?? '';
                const normalizedType = normalizeTypeName(typeName);

                // Check if this is a known image type
                if (isKnownImageType(normalizedType)) {
                    const item = await this.createImageItem(
                        variable.evaluateName ?? variable.name,
                        variable.name,
                        typeName,
                        false
                    );
                    this.localImages.push(item);
                }
            }
        } catch (error) {
            console.error('Failed to scan local variables:', error);
        }
    }

    /**
     * Evaluate all watch expressions
     */
    private async evaluateWatchExpressions(): Promise<void> {
        this.watchImages = [];

        for (const expr of this.watchExpressions) {
            const item = await this.createImageItemFromExpression(expr, true);
            this.watchImages.push(item);
        }
    }

    /**
     * Create an ImageItem from an expression
     */
    private async createImageItemFromExpression(expression: string, isWatch: boolean): Promise<ImageItem> {
        try {
            const result = await this.sessionManager.evaluate(expression);

            if (!result) {
                return {
                    id: `${isWatch ? 'watch' : 'local'}_${expression}`,
                    label: expression,
                    description: 'Failed to evaluate',
                    tooltip: `Expression: ${expression}\nError: Failed to evaluate`,
                    expression,
                    isWatch,
                    error: 'Failed to evaluate expression',
                };
            }

            return this.createImageItem(expression, expression, result.type ?? '', isWatch);
        } catch (error) {
            return {
                id: `${isWatch ? 'watch' : 'local'}_${expression}`,
                label: expression,
                description: 'Error',
                tooltip: `Expression: ${expression}\nError: ${error}`,
                expression,
                isWatch,
                error: String(error),
            };
        }
    }

    /**
     * Create an ImageItem by parsing a variable
     */
    private async createImageItem(
        expression: string,
        displayName: string,
        typeName: string,
        isWatch: boolean
    ): Promise<ImageItem> {
        const id = `${isWatch ? 'watch' : 'local'}_${expression}`;

        try {
            // Find parser for this type
            const parser = this.parserRegistry.findParser(normalizeTypeName(typeName));

            if (!parser) {
                return {
                    id,
                    label: displayName,
                    description: typeName,
                    tooltip: `${expression}: ${typeName}\nNo parser available for this type`,
                    expression,
                    isWatch,
                    error: 'No parser available',
                };
            }

            // Evaluate to get variables reference
            const evalResult = await this.sessionManager.evaluate(expression);

            if (!evalResult) {
                return {
                    id,
                    label: displayName,
                    description: 'Failed to evaluate',
                    tooltip: `${expression}\nFailed to evaluate expression`,
                    expression,
                    isWatch,
                    error: 'Failed to evaluate',
                };
            }

            // Parse the image
            const parseResult = await parser.parse(this.sessionManager, expression, evalResult);

            if (!parseResult.success || !parseResult.metadata) {
                return {
                    id,
                    label: displayName,
                    description: parseResult.error ?? 'Parse failed',
                    tooltip: `${expression}: ${typeName}\n${parseResult.error ?? 'Parse failed'}`,
                    expression,
                    isWatch,
                    error: parseResult.error,
                };
            }

            const meta = parseResult.metadata;
            const description = `${meta.width}×${meta.height} ${meta.typeName}`;
            const tooltip = [
                `${expression}`,
                `Size: ${meta.width}×${meta.height}`,
                `Type: ${meta.typeName}`,
                `Channels: ${meta.channels}`,
                `Address: ${meta.dataAddress}`,
                parseResult.warnings?.map(w => `⚠ ${w}`).join('\n'),
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

        if (this.watchExpressions.includes(expression)) {
            vscode.window.showInformationMessage(`"${expression}" is already in the watch list`);
            return;
        }

        this.watchExpressions.push(expression);
        await this.context.workspaceState.update('imview.watchExpressions', this.watchExpressions);

        // Evaluate and add to list if debugger is paused
        if (this.sessionManager.activeSession && this.sessionManager.isPaused) {
            const item = await this.createImageItemFromExpression(expression, true);
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
    }
}
