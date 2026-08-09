import * as assert from 'assert';
import { DebugSessionManager, EvaluateResponse } from '../../src/core/debugSessionManager';
import { resolveImageExpression } from '../../src/core/imageResolver';
import { IImageParser, ImageParserRegistry } from '../../src/parsers/baseParser';
import { ParseResult, PixelDepth } from '../../src/types';

class ResolverTestParser implements IImageParser {
    readonly name = 'ResolverTest';
    readonly priority = 10_000;

    canParse(typeName: string): boolean {
        return typeName === 'ResolverImage';
    }

    async parse(
        session: DebugSessionManager,
        expression: string,
        evaluateResult: EvaluateResponse
    ): Promise<ParseResult> {
        return {
            success: true,
            metadata: {
                id: `resolver_${expression}`,
                name: expression,
                expression,
                typeName: evaluateResult.type ?? 'ResolverImage',
                depth: PixelDepth.CV_8S,
                channels: 1,
                width: 2,
                height: 1,
                stride: 2,
                dataAddress: '0x1000',
                dataSize: 2,
                debuggerType: session.getDebuggerType(),
            },
        };
    }
}

describe('Image expression resolution', () => {
    before(() => {
        ImageParserRegistry.getInstance().register(new ResolverTestParser());
    });

    it('routes operators through parser, memory read, and transform exactly once', async () => {
        let evaluations = 0;
        let reads = 0;
        const session = {
            evaluate: async () => {
                evaluations++;
                return { result: 'source', type: 'ResolverImage', variablesReference: 0 };
            },
            readMemoryChunked: async () => {
                reads++;
                return Uint8Array.from([0xFF, 2]);
            },
            getDebuggerType: () => 'cppdbg',
            currentFrameId: 3,
        } as unknown as DebugSessionManager;

        const result = await resolveImageExpression(session, '@abs(source)');
        assert.strictEqual(result.success, true, result.error);
        assert.deepStrictEqual(Array.from(result.data?.data ?? []), [1, 2]);
        assert.strictEqual(result.metadata?.expression, '@abs(source)');
        assert.strictEqual(evaluations, 1);
        assert.strictEqual(reads, 1);
    });

    it('resolves validated raw memory expressions without debugger evaluation', async () => {
        const session = {
            evaluate: async () => assert.fail('Raw memory must not be evaluated by the debugger'),
            getDebuggerType: () => 'cppdbg',
            currentFrameId: 4,
        } as unknown as DebugSessionManager;

        const result = await resolveImageExpression(
            session,
            '@mem(0x1234, uint8, 3, 2, 2, 8)'
        );
        assert.strictEqual(result.success, true, result.error);
        assert.strictEqual(result.metadata?.dataSize, 14);
        assert.strictEqual(result.metadata?.debuggerType, 'cppdbg');
    });
});
