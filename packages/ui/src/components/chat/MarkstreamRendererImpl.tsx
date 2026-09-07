import React from 'react';
import MarkdownRender from 'markstream-react';
import { useEvent, useEventListener, useResizeObserver } from '@reactuses/core';
import type { Part } from '@opencode-ai/sdk/v2';
import { cn } from '@/lib/utils';
import { useOptionalThemeSystem } from '@/contexts/useThemeSystem';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { markdownHeightCacheKey, rememberMarkdownHeight } from './markdown/markdownHeightCache';
import {
  handleMarkstreamFileReferenceKeyDown,
  handleMarkstreamPointerEvent,
} from './markstream/markstreamInteractions';
import { MarkstreamFileReferenceProvider } from './markstream/markstreamFileReferences';
import { ensureMarkstreamCustomComponents } from './markstream/markstreamCustomComponents';
import {
  MarkstreamHostContext,
  type MarkstreamMarkdownVariant,
} from './markstream/markstreamHostContext';
import { MARKSTREAM_CHAT_STREAM_PERFORMANCE } from './markstream/markstreamPerformance';
import type { ToolPopupContent } from './message/types';
import './markstream/markstreamTheme.css';

// text / inline_code / link / code_block overrides register once here.
ensureMarkstreamCustomComponents();

type MarkdownVariant = MarkstreamMarkdownVariant;

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

const MarkstreamRendererImpl: React.FC<MarkstreamRendererProps> = ({
  content,
  part,
  messageId,
  className,
  isStreaming = false,
  disableStreamAnimation = false,
  variant = 'assistant',
  onShowPopup,
  enableFileReferences = true,
}) => {
  const themeSystem = useOptionalThemeSystem();
  const isDark = themeSystem?.currentTheme.metadata.variant === 'dark';
  const { editor, runtime } = useRuntimeAPIs();
  const effectiveDirectory = useEffectiveDirectory() ?? '';
  const containerRef = React.useRef<HTMLDivElement>(null);
  const customId = part?.id ? `oc-ms-${part.id}` : `oc-ms-${messageId}`;
  const cacheKey = markdownHeightCacheKey(content, `markstream:${variant}`);
  const recordHeight = !isStreaming;
  const fileReferencesEnabled = enableFileReferences && !isStreaming;
  const fileReferenceOptions = fileReferencesEnabled
    ? {
      effectiveDirectory,
      editor,
      preferRuntimeEditor: runtime.isVSCode,
      onShowPopup,
    }
    : undefined;

  const hostContext = React.useMemo(() => ({
    messageId,
    part,
    isStreaming,
    disableStreamAnimation,
    variant,
    onShowPopup,
    enableFileReferences,
  }), [
    messageId,
    part,
    isStreaming,
    disableStreamAnimation,
    variant,
    onShowPopup,
    enableFileReferences,
  ]);

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
    handleMarkstreamPointerEvent(event, { onShowPopup, fileReference: fileReferenceOptions });
  });
  const handleKeyDown = useEvent((event: KeyboardEvent) => {
    handleMarkstreamFileReferenceKeyDown(event, { fileReference: fileReferenceOptions });
  });
  useEventListener('click', handleClick, containerRef);
  useEventListener('keydown', handleKeyDown, containerRef);

  return (
    <div
      ref={containerRef}
      className={cn('relative break-words w-full min-w-0', markdownContentClassName(variant), className)}
      data-markdown-ready="true"
      data-markdown-hydration="ready"
      data-oc-markdown-engine="markstream"
      data-oc-markstream-virtual="off"
    >
      <MarkstreamHostContext.Provider value={hostContext}>
        <MarkstreamFileReferenceProvider
          enabled={fileReferencesEnabled}
          effectiveDirectory={effectiveDirectory}
          editor={editor}
          preferRuntimeEditor={runtime.isVSCode}
          onShowPopup={onShowPopup}
          content={content}
        >
          <MarkdownRender
            content={content}
            customId={customId}
            final={!isStreaming}
            isDark={isDark}
            // Keep library stream flag aligned with the host. code_block is overridden
            // (MarkstreamCodeBlockNode gates on host.isStreaming + node.loading); residual
            // library paths may still read codeBlockStream.
            codeBlockStream={isStreaming}
            {...MARKSTREAM_CHAT_STREAM_PERFORMANCE}
          />
        </MarkstreamFileReferenceProvider>
      </MarkstreamHostContext.Provider>
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
