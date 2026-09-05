import React from 'react';
import MarkdownRender from 'markstream-react';
import { useEvent, useEventListener, useResizeObserver } from '@reactuses/core';
import type { Part } from '@opencode-ai/sdk/v2';
import { cn } from '@/lib/utils';
import { useOptionalThemeSystem } from '@/contexts/useThemeSystem';
import { markdownHeightCacheKey, rememberMarkdownHeight } from './markdown/markdownHeightCache';
import { handleMarkstreamPointerEvent } from './markstream/markstreamInteractions';
import { MARKSTREAM_CHAT_STREAM_PERFORMANCE } from './markstream/markstreamPerformance';
import type { ToolPopupContent } from './message/types';
import 'markstream-react/index.css';
import './markstream/markstreamTheme.css';

type MarkdownVariant = 'assistant' | 'reasoning' | 'tool';

interface MarkstreamRendererProps {
  content: string;
  part?: Part;
  messageId: string;
  isAnimated?: boolean;
  skipFadeIn?: boolean;
  className?: string;
  isStreaming?: boolean;
  disableStreamAnimation?: boolean;
  variant?: MarkdownVariant;
  onShowPopup?: (content: ToolPopupContent) => void;
  enableFileReferences?: boolean;
}

const markdownContentClassName = (variant: MarkdownVariant): string =>
  variant === 'tool'
    ? 'markdown-content markdown-tool oc-markstream-host'
    : variant === 'reasoning'
      ? 'markdown-content markdown-reasoning oc-markstream-host'
      : 'markdown-content leading-relaxed oc-markstream-host';

const MARKSTREAM_CODE_BLOCK_OPTIONS = {
  overflow: 'wrap',
} as const;

const MarkstreamRendererImpl: React.FC<MarkstreamRendererProps> = ({
  content,
  part,
  messageId,
  className,
  isStreaming = false,
  variant = 'assistant',
  onShowPopup,
}) => {
  const themeSystem = useOptionalThemeSystem();
  const isDark = themeSystem?.currentTheme.metadata.variant === 'dark';
  const containerRef = React.useRef<HTMLDivElement>(null);
  const customId = part?.id ? `oc-ms-${part.id}` : `oc-ms-${messageId}`;
  const cacheKey = markdownHeightCacheKey(content, `markstream:${variant}`);
  const recordHeight = !isStreaming;

  const enabledRef = React.useRef(recordHeight);
  enabledRef.current = recordHeight;
  const cacheKeyRef = React.useRef(cacheKey);
  cacheKeyRef.current = cacheKey;

  const handleResize = useEvent<ResizeObserverCallback>((entries) => {
    if (!enabledRef.current) return;
    const entry = entries[0];
    if (!entry) return;
    const box = entry.borderBoxSize?.[0];
    const height = box ? box.blockSize : entry.contentRect.height;
    const width = box ? box.inlineSize : entry.contentRect.width;
    rememberMarkdownHeight(cacheKeyRef.current, height, width);
  });
  useResizeObserver(containerRef, handleResize);

  const handleClick = useEvent((event: MouseEvent) => {
    handleMarkstreamPointerEvent(event, { onShowPopup });
  });
  useEventListener('click', handleClick, containerRef);

  return (
    <div
      ref={containerRef}
      className={cn('relative break-words w-full min-w-0', markdownContentClassName(variant), className)}
      data-markdown-ready="true"
      data-markdown-hydration="ready"
      data-oc-markdown-engine="markstream"
      data-oc-markstream-virtual="nodes"
    >
      <MarkdownRender
        content={content}
        customId={customId}
        final={!isStreaming}
        isDark={isDark}
        codeBlockOptions={MARKSTREAM_CODE_BLOCK_OPTIONS}
        codeBlockStream={isStreaming}
        {...MARKSTREAM_CHAT_STREAM_PERFORMANCE}
      />
    </div>
  );
};

export const MarkstreamRenderer = React.memo(MarkstreamRendererImpl, (prev, next) => (
  prev.content === next.content
    && prev.isStreaming === next.isStreaming
    && prev.disableStreamAnimation === next.disableStreamAnimation
    && prev.variant === next.variant
    && prev.isAnimated === next.isAnimated
    && prev.skipFadeIn === next.skipFadeIn
    && prev.className === next.className
    && prev.messageId === next.messageId
    && prev.onShowPopup === next.onShowPopup
    && prev.enableFileReferences === next.enableFileReferences
    && prev.part?.id === next.part?.id
));
