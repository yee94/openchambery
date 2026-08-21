import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { MobileSheetSnapHandle } from '@/components/ui/MobileSheetSnapHandle';
import { MobileWindowMotion } from '@/components/ui/MobileWindowMotion';
import { cn } from '@/lib/utils';
import {
  MOBILE_SHEET_EXPANDED_SNAP,
  useMobileSheetSnap,
} from '@/components/ui/useMobileSheetSnap';

type MobileResizableSheetProps = {
  id: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: React.ReactNode;
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
  ariaLabel: string;
  closeAriaLabel: string;
  resizeAriaLabel: string;
  initiallyExpanded?: boolean;
  fitContent?: boolean;
  bodyClassName?: string;
  children: React.ReactNode;
};

export const MobileResizableSheet: React.FC<MobileResizableSheetProps> = ({
  id,
  open,
  onOpenChange,
  title,
  leading,
  trailing,
  ariaLabel,
  closeAriaLabel,
  resizeAriaLabel,
  initiallyExpanded = false,
  fitContent = false,
  bodyClassName,
  children,
}) => {
  const sheetSnap = useMobileSheetSnap({
    initialSnapPoint: initiallyExpanded ? MOBILE_SHEET_EXPANDED_SNAP : undefined,
    fitContent,
    onDismiss: () => onOpenChange(false),
  });
  const hasHeader = title != null || leading != null || trailing != null;

  return (
    <MobileWindowMotion
      id={id}
      open={open}
      onOpenChange={onOpenChange}
      presentation="sheet"
      edge="bottom"
      dismissGesture={{ reservedTargetSelector: '[data-mobile-sheet-snap-handle]' }}
      ariaLabel={ariaLabel}
      surfaceClassName={sheetSnap.snapPoint === MOBILE_SHEET_EXPANDED_SNAP
        ? 'h-[98dvh] max-h-[98dvh]'
        : fitContent
          ? 'h-auto max-h-[72dvh]'
          : 'h-[72dvh] max-h-[98dvh]'}
      surfaceElementRef={sheetSnap.surfaceRef}
      onExitComplete={sheetSnap.reset}
    >
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="shrink-0">
          <MobileSheetSnapHandle controller={sheetSnap} ariaLabel={resizeAriaLabel} />
          {hasHeader ? (
            <div className="flex min-h-10 items-center gap-2 px-4 pb-2">
              {leading ? <div className="flex shrink-0 items-center">{leading}</div> : null}
              <div className="min-w-0 flex-1">{title}</div>
              {trailing ? <div className="flex shrink-0 items-center gap-1.5">{trailing}</div> : null}
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => onOpenChange(false)}
                aria-label={closeAriaLabel}
                className="shrink-0 text-muted-foreground"
                style={{ touchAction: 'manipulation' }}
              >
                <Icon name="close" className="size-5" />
              </Button>
            </div>
          ) : null}
        </div>
        {/*
          Body must be a flex column: picker children rely on `flex-1 min-h-0`
          to own the scroll region. Without `flex`, children grow to content
          height and get clipped by overflow-hidden — no vertical scroll.
          `data-page-scroll-lock` keeps overflow:hidden under the global
          mobile-pointer rewrite that turns `.overflow-hidden` into overflow-y:auto.
        */}
        <div
          className={cn('flex min-h-0 flex-1 flex-col overflow-hidden', bodyClassName)}
          data-page-scroll-lock="true"
        >
          {children}
        </div>
      </div>
    </MobileWindowMotion>
  );
};
