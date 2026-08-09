export * from './baseParser';
export * from './cvMatParser';
export * from './cvMatTemplateParser';
export * from './cvMatxParser';
export * from './legacyParser';
export * from './rawArrayParser';
export * from './customTypeParser';
export * from './numpyParser';
export * from './pilParser';
export * from './torchParser';

import { ImageParserRegistry } from './baseParser';
import { CvMatParser } from './cvMatParser';
import { CvMatTemplateParser } from './cvMatTemplateParser';
import { CvMatxParser, CvVecParser } from './cvMatxParser';
import { CvMatLegacyParser, IplImageParser } from './legacyParser';
import { CustomTypeParser } from './customTypeParser';
import { NumpyArrayParser } from './numpyParser';
import { PILImageParser } from './pilParser';
import { TorchTensorParser } from './torchParser';

/**
 * Register all built-in parsers
 */
export function registerBuiltInParsers(): void {
    const registry = ImageParserRegistry.getInstance();
    const registeredNames = new Set(registry.getAllParsers().map(parser => parser.name));
    const register = (parser: Parameters<typeof registry.register>[0]): void => {
        if (!registeredNames.has(parser.name)) {
            registry.register(parser);
            registeredNames.add(parser.name);
        }
    };

    // Register in order of priority (registry will sort them)
    // C++ parsers
    register(new CvVecParser());
    register(new CvMatxParser());
    register(new CvMatTemplateParser());
    register(new CvMatParser());
    register(new CustomTypeParser());
    register(new CvMatLegacyParser());
    register(new IplImageParser());

    // Python parsers
    register(new NumpyArrayParser());
    register(new TorchTensorParser());
    register(new PILImageParser());
}
