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
    private lastStopKey?: string;

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
                if (this.isSupportedDebugger(session.type) &&
                    (!this._activeSession || vscode.debug.activeDebugSession?.id === session.id)) {
                    this.changeActiveSession(session);
                }
            })
        );

        this.disposables.push(
            vscode.debug.onDidTerminateDebugSession(session => {
                if (this._activeSession === session) {
                    this.changeActiveSession(undefined);
                }
            })
        );

        // Listen for active debug session changes
        this.disposables.push(
            vscode.debug.onDidChangeActiveDebugSession(session => {
                if (session && this.isSupportedDebugger(session.type)) {
                    this.changeActiveSession(session);
                } else {
                    this.changeActiveSession(undefined);
                }
            })
        );

        // Listen for stopped events (breakpoints, step, etc.)
        this.disposables.push(
            vscode.debug.onDidReceiveDebugSessionCustomEvent(event => {
                if (event.event === 'stopped') {
                    void this.handleAdapterStopped(event.session, event.body ?? {});
                } else if (event.event === 'continued') {
                    this.handleAdapterContinued(event.session, event.body ?? {});
                }
            })
        );

        // Listen for stack frame changes - most reliable way to detect paused state
        this.disposables.push(
            vscode.debug.onDidChangeActiveStackItem(item => {
                if (!item) {
                    if (this._activeSession) {
                        this.handleAdapterContinued(this._activeSession);
                    }
                    return;
                }
                if (!this.isSupportedDebugger(item.session.type)) {
                    return;
                }
                if (this._activeSession?.id !== item.session.id) {
                    this.changeActiveSession(item.session);
                }

                this._isPaused = true;
                this._currentThreadId = item.threadId;
                if ('frameId' in item) {
                    this._currentFrameId = item.frameId;
                    this.emitStopped(item.session, item.threadId, item.frameId);
                }
            })
        );

        // Set initial active session if one exists
        if (vscode.debug.activeDebugSession && this.isSupportedDebugger(vscode.debug.activeDebugSession.type)) {
            this.changeActiveSession(vscode.debug.activeDebugSession);
            if (vscode.debug.activeStackItem) {
                this._isPaused = true;
            }
        }
    }

    private changeActiveSession(session: vscode.DebugSession | undefined): void {
        if (this._activeSession?.id === session?.id) {
            return;
        }
        this._activeSession = session;
        this._currentThreadId = undefined;
        this._currentFrameId = undefined;
        this._isPaused = false;
        this.lastStopKey = undefined;
        this._onDidChangeSession.fire(session);
    }

    /** Receive a standard DAP stopped event from the registered adapter tracker. */
    public async handleAdapterStopped(
        session: vscode.DebugSession,
        body: { threadId?: number; allThreadsStopped?: boolean }
    ): Promise<void> {
        if (!this.isSupportedDebugger(session.type)) {
            return;
        }
        if (this._activeSession?.id !== session.id) {
            if (vscode.debug.activeDebugSession?.id !== session.id) {
                return;
            }
            this.changeActiveSession(session);
        }

        this._isPaused = true;

        try {
            let threadId = body.threadId;
            if (threadId === undefined) {
                const activeStackItem = vscode.debug.activeStackItem;
                if (activeStackItem?.session.id === session.id) {
                    threadId = activeStackItem.threadId;
                } else {
                    const threadsResponse = await session.customRequest('threads', {});
                    if (this._activeSession?.id !== session.id || !this._isPaused) {
                        return;
                    }
                    threadId = threadsResponse.threads?.[0]?.id;
                }
            }
            if (threadId === undefined || !Number.isInteger(threadId)) {
                console.error('[ImView] Stopped event did not identify a usable thread');
                return;
            }
            this._currentThreadId = threadId;

            // Get the current stack frame
            const stackResponse = await session.customRequest('stackTrace', {
                threadId,
                startFrame: 0,
                levels: 1,
            });

            if (this._activeSession?.id !== session.id || !this._isPaused) {
                return;
            }

            if (stackResponse.stackFrames && stackResponse.stackFrames.length > 0) {
                const frame = stackResponse.stackFrames[0];
                this._currentFrameId = frame.id;
                this.emitStopped(session, threadId, frame.id);
            }
        } catch (error) {
            console.error('Failed to get stack trace:', error);
        }
    }

    /** Receive a standard DAP continued event from the registered adapter tracker. */
    public handleAdapterContinued(
        session: vscode.DebugSession,
        body: { threadId?: number; allThreadsContinued?: boolean } = {}
    ): void {
        if (this._activeSession?.id !== session.id) {
            return;
        }
        if (this._currentThreadId !== undefined &&
            body.threadId !== undefined &&
            body.threadId !== this._currentThreadId &&
            body.allThreadsContinued !== true) {
            return;
        }
        const wasPaused = this._isPaused || this._currentFrameId !== undefined;
        this._isPaused = false;
        this._currentThreadId = undefined;
        this._currentFrameId = undefined;
        this.lastStopKey = undefined;
        if (wasPaused) {
            this._onDidContinue.fire(session);
        }
    }

    private emitStopped(session: vscode.DebugSession, threadId: number, frameId: number): void {
        const key = `${session.id}:${threadId}:${frameId}`;
        if (this.lastStopKey === key) {
            return;
        }
        this.lastStopKey = key;
        this._onDidStopOnBreakpoint.fire({ session, threadId, frameId });
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

    /** Check whether a standard adapter/stack event has put the active session in a paused state. */
    public get isPaused(): boolean {
        return this._isPaused;
    }

    /**
     * Evaluate an expression in the current context
     */
    public async evaluate(expression: string, context: 'watch' | 'repl' | 'hover' = 'watch'): Promise<EvaluateResponse | undefined> {
        if (!this._activeSession || !this.isPaused) {
            console.error('[ImView] evaluate: No paused active session');
            return undefined;
        }

        // Try to get frame ID if we don't have one
        if (this._currentFrameId === undefined) {
            await this.tryGetCurrentFrame();
        }

        const session = this._activeSession;
        const frameId = this._currentFrameId;
        if (frameId === undefined || !this._isPaused) {
            console.error('[ImView] evaluate: No frame ID available');
            return undefined;
        }

        return this.evaluateInContext(session, frameId, expression, context);
    }

    private async evaluateInContext(
        session: vscode.DebugSession,
        frameId: number,
        expression: string,
        context: 'watch' | 'repl' | 'hover'
    ): Promise<EvaluateResponse | undefined> {
        try {
            console.log(`[ImView] Evaluating (context=${context}, frameId=${frameId}): ${expression.substring(0, 100)}...`);
            const response = await session.customRequest('evaluate', {
                expression,
                frameId,
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
        const session = this._activeSession;
        if (!session || !this._isPaused) {
            return;
        }
        const captureIsCurrent = (): boolean =>
            this._activeSession?.id === session.id && this._isPaused;

        // Check if there's an active stack item
        const stackItem = vscode.debug.activeStackItem;
        if (stackItem && stackItem.session.id === session.id && 'frameId' in stackItem) {
            this._currentFrameId = stackItem.frameId;
            this._currentThreadId = stackItem.threadId;
            return;
        }

        // Try to get threads and stack trace
        try {
            const threadsResponse = await session.customRequest('threads', {});
            if (!captureIsCurrent()) {
                return;
            }
            const threads = threadsResponse.threads || [];

            if (threads.length > 0) {
                const threadId = threads[0].id;
                const stackResponse = await session.customRequest('stackTrace', {
                    threadId,
                    startFrame: 0,
                    levels: 1,
                });
                if (!captureIsCurrent()) {
                    return;
                }

                if (stackResponse.stackFrames && stackResponse.stackFrames.length > 0) {
                    this._currentThreadId = threadId;
                    this._currentFrameId = stackResponse.stackFrames[0].id;
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
        if (!this._activeSession || !this.isPaused || !this.isValidTransferSize(count)) {
            return undefined;
        }
        const session = this._activeSession;

        try {
            const response = await session.customRequest('readMemory', {
                memoryReference: address,
                offset: 0,
                count,
            }) as ReadMemoryResponse;

            if (response.data) {
                const bytes = new Uint8Array(Buffer.from(response.data, 'base64'));
                if (this._activeSession?.id !== session.id || !this._isPaused ||
                    bytes.length !== count || (response.unreadableBytes ?? 0) > 0) {
                    return undefined;
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
        if (!this._activeSession || !this.isPaused || !this.isValidTransferSize(totalSize) ||
            !Number.isSafeInteger(chunkSize) || chunkSize <= 0) {
            return undefined;
        }

        const session = this._activeSession;
        const captureIsCurrent = (): boolean =>
            this._activeSession?.id === session.id && this._isPaused;
        const result = new Uint8Array(totalSize);
        let offset = 0;

        while (offset < totalSize) {
            const remaining = totalSize - offset;
            const readSize = Math.min(chunkSize, remaining);

            try {
                if (!captureIsCurrent()) {
                    console.error('[ImView] Debug context changed during memory transfer');
                    return undefined;
                }
                const response = await session.customRequest('readMemory', {
                    // DAP memory references are opaque. Advance with the request offset.
                    memoryReference: address,
                    offset,
                    count: readSize,
                }) as ReadMemoryResponse;
                if (!captureIsCurrent()) {
                    console.error('[ImView] Debug context changed during memory transfer');
                    return undefined;
                }

                if (response.data) {
                    const bytes = new Uint8Array(Buffer.from(response.data, 'base64'));
                    if (bytes.length === 0 || bytes.length > readSize || (response.unreadableBytes ?? 0) > 0) {
                        console.error(
                            `[ImView] Incomplete memory read at offset ${offset}: requested ${readSize}, got ${bytes.length}`
                        );
                        return undefined;
                    }
                    result.set(bytes, offset);
                    offset += bytes.length;
                } else {
                    console.error(`No data returned for memory read at offset ${offset}`);
                    return undefined;
                }
            } catch (error) {
                console.error(`Failed to read memory chunk at offset ${offset}:`, error);
                return undefined;
            }
        }

        return result;
    }

    private isValidTransferSize(size: number): boolean {
        const configuredLimit = vscode.workspace
            .getConfiguration('imview')
            .get<number>('maxImageBytes', 256 * 1024 * 1024);
        const maxBytes = Number.isFinite(configuredLimit) && configuredLimit > 0
            ? Math.floor(configuredLimit)
            : 256 * 1024 * 1024;

        if (!Number.isSafeInteger(size) || size <= 0 || size > maxBytes) {
            console.error(`[ImView] Refusing invalid or oversized image transfer: ${size} bytes (max ${maxBytes})`);
            return false;
        }
        return true;
    }

    /**
     * Get variables from a variables reference
     */
    public async getVariables(variablesReference: number): Promise<VariableInfo[]> {
        const session = this._activeSession;
        if (!session || !this._isPaused || variablesReference === 0) {
            return [];
        }

        try {
            const response = await session.customRequest('variables', {
                variablesReference,
            });
            if (this._activeSession?.id !== session.id || !this._isPaused) {
                return [];
            }
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
        const session = this._activeSession;
        const frameId = this._currentFrameId;
        if (!session || !this._isPaused || frameId === undefined) {
            return [];
        }

        try {
            const response = await session.customRequest('scopes', {
                frameId,
            });
            if (this._activeSession?.id !== session.id ||
                this._currentFrameId !== frameId || !this._isPaused) {
                return [];
            }
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

            return new Uint8Array(Buffer.from(base64Data, 'base64'));
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
        if (!this._activeSession || !this.isPaused) {
            console.error('[ImView] No paused active session for readPythonArrayData');
            return undefined;
        }

        if (this._currentFrameId === undefined) {
            await this.tryGetCurrentFrame();
        }
        const session = this._activeSession;
        const frameId = this._currentFrameId;
        if (frameId === undefined || !this._isPaused) {
            console.error('[ImView] No fixed stack frame for Python data transfer');
            return undefined;
        }
        const evaluateCaptured = (pythonExpression: string): Promise<EvaluateResponse | undefined> =>
            this.evaluateInContext(session, frameId, pythonExpression, 'repl');
        const captureIsCurrent = (): boolean =>
            this._activeSession?.id === session.id &&
            this._currentFrameId === frameId &&
            this._isPaused;

        const tempVarName = `_imview_temp_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        let temporaryValueCreated = false;

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
            const storeExpr = `globals().__setitem__('${tempVarName}', ${dataExpr}.tobytes()) or len(globals()['${tempVarName}'])`;

            console.log(`[ImView] Store expression: ${storeExpr}`);
            temporaryValueCreated = true;
            const sizeResult = await evaluateCaptured(storeExpr);
            console.log(`[ImView] Size result:`, JSON.stringify(sizeResult));

            if (!captureIsCurrent() || !sizeResult || !sizeResult.result) {
                console.error(`[ImView] Failed to store Python array data, result:`, sizeResult);
                return undefined;
            }
            const totalSize = parseInt(sizeResult.result, 10);
            if (!this.isValidTransferSize(totalSize)) {
                console.error(`[ImView] Invalid array size: ${sizeResult.result}`);
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
                if (!captureIsCurrent()) {
                    console.error('[ImView] Debug context changed during Python data transfer');
                    return undefined;
                }
                const remaining = totalSize - offset;
                const readSize = Math.min(chunkSize, remaining);

                // Read chunk as base64
                const chunkExpr = `__import__('base64').b64encode(globals()['${tempVarName}'][${offset}:${offset + readSize}]).decode('ascii')`;
                const chunkResult = await evaluateCaptured(chunkExpr);

                if (!captureIsCurrent() || !chunkResult || !chunkResult.result) {
                    console.error(`[ImView] Failed to read chunk at offset ${offset}, result:`, chunkResult);
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
                    return undefined;
                }

                // Decode base64 chunk
                try {
                    const bytes = new Uint8Array(Buffer.from(base64Data, 'base64'));
                    if (bytes.length !== readSize) {
                        console.error(`[ImView] Python chunk size mismatch: expected ${readSize}, got ${bytes.length}`);
                        return undefined;
                    }
                    result.set(bytes, offset);
                    offset += bytes.length;
                    console.log(`[ImView] Read chunk: ${offset}/${totalSize} bytes`);
                } catch (decodeError) {
                    console.error(`[ImView] Failed to decode base64 at offset ${offset}:`, decodeError);
                    console.error(`[ImView] Base64 length: ${base64Data.length}`);
                    return undefined;
                }
            }

            console.log(`[ImView] Successfully read ${result.length} bytes`);
            return captureIsCurrent() ? result : undefined;
        } catch (error) {
            console.error(`[ImView] Failed to read Python array data:`, error);
            return undefined;
        } finally {
            if (temporaryValueCreated && captureIsCurrent()) {
                await evaluateCaptured(`globals().pop('${tempVarName}', None)`);
            }
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
            const str = result.result.trim();
            const isTuple = str.startsWith('(') && str.endsWith(')');
            const isList = str.startsWith('[') && str.endsWith(']');
            if (!isTuple && !isList) {
                return undefined;
            }

            const contents = str.slice(1, -1).trim();
            if (contents.length === 0) {
                return [];
            }

            const parts = contents.split(',');
            if (parts[parts.length - 1].trim() === '') {
                parts.pop();
            }
            if (parts.length === 0 || parts.some(value => value.trim() === '')) {
                return undefined;
            }
            const values = parts.map(value => Number(value.trim()));

            if (values.some(value => !Number.isFinite(value))) {
                return undefined;
            }

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
