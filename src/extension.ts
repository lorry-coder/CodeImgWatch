import * as vscode from 'vscode';
import { DebugSessionManager } from './core/debugSessionManager';
import { registerBuiltInParsers, ImageParserRegistry } from './parsers';
import { ImageListProvider, ImageTreeItem } from './providers/imageListProvider';
import { ImageViewerProvider } from './providers/imageViewerProvider';
import { ImageEditorManager } from './providers/imageEditorProvider';
import { ImageWatchDebugAdapterTrackerFactory } from './providers/debugVariableDecorator';
import { ImageItem } from './types';
import { getDebugVariableDetails } from './utils/debugVariableContext';

let sessionManager: DebugSessionManager;
let imageListProvider: ImageListProvider;
let imageViewerProvider: ImageViewerProvider;
let imageEditorManager: ImageEditorManager;
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

    // Keep every open viewer tied to the freshly parsed item from the current stop.
    imageListProvider.onDidRefreshImages((items) => {
        // Serialize pixel reads: debugger adapters are easily stalled by several
        // large readMemory/evaluate requests from multiple visible views.
        void (async () => {
            await imageViewerProvider.updateImages(items);
            await imageEditorManager.updateItems(items);
        })();
    });

    const invalidateImageDisplays = (): void => {
        imageViewerProvider.invalidateDisplay();
        imageEditorManager.invalidateDisplays();
    };
    context.subscriptions.push(
        sessionManager.onDidStopOnBreakpoint(() => {
            // A stack-frame switch can emit another stop without a preceding
            // continue event. Never leave pixels from the previous frame visible.
            invalidateImageDisplays();
        }),
        sessionManager.onDidContinue(() => {
            invalidateImageDisplays();
        }),
        sessionManager.onDidChangeSession(() => {
            invalidateImageDisplays();
        })
    );

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
                ImageParserRegistry.getInstance().reloadConfiguration();
                imageViewerProvider.reloadConfiguration();
                imageEditorManager.reloadConfiguration();
                if (sessionManager.isPaused) {
                    void imageListProvider.refresh();
                }
            }
        })
    );

    // Register disposables
    context.subscriptions.push(sessionManager);
    context.subscriptions.push(imageListProvider);
    context.subscriptions.push(imageViewerProvider);
    context.subscriptions.push(imageEditorManager);

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
        vscode.commands.registerCommand(
            'imview.exportImage',
            async (itemOrTreeItem?: ImageItem | ImageTreeItem) => {
                const item = itemOrTreeItem instanceof ImageTreeItem
                    ? itemOrTreeItem.imageItem
                    : itemOrTreeItem;
                if (item?.metadata) {
                    await imageViewerProvider.exportImage(item);
                } else if (itemOrTreeItem === undefined) {
                    await imageViewerProvider.exportCurrentImage();
                } else {
                    vscode.window.showWarningMessage(item?.error
                        ? `Cannot export image: ${item.error}`
                        : 'No image to export');
                }
            }
        )
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
        vscode.commands.registerCommand('imview.visualizeVariable', async (debugVariable?: unknown) => {
            await visualizeDebugVariable(debugVariable);
        })
    );

    // Visualize in a separate panel/editor
    context.subscriptions.push(
        vscode.commands.registerCommand('imview.visualizeVariableInPanel', async (debugVariable?: unknown) => {
            await visualizeDebugVariable(debugVariable, true);
        })
    );

    // Add a variable to the watch list (from context menu - no dialog)
    context.subscriptions.push(
        vscode.commands.registerCommand('imview.addToWatch', async (debugVariable?: unknown) => {
            const details = getDebugVariableDetails(debugVariable);
            let expression = details.expression;

            if (details.sessionId && details.sessionId !== sessionManager.activeSession?.id) {
                vscode.window.showWarningMessage(
                    'The selected variable belongs to a different debug session.'
                );
                return;
            }

            // If no expression from debug variable, try editor selection
            if (!expression && !details.isVariablesViewContext) {
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

            if (getWatchItem(expression)) {
                vscode.window.showInformationMessage(`"${expression}" is already in the ImView watch list`);
                return;
            }

            const item = await imageListProvider.addWatch(expression);
            if (!item) {
                vscode.window.showWarningMessage(`Could not add "${expression}" to ImView`);
                return;
            }
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

function getWatchItem(expression: string): ImageItem | undefined {
    const item = imageListProvider.getImageById(`watch_${expression}`);
    return item?.isWatch && item.expression === expression ? item : undefined;
}

/**
 * Adds Variables-view selections to Watch before displaying them. addWatch()
 * resolves a newly added expression while paused, so reusing the stored item
 * avoids evaluating the same debugger expression twice.
 */
async function getImageForVisualization(
    expression: string,
    persistInWatch: boolean
): Promise<ImageItem | undefined> {
    if (!persistInWatch) {
        return imageListProvider.resolveImageItem(expression, false);
    }

    const existing = getWatchItem(expression);
    if (existing) {
        return imageListProvider.ensureWatchImage(expression);
    }

    return imageListProvider.addWatch(expression);
}

/**
 * Visualize a debug variable
 */
async function visualizeDebugVariable(debugVariable?: unknown, openInEditor: boolean = false): Promise<void> {
    // Check if we have an active debug session
    if (!sessionManager.activeSession) {
        vscode.window.showWarningMessage('No active debug session. Start debugging first.');
        return;
    }

    if (!sessionManager.isPaused) {
        vscode.window.showWarningMessage('Debugger must be paused to view images.');
        return;
    }

    const details = getDebugVariableDetails(debugVariable);
    let expression = details.expression;
    const typeName = details.typeName;

    if (details.sessionId && details.sessionId !== sessionManager.activeSession.id) {
        vscode.window.showWarningMessage('The selected variable belongs to a different debug session.');
        return;
    }

    // Variables-view commands must use the clicked variable, never unrelated
    // editor text or a manual prompt.
    if (!expression && details.isVariablesViewContext) {
        vscode.window.showWarningMessage('The selected variable does not provide an evaluatable name.');
        return;
    }

    // Editor and command-palette invocations retain their existing fallbacks.
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
        location: vscode.ProgressLocation.Window,
        title: `Loading image: ${expression}`,
        cancellable: false
    }, async (progress) => {
        try {
            progress.report({ message: 'Parsing image structure...' });
            const imageItem = await getImageForVisualization(
                expression!,
                details.isVariablesViewContext
            );
            if (!imageItem) {
                vscode.window.showErrorMessage(
                    `Failed to add "${expression}" to the ImView watch list. Please try again.`
                );
                return;
            }
            if (!imageItem.metadata) {
                vscode.window.showErrorMessage(
                    `Failed to parse image "${expression}": ${imageItem.error ?? typeName ?? 'Unknown error'}. ` +
                    'Use Refresh Images to retry.'
                );
                return;
            }

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
