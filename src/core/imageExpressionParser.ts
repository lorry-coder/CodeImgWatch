/**
 * Token types for expression parsing
 */
enum TokenType {
    IDENTIFIER = 'IDENTIFIER',
    OPERATOR = 'OPERATOR',
    NUMBER = 'NUMBER',
    STRING = 'STRING',
    LPAREN = 'LPAREN',
    RPAREN = 'RPAREN',
    COMMA = 'COMMA',
    AT = 'AT',
    EOF = 'EOF',
}

/**
 * Token structure
 */
interface Token {
    type: TokenType;
    value: string;
    position: number;
}

/**
 * AST node types
 */
export type ExpressionNode =
    | VariableNode
    | OperatorNode
    | NumberNode
    | StringNode;

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

/**
 * Parse result
 */
export interface ParseExpressionResult {
    success: boolean;
    ast?: ExpressionNode;
    error?: string;
    position?: number;
}

/**
 * Tokenizer for image expressions
 */
class Tokenizer {
    private input: string;
    private position: number = 0;
    private tokens: Token[] = [];

    constructor(input: string) {
        this.input = input;
    }

    tokenize(): Token[] {
        while (this.position < this.input.length) {
            this.skipWhitespace();
            if (this.position >= this.input.length) {
                break;
            }

            const char = this.input[this.position];

            if (char === '@') {
                this.tokens.push({ type: TokenType.AT, value: '@', position: this.position });
                this.position++;
            } else if (char === '(') {
                this.tokens.push({ type: TokenType.LPAREN, value: '(', position: this.position });
                this.position++;
            } else if (char === ')') {
                this.tokens.push({ type: TokenType.RPAREN, value: ')', position: this.position });
                this.position++;
            } else if (char === ',') {
                this.tokens.push({ type: TokenType.COMMA, value: ',', position: this.position });
                this.position++;
            } else if (char === '"' || char === "'") {
                this.readString(char);
            } else if (this.isDigit(char) || (char === '-' && this.isDigit(this.peek(1)))) {
                this.readNumber();
            } else if (this.isIdentifierStart(char)) {
                this.readIdentifier();
            } else {
                // Unknown character, include it as part of identifier
                this.readIdentifier();
            }
        }

        this.tokens.push({ type: TokenType.EOF, value: '', position: this.position });
        return this.tokens;
    }

    private skipWhitespace(): void {
        while (this.position < this.input.length && /\s/.test(this.input[this.position])) {
            this.position++;
        }
    }

    private peek(offset: number = 0): string {
        const pos = this.position + offset;
        return pos < this.input.length ? this.input[pos] : '';
    }

    private isDigit(char: string): boolean {
        return /[0-9]/.test(char);
    }

    private isIdentifierStart(char: string): boolean {
        return /[a-zA-Z_]/.test(char);
    }

    private isIdentifierChar(char: string): boolean {
        return /[a-zA-Z0-9_:.<>\[\]&*\->]/.test(char);
    }

    private readString(quote: string): void {
        const startPos = this.position;
        this.position++; // Skip opening quote

        let value = '';
        while (this.position < this.input.length && this.input[this.position] !== quote) {
            if (this.input[this.position] === '\\' && this.position + 1 < this.input.length) {
                this.position++;
                value += this.input[this.position];
            } else {
                value += this.input[this.position];
            }
            this.position++;
        }

        if (this.position < this.input.length) {
            this.position++; // Skip closing quote
        }

        this.tokens.push({ type: TokenType.STRING, value, position: startPos });
    }

    private readNumber(): void {
        const startPos = this.position;
        let value = '';

        if (this.input[this.position] === '-') {
            value += '-';
            this.position++;
        }

        // Check for hex
        if (this.input[this.position] === '0' && (this.peek(1) === 'x' || this.peek(1) === 'X')) {
            value += this.input[this.position++];
            value += this.input[this.position++];
            while (this.position < this.input.length && /[0-9a-fA-F]/.test(this.input[this.position])) {
                value += this.input[this.position++];
            }
        } else {
            // Decimal
            while (this.position < this.input.length && this.isDigit(this.input[this.position])) {
                value += this.input[this.position++];
            }

            // Decimal point
            if (this.position < this.input.length && this.input[this.position] === '.') {
                value += this.input[this.position++];
                while (this.position < this.input.length && this.isDigit(this.input[this.position])) {
                    value += this.input[this.position++];
                }
            }

            // Exponent
            if (this.position < this.input.length && /[eE]/.test(this.input[this.position])) {
                value += this.input[this.position++];
                if (this.position < this.input.length && /[+-]/.test(this.input[this.position])) {
                    value += this.input[this.position++];
                }
                while (this.position < this.input.length && this.isDigit(this.input[this.position])) {
                    value += this.input[this.position++];
                }
            }
        }

        this.tokens.push({ type: TokenType.NUMBER, value, position: startPos });
    }

