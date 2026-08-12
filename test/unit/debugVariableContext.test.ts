import * as assert from 'assert';
import { getDebugVariableDetails } from '../../src/utils/debugVariableContext';

describe('Debug variable context', () => {
    it('reads the protocol variable nested in the VS Code menu payload', () => {
        const details = getDebugVariableDetails({
            sessionId: 'debug-session',
            container: {
                name: 'Locals',
            },
            variable: {
                name: 'frame',
                evaluateName: 'pipeline.frames[index]',
                type: 'cv::Mat',
                value: '{...}',
                variablesReference: 42,
            },
        });

        assert.deepStrictEqual(details, {
            expression: 'pipeline.frames[index]',
            typeName: 'cv::Mat',
            sessionId: 'debug-session',
            isVariablesViewContext: true,
        });
    });

    it('falls back to the clicked variable name when evaluateName is blank', () => {
        const details = getDebugVariableDetails({
            sessionId: 'debug-session',
            variable: {
                name: ' image ',
                evaluateName: '   ',
                type: ' numpy.ndarray ',
            },
        });

        assert.strictEqual(details.expression, 'image');
        assert.strictEqual(details.typeName, 'numpy.ndarray');
        assert.strictEqual(details.isVariablesViewContext, true);
    });

    it('never substitutes the parent container for an unnamed clicked variable', () => {
        const details = getDebugVariableDetails({
            container: {
                name: 'wrongParent',
                evaluateName: 'wrongParent',
            },
            variable: {
                name: '   ',
                evaluateName: '',
            },
        });

        assert.strictEqual(details.expression, undefined);
        assert.strictEqual(details.isVariablesViewContext, true);
    });

    it('supports direct protocol variables and programmatic string arguments', () => {
        assert.deepStrictEqual(
            getDebugVariableDetails({
                name: 'fallback',
                evaluateName: ' selected.image ',
                type: 'cv::Mat',
            }),
            {
                expression: 'selected.image',
                typeName: 'cv::Mat',
                sessionId: undefined,
                isVariablesViewContext: false,
            }
        );
        assert.deepStrictEqual(getDebugVariableDetails(' frames[0] '), {
            expression: 'frames[0]',
            isVariablesViewContext: false,
        });
    });

    it('rejects missing and non-string expression fields', () => {
        assert.deepStrictEqual(getDebugVariableDetails(undefined), {
            isVariablesViewContext: false,
        });
        assert.deepStrictEqual(getDebugVariableDetails({
            variable: {
                name: 123,
                evaluateName: false,
            },
        }), {
            expression: undefined,
            typeName: undefined,
            sessionId: undefined,
            isVariablesViewContext: true,
        });
    });
});
