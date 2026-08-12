import * as vscode from 'vscode';
import { DebugSessionManager, EvaluateResponse } from '../core/debugSessionManager';
import { BaseImageParser, normalizeTypeName } from './baseParser';
import {
    ParseResult,
    ImageMetadata,
    PixelDepthSize,
    CustomTypeConfig,
    PixelTypeNameToDepth,
    createTypePattern,
    validateCustomTypeConfig,
} from '../types';
import { calculateDataSize } from '../utils/imageTransform';

/**
 * Parser for user-defined custom image types
 */
export class CustomTypeParser extends BaseImageParser {
    readonly name = 'CustomType';
    readonly priority = 75; // Between standard types and legacy

    private configs: CustomTypeConfig[] = [];
    private configPatterns: Map<string, RegExp> = new Map();

    constructor() {
        super();
        this.loadConfigs();
    }

    /**
     * Load custom type configurations from settings
     */
    loadConfigs(): void {
        const config = vscode.workspace.getConfiguration('imview');
        const customTypes = config.get<unknown[]>('customTypes', []);

        this.configs = [];
        this.configPatterns.clear();

        for (const typeConfig of customTypes) {
            if (validateCustomTypeConfig(typeConfig)) {
                this.configs.push(typeConfig as CustomTypeConfig);
                const pattern = createTypePattern((typeConfig as CustomTypeConfig).typeName);
                this.configPatterns.set((typeConfig as CustomTypeConfig).typeName, pattern);
            }
        }
    }

    /** Reload custom type definitions after workspace configuration changes. */
    reloadConfiguration(): void {
        this.loadConfigs();
    }

    /**
     * Add a custom type config programmatically
     */
    addConfig(config: CustomTypeConfig): void {
        if (validateCustomTypeConfig(config)) {
            this.configs.push(config);
            this.configPatterns.set(config.typeName, createTypePattern(config.typeName));
        }
    }

    canParse(typeName: string): boolean {
        const normalized = normalizeTypeName(typeName);

        for (const [, pattern] of this.configPatterns) {
            if (pattern.test(normalized)) {
                return true;
            }
        }
        return false;
    }

    /**
     * Find matching config for a type name
     */
    private findConfig(typeName: string): CustomTypeConfig | undefined {
        const normalized = normalizeTypeName(typeName);

        for (const config of this.configs) {
            const pattern = this.configPatterns.get(config.typeName);
            if (pattern && pattern.test(normalized)) {
                return config;
            }
        }
        return undefined;
    }

    async parse(
        session: DebugSessionManager,
        expression: string,
        evaluateResult: EvaluateResponse
    ): Promise<ParseResult> {
        const config = this.findConfig(evaluateResult.type ?? '');
        if (!config) {
            return this.errorResult('No matching custom type configuration found');
        }

        try {
            const props = config.properties;
            const typeName = evaluateResult.type ?? '';

            // Evaluate width
            const width = await this.evaluateAsInt(
                session,
                this.getMemberExpression(expression, typeName, props.width)
            );
            if (width === undefined || width <= 0) {
                return this.errorResult(`Failed to read width from ${props.width}`);
            }

            // Evaluate height
            const height = await this.evaluateAsInt(
                session,
                this.getMemberExpression(expression, typeName, props.height)
            );
            if (height === undefined || height <= 0) {
                return this.errorResult(`Failed to read height from ${props.height}`);
            }

            // Get channels (can be constant or expression)
            let channels: number;
            if (typeof props.channels === 'number') {
                channels = props.channels;
            } else {
                const evalChannels = await this.evaluateAsInt(
                    session,
                    this.getMemberExpression(expression, typeName, props.channels)
                );
                if (evalChannels === undefined || evalChannels <= 0) {
                    return this.errorResult(`Failed to read channels from ${props.channels}`);
                }
                channels = evalChannels;
            }

            // Get data pointer
            const dataAddress = await this.evaluateAsPointer(
                session,
                this.getMemberExpression(expression, typeName, props.data)
            );
            if (!dataAddress || this.isNullPointerValue(dataAddress)) {
                return this.errorResult('Data pointer is null');
            }

            // Get pixel depth
            const depth = PixelTypeNameToDepth[props.pixelType];
            if (depth === undefined) {
                return this.errorResult(`Unknown pixel type: ${props.pixelType}`);
            }

            // Calculate or evaluate stride
            let stride: number;
            const pixelSize = PixelDepthSize[depth] * channels;

            if (props.stride === 'auto') {
                stride = width * pixelSize;
            } else {
                const evalStride = await this.evaluateAsInt(
                    session,
                    this.getMemberExpression(expression, typeName, props.stride)
                );
                if (evalStride === undefined || evalStride <= 0) {
                    return this.errorResult(`Failed to read stride from ${props.stride}`);
                }
                stride = evalStride;
            }

            // Optional validity check
            if (props.isValid) {
                const validityResult = await this.evaluateExpression(
                    session,
                    this.getMemberExpression(expression, typeName, props.isValid)
                );
                if (!validityResult) {
                    return this.errorResult(`Failed to evaluate validity from ${props.isValid}`);
                }
                const normalizedValidity = validityResult.result.trim().toLowerCase();
                if (/^(?:false|0)\b/.test(normalizedValidity)) {
                    return this.errorResult('Image validity check failed');
                }
                if (!/^true\b/.test(normalizedValidity) && this.parseIntValue(normalizedValidity) === undefined) {
                    return this.errorResult(`Invalid validity value: ${validityResult.result}`);
                }
            }

            const validationError = this.getImageValidationError(width, height, channels, depth, stride);
            if (validationError) {
                return this.errorResult(validationError);
            }

            const metadata: ImageMetadata = {
                id: this.generateImageId(expression),
                name: expression,
                expression,
                typeName: config.typeName,
                depth,
                channels,
                width,
                height,
                stride,
                dataAddress,
                dataSize: 0,
                isContinuous: stride === width * pixelSize,
                debuggerType: session.getDebuggerType(),
                frameId: session.currentFrameId,
                rawProperties: {
                    customType: config.typeName,
                    configDescription: config.description,
                },
            };
            metadata.dataSize = calculateDataSize(metadata);

            return this.successResult(metadata);
        } catch (error) {
            return this.errorResult(`Failed to parse custom type ${config.typeName}: ${error}`);
        }
    }
}
