/**
 * Colormap utilities for the extension side
 * (Mirror of webview colormap for consistency)
 */

export type RGB = [number, number, number];

/**
 * Available colormap names
 */
export const COLORMAP_NAMES = [
    'grayscale',
    'jet',
    'hot',
    'cool',
    'viridis',
    'plasma',
] as const;

export type ColormapName = (typeof COLORMAP_NAMES)[number];

/**
 * Validate colormap name
 */
export function isValidColormap(name: string): name is ColormapName {
    return COLORMAP_NAMES.includes(name as ColormapName);
}

/**
 * Get default colormap
 */
export function getDefaultColormap(): ColormapName {
    return 'grayscale';
}
