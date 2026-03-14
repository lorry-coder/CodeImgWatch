import * as vscode from 'vscode';
import { DebuggerType } from '../types';

/**
 * Event emitted when the active stack frame changes
 */
export interface StackFrameChangedEvent {
    session: vscode.DebugSession;
    threadId: number;
    frameId: number;
}

/**
 * Response from evaluate request
 */
export interface EvaluateResponse {
    result: string;
    type?: string;
    variablesReference: number;
    memoryReference?: string;
    presentationHint?: {
        kind?: string;
        attributes?: string[];
    };
}

/**
 * Response from readMemory request
 */
export interface ReadMemoryResponse {
    address: string;
    unreadableBytes?: number;
    data?: string; // base64 encoded
}

/**
 * Variable information from variables request
 */
export interface VariableInfo {
    name: string;
    value: string;
    type?: string;
    variablesReference: number;
    memoryReference?: string;
    evaluateName?: string;
}

/**
 * Manages debug sessions and provides DAP communication
 */
export class DebugSessionManager implements vscode.Disposable {
    private static instance: DebugSessionManager | undefined;

    private disposables: vscode.Disposable[] = [];
    private _activeSession: vscode.DebugSession | undefined;
    private _currentThreadId: number | undefined;
    private _currentFrameId: number | undefined;
    private _isPaused: boolean = false;

    private readonly _onDidChangeSession = new vscode.EventEmitter<vscode.DebugSession | undefined>();
    private readonly _onDidStopOnBreakpoint = new vscode.EventEmitter<StackFrameChangedEvent>();
    private readonly _onDidContinue = new vscode.EventEmitter<vscode.DebugSession>();

    public readonly onDidChangeSession = this._onDidChangeSession.event;
    public readonly onDidStopOnBreakpoint = this._onDidStopOnBreakpoint.event;
    public readonly onDidContinue = this._onDidContinue.event;

    private constructor() {
        this.setupEventListeners();
    }

    public static getInstance(): DebugSessionManager {
        if (!DebugSessionManager.instance) {
            DebugSessionManager.instance = new DebugSessionManager();
        }
        return DebugSessionManager.instance;
    }

    private setupEventListeners(): void {
        // Listen for debug session changes
        this.disposables.push(
            vscode.debug.onDidStartDebugSession(session => {
                if (this.isSupportedDebugger(session.type)) {
                    this._activeSession = session;
                    this._onDidChangeSession.fire(session);
                }
            })
        );

        this.disposables.push(
            vscode.debug.onDidTerminateDebugSession(session => {
                if (this._activeSession === session) {
                    this._activeSession = undefined;
                    this._currentThreadId = undefined;
                    this._currentFrameId = undefined;
                    this._isPaused = false;
                    this._onDidChangeSession.fire(undefined);
                }
            })
        );

        // Listen for active debug session changes
        this.disposables.push(
            vscode.debug.onDidChangeActiveDebugSession(session => {
                if (session && this.isSupportedDebugger(session.type)) {
                    this._activeSession = session;
                    this._onDidChangeSession.fire(session);
                }
            })
        );

        // Listen for stopped events (breakpoints, step, etc.)
        this.disposables.push(
            vscode.debug.onDidReceiveDebugSessionCustomEvent(event => {
                if (event.event === 'stopped' && event.session === this._activeSession) {
                    this._isPaused = true;
                    this.handleStoppedEvent(event.body);
                } else if (event.event === 'continued' && event.session === this._activeSession) {
                    this._isPaused = false;
                    this._onDidContinue.fire(event.session);
                }
            })
        );

        // Listen for stack frame changes - most reliable way to detect paused state
        this.disposables.push(
            vscode.debug.onDidChangeActiveStackItem(item => {
                if (item && this._activeSession) {
                    this._isPaused = true;

                    if ('frameId' in item) {
                        const frame = item as { frameId: number; threadId: number };
                        this._currentFrameId = frame.frameId;
                        this._currentThreadId = frame.threadId;

                        this._onDidStopOnBreakpoint.fire({
                            session: this._activeSession,
                            threadId: frame.threadId,
                            frameId: frame.frameId,
                        });
                    }
                }
            })
        );

        // Set initial active session if one exists
        if (vscode.debug.activeDebugSession && this.isSupportedDebugger(vscode.debug.activeDebugSession.type)) {
            this._activeSession = vscode.debug.activeDebugSession;
            if (vscode.debug.activeStackItem) {
                this._isPaused = true;
            }
        }
    }

