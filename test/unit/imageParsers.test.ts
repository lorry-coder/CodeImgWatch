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
    it('distinguishes NumPy/OpenCV arrays from Python array.array values', () => {
        const parser = new NumpyArrayParser();
        assert.strictEqual(parser.canParse('numpy.ndarray'), true);
        assert.strictEqual(parser.canParse('Mat'), true);
        assert.strictEqual(parser.canParse('cv2.Mat'), true);
        assert.strictEqual(parser.canParse('array.array'), false);
        assert.strictEqual(new TorchTensorParser().canParse('torch.nn.parameter.Parameter'), true);
    });

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

    it('parenthesizes NumPy expressions and rejects structured dtypes', async () => {
        const tupleExpressions: string[] = [];
        const stringExpressions: string[] = [];
        const session = {
            evaluatePythonAsTuple: async (expression: string) => {
                tupleExpressions.push(expression);
                return [2, 3];
            },
            evaluatePythonAsString: async (expression: string) => {
                stringExpressions.push(expression);
                return expression.includes('dtype') ? "[('r', 'u1'), ('g', 'u1')]" : 'True';
            },
        } as unknown as DebugSessionManager;

        const result = await new NumpyArrayParser().parse(session, 'left if flag else right');

        assert.strictEqual(result.success, false);
        assert.match(result.error ?? '', /Unsupported dtype/);
        assert.deepStrictEqual(tupleExpressions, ['(left if flag else right).shape']);
        assert.strictEqual(stringExpressions[0], 'str((left if flag else right).dtype)');
    });

    it('parses a one-dimensional big-endian NumPy scalar buffer', async () => {
        const session = {
            evaluatePythonAsTuple: async () => [10],
            evaluatePythonAsString: async (expression: string) => expression.includes('dtype') ? '>u2' : 'True',
        } as unknown as DebugSessionManager;

        const result = await new NumpyArrayParser().parse(session, 'samples');
        assert.strictEqual(result.success, true, result.error);
        assert.strictEqual(result.metadata?.width, 10);
        assert.strictEqual(result.metadata?.height, 1);
        assert.strictEqual(result.metadata?.depth, PixelDepth.CV_16U);
        assert.strictEqual(result.metadata?.byteOrder, 'big');
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

    it('recognizes Pillow ImageFile subclasses and converts RGBX to RGB', async () => {
        const tupleExpressions: string[] = [];
        const stringExpressions: string[] = [];
        const parser = new PILImageParser();
        const session = {
            evaluatePythonAsTuple: async (expression: string) => {
                tupleExpressions.push(expression);
                return [7, 5];
            },
            evaluatePythonAsString: async (expression: string) => {
                stringExpressions.push(expression);
                return 'RGBX';
            },
        } as unknown as DebugSessionManager;

        assert.strictEqual(parser.canParse('PngImageFile'), true);
        assert.strictEqual(parser.canParse('PIL.JpegImagePlugin.JpegImageFile'), true);

        const result = await parser.parse(session, 'first if use_first else second');
        assert.strictEqual(result.success, true, result.error);
        assert.strictEqual(result.metadata?.channels, 3);
        assert.strictEqual(result.metadata?.channelFormat, ChannelFormat.RGB);
        assert.strictEqual(result.metadata?.rawProperties?.pilConversionMode, 'RGB');
        assert.deepStrictEqual(tupleExpressions, ['(first if use_first else second).size']);
        assert.deepStrictEqual(stringExpressions, ['(first if use_first else second).mode']);
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
                if (expression.includes('layout')) {
                    return 'torch.strided';
                }
                if (expression.includes('is_quantized')) {
                    return 'False';
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
                if (expression.includes('layout')) {
                    return 'torch.strided';
                }
                if (expression.includes('is_quantized')) {
                    return 'False';
                }
                return 'True';
            },
        } as unknown as DebugSessionManager;

        const result = await new TorchTensorParser().parse(session, 'tensor');
        assert.strictEqual(result.success, true, result.error);
        assert.ok(result.warnings?.some(warning => warning.includes('copied to CPU')));
    });

    it('rejects meta, non-strided, quantized, and unsupported unsigned tensors clearly', async () => {
        const parseWith = async (
            device: string,
            layout: string,
            quantized: string,
            dtype: string
        ) => {
            const session = {
                evaluatePythonAsTuple: async () => [3, 4, 5],
                evaluatePythonAsString: async (expression: string) => {
                    if (expression.includes('device')) {
                        return device;
                    }
                    if (expression.includes('layout')) {
                        return layout;
                    }
                    if (expression.includes('is_quantized')) {
                        return quantized;
                    }
                    if (expression.includes('dtype')) {
                        return dtype;
                    }
                    return 'True';
                },
            } as unknown as DebugSessionManager;
            return new TorchTensorParser().parse(session, 'tensor');
        };

        assert.match((await parseWith('meta', 'torch.strided', 'False', 'torch.float32')).error ?? '', /Meta/);
        assert.match((await parseWith('cpu', 'torch.sparse_coo', 'False', 'torch.float32')).error ?? '', /layout/);
        assert.match((await parseWith('cpu', 'torch.strided', 'True', 'torch.quint8')).error ?? '', /Quantized/);
        assert.match((await parseWith('cpu', 'torch.strided', 'False', 'torch.uint16')).error ?? '', /Unsupported dtype/);
    });

    it('indexes a batched tensor after parenthesizing a compound expression', async () => {
        const stringExpressions: string[] = [];
        const session = {
            evaluatePythonAsTuple: async (expression: string) => {
                assert.strictEqual(expression, 'tuple((batch_a if use_a else batch_b).shape)');
                return [2, 3, 4, 5];
            },
            evaluatePythonAsString: async (expression: string) => {
                stringExpressions.push(expression);
                if (expression.includes('device')) {
                    return 'cpu';
                }
                if (expression.includes('layout')) {
                    return 'torch.strided';
                }
                if (expression.includes('is_quantized')) {
                    return 'False';
                }
                if (expression.includes('dtype')) {
                    return 'torch.float32';
                }
                return 'True';
            },
        } as unknown as DebugSessionManager;

        const result = await new TorchTensorParser().parse(session, 'batch_a if use_a else batch_b');
        assert.strictEqual(result.success, true, result.error);
        assert.strictEqual(result.metadata?.expression, '(batch_a if use_a else batch_b)[0]');
        assert.ok(stringExpressions.includes('str(((batch_a if use_a else batch_b)[0]).is_contiguous())'));
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
