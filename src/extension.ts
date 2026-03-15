import * as vscode from 'vscode';
import { DebugSessionManager } from './core/debugSessionManager';
import { registerBuiltInParsers, ImageParserRegistry, isKnownImageType, normalizeTypeName } from './parsers';
import { ImageListProvider, ImageTreeItem } from './providers/imageListProvider';
import { ImageViewerProvider } from './providers/imageViewerProvider';
import { ImageEditorManager } from './providers/imageEditorProvider';
import { DebugVariableDecorator, ImageWatchDebugAdapterTrackerFactory } from './providers/debugVariableDecorator';
import { ImageItem } from './types';

let sessionManager: DebugSessionManager;
let imageListProvider: ImageListProvider;
let imageViewerProvider: ImageViewerProvider;
let imageEditorManager: ImageEditorManager;
let debugVariableDecorator: DebugVariableDecorator;
let debugAdapterTrackerFactory: ImageWatchDebugAdapterTrackerFactory;

/**
 * Extension activation
 */
export function activate(context: vscode.ExtensionContext): void {
    console.log('ImView extension activating...');

    // Initialize debug session manager
    sessionManager = DebugSessionManager.getInstance();

    // Register built-in parsers
    registerBuiltInParsers();

    // Initialize providers
    imageListProvider = new ImageListProvider(context);
    imageViewerProvider = new ImageViewerProvider(context.extensionUri);
    imageEditorManager = new ImageEditorManager(context.extensionUri);
    debugVariableDecorator = new DebugVariableDecorator();

    // Register debug adapter tracker factory for intercepting variable info
    debugAdapterTrackerFactory = new ImageWatchDebugAdapterTrackerFactory();
    context.subscriptions.push(
        vscode.debug.registerDebugAdapterTrackerFactory('cppdbg', debugAdapterTrackerFactory),
        vscode.debug.registerDebugAdapterTrackerFactory('cppvsdbg', debugAdapterTrackerFactory),
        vscode.debug.registerDebugAdapterTrackerFactory('lldb', debugAdapterTrackerFactory),
        vscode.debug.registerDebugAdapterTrackerFactory('debugpy', debugAdapterTrackerFactory)
    );

    // Register tree view
    const treeView = vscode.window.createTreeView('imview.imageList', {
        treeDataProvider: imageListProvider,
        showCollapseAll: true,
    });
    context.subscriptions.push(treeView);

    // Register webview view provider (panel)
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            ImageViewerProvider.viewType,
            imageViewerProvider,
            {
                webviewOptions: {
                    retainContextWhenHidden: true
                }
            }
        )
    );

    // Handle image selection from list
    imageListProvider.onDidSelectImage(async (item: ImageItem) => {
        if (item.metadata) {
            await imageViewerProvider.displayImage(item);
            // Also focus the viewer panel
            vscode.commands.executeCommand('imview.imageViewer.focus');
        } else if (item.error) {
            vscode.window.showWarningMessage(`Cannot display image: ${item.error}`);
        }
    });

    // Sync view states between sidebar and editor panels
    imageViewerProvider.onDidChangeViewState((state) => {
        imageEditorManager.syncViewState('sidebar', state);
    });

    imageEditorManager.onDidChangeViewState(({ panelId, state }) => {
        imageViewerProvider.syncViewState(state);
        imageEditorManager.syncViewState(panelId, state);
    });

    // Register commands
    registerCommands(context);

    // Listen for configuration changes
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('imview')) {
                // Custom type parser will reload configurations on next use
            }
        })
    );

    // Register disposables
    context.subscriptions.push(sessionManager);
    context.subscriptions.push(imageListProvider);
    context.subscriptions.push(imageViewerProvider);
    context.subscriptions.push(imageEditorManager);
    context.subscriptions.push(debugVariableDecorator);

    console.log('ImView extension activated');
}

/**
 * Register extension commands
 */
