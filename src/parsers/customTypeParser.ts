import * as vscode from 'vscode';
import { DebugSessionManager, EvaluateResponse } from '../core/debugSessionManager';
import { BaseImageParser } from './baseParser';
import {
    ParseResult,
    ImageMetadata,
    PixelDepthSize,
    CustomTypeConfig,
    PixelTypeNameToDepth,
    createTypePattern,
    validateCustomTypeConfig,
} from '../types';

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
        const normalized = typeName.replace(/^(const\s+)?(class\s+|struct\s+)?/, '').trim();

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
        const normalized = typeName.replace(/^(const\s+)?(class\s+|struct\s+)?/, '').trim();

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

            // Evaluate width
            const width = await this.evaluateAsInt(session, `${expression}.${props.width}`);
            if (width === undefined || width <= 0) {
                return this.errorResult(`Failed to read width from ${props.width}`);
            }

            // Evaluate height
            const height = await this.evaluateAsInt(session, `${expression}.${props.height}`);
            if (height === undefined || height <= 0) {
                return this.errorResult(`Failed to read height from ${props.height}`);
            }

            // Get channels (can be constant or expression)
            let channels: number;
            if (typeof props.channels === 'number') {
                channels = props.channels;
            } else {
                const evalChannels = await this.evaluateAsInt(session, `${expression}.${props.channels}`);
                if (evalChannels === undefined || evalChannels <= 0) {
                    return this.errorResult(`Failed to read channels from ${props.channels}`);
                }
                channels = evalChannels;
            }

            // Get data pointer
            const dataAddress = await this.evaluateAsPointer(session, `${expression}.${props.data}`);
            if (!dataAddress || dataAddress === '0x0') {
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
                const evalStride = await this.evaluateAsInt(session, `${expression}.${props.stride}`);
                if (evalStride === undefined || evalStride <= 0) {
                    // Fall back to calculated stride
                    stride = width * pixelSize;
                } else {
                    stride = evalStride;
                }
            }

            // Optional validity check
            if (props.isValid) {
                const isValid = await this.evaluateAsInt(session, `${expression}.${props.isValid}`);
                if (isValid === 0) {
                    return this.errorResult('Image validity check failed');
                }
            }

            const dataSize = stride * height;

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
                dataSize,
                isContinuous: stride === width * pixelSize,
                debuggerType: session.getDebuggerType(),
                frameId: session.currentFrameId,
                rawProperties: {
                    customType: config.typeName,
                    configDescription: config.description,
                },
            };

            return this.successResult(metadata);
        } catch (error) {
            return this.errorResult(`Failed to parse custom type ${config.typeName}: ${error}`);
        }
    }
}
