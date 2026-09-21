import React from 'react';
import type { NodeComponentProps } from 'markstream-react';
// Direct Impl import (not MarkdownRenderer.tsx) so the feature-flag Markstream
// wrapper cannot recurse when a fenced block nests inside Markstream.
import { MarkdownRenderer } from '../MarkdownRendererImpl';
import { fenceMarkdownFromCodeBlockNode } from './markstreamCodeBlockFence';
import { markstreamCodeBlockMessageId } from './markstreamCodeBlockMessageId';
import { useMarkstreamHostContext } from './markstreamHostContext';

type CodeBlockNodeShape = {
  type: 'code_block';
  language?: string;
  code?: string;
  loading?: boolean;
  raw?: string;
};

type MarkstreamCodeBlockProps = NodeComponentProps<CodeBlockNodeShape> & {
  loading?: boolean;
  stream?: boolean;
  indexKey?: React.Key;
};

/**
 * Markstream `code_block` override: delegate fenced blocks to the established
 * MarkdownRendererImpl path (marked + Shiki + morphdom decorate) so chat keeps
 * the compact OpenChamber code card instead of markstream-react's default
 * multi-control toolbar. Body nodes stay on Markstream.
 */
export function MarkstreamCodeBlockNode(props: MarkstreamCodeBlockProps) {
  const host = useMarkstreamHostContext();
  const language = props.node.language ?? '';
  const code = props.node.code ?? '';
  const raw = props.node.raw ?? '';
  const loading = props.node.loading === true || props.loading === true;
  const content = React.useMemo(
    () => fenceMarkdownFromCodeBlockNode({ type: 'code_block', language, code, raw, loading }),
    [language, code, raw, loading],
  );
  // Nested MarkdownRendererImpl streaming follows the OpenChamber host flag and
  // Markstream node.loading (open fence). Host already passes
  // codeBlockStream={isStreaming}; the library stream prop alone is not treated
  // as a proven blank-on-remount root cause — only as adapter input to ignore
  // when the host says the body is settled.
  const streaming = host.isStreaming
    || props.loading === true
    || props.node.loading === true;
  const messageId = markstreamCodeBlockMessageId({
    messageId: host.messageId,
    partId: host.part?.id,
    indexKey: props.indexKey,
    language: props.node.language,
  });

  return (
    <div
      className="oc-markstream-code-host min-w-0 w-full"
      data-oc-markstream-code="markdown-impl"
      data-oc-markstream-code-id={messageId}
    >
      <MarkdownRenderer
        content={content}
        // part omitted on purpose — see markstreamCodeBlockMessageId.
        messageId={messageId}
        isAnimated={false}
        skipFadeIn
        isStreaming={streaming}
        disableStreamAnimation={host.disableStreamAnimation}
        variant={host.variant}
        onShowPopup={host.onShowPopup}
        // Fence body file refs stay Morphdom-owned inside MarkdownRendererImpl.
        enableFileReferences={host.enableFileReferences && !streaming}
      />
    </div>
  );
}
