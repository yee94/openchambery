/**
 * Host → webview SSE fan-out for Extension-owned events (e.g. archive
 * session.updated) that must reach every active openSseProxy stream.
 */

const hostSseEmitters = new Set<(chunk: string) => void>();

export const registerHostSseEmitter = (emit: (chunk: string) => void): (() => void) => {
  hostSseEmitters.add(emit);
  return () => {
    hostSseEmitters.delete(emit);
  };
};

/** Inject one JSON SSE data event into every active webview stream. */
export const injectHostSseEvent = (payload: unknown): void => {
  if (payload == null) return;
  const chunk = `data: ${JSON.stringify(payload)}\n\n`;
  for (const emit of hostSseEmitters) {
    try {
      emit(chunk);
    } catch {
      // Closed streams must not break fan-out.
    }
  }
};

/** Test seam. */
export const __clearHostSseEmittersForTests = (): void => {
  hostSseEmitters.clear();
};

export const __hostSseEmitterCountForTests = (): number => hostSseEmitters.size;
