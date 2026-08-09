/** AST nodes used by ImView watch expressions. */
export type ExpressionNode = VariableNode | OperatorNode | NumberNode | StringNode;

export interface VariableNode {
    type: 'variable';
    name: string;
}

export interface OperatorNode {
    type: 'operator';
    name: string;
    args: ExpressionNode[];
}

export interface NumberNode {
    type: 'number';
    value: number;
}

export interface StringNode {
    type: 'string';
    value: string;
}

export interface ParseExpressionResult {
    success: boolean;
    ast?: ExpressionNode;
    error?: string;
    position?: number;
}

class ExpressionSyntaxError extends Error {
    constructor(message: string, readonly position: number) {
        super(`${message} at position ${position}`);
    }
}

interface Segment {
    text: string;
    offset: number;
}

/**
 * Parser for ImView expressions.
 *
 * Debugger expressions are deliberately treated as opaque variable nodes. This
 * lets C++, Python, and custom debugger adapters use their native expression
 * syntax while ImView only parses its own leading `@operator(...)` grammar.
 */
export class ImageExpressionParser {
    parse(input: string): ParseExpressionResult {
        try {
            const leadingWhitespace = input.length - input.trimStart().length;
            const text = input.trim();
            if (!text) {
                throw new ExpressionSyntaxError('Expression is empty', leadingWhitespace);
            }

            return {
                success: true,
                ast: this.parseSegment({ text, offset: leadingWhitespace }),
            };
        } catch (error) {
            if (error instanceof ExpressionSyntaxError) {
                return { success: false, error: error.message, position: error.position };
            }
            return {
                success: false,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }

    private parseSegment(segment: Segment): ExpressionNode {
        const trimmed = this.trimSegment(segment);
        const { text, offset } = trimmed;

        if (text.startsWith('@')) {
            return this.parseOperator(trimmed);
        }

        if (text.startsWith("'") || text.startsWith('"')) {
            return this.parseString(trimmed);
        }

        const number = this.parseNumber(text);
        if (number !== undefined) {
            return { type: 'number', value: number };
        }

        if (this.looksLikeMalformedNumber(text)) {
            throw new ExpressionSyntaxError(`Invalid number: ${text}`, offset);
        }

        return { type: 'variable', name: text };
    }

    private parseOperator(segment: Segment): OperatorNode {
        const nameMatch = segment.text.match(/^@([A-Za-z_][A-Za-z0-9_-]*)/);
        if (!nameMatch) {
            throw new ExpressionSyntaxError("Expected operator name after '@'", segment.offset + 1);
        }

        const name = nameMatch[1];
        let cursor = nameMatch[0].length;
        while (/\s/.test(segment.text[cursor] ?? '')) {
            cursor++;
        }
        if (segment.text[cursor] !== '(') {
            throw new ExpressionSyntaxError(
                `Expected '(' after operator name`,
                segment.offset + cursor
            );
        }

        const closing = this.findMatchingParenthesis(segment.text, cursor, segment.offset);
        const trailing = segment.text.slice(closing + 1).trim();
        if (trailing) {
            const trailingOffset = segment.text.indexOf(trailing, closing + 1);
            throw new ExpressionSyntaxError('Unexpected text after operator', segment.offset + trailingOffset);
        }

        const body: Segment = {
            text: segment.text.slice(cursor + 1, closing),
            offset: segment.offset + cursor + 1,
        };
        const args = this.splitArguments(body).map(arg => this.parseSegment(arg));
        return { type: 'operator', name, args };
    }

    private parseString(segment: Segment): StringNode {
        const quote = segment.text[0];
        let value = '';
        let escaped = false;

        for (let index = 1; index < segment.text.length; index++) {
            const char = segment.text[index];
            if (escaped) {
                const escapes: Record<string, string> = {
                    n: '\n',
                    r: '\r',
                    t: '\t',
                    '\\': '\\',
                    "'": "'",
                    '"': '"',
                };
                value += escapes[char] ?? char;
                escaped = false;
            } else if (char === '\\') {
                escaped = true;
            } else if (char === quote) {
                if (segment.text.slice(index + 1).trim()) {
                    throw new ExpressionSyntaxError('Unexpected text after string', segment.offset + index + 1);
                }
                return { type: 'string', value };
            } else {
                value += char;
            }
        }

        throw new ExpressionSyntaxError('Unterminated string', segment.offset);
    }

    private parseNumber(text: string): number | undefined {
        if (/^-?0[xX][0-9a-fA-F]+$/.test(text)) {
            const negative = text.startsWith('-');
            const digits = text.replace(/^-?0[xX]/, '');
            const value = Number.parseInt(digits, 16);
            return negative ? -value : value;
        }

        if (/^-?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE][+-]?\d+)?$/.test(text)) {
            const value = Number(text);
            return Number.isFinite(value) ? value : undefined;
        }
        return undefined;
    }

    private looksLikeMalformedNumber(text: string): boolean {
        return /^-?(?:0[xX]|\d+(?:\.\d*)?[eE][+-]?)$/.test(text);
    }

