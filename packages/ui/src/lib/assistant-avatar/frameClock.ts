import { cancelFrame, frame } from 'motion';

type FrameListener = (timestamp: number) => void;
const listeners = new Set<{ paint: FrameListener; measure?: () => void }>();
let lastPaint = -Infinity;
let timestamp = 0;
let due = false;

// One bounded 30fps clock for visible live faces, not a React state update or
// timer per transcript row. Static/reduced-motion/offscreen faces never join.
function readFrame(data: { timestamp: number }) {
  due = data.timestamp - lastPaint >= 1000 / 30 - 0.5;
  if (due) {
    timestamp = lastPaint = data.timestamp;
    // Batch all geometry reads before any SVG writes to avoid layout thrashing
    // when several faces track the same pointer or move during scrolling.
    listeners.forEach((listener) => listener.measure?.());
  }
}

function paintFrame() {
  if (!due) return;
  due = false;
  listeners.forEach((listener) => listener.paint(timestamp));
}

export function subscribeAvatarFrames(paint: FrameListener, measure?: () => void): () => void {
  const listener = { paint, measure };
  listeners.add(listener);
  if (listeners.size === 1) {
    frame.read(readFrame, true);
    frame.render(paintFrame, true);
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      cancelFrame(readFrame);
      cancelFrame(paintFrame);
      lastPaint = -Infinity;
      due = false;
    }
  };
}
