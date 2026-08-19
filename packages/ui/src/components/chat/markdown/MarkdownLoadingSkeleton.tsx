import React from 'react';

import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

const MAX_SKELETON_LINES = 5;
const WRAPPED_LINE_CHARACTER_ESTIMATE = 88;
const SKELETON_LINE_WIDTHS = [
  'w-full',
  'w-[92%]',
  'w-[84%]',
  'w-[96%]',
] as const;

const TABLE_ROW_LINE = /^\s*\|.*\|\s*$/;
const TABLE_SEPARATOR_LINE = /^[\s|:-]+$/;

/**
 * Table source collapses hard once rendered: every pipe row is exactly one
 * nowrap line (the table-scroll wrapper forbids wrapping) and the `|---|`
 * separator draws a border instead of text, while the raw characters
 * wrap-estimate to several lines each. Normalizing rows before the invisible
 * pre-wrap spacer and the line estimate keeps the deferred placeholder from
 * overshooting badly on table-heavy Markdown.
 */
// eslint-disable-next-line react-refresh/only-export-components -- pure helper exported for tests
export const normalizeTableLinesForEstimate = (content: string): string => (
  content
    .split('\n')
    .map((line) => {
      if (!TABLE_ROW_LINE.test(line)) return line;
      if (TABLE_SEPARATOR_LINE.test(line)) return '';
      return 'x';
    })
    .join('\n')
);

const estimateSkeletonLineCount = (content: string): number => {
  const trimmed = content.trim();
  if (!trimmed) return 1;

  const explicitLines = trimmed.split(/\n+/).length;
  const wrappedLines = Math.ceil(trimmed.length / WRAPPED_LINE_CHARACTER_ESTIMATE);
  return Math.min(MAX_SKELETON_LINES, Math.max(1, explicitLines, wrappedLines));
};

/**
 * Keeps a size spacer in place while showing only a bounded skeleton, so rich
 * Markdown can replace it without exposing raw source syntax or creating dozens
 * of animated placeholder nodes.
 *
 * The spacer prefers `reservedHeight` — the height this content actually
 * rendered at last time. Rendered Markdown is far shorter than its source
 * (fenced code, link targets and table pipes all collapse), so the plain-text
 * fallback overshoots badly and the swap to real content collapses the row,
 * which the virtualizer then compensates by yanking the scroll offset.
 */
export const MarkdownLoadingPlaceholder: React.FC<{
  animated?: boolean;
  content: string;
  reservedHeight?: number;
}> = ({ animated = true, content, reservedHeight }) => {
  // The size spacer and the skeleton-bar count both estimate from the
  // table-normalized source (see normalizeTableLinesForEstimate).
  const normalizedContent = normalizeTableLinesForEstimate(content);
  const lineCount = estimateSkeletonLineCount(normalizedContent);
  const showSkeleton = content.trim().length > 0;
  const hasReservedHeight = typeof reservedHeight === 'number'
    && Number.isFinite(reservedHeight)
    && reservedHeight > 0;

  return (
    <>
      {hasReservedHeight ? (
        <span
          aria-hidden="true"
          className="block"
          data-markdown-size-spacer="measured"
          style={{ height: `${reservedHeight}px` }}
        />
      ) : (
        <span
          aria-hidden="true"
          className="invisible block whitespace-pre-wrap"
          data-markdown-size-spacer="true"
        >
          {normalizedContent || '\u00a0'}
        </span>
      )}
      {showSkeleton && (
        <div
          aria-hidden="true"
          className={cn(
            'pointer-events-none absolute inset-0 flex w-full flex-col gap-2 overflow-hidden py-1',
            animated && 'motion-safe:animate-pulse',
          )}
          data-markdown-placeholder="skeleton"
        >
          {Array.from({ length: lineCount }, (_, index) => (
            <Skeleton
              key={index}
              className={cn(
                'h-3.5 animate-none',
                index === lineCount - 1
                  ? 'w-[68%]'
                  : SKELETON_LINE_WIDTHS[index % SKELETON_LINE_WIDTHS.length],
              )}
            />
          ))}
        </div>
      )}
    </>
  );
};
