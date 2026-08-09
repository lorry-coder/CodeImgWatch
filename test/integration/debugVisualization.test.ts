import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { DebugSessionManager } from '../../src/core/debugSessionManager';
import { readImageDataForDisplay } from '../../src/core/imageDataReader';
import { resolveImageExpression } from '../../src/core/imageResolver';
import { registerBuiltInParsers } from '../../src/parsers';
import { CvMatParser } from '../../src/parsers/cvMatParser';
import { NumpyArrayParser } from '../../src/parsers/numpyParser';
import { PILImageParser } from '../../src/parsers/pilParser';
import { TorchTensorParser } from '../../src/parsers/torchParser';

const runIntegration = process.env.IMVIEW_RUN_DEBUG_INTEGRATION === '1';
const integrationTest = runIntegration ? it : it.skip;

function repositoryPath(...parts: string[]): string {
    return path.resolve(__dirname, '../../..', ...parts);
}

function findLine(filePath: string, marker: string): number {
    const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
    const line = lines.findIndex(value => value.includes(marker));
    assert.ok(line >= 0, `Breakpoint marker not found: ${marker}`);
    return line;
}

function waitForStop(manager: DebugSessionManager, timeoutMs: number = 30000): Promise<void> {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            disposable.dispose();
            reject(new Error('Timed out waiting for debugger to stop'));
        }, timeoutMs);
        const disposable = manager.onDidStopOnBreakpoint(() => {
            clearTimeout(timeout);
            disposable.dispose();
            resolve();
        });
    });
}

function waitForContinue(manager: DebugSessionManager, timeoutMs: number = 30000): Promise<void> {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            disposable.dispose();
            reject(new Error('Timed out waiting for debugger to continue'));
        }, timeoutMs);
        const disposable = manager.onDidContinue(() => {
            clearTimeout(timeout);
            disposable.dispose();
            resolve();
        });
    });
}

async function stopDebugging(): Promise<void> {
    if (vscode.debug.activeDebugSession) {
        await vscode.debug.stopDebugging(vscode.debug.activeDebugSession);
    }
    vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
}

