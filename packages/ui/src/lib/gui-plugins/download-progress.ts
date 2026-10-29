// Transient transport progress, not inventory or cached server state.
const downloads = new Map<string, number>();
const listeners = new Set<() => void>();
export const guiDownloadProgress = {
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  pending(transport: string) { return (downloads.get(transport) ?? 0) > 0; },
  begin(transport: string, signal: AbortSignal) {
    if (signal.aborted) return () => {};
    let ended = false;
    downloads.set(transport, (downloads.get(transport) ?? 0) + 1);
    const finish = () => {
      if (ended) return;
      ended = true;
      signal.removeEventListener('abort', finish);
      const count = (downloads.get(transport) ?? 1) - 1;
      if (count) downloads.set(transport, count); else downloads.delete(transport);
      for (const listener of listeners) listener();
    };
    signal.addEventListener('abort', finish, { once: true });
    for (const listener of listeners) listener();
    return finish;
  },
};