    private async handleStoppedEvent(body: { threadId?: number; allThreadsStopped?: boolean }): Promise<void> {
        if (!this._activeSession) {
            return;
        }

        const threadId = body.threadId ?? 1;
        this._currentThreadId = threadId;

        try {
            // Get the current stack frame
            const stackResponse = await this._activeSession.customRequest('stackTrace', {
                threadId,
                startFrame: 0,
                levels: 1,
            });

            if (stackResponse.stackFrames && stackResponse.stackFrames.length > 0) {
                const frame = stackResponse.stackFrames[0];
                this._currentFrameId = frame.id;

                this._onDidStopOnBreakpoint.fire({
                    session: this._activeSession,
                    threadId,
                    frameId: frame.id,
                });
            }
        } catch (error) {
            console.error('Failed to get stack trace:', error);
        }
    }

    /**
     * Check if a debugger type is supported
     */
    public isSupportedDebugger(type: string): boolean {
        const supportedTypes = ['cppdbg', 'cppvsdbg', 'lldb'];
        return supportedTypes.includes(type);
    }

    /**
     * Get the debugger type enum
     */
    public getDebuggerType(type?: string): DebuggerType {
        const t = type ?? this._activeSession?.type;
        switch (t) {
            case 'cppdbg':
                return 'cppdbg';
            case 'cppvsdbg':
                return 'cppvsdbg';
            case 'lldb':
                return 'lldb';
            default:
                return 'unknown';
        }
    }

    /**
     * Get the active debug session
     */
    public get activeSession(): vscode.DebugSession | undefined {
        return this._activeSession;
    }

    /**
     * Get the current thread ID
     */
    public get currentThreadId(): number | undefined {
        return this._currentThreadId;
    }

    /**
     * Get the current frame ID
     */
    public get currentFrameId(): number | undefined {
        return this._currentFrameId;
    }

    /**
     * Check if debugger is paused
     * Uses multiple methods to detect paused state
     */
    public get isPaused(): boolean {
        // Method 1: Check our internal flag
        if (this._isPaused) {
            return true;
        }

        // Method 2: Check if there's an active stack item (most reliable)
        if (vscode.debug.activeStackItem) {
            this._isPaused = true;
            return true;
        }

        // Method 3: Check if we have a valid frame ID
        if (this._currentFrameId !== undefined && this._activeSession) {
            return true;
        }

        return false;
    }

    /**
     * Evaluate an expression in the current context
     */
    public async evaluate(expression: string, context: 'watch' | 'repl' | 'hover' = 'watch'): Promise<EvaluateResponse | undefined> {
        if (!this._activeSession) {
            return undefined;
        }

        // Try to get frame ID if we don't have one
        if (this._currentFrameId === undefined) {
            await this.tryGetCurrentFrame();
        }

        if (this._currentFrameId === undefined) {
            return undefined;
        }

        try {
            const response = await this._activeSession.customRequest('evaluate', {
                expression,
                frameId: this._currentFrameId,
                context,
            });
            return response as EvaluateResponse;
        } catch (error) {
            console.error(`Failed to evaluate '${expression}':`, error);
            return undefined;
        }
    }

    /**
     * Try to get the current stack frame if we don't have one
     */
    private async tryGetCurrentFrame(): Promise<void> {
        if (!this._activeSession) {
            return;
        }

        // Check if there's an active stack item
        const stackItem = vscode.debug.activeStackItem;
        if (stackItem && 'frameId' in stackItem) {
            const frame = stackItem as { frameId: number; threadId: number };
            this._currentFrameId = frame.frameId;
            this._currentThreadId = frame.threadId;
            this._isPaused = true;
            return;
        }

        // Try to get threads and stack trace
        try {
            const threadsResponse = await this._activeSession.customRequest('threads', {});
            const threads = threadsResponse.threads || [];

            if (threads.length > 0) {
                const threadId = threads[0].id;
                this._currentThreadId = threadId;

                const stackResponse = await this._activeSession.customRequest('stackTrace', {
                    threadId,
                    startFrame: 0,
                    levels: 1,
                });

                if (stackResponse.stackFrames && stackResponse.stackFrames.length > 0) {
                    this._currentFrameId = stackResponse.stackFrames[0].id;
                    this._isPaused = true;
                }
            }
        } catch {
            // Silently fail - frame will remain undefined
        }
    }

    /**
     * Read memory from the debugged process
     */
    public async readMemory(address: string, count: number): Promise<Uint8Array | undefined> {
        if (!this._activeSession) {
            return undefined;
        }

        try {
            const response = await this._activeSession.customRequest('readMemory', {
                memoryReference: address,
                offset: 0,
                count,
            }) as ReadMemoryResponse;

            if (response.data) {
                // Decode base64 to Uint8Array
                const binaryString = atob(response.data);
                const bytes = new Uint8Array(binaryString.length);
                for (let i = 0; i < binaryString.length; i++) {
                    bytes[i] = binaryString.charCodeAt(i);
                }
                return bytes;
            }

            return undefined;
        } catch (error) {
            console.error(`Failed to read memory at ${address}:`, error);
            return undefined;
        }
    }

