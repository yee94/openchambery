/**
 * Markstream renderer knobs for this experiment branch.
 *
 * TanStack Virtual owns MessageList row height (`measureElement`). A second
 * in-bubble live-node window (`maxLiveNodes > 0`) placeholders off-window
 * nodes and changes bubble height while scrolling — that fights TanStack.
 *
 * `maxLiveNodes: 0` turns off the sliding window. Library default then
 * enables incremental/typewriter batching (`batchRendering`,
 * `smoothStreaming: 'auto'`), which still churns placeholders. Follow the
 * documented small-doc / no-virt preset:
 * https://markstream.simonhe.me/guide/performance
 *
 *   max-live-nodes=0 + batch-rendering=false + smooth-streaming=false
 *
 * Markstream still renders assistant Markdown (default-on). Opt out with
 * `oc:markstream-react=0`. LegendList stays `oc:legend-timeline=1`.
 */
export const MARKSTREAM_CHAT_STREAM_PERFORMANCE = {
  maxLiveNodes: 0,
  liveNodeBuffer: 0,
  batchRendering: false,
  deferNodesUntilVisible: false,
  viewportPriority: false,
  smoothStreaming: false,
  typewriter: false,
  fade: false,
} as const;
