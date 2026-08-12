import { ImageItem } from '../types';

/**
 * Retain only the identity needed to reconnect a viewer after the next debugger
 * stop. Pixel buffers and stale metadata must not stay alive while execution runs.
 */
export function createUnavailableImageReference(
    item: ImageItem,
    availability: NonNullable<ImageItem['availability']> = 'running'
): ImageItem {
    return {
        id: item.id,
        label: item.label,
        description: item.description,
        tooltip: item.tooltip,
        expression: item.expression,
        isWatch: item.isWatch,
        availability,
    };
}
