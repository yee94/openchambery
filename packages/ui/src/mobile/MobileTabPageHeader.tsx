import { useEffect, useRef, type ReactNode } from 'react';

import { useEvent } from '@reactuses/core';

import { cn } from '@/lib/utils';

export type MobileTabPageHeaderProps = {
  title: string;
  eyebrow?: string;
  trailing?: ReactNode;
  className?: string;
};

const MOBILE_TITLE_COLLAPSE_DISTANCE = 48;

/** Safe-area-aware collapsing title + trailing actions for mobile root tabs. */
export function MobileTabPageHeader({
  title,
  eyebrow,
  trailing,
  className,
}: MobileTabPageHeaderProps) {
  const headerRef = useRef<HTMLElement>(null);
  const scrollParentRef = useRef<HTMLElement | null>(null);
  const reducedMotionRef = useRef<MediaQueryList | null>(null);
  const frameRef = useRef<number | null>(null);

  const writeCollapseProgress = useEvent(() => {
    frameRef.current = null;
    const header = headerRef.current;
    const scrollParent = scrollParentRef.current;
    if (!header || !scrollParent) return;

    const progress = Math.min(1, Math.max(0, scrollParent.scrollTop / MOBILE_TITLE_COLLAPSE_DISTANCE));
    const renderedProgress = reducedMotionRef.current?.matches
      ? Number(progress >= 0.5)
      : progress;
    header.style.setProperty('--oc-mobile-title-collapse', renderedProgress.toFixed(4));
  });

  const scheduleCollapseProgress = useEvent(() => {
    if (frameRef.current !== null) return;
    frameRef.current = window.requestAnimationFrame(writeCollapseProgress);
  });

  useEffect(() => {
    const header = headerRef.current;
    if (!header) return;

    const scrollParent = header.closest<HTMLElement>(
      '.oc-mobile-settings-root-surface, [role="tabpanel"]',
    );
    if (!scrollParent) return;

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    scrollParentRef.current = scrollParent;
    reducedMotionRef.current = reducedMotion;
    scrollParent.addEventListener('scroll', scheduleCollapseProgress, { passive: true });
    reducedMotion.addEventListener('change', scheduleCollapseProgress);
    writeCollapseProgress();

    return () => {
      scrollParent.removeEventListener('scroll', scheduleCollapseProgress);
      reducedMotion.removeEventListener('change', scheduleCollapseProgress);
      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
      scrollParentRef.current = null;
      reducedMotionRef.current = null;
    };
    // The DOM ownership is mount-scoped; useEvent supplies current handlers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <header
      ref={headerRef}
      className={cn('oc-mobile-collapsing-header flex shrink-0 items-center gap-4', className)}
    >
      <div className="min-w-0 flex-1">
        {eyebrow ? (
          <p className="oc-mobile-collapsing-header-eyebrow truncate typography-micro font-medium text-muted-foreground">
            {eyebrow}
          </p>
        ) : null}
        <h1 className="oc-mobile-root-page-title truncate font-semibold text-foreground">
          {title}
        </h1>
      </div>
      {trailing ? <div className="flex min-h-10 shrink-0 items-center gap-3.5">{trailing}</div> : null}
    </header>
  );
}
