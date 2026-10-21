import type { Virtualizer, VirtualItem } from '@tanstack/react-virtual';

type SizeAdjustmentState = Pick<Virtualizer<HTMLDivElement, HTMLDivElement>, 'itemSizeCache' | 'scrollOffset'>;

/**
 * Chat history row-size anchoring. Matches virtual-core's default predicate
 * except that a fully-above-fold re-measure is compensated in either scroll
 * direction: rows above an upward-reading viewport still hydrate Markdown or
 * load media, and leaving that delta uncompensated moves the visible messages.
 * Rows spanning the fold keep growing below the reader's anchor, so they are
 * still never compensated. Smooth-scroll and iOS gesture deferral stay in core.
 */
export const shouldAdjustHistoryScrollOnItemSizeChange = (
    item: VirtualItem,
    _delta: number,
    instance: SizeAdjustmentState,
): boolean => {
    const scrollOffset = instance.scrollOffset ?? 0;
    const measuredSize = instance.itemSizeCache.get(item.key);
    if (measuredSize === undefined) return item.start < scrollOffset;
    return item.start + measuredSize <= scrollOffset;
};
