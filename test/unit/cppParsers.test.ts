import * as assert from 'assert';
import { DebugSessionManager, EvaluateResponse, VariableInfo } from '../../src/core/debugSessionManager';
import {
    isKnownImageType,
    normalizeTypeName,
} from '../../src/parsers/baseParser';
import { CustomTypeParser } from '../../src/parsers/customTypeParser';
import { CvMatParser } from '../../src/parsers/cvMatParser';
import { CvMatTemplateParser } from '../../src/parsers/cvMatTemplateParser';
import { CvMatxParser, CvVecParser } from '../../src/parsers/cvMatxParser';
import { CvMatLegacyParser, IplImageParser } from '../../src/parsers/legacyParser';
import { RawArrayParser, RawImageSpec } from '../../src/parsers/rawArrayParser';
import { validateCustomTypeConfig } from '../../src/types/customTypeConfig';
import { PixelDepth } from '../../src/types';

function evaluateResponse(type: string, variablesReference: number = 0): EvaluateResponse {
    return { result: type, type, variablesReference };
}

function pointerResponse(address: string): EvaluateResponse {
    return { result: address, variablesReference: 0 };
}

function parserSession(overrides: Partial<DebugSessionManager> = {}): DebugSessionManager {
    return {
        getDebuggerType: () => 'cppdbg',
        currentFrameId: 7,
        ...overrides,
    } as unknown as DebugSessionManager;
}

