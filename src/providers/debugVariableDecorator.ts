import * as vscode from 'vscode';
import { DebugSessionManager } from '../core/debugSessionManager';
import { isKnownImageType, normalizeTypeName } from '../parsers/baseParser';

/**
 * Provides inline decorations for image variables in the debug view
 */
export class DebugVariableDecorator implements vscode.Disposable {
    private disposables: vscode.Disposable[] = [];
    private sessionManager: DebugSessionManager;

    // Track known image variables for the current context
    private knownImageVariables: Set<string> = new Set();

    constructor() {
        this.sessionManager = DebugSessionManager.getInstance();
        this.setupListeners();
    }

    private setupListeners(): void {
        // Update context when debugger stops
        this.disposables.push(
            this.sessionManager.onDidStopOnBreakpoint(async () => {
                await this.updateImageVariableContext();
            })
        );

        // Clear context when session ends or continues
        this.disposables.push(
            this.sessionManager.onDidChangeSession((session) => {
                if (!session) {
                    this.clearContext();
                }
            })
        );

        this.disposables.push(
            this.sessionManager.onDidContinue(() => {
                this.clearContext();
            })
        );
    }

    /**
     * Scan local variables and mark which ones are image types
     */
    private async updateImageVariableContext(): Promise<void> {
        this.knownImageVariables.clear();

        try {
            const locals = await this.sessionManager.getLocalVariables();

            for (const variable of locals) {
                const typeName = variable.type ?? '';
                const normalizedType = normalizeTypeName(typeName);

                if (isKnownImageType(normalizedType)) {
                    const name = variable.evaluateName ?? variable.name;
                    this.knownImageVariables.add(name);
                }
            }

            // Set context for menu filtering
            const hasImageVariables = this.knownImageVariables.size > 0;
            await vscode.commands.executeCommand(
                'setContext',
                'imview.hasImageVariables',
                hasImageVariables
            );
        } catch {
            // Silently fail - context will remain unchanged
        }
    }

    private async clearContext(): Promise<void> {
        this.knownImageVariables.clear();
        await vscode.commands.executeCommand(
            'setContext',
            'imview.hasImageVariables',
            false
        );
    }

    /**
     * Check if a variable name is a known image type
     */
    public isImageVariable(name: string): boolean {
        return this.knownImageVariables.has(name);
    }

    /**
     * Get all known image variable names
     */
    public getImageVariableNames(): string[] {
        return Array.from(this.knownImageVariables);
    }

    dispose(): void {
        this.clearContext();
        for (const d of this.disposables) {
            d.dispose();
        }
        this.disposables = [];
    }
}

/**
 * Debug Adapter Tracker to intercept variable information
 */
export class ImageWatchDebugAdapterTracker implements vscode.DebugAdapterTracker {
    private imageVariableNames: Set<string> = new Set();

    onWillReceiveMessage(message: any): void {
        // Could intercept requests here if needed
    }

    onDidSendMessage(message: any): void {
        // Intercept variable responses to detect image types
        if (message.type === 'response' && message.command === 'variables') {
            this.processVariables(message.body?.variables || []);
        }
    }

    private processVariables(variables: any[]): void {
        for (const v of variables) {
            const typeName = v.type ?? '';
            const normalizedType = normalizeTypeName(typeName);

            if (isKnownImageType(normalizedType)) {
                const name = v.evaluateName ?? v.name;
                this.imageVariableNames.add(name);

                // Set context that this variable is an image
                // Unfortunately, we can't set per-variable context
            }
        }
    }

    public isImageVariable(name: string): boolean {
        return this.imageVariableNames.has(name);
    }
}

/**
 * Factory to create debug adapter trackers
 */
export class ImageWatchDebugAdapterTrackerFactory implements vscode.DebugAdapterTrackerFactory {
    private trackers: Map<string, ImageWatchDebugAdapterTracker> = new Map();

    createDebugAdapterTracker(session: vscode.DebugSession): vscode.ProviderResult<vscode.DebugAdapterTracker> {
        const tracker = new ImageWatchDebugAdapterTracker();
        this.trackers.set(session.id, tracker);
        return tracker;
    }

    getTracker(sessionId: string): ImageWatchDebugAdapterTracker | undefined {
        return this.trackers.get(sessionId);
    }

    removeTracker(sessionId: string): void {
        this.trackers.delete(sessionId);
    }
}
