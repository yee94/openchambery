import type React from 'react';

/**
 * Stable morphdom cache identity for a nested fence.
 * MarkdownRendererImpl keys `markdown-message-${messageId}` when `part` is
 * omitted — we omit `part` so multiple fences in one part do not share one
 * part-id cache slot. Uniqueness therefore encodes host message, host part,
 * and Markstream's node `indexKey` (tree position), not language alone.
 */
export const markstreamCodeBlockMessageId = (input: {
  messageId: string;
  partId?: string | null;
  indexKey?: React.Key;
  language?: string | null;
}): string => {
  const partKey = input.partId ? `part-${input.partId}` : 'body';
  const hasIndex = input.indexKey !== undefined && input.indexKey !== null && String(input.indexKey).length > 0;
  const blockKey = hasIndex
    ? String(input.indexKey)
    : (input.language && input.language.length > 0 ? input.language : 'code');
  return `${input.messageId}:${partKey}:code:${blockKey}`;
};