function registerCommands(context: vscode.ExtensionContext): void {
    // Refresh images
    context.subscriptions.push(
        vscode.commands.registerCommand('imview.refresh', async () => {
            await imageListProvider.refresh();
        })
    );

    // Add watch expression
    context.subscriptions.push(
        vscode.commands.registerCommand('imview.addWatch', async () => {
            await imageListProvider.addWatch();
        })
    );

    // Remove watch expression
    context.subscriptions.push(
        vscode.commands.registerCommand('imview.removeWatch', async (treeItem?: ImageTreeItem) => {
            if (treeItem?.imageItem) {
                await imageListProvider.removeWatch(treeItem.imageItem);
            }
        })
    );

    // Select image (internal command)
    context.subscriptions.push(
        vscode.commands.registerCommand('imview.selectImage', (item: ImageItem) => {
            imageListProvider.selectImage(item);
        })
    );

    // Open in editor tab
    context.subscriptions.push(
        vscode.commands.registerCommand('imview.openInEditor', async (itemOrTreeItem?: ImageItem | ImageTreeItem) => {
            let item: ImageItem | undefined;

            if (itemOrTreeItem instanceof ImageTreeItem) {
                item = itemOrTreeItem.imageItem;
            } else if (itemOrTreeItem) {
                item = itemOrTreeItem;
            }

            if (item?.metadata) {
                await imageEditorManager.openInEditor(item);
            } else if (item?.error) {
                vscode.window.showWarningMessage(`Cannot open image: ${item.error}`);
            } else {
                vscode.window.showWarningMessage('No image selected');
            }
        })
    );

    // Export image
    context.subscriptions.push(
        vscode.commands.registerCommand('imview.exportImage', async (treeItem?: ImageTreeItem) => {
            const item = treeItem?.imageItem;
            if (!item?.metadata) {
                vscode.window.showWarningMessage('No image to export');
                return;
            }

            const format = await vscode.window.showQuickPick(
                [
                    { label: 'PNG', value: 'png' },
                    { label: 'JPEG', value: 'jpg' },
                    { label: 'Raw Binary', value: 'bin' },
                ],
                { placeHolder: 'Select export format' }
            );

            if (!format) {
                return;
            }

            const defaultName = `${item.metadata.name.replace(/[^a-zA-Z0-9]/g, '_')}.${format.value}`;
            const uri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file(defaultName),
                filters: {
                    [format.label]: [format.value],
                },
            });

            if (!uri) {
                return;
            }

            try {
                const data = await sessionManager.readMemoryChunked(
                    item.metadata.dataAddress,
                    item.metadata.dataSize
                );

                if (!data) {
                    throw new Error('Failed to read image data');
                }

                if (format.value === 'bin') {
                    await vscode.workspace.fs.writeFile(uri, data);
                    vscode.window.showInformationMessage(`Image exported to ${uri.fsPath}`);
                } else {
                    // PNG/JPG export would need canvas rendering
                    vscode.window.showWarningMessage(
                        'PNG/JPG export is not yet fully implemented. Use "Open in Editor" and export from there.'
                    );
                }
            } catch (error) {
                vscode.window.showErrorMessage(`Export failed: ${error}`);
            }
        })
    );

    // Copy pixel value
    context.subscriptions.push(
        vscode.commands.registerCommand('imview.copyPixelValue', async () => {
            // This is triggered from the webview via message
        })
    );

    // Add watch from selection (context menu in editor)
    context.subscriptions.push(
        vscode.commands.registerCommand('imview.addWatchFromSelection', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                return;
            }

            const selection = editor.selection;
            const text = editor.document.getText(selection);

            if (text.trim()) {
                await imageListProvider.addWatch(text.trim());
            }
        })
    );

    // ========================================
    // New commands for debug variable visualization
    // ========================================

    // Visualize a variable from VARIABLES/WATCH panel or editor selection
    context.subscriptions.push(
        vscode.commands.registerCommand('imview.visualizeVariable', async (debugVariable?: any) => {
            await visualizeDebugVariable(debugVariable);
        })
    );

    // Visualize in a separate panel/editor
    context.subscriptions.push(
        vscode.commands.registerCommand('imview.visualizeVariableInPanel', async (debugVariable?: any) => {
            await visualizeDebugVariable(debugVariable, true);
        })
    );

    // Add a variable to the watch list (from context menu - no dialog)
    context.subscriptions.push(
        vscode.commands.registerCommand('imview.addToWatch', async (debugVariable?: any) => {
            let expression: string | undefined;

            // First, try to extract from debug variable object (from VARIABLES/WATCH panel)
            if (debugVariable && typeof debugVariable === 'object') {
                expression = debugVariable.evaluateName
                    || debugVariable.name
                    || debugVariable.variable?.evaluateName
                    || debugVariable.variable?.name;
            }

            if (typeof debugVariable === 'string') {
                expression = debugVariable;
            }

            // If no expression from debug variable, try editor selection
            if (!expression) {
                const editor = vscode.window.activeTextEditor;
                if (editor && !editor.selection.isEmpty) {
                    expression = editor.document.getText(editor.selection).trim();
                }
            }

            // If no expression found, show a warning (don't show input dialog)
            if (!expression) {
                vscode.window.showWarningMessage('No variable selected. Please select a variable first.');
                return;
            }

            await imageListProvider.addWatch(expression);
            vscode.window.showInformationMessage(`Added "${expression}" to ImView`);
        })
    );

    // Open the viewer panel
    context.subscriptions.push(
        vscode.commands.registerCommand('imview.openViewerPanel', async () => {
            // Focus the ImView panel in the bottom area
            await vscode.commands.executeCommand('imview.imageViewer.focus');
        })
    );

    // Move viewer to secondary sidebar (right side)
    context.subscriptions.push(
        vscode.commands.registerCommand('imview.moveViewerToSecondary', async () => {
            // This is a hint to the user - VS Code doesn't have API to programmatically move views
            vscode.window.showInformationMessage(
                'To move Image Viewer to the right sidebar:\n' +
                '1. Right-click on "ImView" tab in the panel\n' +
                '2. Select "Move Panel Right" or drag to the secondary sidebar',
                'OK'
            );
        })
    );
}

