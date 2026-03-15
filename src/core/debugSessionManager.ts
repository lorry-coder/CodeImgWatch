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
        const supportedTypes = ['cppdbg', 'cppvsdbg', 'lldb', 'debugpy'];
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
            case 'debugpy':
                return 'debugpy';
            default:
                return 'unknown';
        }
    }

    /**
     * Check if current debugger is Python-based
     */
    public isPythonDebugger(): boolean {
        return this.getDebuggerType() === 'debugpy';
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
            console.error('[ImView] evaluate: No active session');
            return undefined;
        }

        // Try to get frame ID if we don't have one
        if (this._currentFrameId === undefined) {
            await this.tryGetCurrentFrame();
        }

        if (this._currentFrameId === undefined) {
            console.error('[ImView] evaluate: No frame ID available');
            return undefined;
        }

        try {
            console.log(`[ImView] Evaluating (context=${context}, frameId=${this._currentFrameId}): ${expression.substring(0, 100)}...`);
            const response = await this._activeSession.customRequest('evaluate', {
                expression,
                frameId: this._currentFrameId,
                context,
            });
            console.log(`[ImView] Evaluate response: result=${response?.result?.substring(0, 100)}...`);
            return response as EvaluateResponse;
        } catch (error) {
            console.error(`[ImView] Failed to evaluate '${expression.substring(0, 100)}...':`, error);
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

    /**
     * Read memory via Python expression evaluation (for debugpy)
     * Since debugpy doesn't support DAP readMemory, we use expression evaluation
     * with base64 encoding to transfer binary data
     */
    public async readMemoryViaPython(expression: string): Promise<Uint8Array | undefined> {
        if (!this._activeSession) {
            return undefined;
        }

        try {
            // Evaluate Python expression that returns base64-encoded bytes
            // The expression should be constructed by the caller to use:
            // import base64; base64.b64encode(arr.tobytes()).decode()
            const pythonExpr = `__import__('base64').b64encode(${expression}.tobytes()).decode('ascii')`;
            const result = await this.evaluate(pythonExpr, 'repl');

            if (!result || !result.result) {
                console.error(`Failed to evaluate Python expression for memory read`);
                return undefined;
            }

            // The result is a string with quotes, e.g., "'SGVsbG8='"
            // Remove quotes and decode base64
            let base64Data = result.result;
            // Remove surrounding quotes if present
            if ((base64Data.startsWith("'") && base64Data.endsWith("'")) ||
                (base64Data.startsWith('"') && base64Data.endsWith('"'))) {
                base64Data = base64Data.slice(1, -1);
            }

            // Decode base64 to Uint8Array
            const binaryString = atob(base64Data);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
                bytes[i] = binaryString.charCodeAt(i);
            }
            return bytes;
        } catch (error) {
            console.error(`Failed to read memory via Python:`, error);
            return undefined;
        }
    }

    /**
     * Read memory for Python arrays by ensuring data is contiguous first
     * This handles non-contiguous numpy arrays by using np.ascontiguousarray
     * Uses chunked reading to handle large images that exceed debugpy's output limits
     */
    public async readPythonArrayData(expression: string, ensureContiguous: boolean = true): Promise<Uint8Array | undefined> {
        if (!this._activeSession) {
            console.error('[ImView] No active session for readPythonArrayData');
            return undefined;
        }

        try {
            // Build the expression to get contiguous data
            let dataExpr: string;
            if (ensureContiguous) {
                // Use numpy.ascontiguousarray to ensure C-contiguous layout
                dataExpr = `__import__('numpy').ascontiguousarray(${expression})`;
            } else {
                dataExpr = expression;
            }

            console.log(`[ImView] Reading Python array data: ${dataExpr}`);

            // First, store the array in a temporary variable and get its size
            // This avoids re-evaluating the expression multiple times
            const tempVarName = `_imview_temp_${Date.now()}`;
            const storeExpr = `globals().__setitem__('${tempVarName}', ${dataExpr}.tobytes()) or len(globals()['${tempVarName}'])`;

            console.log(`[ImView] Store expression: ${storeExpr}`);
            const sizeResult = await this.evaluate(storeExpr, 'repl');
            console.log(`[ImView] Size result:`, JSON.stringify(sizeResult));

            if (!sizeResult || !sizeResult.result) {
                console.error(`[ImView] Failed to store Python array data, result:`, sizeResult);
                return undefined;
            }

            const totalSize = parseInt(sizeResult.result, 10);
            if (isNaN(totalSize) || totalSize <= 0) {
                console.error(`[ImView] Invalid array size: ${sizeResult.result}`);
                // Clean up temp variable
                await this.evaluate(`globals().pop('${tempVarName}', None)`, 'repl');
                return undefined;
            }

            console.log(`[ImView] Total size to read: ${totalSize} bytes`);

            // Read data in chunks to avoid debugpy output limits
            // debugpy limits evaluate result to ~64KB, base64 increases size by ~33%
            // So we can read about 48KB of raw data per chunk (48KB * 1.33 ≈ 64KB)
            const chunkSize = 48 * 1024; // 48KB chunks (will be ~64KB in base64)
            const result = new Uint8Array(totalSize);
            let offset = 0;

            while (offset < totalSize) {
                const remaining = totalSize - offset;
                const readSize = Math.min(chunkSize, remaining);

                // Read chunk as base64
                const chunkExpr = `__import__('base64').b64encode(globals()['${tempVarName}'][${offset}:${offset + readSize}]).decode('ascii')`;
                const chunkResult = await this.evaluate(chunkExpr, 'repl');

                if (!chunkResult || !chunkResult.result) {
                    console.error(`[ImView] Failed to read chunk at offset ${offset}, result:`, chunkResult);
                    // Clean up temp variable
                    await this.evaluate(`globals().pop('${tempVarName}', None)`, 'repl');
                    return undefined;
                }

                // Parse result - remove quotes and clean up
                let base64Data = chunkResult.result;

                // Remove surrounding quotes if present
                if ((base64Data.startsWith("'") && base64Data.endsWith("'")) ||
                    (base64Data.startsWith('"') && base64Data.endsWith('"'))) {
                    base64Data = base64Data.slice(1, -1);
                }

                // Remove any newlines, spaces, or escape sequences that debugpy might add
                base64Data = base64Data.replace(/[\r\n\s\\]/g, '');

                // Validate base64 string
                if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64Data)) {
                    console.error(`[ImView] Invalid base64 string at offset ${offset}, length: ${base64Data.length}`);
                    console.error(`[ImView] First 100 chars: ${base64Data.substring(0, 100)}`);
                    console.error(`[ImView] Last 100 chars: ${base64Data.substring(base64Data.length - 100)}`);
                    // Clean up temp variable
                    await this.evaluate(`globals().pop('${tempVarName}', None)`, 'repl');
                    return undefined;
                }

                // Decode base64 chunk
                try {
                    const binaryString = atob(base64Data);
                    for (let i = 0; i < binaryString.length; i++) {
                        result[offset + i] = binaryString.charCodeAt(i);
                    }
                    offset += binaryString.length;
                    console.log(`[ImView] Read chunk: ${offset}/${totalSize} bytes`);
                } catch (decodeError) {
                    console.error(`[ImView] Failed to decode base64 at offset ${offset}:`, decodeError);
                    console.error(`[ImView] Base64 length: ${base64Data.length}`);
                    // Clean up temp variable
                    await this.evaluate(`globals().pop('${tempVarName}', None)`, 'repl');
                    return undefined;
                }
            }

            // Clean up temp variable
            await this.evaluate(`globals().pop('${tempVarName}', None)`, 'repl');

            console.log(`[ImView] Successfully read ${result.length} bytes`);
            return result;
        } catch (error) {
            console.error(`[ImView] Failed to read Python array data:`, error);
            return undefined;
        }
    }

    /**
     * Evaluate a Python expression and get a numeric result
     */
    public async evaluatePythonAsNumber(expression: string): Promise<number | undefined> {
        const result = await this.evaluate(expression, 'repl');
        if (!result || !result.result) {
            return undefined;
        }

        // Parse the result as number
        const value = parseFloat(result.result);
        return isNaN(value) ? undefined : value;
    }

    /**
     * Evaluate a Python expression and get a string result
     */
    public async evaluatePythonAsString(expression: string): Promise<string | undefined> {
        const result = await this.evaluate(expression, 'repl');
        if (!result || !result.result) {
            return undefined;
        }

        // Remove surrounding quotes
        let str = result.result;
        if ((str.startsWith("'") && str.endsWith("'")) ||
            (str.startsWith('"') && str.endsWith('"'))) {
            str = str.slice(1, -1);
        }
        return str;
    }

    /**
     * Evaluate a Python expression and get a tuple/list as number array
     */
    public async evaluatePythonAsTuple(expression: string): Promise<number[] | undefined> {
        const result = await this.evaluate(expression, 'repl');
        if (!result || !result.result) {
            return undefined;
        }

        try {
            // Parse tuple/list format like (100, 200, 3) or [100, 200, 3]
            const str = result.result.trim();
            const match = str.match(/[\(\[](.*)[\)\]]/);
            if (!match) {
                return undefined;
            }

            const values = match[1].split(',').map(v => {
                const num = parseFloat(v.trim());
                return isNaN(num) ? 0 : num;
            });

            return values;
        } catch {
            return undefined;
        }
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
