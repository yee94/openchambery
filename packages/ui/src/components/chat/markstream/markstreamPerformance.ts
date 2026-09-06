/**
 * Markstream in-document node virtualization for this experiment branch.
 *
 * This is **not** a chat-timeline virtualizer. TanStack Virtual remains the
 * MessageList default; LegendList stays opt-in via `oc:legend-timeline=1`.
 * Markstream only windows parsed Markdown nodes inside one assistant bubble
 * (`max-live-nodes` / live-node buffer / placeholders).
 *
 * Values match `markstream-react@2.0.8` library defaults (`Pr` in the
 * renderer) and the official "AI chat defaults" preset:
 * https://markstream.simonhe.me/guide/performance
 *
 * `maxLiveNodes: 0` is typewriter / incremental-placeholder mode and is
 * intentionally not used. `smoothStreaming: 'auto'` only paces when
 * typewriter is on or `maxLiveNodes <= 0`, so it stays inactive here.
 * `viewportPriority` is the documented pair for `deferNodesUntilVisible`
 * (heavy mermaid/code surfaces wait until near the viewport).
 */
export const MARKSTREAM_CHAT_STREAM_PERFORMANCE = {
  maxLiveNodes: 320,
  liveNodeBuffer: 60,
  batchRendering: true,
  deferNodesUntilVisible: true,
  viewportPriority: true,
  initialRenderBatchSize: 40,
  renderBatchSize: 80,
  renderBatchDelay: 16,
  renderBatchBudgetMs: 6,
  renderBatchIdleTimeoutMs: 120,
  smoothStreaming: 'auto' as const,
  typewriter: false,
  fade: false,
} as const;