/**
 * Visualize a debug variable
 */
async function visualizeDebugVariable(debugVariable?: any, openInEditor: boolean = false): Promise<void> {
    // Check if we have an active debug session
    if (!sessionManager.activeSession) {
        vscode.window.showWarningMessage('No active debug session. Start debugging first.');
        return;
    }

    if (!sessionManager.isPaused) {
        vscode.window.showWarningMessage('Debugger must be paused to view images.');
        return;
    }

    let expression: string | undefined;
    let typeName: string | undefined;

    // First, try to extract from debug variable object (from VARIABLES/WATCH panel)
    if (debugVariable && typeof debugVariable === 'object') {
        expression = debugVariable.evaluateName || debugVariable.name || debugVariable.variable?.evaluateName || debugVariable.variable?.name;
        typeName = debugVariable.type || debugVariable.variable?.type;

        // Try to extract from container if nested
        if (!expression && debugVariable.container) {
            expression = debugVariable.container.evaluateName || debugVariable.container.name;
            typeName = debugVariable.container.type;
        }
    }

    if (typeof debugVariable === 'string') {
        expression = debugVariable;
    }

    // If no expression from debug variable, try editor selection
    if (!expression) {
        const editor = vscode.window.activeTextEditor;
        if (editor && !editor.selection.isEmpty) {
            expression = editor.document.getText(editor.selection).trim();
        }
    }

    // If still no expression, show input dialog (for command palette usage)
    if (!expression) {
        expression = await vscode.window.showInputBox({
            prompt: 'Enter variable expression to visualize',
            placeHolder: 'e.g., myImage, images[0], ptr->frame'
        });
    }

    if (!expression) {
        vscode.window.showWarningMessage('No variable expression provided.');
        return;
    }

    // Show progress
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Loading image: ${expression}`,
        cancellable: false
    }, async (progress) => {
        try {
            // Evaluate the expression
            progress.report({ message: 'Evaluating expression...' });
            const evalResult = await sessionManager.evaluate(expression!);

            if (!evalResult) {
                vscode.window.showErrorMessage(`Failed to evaluate "${expression}". Make sure the variable is in scope.`);
                return;
            }

            const actualTypeName = evalResult.type || typeName || '';
            const normalizedType = normalizeTypeName(actualTypeName);

            // Check if it's a known image type
            if (!isKnownImageType(normalizedType)) {
                // Ask user if they want to try anyway
                const choice = await vscode.window.showWarningMessage(
                    `"${actualTypeName || 'unknown type'}" is not a recognized image type (cv::Mat, etc.). Try to visualize anyway?`,
                    'Try Anyway', 'Cancel'
                );
                if (choice !== 'Try Anyway') {
                    return;
                }
            }

            // Find parser
            const registry = ImageParserRegistry.getInstance();
            const parser = registry.findParser(normalizedType);

            if (!parser) {
                vscode.window.showErrorMessage(
                    `No parser available for type: ${actualTypeName || 'unknown'}\n` +
                    'Supported types: cv::Mat, cv::Mat_<T>, cv::Matx, CvMat, IplImage.\n' +
                    'You can configure custom types in settings.'
                );
                return;
            }

            // Parse the image
            progress.report({ message: 'Parsing image structure...' });
            const parseResult = await parser.parse(sessionManager, expression!, evalResult);

            if (!parseResult.success || !parseResult.metadata) {
                vscode.window.showErrorMessage(
                    `Failed to parse image "${expression}": ${parseResult.error || 'Unknown error'}`
                );
                return;
            }

            // Create ImageItem
            const imageItem: ImageItem = {
                id: `quick_${Date.now()}_${expression}`,
                label: expression!,
                description: `${parseResult.metadata.width}×${parseResult.metadata.height} ${parseResult.metadata.typeName}`,
                tooltip: `${expression}: ${actualTypeName}`,
                expression: expression!,
                isWatch: true,  // Mark as watch item
                metadata: parseResult.metadata
            };

            // Also add to watch list (if not already there)
            await imageListProvider.addWatch(expression!);

            // Display the image
            progress.report({ message: 'Reading image data...' });

            if (openInEditor) {
                await imageEditorManager.openInEditor(imageItem);
            } else {
                await imageViewerProvider.displayImage(imageItem);
                // Focus the panel
                try {
                    await vscode.commands.executeCommand('imview.imageViewer.focus');
                } catch {
                    // Ignore focus errors
                }
            }

            // Show warnings if any
            if (parseResult.warnings && parseResult.warnings.length > 0) {
                vscode.window.showWarningMessage(
                    `Image loaded with warnings: ${parseResult.warnings.join(', ')}`
                );
            }

        } catch (error) {
            vscode.window.showErrorMessage(`Error visualizing variable: ${error}`);
        }
    });
}

/**
 * Extension deactivation
 */
export function deactivate(): void {
    console.log('ImView extension deactivating...');
}