    /**
     * Read memory in chunks to handle large images
     */
    public async readMemoryChunked(address: string, totalSize: number, chunkSize: number = 65536): Promise<Uint8Array | undefined> {
        if (!this._activeSession) {
            return undefined;
        }

        const result = new Uint8Array(totalSize);
        let offset = 0;

        while (offset < totalSize) {
            const remaining = totalSize - offset;
            const readSize = Math.min(chunkSize, remaining);

            try {
                // Calculate address with offset
                const currentAddress = this.addToAddress(address, offset);

                const response = await this._activeSession.customRequest('readMemory', {
                    memoryReference: currentAddress,
                    offset: 0,
                    count: readSize,
                }) as ReadMemoryResponse;

                if (response.data) {
                    const binaryString = atob(response.data);
                    for (let i = 0; i < binaryString.length; i++) {
                        result[offset + i] = binaryString.charCodeAt(i);
                    }
                    offset += binaryString.length;
                } else {
                    console.error(`No data returned for memory read at ${currentAddress}`);
                    return undefined;
                }
            } catch (error) {
                console.error(`Failed to read memory chunk at offset ${offset}:`, error);
                return undefined;
            }
        }

        return result;
    }

    /**
     * Add offset to a hex address string
     */
    private addToAddress(address: string, offset: number): string {
        // Parse address (handle various formats: 0x1234, 1234, etc.)
        let addr: bigint;
        if (address.startsWith('0x') || address.startsWith('0X')) {
            addr = BigInt(address);
        } else {
            addr = BigInt('0x' + address);
        }

        const newAddr = addr + BigInt(offset);
        return '0x' + newAddr.toString(16);
    }

    /**
     * Get variables from a variables reference
     */
    public async getVariables(variablesReference: number): Promise<VariableInfo[]> {
        if (!this._activeSession || variablesReference === 0) {
            return [];
        }

        try {
            const response = await this._activeSession.customRequest('variables', {
                variablesReference,
            });
            return (response.variables ?? []) as VariableInfo[];
        } catch (error) {
            console.error(`Failed to get variables for ref ${variablesReference}:`, error);
            return [];
        }
    }

    /**
     * Get scopes for the current frame
     */
    public async getScopes(): Promise<{ name: string; variablesReference: number; expensive: boolean }[]> {
        if (!this._activeSession || this._currentFrameId === undefined) {
            return [];
        }

        try {
            const response = await this._activeSession.customRequest('scopes', {
                frameId: this._currentFrameId,
            });
            return response.scopes ?? [];
        } catch (error) {
            console.error('Failed to get scopes:', error);
            return [];
        }
    }

    /**
     * Get local variables from the current scope
     */
    public async getLocalVariables(): Promise<VariableInfo[]> {
        const scopes = await this.getScopes();

        // Find the "Locals" or "Local" scope
        const localScope = scopes.find(s =>
            s.name.toLowerCase().includes('local') && !s.name.toLowerCase().includes('static')
        );

        if (localScope) {
            return this.getVariables(localScope.variablesReference);
        }

        // Fallback: return variables from first non-expensive scope
        const nonExpensiveScope = scopes.find(s => !s.expensive);
        if (nonExpensiveScope) {
            return this.getVariables(nonExpensiveScope.variablesReference);
        }

        return [];
    }

    /**
     * Get a specific variable by evaluating its name
     */
    public async getVariableByName(name: string): Promise<EvaluateResponse | undefined> {
        return this.evaluate(name);
    }

    /**
     * Get the value of a struct member
     */
    public async getMemberValue(variablesReference: number, memberName: string): Promise<VariableInfo | undefined> {
        const variables = await this.getVariables(variablesReference);
        return variables.find(v => v.name === memberName);
    }

    /**
     * Parse a numeric value from a debug string
     */
    public parseNumericValue(value: string): number | undefined {
        // Handle hex values
        if (value.startsWith('0x') || value.startsWith('0X')) {
            return parseInt(value, 16);
        }

        // Handle decimal with possible suffix or extra info
        const match = value.match(/^-?\d+/);
        if (match) {
            return parseInt(match[0], 10);
        }

        return undefined;
    }

    /**
     * Parse an address from a debug string
     */
    public parseAddress(value: string): string | undefined {
        // Match hex address patterns
        const hexMatch = value.match(/0x[0-9a-fA-F]+/);
        if (hexMatch) {
            return hexMatch[0];
        }

        // Some debuggers show address without 0x prefix
        const plainMatch = value.match(/^[0-9a-fA-F]{8,16}$/);
        if (plainMatch) {
            return '0x' + plainMatch[0];
        }

        return undefined;
    }

    public dispose(): void {
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
        this.disposables = [];
        this._onDidChangeSession.dispose();
        this._onDidStopOnBreakpoint.dispose();
        this._onDidContinue.dispose();
        DebugSessionManager.instance = undefined;
    }
}
