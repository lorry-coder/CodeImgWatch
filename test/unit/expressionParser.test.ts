import * as assert from 'assert';
import {
    ImageExpressionParser,
    hasOperators,
    extractBaseVariable,
} from '../../src/core/imageExpressionParser';

describe('ImageExpressionParser', () => {
    let parser: ImageExpressionParser;

    beforeEach(() => {
        parser = new ImageExpressionParser();
    });

    describe('Simple expressions', () => {
        it('should parse simple variable', () => {
            const result = parser.parse('myImage');
            assert.strictEqual(result.success, true);
            assert.strictEqual(result.ast?.type, 'variable');
            if (result.ast?.type === 'variable') {
                assert.strictEqual(result.ast.name, 'myImage');
            }
        });

        it('should parse variable with namespace', () => {
            const result = parser.parse('cv::Mat');
            assert.strictEqual(result.success, true);
            assert.strictEqual(result.ast?.type, 'variable');
        });

        it('should parse array access', () => {
            const result = parser.parse('images[0]');
            assert.strictEqual(result.success, true);
            assert.strictEqual(result.ast?.type, 'variable');
            if (result.ast?.type === 'variable') {
                assert.strictEqual(result.ast.name, 'images[0]');
            }
        });

        it('should parse pointer member access', () => {
            const result = parser.parse('ptr->data');
            assert.strictEqual(result.success, true);
            assert.strictEqual(result.ast?.type, 'variable');
            if (result.ast?.type === 'variable') {
                assert.strictEqual(result.ast.name, 'ptr->data');
            }
        });
    });

    describe('Operator expressions', () => {
        it('should parse simple operator', () => {
            const result = parser.parse('@abs(img)');
            assert.strictEqual(result.success, true);
            assert.strictEqual(result.ast?.type, 'operator');
            if (result.ast?.type === 'operator') {
                assert.strictEqual(result.ast.name, 'abs');
                assert.strictEqual(result.ast.args.length, 1);
                assert.strictEqual(result.ast.args[0].type, 'variable');
            }
        });

        it('should parse operator with two arguments', () => {
            const result = parser.parse('@band(img, 0)');
            assert.strictEqual(result.success, true);
            assert.strictEqual(result.ast?.type, 'operator');
            if (result.ast?.type === 'operator') {
                assert.strictEqual(result.ast.name, 'band');
                assert.strictEqual(result.ast.args.length, 2);
                assert.strictEqual(result.ast.args[0].type, 'variable');
                assert.strictEqual(result.ast.args[1].type, 'number');
            }
        });

        it('should parse nested operators', () => {
            const result = parser.parse('@abs(@diff(img1, img2))');
            assert.strictEqual(result.success, true);
            assert.strictEqual(result.ast?.type, 'operator');
            if (result.ast?.type === 'operator') {
                assert.strictEqual(result.ast.name, 'abs');
                assert.strictEqual(result.ast.args.length, 1);
                assert.strictEqual(result.ast.args[0].type, 'operator');
            }
        });

        it('should parse operator with string argument', () => {
            const result = parser.parse('@file("test.png")');
            assert.strictEqual(result.success, true);
            assert.strictEqual(result.ast?.type, 'operator');
            if (result.ast?.type === 'operator') {
                assert.strictEqual(result.ast.name, 'file');
                assert.strictEqual(result.ast.args.length, 1);
                assert.strictEqual(result.ast.args[0].type, 'string');
                if (result.ast.args[0].type === 'string') {
                    assert.strictEqual(result.ast.args[0].value, 'test.png');
                }
            }
        });

        it('should parse @mem operator', () => {
            const result = parser.parse('@mem(0x12345678, uint8, 3, 640, 480)');
            assert.strictEqual(result.success, true);
            assert.strictEqual(result.ast?.type, 'operator');
            if (result.ast?.type === 'operator') {
                assert.strictEqual(result.ast.name, 'mem');
                assert.strictEqual(result.ast.args.length, 5);
            }
        });
    });

    describe('hasOperators', () => {
        it('should detect operators', () => {
            assert.strictEqual(hasOperators('@abs(img)'), true);
            assert.strictEqual(hasOperators('@band(img, 0)'), true);
        });

        it('should not detect operators in simple expressions', () => {
            assert.strictEqual(hasOperators('myImage'), false);
            assert.strictEqual(hasOperators('images[0]'), false);
        });
    });

    describe('extractBaseVariable', () => {
        it('should extract variable from simple expression', () => {
            assert.strictEqual(extractBaseVariable('myImage'), 'myImage');
        });

        it('should extract variable from operator expression', () => {
            assert.strictEqual(extractBaseVariable('@abs(img)'), 'img');
        });

        it('should extract variable from nested operators', () => {
            assert.strictEqual(extractBaseVariable('@abs(@diff(img1, img2))'), 'img1');
        });
    });

    describe('Error handling', () => {
        it('should return error for empty expression', () => {
            const result = parser.parse('');
            assert.strictEqual(result.success, false);
        });

        it('should return error for unclosed parenthesis', () => {
            const result = parser.parse('@abs(img');
            assert.strictEqual(result.success, false);
        });

        it('should return error for missing operator name', () => {
            const result = parser.parse('@(img)');
            assert.strictEqual(result.success, false);
        });
    });
});