describe('Real debugger visualization', function () {
    this.timeout(60000);

    before(async () => {
        registerBuiltInParsers();
        await vscode.workspace
            .getConfiguration('imview')
            .update('autoRefresh', false, vscode.ConfigurationTarget.Global);
    });

    afterEach(async () => {
        await stopDebugging();
    });

    after(async () => {
        await vscode.workspace
            .getConfiguration('imview')
            .update('autoRefresh', undefined, vscode.ConfigurationTarget.Global);
    });

    integrationTest('reads NumPy/OpenCV and Pillow images through debugpy', async () => {
        const debugpy = vscode.extensions.getExtension('ms-python.debugpy');
        assert.ok(debugpy, 'The debugpy extension was not loaded into the test host');

        const program = repositoryPath('samples', 'test_python.py');
        const uri = vscode.Uri.file(program);
        const breakpoint = new vscode.SourceBreakpoint(
            new vscode.Location(uri, new vscode.Position(findLine(program, 'Set a breakpoint here'), 0))
        );
        vscode.debug.addBreakpoints([breakpoint]);

        const manager = DebugSessionManager.getInstance();
        const stopped = waitForStop(manager);
        const started = await vscode.debug.startDebugging(undefined, {
            name: 'ImView Python integration',
            type: 'debugpy',
            request: 'launch',
            program,
            python: process.env.IMVIEW_PYTHON_PATH ?? 'python3',
            justMyCode: false,
        });
        assert.strictEqual(started, true, 'debugpy session did not start');
        await stopped;

        const numpyResult = await manager.evaluate('bgr');
        assert.ok(numpyResult, 'Could not evaluate bgr');
        const numpyMetadata = await new NumpyArrayParser().parse(manager, 'bgr');
        assert.strictEqual(numpyMetadata.success, true, numpyMetadata.error);
        const numpyData = await readImageDataForDisplay(manager, numpyMetadata.metadata!);
        assert.strictEqual(numpyData?.data.length, 100 * 100 * 3);

        const nonContiguousMetadata = await new NumpyArrayParser().parse(manager, 'non_contiguous');
        assert.strictEqual(nonContiguousMetadata.success, true, nonContiguousMetadata.error);
        const nonContiguousData = await readImageDataForDisplay(manager, nonContiguousMetadata.metadata!);
        assert.strictEqual(nonContiguousData?.data.length, 100 * 50 * 3);

        const pilResult = await manager.evaluate('pil_rgba');
        assert.ok(pilResult, 'Could not evaluate pil_rgba');
        const pilMetadata = await new PILImageParser().parse(manager, 'pil_rgba');
        assert.strictEqual(pilMetadata.success, true, pilMetadata.error);
        const pilData = await readImageDataForDisplay(manager, pilMetadata.metadata!);
        assert.strictEqual(pilData?.data.length, 100 * 100 * 4);

        const fileImageResult = await manager.evaluate('pil_file');
        assert.match(fileImageResult?.type ?? '', /ImageFile/);
        const fileImageMetadata = await new PILImageParser().parse(manager, 'pil_file');
        assert.strictEqual(fileImageMetadata.success, true, fileImageMetadata.error);
        const fileImageData = await readImageDataForDisplay(manager, fileImageMetadata.metadata!);
        assert.strictEqual(fileImageData?.data.length, 100 * 100 * 3);

        const tensorResult = await manager.evaluate('tensor_chw');
        if (tensorResult && tensorResult.result !== 'None') {
            const tensorMetadata = await new TorchTensorParser().parse(manager, 'tensor_chw');
            assert.strictEqual(tensorMetadata.success, true, tensorMetadata.error);
            const tensorData = await readImageDataForDisplay(manager, tensorMetadata.metadata!);
            assert.strictEqual(tensorData?.data.length, 3 * 100 * 100);
        }

        const derived = await resolveImageExpression(manager, '@rot90(bgr)');
        assert.strictEqual(derived.success, true, derived.error);
        assert.strictEqual(derived.data?.metadata.width, 100);
        assert.strictEqual(derived.data?.data.length, 100 * 100 * 3);
    });

    integrationTest('reads continuous and ROI cv::Mat data through GDB DAP', async () => {
        const cpptools = vscode.extensions.getExtension('ms-vscode.cpptools');
        assert.ok(cpptools, 'The C/C++ extension was not loaded into the test host');

        const program = process.env.IMVIEW_CPP_SAMPLE;
        assert.ok(program && fs.existsSync(program), 'IMVIEW_CPP_SAMPLE must point to the compiled sample');
        const source = repositoryPath('samples', 'test_opencv.cpp');
        const uri = vscode.Uri.file(source);
        const breakpoint = new vscode.SourceBreakpoint(
            new vscode.Location(uri, new vscode.Position(findLine(source, 'Breakpoint here to inspect images'), 0))
        );
        vscode.debug.addBreakpoints([breakpoint]);

        const manager = DebugSessionManager.getInstance();
        const stopped = waitForStop(manager);
        const started = await vscode.debug.startDebugging(undefined, {
            name: 'ImView C++ integration',
            type: 'cppdbg',
            request: 'launch',
            program,
            cwd: path.dirname(program),
            MIMode: 'gdb',
        });
        assert.strictEqual(started, true, 'GDB session did not start');
        await stopped;

        for (const expression of ['color', 'roi']) {
            const evaluated = await manager.evaluate(expression);
            assert.ok(evaluated, `Could not evaluate ${expression}`);
            const parsed = await new CvMatParser().parse(manager, expression, evaluated);
            assert.strictEqual(parsed.success, true, parsed.error);
            assert.strictEqual(parsed.metadata?.stride, 300);
            if (expression === 'roi') {
                assert.strictEqual(parsed.metadata?.dataSize, 14850);
            }
            const image = await readImageDataForDisplay(manager, parsed.metadata!);
            assert.strictEqual(image?.data.length, parsed.metadata?.dataSize);
        }

        const band = await resolveImageExpression(manager, '@band(color, 0)');
        assert.strictEqual(band.success, true, band.error);
        assert.strictEqual(band.data?.data.length, 100 * 100);

        const continued = waitForContinue(manager);
        const session = vscode.debug.activeDebugSession;
        assert.ok(session && manager.currentThreadId !== undefined);
        await session.customRequest('continue', { threadId: manager.currentThreadId });
        await continued;
        assert.strictEqual(manager.currentFrameId, undefined);
    });
});
