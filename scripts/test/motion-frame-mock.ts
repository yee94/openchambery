type Callback = (data: { timestamp: number }) => void;
const reads = new Map<Callback, boolean>();
const renders = new Map<Callback, boolean>();
let scheduled: number | null = null;

function tick(timestamp: number) {
  scheduled = null;
  for (const phase of [reads, renders]) for (const [callback, keepAlive] of [...phase]) {
    if (!phase.has(callback)) continue;
    if (!keepAlive) phase.delete(callback);
    callback({ timestamp });
  }
  if (reads.size || renders.size) scheduled = requestAnimationFrame(tick);
}
function schedule(phase: Map<Callback, boolean>, callback: Callback, keepAlive = false) {
  phase.set(callback, keepAlive);
  scheduled ??= requestAnimationFrame(tick);
  return callback;
}
export const frame = {
  read: (callback: Callback, keepAlive?: boolean) => schedule(reads, callback, keepAlive),
  render: (callback: Callback, keepAlive?: boolean) => schedule(renders, callback, keepAlive),
};
export function cancelFrame(callback: Callback) {
  reads.delete(callback); renders.delete(callback);
  if (!reads.size && !renders.size && scheduled !== null) { cancelAnimationFrame(scheduled); scheduled = null; }
}
