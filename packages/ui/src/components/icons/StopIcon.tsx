import type { ComponentPropsWithoutRef } from 'react';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';

/**
 * Composer abort / send control: inverted filled circle.
 * Stop uses a CSS square (not sprite `stop`) because button SVG rects are
 * forced to `fill: none` in the global WebKit icon workaround.
 * Native iOS `OpenChamberComposer` paints the same 24pt disc (arrow 56% /
 * stop square 38% with 20% radius) in `composerCircleImage`.
 */
function ComposerCircleGlyph({
    className,
    children,
    ...props
}: ComponentPropsWithoutRef<'span'>) {
    return (
        <span
            className={cn(
                'inline-flex shrink-0 items-center justify-center rounded-full bg-foreground text-background',
                className,
            )}
            {...props}
            aria-hidden
        >
            {children}
        </span>
    );
}

export function StopIcon({ className, ...props }: ComponentPropsWithoutRef<'span'>) {
    return (
        <ComposerCircleGlyph className={className} {...props}>
            <span
                data-stop-glyph="true"
                className="block size-[38%] rounded-[20%] bg-current"
            />
        </ComposerCircleGlyph>
    );
}

export function SendCircleIcon({
    className,
    spinning = false,
    ...props
}: ComponentPropsWithoutRef<'span'> & { spinning?: boolean }) {
    return (
        <ComposerCircleGlyph className={className} {...props}>
            <Icon
                name={spinning ? 'loader-4' : 'arrow-up'}
                weight="medium"
                className={cn(spinning ? 'size-[50%] animate-spin' : 'size-[56%]')}
            />
        </ComposerCircleGlyph>
    );
}
