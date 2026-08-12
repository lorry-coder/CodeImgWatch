import { ImageParserRegistry, normalizeTypeName } from '../parsers/baseParser';
import { RawArrayParser } from '../parsers/rawArrayParser';
import { ImageData, ImageMetadata, ParseResult, PixelDepthName } from '../types';
import { DebugSessionManager, EvaluateResponse } from './debugSessionManager';
import { readImageDataForDisplay } from './imageDataReader';
import { ImageExpressionParser, OperatorNode } from './imageExpressionParser';
import { evaluateOperator } from './imageOperators';

export interface ResolveImageResult extends ParseResult {
    data?: ImageData;
    evaluatedType?: string;
}

/** Resolve a debugger image, raw-memory specification, or ImView operator expression. */
export async function resolveImageExpression(
    session: DebugSessionManager,
    expression: string,
    evaluateResult?: EvaluateResponse
): Promise<ResolveImageResult> {
    const trimmed = expression.trim();
    if (!trimmed) {
        return { success: false, error: 'Image expression is empty' };
    }

    if (/^@mem\b/i.test(trimmed)) {
        return resolveRawMemory(session, trimmed);
    }

    if (trimmed.startsWith('@')) {
        return resolveOperatorExpression(session, trimmed);
    }

    return resolveDebuggerExpression(session, trimmed, evaluateResult);
}

async function resolveDebuggerExpression(
    session: DebugSessionManager,
    expression: string,
    evaluateResult?: EvaluateResponse
): Promise<ResolveImageResult> {
    const evaluated = evaluateResult ?? await session.evaluate(expression);
    if (!evaluated) {
        return {
            success: false,
            error: `Failed to evaluate "${expression}". Make sure it is in scope and the debugger is paused.`,
        };
    }

    const typeName = evaluated.type ?? '';
    let resolvedTypeName = typeName;
    let parser = ImageParserRegistry.getInstance().findParser(normalizeTypeName(typeName));
    if (!parser && session.getDebuggerType() === 'debugpy') {
        const qualifiedType = await session.evaluatePythonAsString(
            `(lambda _imview_type: _imview_type.__module__ + '.' + ` +
            `_imview_type.__name__)(type((${expression})))`
        );
        if (qualifiedType) {
            resolvedTypeName = qualifiedType;
            parser = ImageParserRegistry.getInstance().findParser(normalizeTypeName(qualifiedType));
        }
    }
    if (!parser) {
        return {
            success: false,
            error: resolvedTypeName
                ? `No image parser is available for type: ${resolvedTypeName}`
                : 'The debugger did not provide a type for this expression',
            evaluatedType: resolvedTypeName,
        };
    }

    const parserEvaluateResult = resolvedTypeName === typeName
        ? evaluated
        : { ...evaluated, type: resolvedTypeName };
    const parsed = await parser.parse(session, expression, parserEvaluateResult);
    return { ...parsed, evaluatedType: resolvedTypeName };
}

function resolveRawMemory(session: DebugSessionManager, expression: string): ResolveImageResult {
    const spec = RawArrayParser.parseMemSpec(expression);
    if ('error' in spec) {
        return { success: false, error: spec.error };
    }

    try {
        const metadata = RawArrayParser.createMetadata(spec, expression);
        metadata.debuggerType = session.getDebuggerType();
        metadata.frameId = session.currentFrameId;
        return { success: true, metadata };
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

async function resolveOperatorExpression(
    session: DebugSessionManager,
    expression: string
): Promise<ResolveImageResult> {
    const parsedExpression = new ImageExpressionParser().parse(expression);
    if (!parsedExpression.success || !parsedExpression.ast) {
        return {
            success: false,
            error: parsedExpression.error ?? 'Invalid image expression',
        };
    }
    if (parsedExpression.ast.type !== 'operator') {
        return { success: false, error: 'Expected an ImView operator expression' };
    }
    if (parsedExpression.ast.name.toLowerCase() === 'mem') {
        return resolveRawMemory(session, expression);
    }

    const cache = new Map<string, Promise<ImageData | undefined>>();
    let dependencyError: string | undefined;

    const getImageData = (baseExpression: string): Promise<ImageData | undefined> => {
        let promise = cache.get(baseExpression);
        if (!promise) {
            promise = (async () => {
                const resolved = await resolveDebuggerExpression(session, baseExpression);
                if (!resolved.success || !resolved.metadata) {
                    dependencyError = resolved.error ?? `Failed to resolve ${baseExpression}`;
                    return undefined;
                }
                const image = await readImageDataForDisplay(session, resolved.metadata);
                if (!image) {
                    dependencyError = `Failed to read image data for ${baseExpression}`;
                    return undefined;
                }
                return {
                    metadata: image.metadata,
                    data: image.data,
                    timestamp: Date.now(),
                };
            })();
            cache.set(baseExpression, promise);
        }
        return promise;
    };

    const evaluated = await evaluateOperator(parsedExpression.ast as OperatorNode, {
        session,
        getImageData,
    });
    if (!evaluated.success || !evaluated.data) {
        return {
            success: false,
            error: dependencyError ?? evaluated.error ?? `Failed to evaluate ${expression}`,
        };
    }

    const metadata: ImageMetadata = {
        ...evaluated.data.metadata,
        id: `operator_${hashExpression(expression)}`,
        name: expression,
        expression,
        typeName: `${PixelDepthName[evaluated.data.metadata.depth]} ` +
            `${evaluated.data.metadata.channels}ch (derived)`,
        frameId: session.currentFrameId,
        rawProperties: {
            ...evaluated.data.metadata.rawProperties,
            operatorExpression: expression,
        },
    };
    const data: ImageData = {
        metadata,
        data: evaluated.data.data,
        timestamp: evaluated.data.timestamp,
    };
    return { success: true, metadata, data };
}

function hashExpression(expression: string): string {
    let hash = 2166136261;
    for (let index = 0; index < expression.length; index++) {
        hash ^= expression.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
}
