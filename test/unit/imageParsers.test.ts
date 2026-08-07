import * as assert from 'assert';
import { DebugSessionManager, EvaluateResponse, VariableInfo } from '../../src/core/debugSessionManager';
import { CvMatParser } from '../../src/parsers/cvMatParser';
import { NumpyArrayParser } from '../../src/parsers/numpyParser';
import { PILImageParser } from '../../src/parsers/pilParser';
import { TorchTensorParser } from '../../src/parsers/torchParser';
import { ChannelFormat, ImageTypeName, PixelDepth } from '../../src/types';

function evaluateResponse(type: string, variablesReference: number = 0): EvaluateResponse {
    return { result: type, type, variablesReference };
}

describe('Python image parsers', () => {
    it('parses OpenCV-style NumPy arrays as BGR', async () => {
        const session = {
            evaluatePythonAsTuple: async () => [10, 20, 3],
            evaluatePythonAsString: async (expression: string) => expression.includes('dtype') ? 'uint8' : 'True',
        } as unknown as DebugSessionManager;

        const result = await new NumpyArrayParser().parse(session, 'frame');
        assert.strictEqual(result.success, true, result.error);
        assert.strictEqual(result.metadata?.width, 20);
        assert.strictEqual(result.metadata?.height, 10);
        assert.strictEqual(result.metadata?.channelFormat, ChannelFormat.BGR);
    });

    it('normalizes palette Pillow images to RGBA without NumPy', async () => {
        const session = {
            evaluatePythonAsTuple: async () => [7, 5],
            evaluatePythonAsString: async () => 'P',
        } as unknown as DebugSessionManager;

        const result = await new PILImageParser().parse(session, 'image');
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.metadata?.channels, 4);
        assert.strictEqual(result.metadata?.channelFormat, ChannelFormat.RGBA);
        assert.strictEqual(result.metadata?.rawProperties?.pilConversionMode, 'RGBA');
    });

    it('converts torch int64 metadata to the actual int32 transfer layout', async () => {
        const session = {
            evaluatePythonAsTuple: async () => [3, 4, 5],
            evaluatePythonAsString: async (expression: string) => {
                if (expression.includes('device')) {
                    return 'cpu';
                }
                if (expression.includes('dtype')) {
                    return 'torch.int64';
                }
                return 'True';
            },
        } as unknown as DebugSessionManager;

        const result = await new TorchTensorParser().parse(session, 'tensor');
        assert.strictEqual(result.success, true, result.error);
        assert.strictEqual(result.metadata?.depth, PixelDepth.CV_32S);
        assert.strictEqual(result.metadata?.dataSize, 3 * 4 * 5 * 4);
        assert.strictEqual(result.metadata?.rawProperties?.torchConversionDtype, 'int32');
    });

    it('allows GPU tensors through the CPU transfer path', async () => {
        const session = {
            evaluatePythonAsTuple: async () => [3, 4, 5],
            evaluatePythonAsString: async (expression: string) => {
                if (expression.includes('device')) {
                    return 'cuda:0';
                }
                if (expression.includes('dtype')) {
                    return 'torch.float32';
                }
                return 'True';
            },
        } as unknown as DebugSessionManager;

        const result = await new TorchTensorParser().parse(session, 'tensor');
        assert.strictEqual(result.success, true, result.error);
        assert.ok(result.warnings?.some(warning => warning.includes('copied to CPU')));
    });
});

describe('cv::Mat parser', () => {
    it('uses pointer values and does not over-read ROI padding after the last row', async () => {
        const members: VariableInfo[] = [
            { name: 'rows', value: '2', variablesReference: 0 },
            { name: 'cols', value: '2', variablesReference: 0 },
            { name: 'flags', value: String(16), variablesReference: 0 },
            { name: 'dims', value: '2', variablesReference: 0 },
            {
                name: 'data',
                value: '0x1234',
                variablesReference: 0,
                memoryReference: 'pointer-variable-location',
            },
        ];
        const session = {
            getVariables: async () => members,
            evaluate: async (expression: string) => expression.includes('step')
                ? { result: '8', variablesReference: 0 }
                : undefined,
            getDebuggerType: () => 'cppdbg',
            currentFrameId: 1,
        } as unknown as DebugSessionManager;

        const result = await new CvMatParser().parse(session, 'roi', evaluateResponse('cv::Mat', 1));
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.metadata?.dataAddress, '0x1234');
        assert.strictEqual(result.metadata?.channelFormat, ChannelFormat.BGR);
        assert.strictEqual(result.metadata?.dataSize, 14);
        assert.strictEqual(result.metadata?.typeName, 'CV_8UC3');
        assert.strictEqual(result.metadata?.typeName.startsWith(ImageTypeName.CV_MAT), false);
    });
});
