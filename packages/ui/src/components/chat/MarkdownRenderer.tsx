import React from 'react';
import { lazyWithChunkRecovery } from '@/lib/chunkLoadRecovery';
import { cn } from '@/lib/utils';
import { useFeatureFlagsStore } from '@/stores/useFeatureFlagsStore';
import { loadMarkdownRendererModule } from './markdownRendererLoader';
import { loadMarkstreamRendererModule } from './markstreamRendererLoader';
import { MarkstreamFallbackBoundary } from './MarkstreamFallbackBoundary';
import { useMarkdownHydrationEnabled } from './markdown/markdownHydrationContext';
import { MarkdownLoadingPlaceholder } from './markdown/MarkdownLoadingSkeleton';
import { markdownHeightCacheKey, recallMarkdownHeight } from './markdown/markdownHeightCache';
import { isVideoSource } from './video';

// Thin lazy wrapper around the MarkdownRenderer implementation.
// The full implementation (marked + Shiki highlighting + KaTeX + morphdom
// DOM morphing, plus Pele) is loaded on demand, keeping the
// initial bundle lean.

const MarkdownRendererLazy = lazyWithChunkRecovery(() =>
  loadMarkdownRendererModule().then((m) => ({ default: m.MarkdownRenderer }))
);

const MarkstreamRendererLazy = lazyWithChunkRecovery(() =>
  loadMarkstreamRendererModule().then((m) => ({ default: m.MarkstreamRenderer }))
);

const SimpleMarkdownRendererLazy = lazyWithChunkRecovery(() =>
  loadMarkdownRendererModule().then((m) => ({ default: m.SimpleMarkdownRenderer }))
);

const fallbackContentClassName = (variant: unknown): string => {
  if (variant === 'tool') return 'markdown-content markdown-tool';
  if (variant === 'reasoning') return 'markdown-content markdown-reasoning';
  return 'markdown-content leading-relaxed';
};

const MarkdownSkeletonFallback = (props: {
  animated?: boolean;
  content?: unknown;
  className?: unknown;
  variant?: unknown;
  // Only the rich renderer records measured heights, so only its placeholder
  // may reserve one. The simple renderer produces different output for the
  // same source and would reserve the wrong box.
  reserveMeasuredHeight?: boolean;
}) => {
  const markstreamEnabled = useFeatureFlagsStore((state) => state.markstreamReactEnabled);
  const content = typeof props.content === 'string' ? props.content : '';
  const variant = typeof props.variant === 'string' ? props.variant : 'assistant';
  const reservedHeight = props.reserveMeasuredHeight
    ? recallMarkdownHeight(markdownHeightCacheKey(
      content,
      markstreamEnabled ? `markstream:${variant}` : variant,
    ))
    : undefined;
  return (
    <div
      className={cn(
        'relative break-words w-full min-w-0',
        fallbackContentClassName(props.variant),
        typeof props.className === 'string' ? props.className : undefined,
      )}
      aria-busy="true"
      data-markdown-hydration="deferred"
      data-markdown-ready="false"
    >
      <MarkdownLoadingPlaceholder
        animated={props.animated}
        content={content}
        reservedHeight={reservedHeight}
      />
    </div>
  );
};

export const MarkdownRenderer: React.FC<React.ComponentPropsWithoutRef<typeof MarkdownRendererLazy>> = (props) => {
  const hydrationEnabled = useMarkdownHydrationEnabled();
  const markstreamEnabled = useFeatureFlagsStore((state) => state.markstreamReactEnabled);
  if (!hydrationEnabled && props.isStreaming !== true) {
    return <MarkdownSkeletonFallback {...props} animated={false} reserveMeasuredHeight />;
  }

  const currentRenderer = (
    <React.Suspense fallback={<MarkdownSkeletonFallback {...props} reserveMeasuredHeight />}>
      <MarkdownRendererLazy {...props} />
    </React.Suspense>
  );

  const renderer = !markstreamEnabled ? currentRenderer : (
    <MarkstreamFallbackBoundary fallback={currentRenderer}>
      <React.Suspense fallback={<MarkdownSkeletonFallback {...props} reserveMeasuredHeight />}>
        <MarkstreamRendererLazy {...props} />
      </React.Suspense>
    </MarkstreamFallbackBoundary>
  );
  return <div className="contents" onClickCapture={(event) => {
    if (!props.onShowPopup || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
    const url = anchor?.getAttribute('href');
    if (!url || !isVideoSource(url)) return;
    event.preventDefault();
    event.stopPropagation();
    const filename = anchor?.textContent?.trim() || url.split(/[/?#]/).filter(Boolean).pop() || url;
    props.onShowPopup({ open: true, title: filename, content: '', video: { url, filename } });
  }}>{renderer}</div>;
};

export const SimpleMarkdownRenderer: React.FC<React.ComponentPropsWithoutRef<typeof SimpleMarkdownRendererLazy>> = (props) => {
  const hydrationEnabled = useMarkdownHydrationEnabled();
  if (!hydrationEnabled) {
    return <MarkdownSkeletonFallback {...props} animated={false} />;
  }

  return (
    <React.Suspense fallback={<MarkdownSkeletonFallback {...props} />}>
      <SimpleMarkdownRendererLazy {...props} />
    </React.Suspense>
  );
};