describe('C++ image parsers', () => {
    describe('type recognition', () => {
        it('recognizes cv::Vec and normalizes qualified pointer/reference types', () => {
            assert.strictEqual(isKnownImageType('cv::Vec3f'), true);
            assert.strictEqual(normalizeTypeName('const struct MyImage * const &'), 'MyImage');
        });
    });

    describe('cv::Mat stride handling', () => {
        const baseMembers: VariableInfo[] = [
            { name: 'rows', value: '2', variablesReference: 0 },
            { name: 'cols', value: '2', variablesReference: 0 },
            { name: 'flags', value: '16', variablesReference: 0 },
            { name: 'dims', value: '2', variablesReference: 0 },
            { name: 'data', value: '0x1234', variablesReference: 0 },
        ];

        it('rejects a non-continuous Mat when its row stride cannot be read', async () => {
            const session = parserSession({
                getVariables: async () => baseMembers,
                evaluate: async () => undefined,
            });
            const result = await new CvMatParser().parse(
                session,
                'roi',
                evaluateResponse('cv::Mat', 1)
            );
            assert.strictEqual(result.success, false);
            assert.match(result.error ?? '', /row stride.*non-continuous/i);
        });

        it('uses a packed fallback only for a continuous Mat', async () => {
            const members = baseMembers.map(member => member.name === 'flags'
                ? { ...member, value: String(16 | (1 << 14)) }
                : member);
            const session = parserSession({
                getVariables: async () => members,
                evaluate: async () => undefined,
            });
            const result = await new CvMatParser().parse(
                session,
                'image',
                evaluateResponse('cv::Mat', 1)
            );
            assert.strictEqual(result.success, true, result.error);
            assert.strictEqual(result.metadata?.stride, 6);
        });

        it('also rejects a non-continuous typed Mat without a stride', async () => {
            const session = parserSession({
                getVariables: async () => baseMembers.filter(member => member.name !== 'dims'),
                evaluate: async () => undefined,
            });
            const result = await new CvMatTemplateParser().parse(
                session,
                'typed',
                evaluateResponse('cv::Mat_<cv::Vec3b>', 1)
            );
            assert.strictEqual(result.success, false);
            assert.match(result.error ?? '', /row stride.*non-continuous/i);
        });

        it('rejects OpenCV channel counts above the viewer limit without aliasing them', async () => {
            const members = baseMembers.map(member => {
                if (member.name === 'flags') {
                    return { ...member, value: '512' }; // CV_8UC(65)
                }
                if (member.name === 'rows' || member.name === 'cols') {
                    return { ...member, value: '1' };
                }
                return member;
            });
            const session = parserSession({
                getVariables: async () => members,
                evaluate: async (expression: string) => expression.includes('step')
                    ? pointerResponse('65')
                    : undefined,
            });
            const result = await new CvMatParser().parse(
                session,
                'manyChannels',
                evaluateResponse('cv::Mat', 1)
            );
            assert.strictEqual(result.success, false);
            assert.match(result.error ?? '', /channel count: 65/i);
        });
    });

    describe('fixed-size OpenCV types', () => {
        it('parses the cv::Matx33f typedef emitted by GDB', async () => {
            const expressions: string[] = [];
            const session = parserSession({
                evaluate: async (expression: string) => {
                    expressions.push(expression);
                    return pointerResponse('0x1234');
                },
            });
            const parser = new CvMatxParser();
            assert.strictEqual(parser.canParse('cv::Matx33f'), true);

            const result = await parser.parse(
                session,
                'rotation',
                evaluateResponse('cv::Matx33f')
            );
            assert.strictEqual(result.success, true, result.error);
            assert.strictEqual(result.metadata?.width, 3);
            assert.strictEqual(result.metadata?.height, 3);
            assert.strictEqual(result.metadata?.depth, PixelDepth.CV_32F);
            assert.strictEqual(result.metadata?.dataSize, 36);
            assert.strictEqual(expressions[0], '&((rotation).val[0])');
        });

        it('uses pointer member access for cv::Vec pointers', async () => {
            const expressions: string[] = [];
            const session = parserSession({
                evaluate: async (expression: string) => {
                    expressions.push(expression);
                    return pointerResponse('0x5678');
                },
            });
            const result = await new CvVecParser().parse(
                session,
                'vectorPointer',
                evaluateResponse('cv::Vec3f *')
            );
            assert.strictEqual(result.success, true, result.error);
            assert.strictEqual(result.metadata?.width, 3);
            assert.strictEqual(expressions[0], '&((vectorPointer)->val[0])');
        });
    });

    describe('legacy OpenCV types', () => {
        it('evaluates members through a CvMat pointer and keeps the exact ROI range', async () => {
            const values = new Map<string, string>([
                ['(legacy)->rows', '2'],
                ['(legacy)->cols', '2'],
                ['(legacy)->type', '16'],
                ['(legacy)->step', '8'],
                ['(legacy)->data.ptr', '0x1234'],
            ]);
            const session = parserSession({
                evaluate: async (expression: string) => {
                    const value = values.get(expression);
                    return value === undefined ? undefined : pointerResponse(value);
                },
            });
            const result = await new CvMatLegacyParser().parse(
                session,
                'legacy',
                evaluateResponse('CvMat *')
            );
            assert.strictEqual(result.success, true, result.error);
            assert.strictEqual(result.metadata?.stride, 8);
            assert.strictEqual(result.metadata?.dataSize, 14);
        });

        it('accepts signed IplImage depth values emitted as negative decimals', async () => {
            const values = new Map<string, string>([
                ['(image)->width', '2'],
                ['(image)->height', '2'],
                ['(image)->nChannels', '1'],
                ['(image)->depth', '-2147483640'],
                ['(image)->widthStep', '4'],
                ['(image)->imageData', '0x4321'],
            ]);
            const session = parserSession({
                evaluate: async (expression: string) => {
                    const value = values.get(expression);
                    return value === undefined ? undefined : pointerResponse(value);
                },
            });
            const result = await new IplImageParser().parse(
                session,
                'image',
                evaluateResponse('IplImage *')
            );
            assert.strictEqual(result.success, true, result.error);
            assert.strictEqual(result.metadata?.depth, PixelDepth.CV_8S);
            assert.strictEqual(result.metadata?.dataSize, 6);
        });

        it('rejects IplImage layouts that would otherwise render incorrectly', async () => {
            const values = new Map<string, string>([
                ['(image).width', '2'],
                ['(image).height', '2'],
                ['(image).nChannels', '1'],
                ['(image).depth', '8'],
                ['(image).widthStep', '2'],
                ['(image).origin', '1'],
                ['(image).dataOrder', '0'],
            ]);
            const session = parserSession({
                evaluate: async (expression: string) => {
                    const value = values.get(expression);
                    return value === undefined ? undefined : pointerResponse(value);
                },
            });
            const result = await new IplImageParser().parse(
                session,
                'image',
                evaluateResponse('IplImage')
            );
            assert.strictEqual(result.success, false);
            assert.match(result.error ?? '', /bottom-left/i);
        });
    });
});