    private readIdentifier(): void {
        const startPos = this.position;
        let value = '';

        // Handle complex C++ expressions like arr[0], ptr->member, etc.
        let parenDepth = 0;
        let bracketDepth = 0;

        while (this.position < this.input.length) {
            const char = this.input[this.position];

            // Track nested parens/brackets
            if (char === '(') parenDepth++;
            if (char === ')') parenDepth--;
            if (char === '[') bracketDepth++;
            if (char === ']') bracketDepth--;

            // Stop at top-level delimiters
            if (parenDepth === 0 && bracketDepth === 0) {
                if (char === ',' || char === ')' || char === '@') {
                    break;
                }
            }

            if (parenDepth < 0) {
                break; // Unmatched closing paren
            }

            if (this.isIdentifierChar(char) || char === '(' || char === ')' || char === '[' || char === ']') {
                value += char;
                this.position++;
            } else if (/\s/.test(char)) {
                // Allow spaces within complex expressions
                const remaining = this.input.slice(this.position).trimStart();
                if (remaining.length > 0 && /[.\-\[<>]/.test(remaining[0])) {
                    this.position++;
                } else {
                    break;
                }
            } else {
                break;
            }
        }

        value = value.trim();
        if (value.length > 0) {
            this.tokens.push({ type: TokenType.IDENTIFIER, value, position: startPos });
        }
    }
}

/**
 * Parser for image expressions
 */
export class ImageExpressionParser {
    private tokens: Token[] = [];
    private current: number = 0;

    /**
     * Parse an expression string
     */
    parse(input: string): ParseExpressionResult {
        try {
            const tokenizer = new Tokenizer(input.trim());
            this.tokens = tokenizer.tokenize();
            this.current = 0;

            const ast = this.parseExpression();

            // Check for remaining tokens
            if (!this.isAtEnd()) {
                return {
                    success: false,
                    error: `Unexpected token: ${this.peek().value}`,
                    position: this.peek().position,
                };
            }

            return { success: true, ast };
        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }

    private parseExpression(): ExpressionNode {
        // Check for operator (@name)
        if (this.check(TokenType.AT)) {
            return this.parseOperator();
        }

        // Otherwise, it's a variable or literal
        if (this.check(TokenType.NUMBER)) {
            const token = this.advance();
            return {
                type: 'number',
                value: parseFloat(token.value),
            };
        }

        if (this.check(TokenType.STRING)) {
            const token = this.advance();
            return {
                type: 'string',
                value: token.value,
            };
        }

        if (this.check(TokenType.IDENTIFIER)) {
            const token = this.advance();
            return {
                type: 'variable',
                name: token.value,
            };
        }

        throw new Error(`Unexpected token: ${this.peek().type}`);
    }

    private parseOperator(): OperatorNode {
        this.consume(TokenType.AT, "Expected '@'");

        // Get operator name
        const nameToken = this.consume(TokenType.IDENTIFIER, "Expected operator name after '@'");
        const name = nameToken.value;

        // Parse arguments
        this.consume(TokenType.LPAREN, "Expected '(' after operator name");

        const args: ExpressionNode[] = [];

        if (!this.check(TokenType.RPAREN)) {
            args.push(this.parseExpression());

            while (this.check(TokenType.COMMA)) {
                this.advance();
                args.push(this.parseExpression());
            }
        }

        this.consume(TokenType.RPAREN, "Expected ')' after arguments");

        return {
            type: 'operator',
            name,
            args,
        };
    }

    private check(type: TokenType): boolean {
        if (this.isAtEnd()) {
            return false;
        }
        return this.peek().type === type;
    }

    private advance(): Token {
        if (!this.isAtEnd()) {
            this.current++;
        }
        return this.previous();
    }

    private consume(type: TokenType, message: string): Token {
        if (this.check(type)) {
            return this.advance();
        }
        throw new Error(`${message} at position ${this.peek().position}`);
    }

    private peek(): Token {
        return this.tokens[this.current];
    }

    private previous(): Token {
        return this.tokens[this.current - 1];
    }

    private isAtEnd(): boolean {
        return this.peek().type === TokenType.EOF;
    }
}

/**
 * Check if an expression contains operators
 */
export function hasOperators(expression: string): boolean {
    return expression.includes('@');
}

/**
 * Extract the base variable name from an expression
 */
export function extractBaseVariable(expression: string): string {
    const parser = new ImageExpressionParser();
    const result = parser.parse(expression);

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
