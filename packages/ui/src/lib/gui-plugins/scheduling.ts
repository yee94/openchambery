/** A committed UI gets a paint opportunity before optional GUI work starts. */
export function afterGuiPaint(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let frame = 0;
    let task: number | undefined;
    const cleanup = () => {
      cancelAnimationFrame(frame);
      if (task !== undefined) window.clearTimeout(task);
      signal.removeEventListener('abort', abort);
    };
    const abort = () => { cleanup(); reject(signal.reason ?? new DOMException('Aborted', 'AbortError')); };
    const finish = () => { cleanup(); resolve(); };
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        task = window.setTimeout(finish, 0);
      });
    });
  });
}

/** Serialize only synchronous installation, never another plugin's network/IPC wait. */
export function createGuiInstallQueue() {
  let tail = Promise.resolve();
  return (signal: AbortSignal, install: () => void): Promise<void> => {
    const result = tail.then(async () => {
      await afterGuiPaint(signal);
      signal.throwIfAborted();
      install();
    });
    tail = result.catch(() => {});
    return result;
  };
}
