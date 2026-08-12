import * as vscode from 'vscode';
import { DebugSessionManager, EvaluateResponse, VariableInfo } from '../core/debugSessionManager';
import { ImageMetadata, ParseResult, PixelDepth, PixelDepthSize } from '../types';

/**
 * Interface for image type parsers
 */
export interface IImageParser {
    /**
     * Unique name of this parser
     */
    readonly name: string;

    /**
     * Priority for type matching (higher = checked first)
     */
    readonly priority: number;

    /**
     * Check if this parser can handle the given type
     */
    canParse(typeName: string): boolean;

    /**
     * Parse image metadata from a variable
     */
    parse(
        session: DebugSessionManager,
        expression: string,
        evaluateResult: EvaluateResponse
    ): Promise<ParseResult>;

    /** Reload parser-specific workspace configuration, if applicable. */
    reloadConfiguration?(): void;
}

/**
 * Registry for image parsers
 */
export class ImageParserRegistry {
    private static instance: ImageParserRegistry | undefined;
    private parsers: IImageParser[] = [];

    private constructor() {}

    public static getInstance(): ImageParserRegistry {
        if (!ImageParserRegistry.instance) {
            ImageParserRegistry.instance = new ImageParserRegistry();
        }
        return ImageParserRegistry.instance;
    }

    /**
     * Register a parser
     */
    public register(parser: IImageParser): void {
        this.parsers.push(parser);
        // Sort by priority (highest first)
        this.parsers.sort((a, b) => b.priority - a.priority);
    }

    /**
     * Find a parser that can handle the given type
     */
    public findParser(typeName: string): IImageParser | undefined {
        return this.parsers.find(p => p.canParse(typeName));
    }

    /**
     * Get all registered parsers
     */
    public getAllParsers(): IImageParser[] {
        return [...this.parsers];
    }

    /** Reload configuration-backed parsers without rebuilding the registry. */
    public reloadConfiguration(): void {
        for (const parser of this.parsers) {
            parser.reloadConfiguration?.();
        }
    }

    /**
     * Clear all parsers (for testing)
     */
    public clear(): void {
        this.parsers = [];
    }
}

/**
 * Base class for image parsers with common functionality
 */
export abstract class BaseImageParser implements IImageParser {
    abstract readonly name: string;
    abstract readonly priority: number;

    abstract canParse(typeName: string): boolean;
    abstract parse(
        session: DebugSessionManager,
        expression: string,
        evaluateResult: EvaluateResponse
    ): Promise<ParseResult>;

    /**
     * Get a member variable by name from a struct
     */
    protected async getMember(
        session: DebugSessionManager,
        variablesReference: number,
        memberName: string
    ): Promise<VariableInfo | undefined> {
        return session.getMemberValue(variablesReference, memberName);
    }

    /**
     * Evaluate a sub-expression
     */
    protected async evaluateExpression(
        session: DebugSessionManager,
        expression: string
    ): Promise<EvaluateResponse | undefined> {
        return session.evaluate(expression);
    }

    /**
     * Parse an integer value from a variable
     */
    protected parseIntValue(value: string): number | undefined {
        // Handle hex
        if (value.startsWith('0x') || value.startsWith('0X')) {
            return parseInt(value, 16);
        }

        // Handle decimal (may have trailing info like type annotations)
        const match = value.match(/^-?\d+/);
        if (match) {
            return parseInt(match[0], 10);
        }

        return undefined;
    }

    /**
     * Parse a pointer address from a value string
     */
    protected parsePointerValue(value: string): string | undefined {
        // Match hex address
        const hexMatch = value.match(/0[xX][0-9a-fA-F]+/);
        if (hexMatch) {
            return `0x${hexMatch[0].slice(2)}`;
        }

        // Plain hex without prefix
        const plainMatch = value.match(/^[0-9a-fA-F]{8,16}\b/);
        if (plainMatch) {
            return '0x' + plainMatch[0];
        }

        return undefined;
    }

    /**
     * Get member value as integer
     */
    protected async getMemberAsInt(
        session: DebugSessionManager,
        variablesReference: number,
        memberName: string
    ): Promise<number | undefined> {
        const member = await this.getMember(session, variablesReference, memberName);
        if (member) {
            return this.parseIntValue(member.value);
        }
        return undefined;
    }

    /**
     * Get member value as pointer address
     */
    protected async getMemberAsPointer(
        session: DebugSessionManager,
        variablesReference: number,
        memberName: string
    ): Promise<string | undefined> {
        const member = await this.getMember(session, variablesReference, memberName);
        if (member) {
            // First check memoryReference
            if (member.memoryReference) {
                return member.memoryReference;
            }
            // Fall back to parsing value
            return this.parsePointerValue(member.value);
        }
        return undefined;
    }

    /**
     * Evaluate expression and get as integer
     */
    protected async evaluateAsInt(
        session: DebugSessionManager,
        expression: string
    ): Promise<number | undefined> {
        const result = await this.evaluateExpression(session, expression);
        if (result) {
            return this.parseIntValue(result.result);
        }
        return undefined;
    }

    /**
     * Evaluate expression and get as pointer
     */
    protected async evaluateAsPointer(
        session: DebugSessionManager,
        expression: string
    ): Promise<string | undefined> {
        const result = await this.evaluateExpression(session, expression);
        if (result) {
            const pointerValue = this.parsePointerValue(result.result);
            if (pointerValue) {
                return pointerValue;
            }
            return result.memoryReference;
        }
        return undefined;
    }

