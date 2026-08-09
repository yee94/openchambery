import { useEffect, useRef, type ReactNode } from 'react';

import { useEvent } from '@reactuses/core';

import { cn } from '@/lib/utils';

export type MobileTabPageHeaderProps = {
  title: string;
  eyebrow?: string;
  trailing?: ReactNode;
  className?: string;
};

/** Scroll distance (px) that maps to full visual collapse. Layout height never changes. */
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
  const lastProgressRef = useRef<number | null>(null);

  const writeCollapseProgress = useEvent(() => {
    frameRef.current = null;
    const header = headerRef.current;
    const scrollParent = scrollParentRef.current;
    if (!header || !scrollParent) return;

    const progress = Math.min(1, Math.max(0, scrollParent.scrollTop / MOBILE_TITLE_COLLAPSE_DISTANCE));
    const renderedProgress = reducedMotionRef.current?.matches
      ? Number(progress >= 0.5)
      : progress;

    // Skip no-op writes so we do not dirty style when idle at the ends.
    if (
      lastProgressRef.current !== null &&
      Math.abs(lastProgressRef.current - renderedProgress) < 0.001
    ) {
      return;
    }
    lastProgressRef.current = renderedProgress;
    // Compositor-friendly only: CSS must not change layout box from this var.
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
    lastProgressRef.current = null;
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
      lastProgressRef.current = null;
    };
    // The DOM ownership is mount-scoped; useEvent supplies current handlers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <header
        ref={headerRef}
        className={cn('oc-mobile-collapsing-header flex shrink-0 items-start gap-4', className)}
      >
        <div className="oc-mobile-collapsing-header-inner">
          <div className="oc-mobile-collapsing-header-title-block min-w-0 flex-1">
            {eyebrow ? (
              <p className="oc-mobile-collapsing-header-eyebrow truncate typography-micro font-medium text-muted-foreground">
                {eyebrow}
              </p>
            ) : null}
            <h1 className="oc-mobile-root-page-title truncate font-semibold text-foreground">
              {title}
            </h1>
          </div>
          {trailing ? (
            <div className="oc-mobile-collapsing-header-trailing flex min-h-10 shrink-0 items-center gap-3.5">
              {trailing}
            </div>
          ) : null}
        </div>
      </header>
      {/*
        Static in-flow clearance for the expanded visual offset. Scrolls away
        natively so collapse never rewrites sticky layout height (bounce source).
      */}
      <div className="oc-mobile-collapsing-header-spacer" aria-hidden="true" />
    </>
  );
}
