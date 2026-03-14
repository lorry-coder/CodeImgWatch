export * from './baseParser';
export * from './cvMatParser';
export * from './cvMatTemplateParser';
export * from './cvMatxParser';
export * from './legacyParser';
export * from './rawArrayParser';
export * from './customTypeParser';

import { ImageParserRegistry } from './baseParser';
import { CvMatParser } from './cvMatParser';
import { CvMatTemplateParser } from './cvMatTemplateParser';
import { CvMatxParser, CvVecParser } from './cvMatxParser';
import { CvMatLegacyParser, IplImageParser } from './legacyParser';
import { CustomTypeParser } from './customTypeParser';

/**
 * Register all built-in parsers
 */
export function registerBuiltInParsers(): void {
    const registry = ImageParserRegistry.getInstance();

    // Register in order of priority (registry will sort them)
    registry.register(new CvVecParser());
    registry.register(new CvMatxParser());
    registry.register(new CvMatTemplateParser());
    registry.register(new CvMatParser());
    registry.register(new CustomTypeParser());
    registry.register(new CvMatLegacyParser());
    registry.register(new IplImageParser());
}
