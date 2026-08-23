import React from 'react';

import { Button } from '@/components/ui/button';
import { Icon } from "@/components/icon/Icon";
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';

interface ScrollToBottomButtonProps {
    visible: boolean;
    onClick: () => void;
    /** expanded = foot sibling; compact = inline inside the pill input. */
    placement?: 'default' | 'expanded' | 'compact';
}

const ScrollToBottomButton: React.FC<ScrollToBottomButtonProps> = ({ visible, onClick, placement = 'default' }) => {
    const { t } = useI18n();
    const isCompactInline = placement === 'compact';
    if (isCompactInline && !visible) return null;
    return (
        <div
            className={cn(
                placement === 'default' && 'absolute left-1/2 bottom-full mb-2 -translate-x-1/2',
                // Expanded: CSS sets bottom to --oc-chat-foot-inset; mb-2 is the original gap.
                placement === 'expanded' && 'absolute left-1/2 -translate-x-1/2 oc-scroll-to-bottom--expanded mb-2',
                // Compact: sits inside the pill trailing cluster (right side).
                placement === 'compact' && 'oc-scroll-to-bottom--compact relative shrink-0',
                visible
                    ? cn(
                        'pointer-events-auto',
                        placement === 'default' && 'opacity-100',
                    )
                    : cn(
                        // Hide instantly — no fade / slide / scale.
                        'opacity-0 pointer-events-none',
                        placement === 'expanded' && 'oc-scroll-to-bottom--hidden',
                    ),
            )}
        >
            <Button
                variant={isCompactInline ? 'ghost' : 'outline'}
                size="sm"
                onClick={onClick}
                className={cn(
                    'p-0 shadow-none',
                    isCompactInline
                        // Match compact attach: hug the icon, no circle fill.
                        ? 'composer-mobile-actions h-8 w-8 rounded-none bg-transparent hover:bg-transparent text-foreground'
                        : 'size-8 rounded-full [corner-shape:round] bg-background/95 hover:bg-interactive-hover',
                )}
                aria-label={t('chat.scrollToBottom.aria')}
            >
                <Icon
                    name="arrow-down"
                    // Must use `size-*` so Button's `[&_svg:not([class*='size-'])]:size-4`
                    // does not clamp the compact glyph back to 16px.
                    className={isCompactInline ? 'size-5' : 'size-4'}
                    weight={isCompactInline ? 'medium' : 'regular'}
                />
            </Button>
        </div>
    );
};

export default React.memo(ScrollToBottomButton);
