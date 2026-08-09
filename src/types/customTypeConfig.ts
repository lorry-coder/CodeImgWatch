import { PixelDepth } from './pixelFormats';

/**
 * Configuration for a custom image type
 */
export interface CustomTypeConfig {
    /** The C++ type name to match (can include wildcards) */
    typeName: string;

    /** Regex pattern for matching (derived from typeName) */
    typePattern?: RegExp;

    /** Property expressions to extract image info */
    properties: CustomTypeProperties;

    /** Optional description */
    description?: string;
}

/**
 * Properties defining how to extract image information
 */
export interface CustomTypeProperties {
    /** Expression to get image width */
    width: string;

    /** Expression to get image height */
    height: string;

    /** Expression to get data pointer */
    data: string;

    /** Expression to get channel count (or constant) */
    channels: string | number;

    /** Expression to get row stride in bytes (or 'auto') */
    stride: string | 'auto';

    /** Pixel type (constant value) */
    pixelType: PixelTypeName;

    /** Optional: expression to check if data is valid */
    isValid?: string;
}

/**
 * Supported pixel type names for custom types
 */
export type PixelTypeName =
    | 'uint8'
    | 'int8'
    | 'uint16'
    | 'int16'
    | 'int32'
    | 'float32'
    | 'float64';

/**
 * Map pixel type name to PixelDepth
 */
export const PixelTypeNameToDepth: Record<PixelTypeName, PixelDepth> = {
    uint8: PixelDepth.CV_8U,
    int8: PixelDepth.CV_8S,
    uint16: PixelDepth.CV_16U,
    int16: PixelDepth.CV_16S,
    int32: PixelDepth.CV_32S,
    float32: PixelDepth.CV_32F,
    float64: PixelDepth.CV_64F,
};

/**
 * Validate a custom type configuration
 */
export function validateCustomTypeConfig(config: unknown): config is CustomTypeConfig {
    if (typeof config !== 'object' || config === null) {
        return false;
    }

    const c = config as Record<string, unknown>;

    if (typeof c.typeName !== 'string' || c.typeName.trim().length === 0) {
        return false;
    }

    if (typeof c.properties !== 'object' || c.properties === null) {
        return false;
    }

    const props = c.properties as Record<string, unknown>;

    // Required string properties
    const requiredStrings = ['width', 'height', 'data'];
    for (const prop of requiredStrings) {
        if (typeof props[prop] !== 'string' || (props[prop] as string).trim().length === 0) {
            return false;
        }
    }

    // channels can be a non-empty member expression or a supported constant
    if (typeof props.channels === 'string') {
        if (props.channels.trim().length === 0) {
            return false;
        }
    } else if (typeof props.channels === 'number') {
        if (!Number.isSafeInteger(props.channels) || props.channels < 1 || props.channels > 4) {
            return false;
        }
    } else {
        return false;
    }

    // stride can be string (including 'auto')
    if (typeof props.stride !== 'string' || props.stride.trim().length === 0) {
        return false;
    }

    if (props.isValid !== undefined &&
        (typeof props.isValid !== 'string' || props.isValid.trim().length === 0)) {
        return false;
    }

    // pixelType must be a valid type name
    const validTypes = Object.keys(PixelTypeNameToDepth);
    if (!validTypes.includes(props.pixelType as string)) {
        return false;
    }

    return true;
}

/**
 * Create a type pattern regex from a type name with wildcards
 */
export function createTypePattern(typeName: string): RegExp {
    // Escape regex special chars except *
    const escaped = typeName.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    // Convert * to .*
    const pattern = escaped.replace(/\*/g, '.*');
    return new RegExp(`^${pattern}$`);
}

/**
 * Example custom type configurations
 */
export const ExampleCustomTypes: CustomTypeConfig[] = [
    {
        typeName: 'MyImage',
        description: 'Example custom image type',
        properties: {
            width: 'm_width',
            height: 'm_height',
            channels: 3,
            data: 'm_data',
            stride: 'm_stride',
            pixelType: 'uint8',
        },
    },
    {
        typeName: 'stbi_image',
        description: 'STB Image library image',
        properties: {
            width: 'width',
            height: 'height',
            channels: 'comp',
            data: 'data',
            stride: 'auto',
            pixelType: 'uint8',
        },
    },
];
