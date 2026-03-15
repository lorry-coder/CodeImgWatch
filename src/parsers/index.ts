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

    // Register in order of priority (registry will sort them)
    // C++ parsers
    registry.register(new CvVecParser());
    registry.register(new CvMatxParser());
    registry.register(new CvMatTemplateParser());
    registry.register(new CvMatParser());
    registry.register(new CustomTypeParser());
    registry.register(new CvMatLegacyParser());
    registry.register(new IplImageParser());

    // Python parsers
    registry.register(new NumpyArrayParser());
    registry.register(new TorchTensorParser());
    registry.register(new PILImageParser());
}
