// Catalog retries require a settled attempt. A healthy Relay socket does not
// imply that an individual HTTP response (including its body) will ever finish.
export const withConfigQueryDeadline = async <T>(
  signal: AbortSignal,
  request: (signal: AbortSignal) => Promise<T>,
): Promise<T> => {
  const controller = new AbortController();
  let rejectCancelled!: (reason: unknown) => void;
  const cancelled = new Promise<never>((_, reject) => { rejectCancelled = reject; });
  const abort = (reason: unknown) => {
    rejectCancelled(reason);
    controller.abort(reason);
  };
  const onAbort = () => abort(signal.reason ?? new DOMException('Request aborted', 'AbortError'));
  const timer = setTimeout(() => abort(new DOMException('Configuration request timed out', 'TimeoutError')), 30_000);
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    if (signal.aborted) {
      onAbort();
      return await cancelled;
    }
    // Race independently: Electron/Relay bridges may ignore AbortSignal.
    return await Promise.race([request(controller.signal), cancelled]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
};
