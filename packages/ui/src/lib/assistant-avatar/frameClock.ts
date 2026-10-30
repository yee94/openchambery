type FrameListener = (timestamp: number) => void;
const listeners = new Set<FrameListener>();
let frame: number | null = null;
let lastPaint = -Infinity;

// One bounded 30fps clock for visible live faces, not a React state update or
// timer per transcript row. Static/reduced-motion/offscreen faces never join.
function tick(timestamp: number) {
  frame = null;
  if (timestamp - lastPaint >= 1000 / 30 - 0.5) {
    lastPaint = timestamp;
    listeners.forEach((listener) => listener(timestamp));
  }
  if (listeners.size) frame = requestAnimationFrame(tick);
}

export function subscribeAvatarFrames(listener: FrameListener): () => void {
  listeners.add(listener);
  if (frame === null) frame = requestAnimationFrame(tick);
  return () => {
    listeners.delete(listener);
    if (!listeners.size && frame !== null) {
      cancelAnimationFrame(frame);
      frame = null;
      lastPaint = -Infinity;
    }
  };
}