describe('Raw memory image parser', () => {
    it('strictly parses a valid specification and omits trailing-row padding', () => {
        const parsed = RawArrayParser.parseMemSpec('@mem(0X1234, uint8, 3, 2, 2, 8)');
        assert.ok(!('error' in parsed), 'error' in parsed ? parsed.error : undefined);
        const metadata = RawArrayParser.createMetadata(parsed as RawImageSpec, '@mem(...)');
        assert.strictEqual(metadata.dataAddress, '0x1234');
        assert.strictEqual(metadata.stride, 8);
        assert.strictEqual(metadata.dataSize, 14);
    });

    it('rejects malformed addresses, partial integers, nulls, and short strides', () => {
        for (const expression of [
            '@mem(0x12gg, uint8, 3, 2, 2)',
            '@mem(0x1234567890abcdef0, uint8, 3, 2, 2)',
            '@mem(0x1234, uint8, 3junk, 2, 2)',
            '@mem(0x0, uint8, 3, 2, 2)',
            '@mem(0x1234, uint8, 3, 2, 2, 5)',
            'prefix @mem(0x1234, uint8, 3, 2, 2)',
        ]) {
            assert.ok('error' in RawArrayParser.parseMemSpec(expression), expression);
        }
    });

    it('defensively validates metadata created programmatically', () => {
        assert.throws(() => RawArrayParser.createMetadata({
            address: '0x1234',
            pixelType: PixelDepth.CV_8U,
            channels: 3,
            width: 2,
            height: 2,
            stride: 5,
        }, 'invalid'), /row stride/i);
        assert.throws(() => RawArrayParser.createMetadata({
            address: 'not-an-address',
            pixelType: PixelDepth.CV_8U,
            channels: 1,
            width: 1,
            height: 1,
        }, 'invalid'), /address/i);
    });
});

describe('Custom C++ image parser', () => {
    const config = {
        typeName: 'MyImage',
        properties: {
            width: 'width',
            height: 'height',
            channels: 3,
            data: 'data',
            stride: 'stride',
            pixelType: 'uint8' as const,
            isValid: 'valid',
        },
    };

    it('normalizes pointer qualifiers and uses pointer member access', async () => {
        const expressions: string[] = [];
        const values = new Map<string, string>([
            ['(image)->width', '2'],
            ['(image)->height', '2'],
            ['(image)->data', '0x1234'],
            ['(image)->stride', '8'],
            ['(image)->valid', 'true'],
        ]);
        const parser = new CustomTypeParser();
        parser.addConfig(config);
        const session = parserSession({
            evaluate: async (expression: string) => {
                expressions.push(expression);
                const value = values.get(expression);
                return value === undefined ? undefined : pointerResponse(value);
            },
        });

        const result = await parser.parse(
            session,
            'image',
            evaluateResponse('const struct MyImage * const &')
        );
        assert.strictEqual(result.success, true, result.error);
        assert.strictEqual(result.metadata?.dataSize, 14);
        assert.ok(expressions.every(expression => expression.startsWith('(image)->')));
    });

    it('honors debugger boolean false for an isValid expression', async () => {
        const values = new Map<string, string>([
            ['(image).width', '2'],
            ['(image).height', '2'],
            ['(image).data', '0x1234'],
            ['(image).stride', '8'],
            ['(image).valid', 'false'],
        ]);
        const parser = new CustomTypeParser();
        parser.addConfig(config);
        const session = parserSession({
            evaluate: async (expression: string) => {
                const value = values.get(expression);
                return value === undefined ? undefined : pointerResponse(value);
            },
        });

        const result = await parser.parse(session, 'image', evaluateResponse('MyImage'));
        assert.strictEqual(result.success, false);
        assert.match(result.error ?? '', /validity check failed/i);
    });

    it('validates constant channel counts in custom type configuration', () => {
        assert.strictEqual(validateCustomTypeConfig(config), true);
        assert.strictEqual(validateCustomTypeConfig({
            ...config,
            properties: { ...config.properties, channels: 5 },
        }), false);
    });
});
