/**
 * Colormap definitions for single-channel image visualization
 * Each colormap is an array of 256 RGB tuples
 */

type RGB = [number, number, number];

/**
 * Generate grayscale colormap
 */
function generateGrayscale(): RGB[] {
    const map: RGB[] = [];
    for (let i = 0; i < 256; i++) {
        map.push([i, i, i]);
    }
    return map;
}

/**
 * Generate jet colormap (blue -> cyan -> yellow -> red)
 */
function generateJet(): RGB[] {
    const map: RGB[] = [];
    for (let i = 0; i < 256; i++) {
        const t = i / 255;
        let r: number, g: number, b: number;

        if (t < 0.125) {
            r = 0;
            g = 0;
            b = 0.5 + t * 4;
        } else if (t < 0.375) {
            r = 0;
            g = (t - 0.125) * 4;
            b = 1;
        } else if (t < 0.625) {
            r = (t - 0.375) * 4;
            g = 1;
            b = 1 - (t - 0.375) * 4;
        } else if (t < 0.875) {
            r = 1;
            g = 1 - (t - 0.625) * 4;
            b = 0;
        } else {
            r = 1 - (t - 0.875) * 2;
            g = 0;
            b = 0;
        }

        map.push([
            Math.round(r * 255),
            Math.round(g * 255),
            Math.round(b * 255),
        ]);
    }
    return map;
}

/**
 * Generate hot colormap (black -> red -> yellow -> white)
 */
function generateHot(): RGB[] {
    const map: RGB[] = [];
    for (let i = 0; i < 256; i++) {
        const t = i / 255;
        let r: number, g: number, b: number;

        if (t < 0.365) {
            r = t / 0.365;
            g = 0;
            b = 0;
        } else if (t < 0.746) {
            r = 1;
            g = (t - 0.365) / 0.381;
            b = 0;
        } else {
            r = 1;
            g = 1;
            b = (t - 0.746) / 0.254;
        }

        map.push([
            Math.round(r * 255),
            Math.round(g * 255),
            Math.round(b * 255),
        ]);
    }
    return map;
}

/**
 * Generate cool colormap (cyan -> magenta)
 */
function generateCool(): RGB[] {
    const map: RGB[] = [];
    for (let i = 0; i < 256; i++) {
        const t = i / 255;
        map.push([
            Math.round(t * 255),
            Math.round((1 - t) * 255),
            255,
        ]);
    }
    return map;
}

/**
 * Generate viridis colormap (dark purple -> blue -> green -> yellow)
 */
function generateViridis(): RGB[] {
    // Simplified viridis - key colors
    const keyColors: RGB[] = [
        [68, 1, 84],
        [72, 40, 120],
        [62, 74, 137],
        [49, 104, 142],
        [38, 130, 142],
        [31, 158, 137],
        [53, 183, 121],
        [109, 205, 89],
        [180, 222, 44],
        [253, 231, 37],
    ];

    const map: RGB[] = [];
    for (let i = 0; i < 256; i++) {
        const t = (i / 255) * (keyColors.length - 1);
        const idx = Math.floor(t);
        const frac = t - idx;

        if (idx >= keyColors.length - 1) {
            map.push(keyColors[keyColors.length - 1]);
        } else {
            const c1 = keyColors[idx];
            const c2 = keyColors[idx + 1];
            map.push([
                Math.round(c1[0] + (c2[0] - c1[0]) * frac),
                Math.round(c1[1] + (c2[1] - c1[1]) * frac),
                Math.round(c1[2] + (c2[2] - c1[2]) * frac),
            ]);
        }
    }
    return map;
}

/**
 * Generate plasma colormap (dark purple -> magenta -> orange -> yellow)
 */
function generatePlasma(): RGB[] {
    const keyColors: RGB[] = [
        [13, 8, 135],
        [75, 3, 161],
        [125, 3, 168],
        [168, 34, 150],
        [203, 70, 121],
        [229, 107, 93],
        [248, 148, 65],
        [253, 195, 40],
        [240, 249, 33],
    ];

    const map: RGB[] = [];
    for (let i = 0; i < 256; i++) {
        const t = (i / 255) * (keyColors.length - 1);
        const idx = Math.floor(t);
        const frac = t - idx;

        if (idx >= keyColors.length - 1) {
            map.push(keyColors[keyColors.length - 1]);
        } else {
            const c1 = keyColors[idx];
            const c2 = keyColors[idx + 1];
            map.push([
                Math.round(c1[0] + (c2[0] - c1[0]) * frac),
                Math.round(c1[1] + (c2[1] - c1[1]) * frac),
                Math.round(c1[2] + (c2[2] - c1[2]) * frac),
            ]);
        }
    }
    return map;
}

/**
 * Available colormaps
 */
export const colorMaps: Record<string, RGB[]> = {
    grayscale: generateGrayscale(),
    jet: generateJet(),
    hot: generateHot(),
    cool: generateCool(),
    viridis: generateViridis(),
    plasma: generatePlasma(),
};

/**
 * Get list of available colormap names
 */
export function getColormapNames(): string[] {
    return Object.keys(colorMaps);
}