    private findMatchingParenthesis(text: string, opening: number, offset: number): number {
        let depth = 0;
        let quote: string | undefined;
        let escaped = false;

        for (let index = opening; index < text.length; index++) {
            const char = text[index];
            if (quote) {
                if (escaped) {
                    escaped = false;
                } else if (char === '\\') {
                    escaped = true;
                } else if (char === quote) {
                    quote = undefined;
                }
                continue;
            }

            if (char === "'" || char === '"') {
                quote = char;
            } else if (char === '(') {
                depth++;
            } else if (char === ')') {
                depth--;
                if (depth === 0) {
                    return index;
                }
                if (depth < 0) {
                    break;
                }
            }
        }

        if (quote) {
            throw new ExpressionSyntaxError('Unterminated string', offset + opening);
        }
        throw new ExpressionSyntaxError("Expected ')' after arguments", offset + text.length);
    }

    private splitArguments(segment: Segment): Segment[] {
        if (!segment.text.trim()) {
            return [];
        }

        const args: Segment[] = [];
        let start = 0;
        let parenDepth = 0;
        let bracketDepth = 0;
        let braceDepth = 0;
        let angleDepth = 0;
        let quote: string | undefined;
        let escaped = false;

        const addArgument = (end: number): void => {
            const raw = segment.text.slice(start, end);
            if (!raw.trim()) {
                throw new ExpressionSyntaxError('Expected expression', segment.offset + start);
            }
            args.push({ text: raw, offset: segment.offset + start });
        };

        for (let index = 0; index < segment.text.length; index++) {
            const char = segment.text[index];
            if (quote) {
                if (escaped) {
                    escaped = false;
                } else if (char === '\\') {
                    escaped = true;
                } else if (char === quote) {
                    quote = undefined;
                }
                continue;
            }

            if (char === "'" || char === '"') {
                quote = char;
            } else if (char === '(') {
                parenDepth++;
            } else if (char === ')') {
                parenDepth--;
            } else if (char === '[') {
                bracketDepth++;
            } else if (char === ']') {
                bracketDepth--;
            } else if (char === '{') {
                braceDepth++;
            } else if (char === '}') {
                braceDepth--;
            } else if (char === '<' && this.isLikelyTemplateOpening(segment.text, index)) {
                angleDepth++;
            } else if (char === '>' && angleDepth > 0) {
                angleDepth--;
            } else if (char === ',' && parenDepth === 0 && bracketDepth === 0 &&
                braceDepth === 0 && angleDepth === 0) {
                addArgument(index);
                start = index + 1;
            }

            if (parenDepth < 0 || bracketDepth < 0 || braceDepth < 0) {
                throw new ExpressionSyntaxError('Unmatched closing delimiter', segment.offset + index);
            }
        }

        if (quote) {
            throw new ExpressionSyntaxError('Unterminated string', segment.offset + segment.text.length);
        }
        if (parenDepth !== 0 || bracketDepth !== 0 || braceDepth !== 0 || angleDepth !== 0) {
            throw new ExpressionSyntaxError('Unclosed delimiter', segment.offset + segment.text.length);
        }

        addArgument(segment.text.length);
        return args;
    }

    /** Recognize conventional no-whitespace C++ template syntax without treating comparisons as delimiters. */
    private isLikelyTemplateOpening(text: string, index: number): boolean {
        const previous = text[index - 1];
        const next = text[index + 1];
        if (previous === undefined || next === undefined ||
            !/[A-Za-z0-9_:>]/.test(previous) || !/[A-Za-z0-9_:]/.test(next)) {
            return false;
        }

        let depth = 1;
        for (let cursor = index + 1; cursor < text.length; cursor++) {
            if (text[cursor] === '<' &&
                /[A-Za-z0-9_:>]/.test(text[cursor - 1] ?? '') &&
                /[A-Za-z0-9_:]/.test(text[cursor + 1] ?? '')) {
                depth++;
            } else if (text[cursor] === '>') {
                depth--;
                if (depth === 0) {
                    const following = text.slice(cursor + 1).trimStart()[0];
                    return following === undefined || '(),>{}[].:&*-'.includes(following);
                }
            }
        }
        return false;
    }

    private trimSegment(segment: Segment): Segment {
        const leading = segment.text.length - segment.text.trimStart().length;
        return {
            text: segment.text.trim(),
            offset: segment.offset + leading,
        };
    }
}

export function hasOperators(expression: string): boolean {
    return expression.trimStart().startsWith('@');
}

export function extractBaseVariable(expression: string): string {
    const result = new ImageExpressionParser().parse(expression);
    if (!result.success || !result.ast) {
        return expression;
    }
    return findFirstVariable(result.ast) ?? expression;
}

function findFirstVariable(node: ExpressionNode): string | undefined {
    if (node.type === 'variable') {
        return node.name;
    }
    if (node.type === 'operator') {
        for (const arg of node.args) {
            const result = findFirstVariable(arg);
            if (result) {
                return result;
            }
        }
    }
    return undefined;
}