    /** Return whether a numeric pointer representation is null. */
    protected isNullPointerValue(value: string): boolean {
        const normalized = value.trim();
        if (normalized === '0' || normalized.toLowerCase() === 'nullptr') {
            return true;
        }
        const hexMatch = normalized.match(/^0[xX]([0-9a-fA-F]+)$/);
        return hexMatch !== null && /^0+$/.test(hexMatch[1]);
    }

    /** Build member access for values/references and pointer expressions. */
    protected getMemberExpression(expression: string, typeName: string, memberName: string): string {
        const withoutQualifiers = typeName
            .replace(/\b(?:const|volatile)\b/g, ' ')
            .replace(/\b__(?:ptr64|restrict)\b/g, ' ')
            .trim();
        const withoutReferences = withoutQualifiers.replace(/&+\s*$/, '').trim();
        const access = /\*\s*$/.test(withoutReferences) ? '->' : '.';
        return `(${expression})${access}${memberName}`;
    }

    /** Validate dimensions and allocation size before requesting debuggee memory. */
    protected getImageValidationError(
        width: number,
        height: number,
        channels: number,
        depth: PixelDepth,
        stride: number
    ): string | undefined {
        return getImageValidationError(width, height, channels, depth, stride);
    }

    /**
     * Generate a unique ID for an image
     */
    protected generateImageId(expression: string): string {
        return `img_${Date.now()}_${expression.replace(/[^a-zA-Z0-9]/g, '_')}`;
    }

    /**
     * Create an error result
     */
    protected errorResult(message: string): ParseResult {
        return {
            success: false,
            error: message,
        };
    }

    /**
     * Create a success result
     */
    protected successResult(metadata: ImageMetadata, warnings?: string[]): ParseResult {
        return {
            success: true,
            metadata,
            warnings,
        };
    }
}

/**
 * Check if a type name matches known image types
 */
export function isKnownImageType(typeName: string): boolean {
    const knownPatterns = [
        // C++ OpenCV types
        /cv::Mat\b/,
        /cv::Mat_</,
        /cv::Matx</,
        /cv::Vec(?:<|\d)/,
        /\bCvMat\b/,
        /\bIplImage\b/,
        // Python image types
        /\bndarray\b/,           // numpy.ndarray
        /\bImage\b/,             // PIL.Image.Image
        /\b(?:[A-Za-z_]\w*)?ImageFile\b/, // Pillow concrete image subclasses
        /\bTensor\b/,            // torch.Tensor
        /numpy\.ndarray/,
        /PIL\.Image/,
        /torch\.Tensor/,
    ];

    if (knownPatterns.some(pattern => pattern.test(typeName))) {
        return true;
    }

    // Configuration-backed parsers (notably custom C++ image types) cannot be
    // represented by a fixed pattern list. Consult the registry as a fallback.
    return ImageParserRegistry.getInstance().findParser(normalizeTypeName(typeName)) !== undefined;
}

/**
 * Normalize a type name for comparison
 */
export function normalizeTypeName(typeName: string): string {
    let normalized = typeName
        .replace(/\b(?:const|volatile)\b/g, ' ')
        .replace(/\b__(?:ptr64|restrict)\b/g, ' ')
        .trim();
    normalized = normalized.replace(/^(class|struct)\s+/, '');
    normalized = normalized.replace(/(?:\s*[*&])+\s*$/, '').trim();
    return normalized;
}

/** Validate image shape and transfer size using the shared workspace limits. */
export function getImageValidationError(
    width: number,
    height: number,
    channels: number,
    depth: PixelDepth,
    stride: number
): string | undefined {
    const config = vscode.workspace.getConfiguration('imview');
    const configuredMaxDimension = config.get<number>('maxImageSize', 4096);
    const maxDimension = Number.isFinite(configuredMaxDimension) && configuredMaxDimension > 0
        ? Math.floor(configuredMaxDimension)
        : 4096;
    const configuredMaxBytes = config.get<number>('maxImageBytes', 256 * 1024 * 1024);
    const maxBytes = Number.isFinite(configuredMaxBytes) && configuredMaxBytes > 0
        ? Math.floor(configuredMaxBytes)
        : 256 * 1024 * 1024;

    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
        return `Invalid image dimensions: ${width}x${height}`;
    }
    if (width > maxDimension || height > maxDimension) {
        return `Image dimensions ${width}x${height} exceed imview.maxImageSize (${maxDimension})`;
    }
    if (!Number.isSafeInteger(channels) || channels < 1 || channels > 4) {
        return `Unsupported channel count: ${channels} (expected 1-4)`;
    }

    const bytesPerElement = PixelDepthSize[depth];
    if (!bytesPerElement) {
        return `Unsupported pixel depth: ${depth}`;
    }

    const rowSize = width * channels * bytesPerElement;
    if (!Number.isSafeInteger(rowSize) || !Number.isSafeInteger(stride) || stride < rowSize) {
        return `Invalid row stride: ${stride} bytes (minimum ${rowSize})`;
    }

    const dataSize = (height - 1) * stride + rowSize;
    if (!Number.isSafeInteger(dataSize) || dataSize <= 0 || dataSize > maxBytes) {
        return `Image requires ${dataSize} bytes; imview.maxImageBytes is ${maxBytes}`;
    }
    return undefined;
}
