import * as assert from 'assert';
import * as vscode from 'vscode';
import { DebugSessionManager, EvaluateResponse } from '../../src/core/debugSessionManager';
import { ImageWatchDebugAdapterTracker } from '../../src/providers/debugVariableDecorator';

function managerReturning(result: string): DebugSessionManager {
    const manager = Object.create(DebugSessionManager.prototype) as DebugSessionManager;
    manager.evaluate = async (): Promise<EvaluateResponse> => ({
        result,
        variablesReference: 0,
    });
    return manager;
}

describe('DebugSessionManager Python value parsing', () => {
    it('parses the trailing comma in a single-element tuple', async () => {
        const manager = managerReturning('(10,)');
        assert.deepStrictEqual(await manager.evaluatePythonAsTuple('shape'), [10]);
    });

    it('rejects empty tuple fields instead of converting them to zero', async () => {
        const manager = managerReturning('(10,, 20)');
        assert.strictEqual(await manager.evaluatePythonAsTuple('shape'), undefined);
    });
});

describe('Debug adapter lifecycle forwarding', () => {
    it('forwards standard stopped and continued DAP events to the session manager', () => {
        const calls: string[] = [];
        const session = { id: 'session', type: 'cppdbg' } as vscode.DebugSession;
        const manager = {
            handleAdapterStopped: async (received: vscode.DebugSession, body: { threadId?: number }) => {
                assert.strictEqual(received, session);
                assert.strictEqual(body.threadId, 7);
                calls.push('stopped');
            },
            handleAdapterContinued: (received: vscode.DebugSession, body: { allThreadsContinued?: boolean }) => {
                assert.strictEqual(received, session);
                assert.strictEqual(body.allThreadsContinued, true);
                calls.push('continued');
            },
        } as unknown as DebugSessionManager;
        const tracker = new ImageWatchDebugAdapterTracker(session, manager);

        tracker.onDidSendMessage({ type: 'event', event: 'stopped', body: { threadId: 7 } });
        tracker.onDidSendMessage({
            type: 'event',
            event: 'continued',
            body: { allThreadsContinued: true },
        });

        assert.deepStrictEqual(calls, ['stopped', 'continued']);
    });

    it('does not resume the selected thread when only another thread continued', () => {
        const session = { id: 'session', type: 'cppdbg' } as vscode.DebugSession;
        const manager = Object.create(DebugSessionManager.prototype) as DebugSessionManager;
        const continueEmitter = new vscode.EventEmitter<vscode.DebugSession>();
        const state = manager as unknown as {
            _activeSession: vscode.DebugSession;
            _currentThreadId?: number;
            _currentFrameId?: number;
            _isPaused: boolean;
            _onDidContinue: vscode.EventEmitter<vscode.DebugSession>;
        };
        Object.assign(state, {
            _activeSession: session,
            _currentThreadId: 7,
            _currentFrameId: 70,
            _isPaused: true,
            _onDidContinue: continueEmitter,
        });

        manager.handleAdapterContinued(session, { threadId: 8 });
        assert.strictEqual(state._isPaused, true);
        assert.strictEqual(state._currentFrameId, 70);

        manager.handleAdapterContinued(session, { threadId: 8, allThreadsContinued: true });
        assert.strictEqual(state._isPaused, false);
        assert.strictEqual(state._currentFrameId, undefined);
        continueEmitter.dispose();
    });

    it('discards a final memory chunk if the debugger resumes while it is in flight', async () => {
        const manager = Object.create(DebugSessionManager.prototype) as DebugSessionManager;
        const state = manager as unknown as {
            _activeSession: vscode.DebugSession;
            _isPaused: boolean;
        };
        const session = {
            id: 'session',
            type: 'cppdbg',
            customRequest: async () => {
                state._isPaused = false;
                return { data: Buffer.from([1, 2, 3, 4]).toString('base64') };
            },
        } as unknown as vscode.DebugSession;
        Object.assign(state, { _activeSession: session, _isPaused: true });

        const data = await manager.readMemoryChunked('0x1000', 4, 4);
        assert.strictEqual(data, undefined);
    });
});
