export interface DebugVariableDetails {
    expression?: string;
    typeName?: string;
    sessionId?: string;
    isVariablesViewContext: boolean;
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
    return typeof value === 'object' && value !== null
        ? value as UnknownRecord
        : undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
    if (typeof value !== 'string') {
        return undefined;
    }

    const trimmed = value.trim();
    return trimmed || undefined;
}

/**
 * Extracts the selected expression from a VS Code debug variable menu argument.
 *
 * VS Code passes contributed `debug/variables/context` commands an object shaped
 * like `{ sessionId, container, variable }`. Direct protocol-variable objects and
 * strings are also accepted so the same commands remain useful programmatically.
 */
export function getDebugVariableDetails(value: unknown): DebugVariableDetails {
    if (typeof value === 'string') {
        return {
            expression: asNonEmptyString(value),
            isVariablesViewContext: false,
        };
    }

    const context = asRecord(value);
    if (!context) {
        return { isVariablesViewContext: false };
    }

    const variable = asRecord(context.variable);
    if (variable) {
        return {
            expression: asNonEmptyString(variable.evaluateName)
                ?? asNonEmptyString(variable.name),
            typeName: asNonEmptyString(variable.type),
            sessionId: asNonEmptyString(context.sessionId),
            isVariablesViewContext: true,
        };
    }

    return {
        expression: asNonEmptyString(context.evaluateName)
            ?? asNonEmptyString(context.name),
        typeName: asNonEmptyString(context.type),
        sessionId: asNonEmptyString(context.sessionId),
        isVariablesViewContext: false,
    };
}
