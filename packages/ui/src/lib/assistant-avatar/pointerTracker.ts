type Pointer = { x: number; y: number } | null;
type Tracker = { users: number; point: Pointer; dispose: () => void };
const trackers = new WeakMap<Window, Tracker>();

// One imperative input owner per window, not a React listener per avatar. Events
// only replace a sample; the shared clock reads it once per visible face/paint.
export function acquireAvatarPointer(win: Window) {
  let tracker = trackers.get(win);
  if (!tracker) {
    const state: Tracker = { users: 0, point: null, dispose: () => {} };
    const move = (event: PointerEvent) => {
      state.point = event.pointerType === 'mouse' ? { x: event.clientX, y: event.clientY } : null;
    };
    const clear = () => { state.point = null; };
    const leave = (event: PointerEvent) => { if (event.relatedTarget === null) clear(); };
    win.addEventListener('pointermove', move, { passive: true });
    win.addEventListener('pointerout', leave, { passive: true });
    win.addEventListener('blur', clear);
    state.dispose = () => {
      win.removeEventListener('pointermove', move);
      win.removeEventListener('pointerout', leave);
      win.removeEventListener('blur', clear);
      state.point = null;
    };
    tracker = state;
    trackers.set(win, state);
  }
  const state = tracker;
  state.users++;
  let released = false;
  return {
    read: () => state.point,
    release() {
      if (released) return;
      released = true;
      if (--state.users === 0) { state.dispose(); trackers.delete(win); }
    },
  };
}
