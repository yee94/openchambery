// Align with relay-server per-connection queue cap (2 MiB).
export const SSE_CLIENT_MAX_BUFFERED_BYTES = 2 * 1024 * 1024;

const isSseResponseClosed = (res) => Boolean(res?.writableEnded || res?.destroyed);

const getSseBufferedBytes = (res) => {
  if (typeof res?.writableLength === 'number' && Number.isFinite(res.writableLength)) {
    return res.writableLength;
  }
  const tracked = res?.__sseBufferedBytes;
  return typeof tracked === 'number' && Number.isFinite(tracked) ? tracked : 0;
};

const attachSseDrainListener = (res) => {
  if (res.__sseDrainAttached) {
    return;
  }
  res.__sseDrainAttached = true;
  res.once('drain', () => {
    res.__ssePaused = false;
    res.__sseBufferedBytes = 0;
    res.__sseDrainAttached = false;
    res.__ssePausedHeartbeatCycles = 0;
  });
};

// Intentional resource protection for slow/zombie SSE clients.
// SSE is best-effort; authoritative data is fetched over HTTP.
const destroySseClientForBackpressure = (res) => {
  try {
    if (!res.destroyed) {
      res.destroy();
    }
  } catch {
    // ignore — cleanup must stay idempotent
  }
};

export const createNotificationEmitterRuntime = (dependencies) => {
  const {
    process,
    getDesktopNotifyEnabled,
    desktopNotifyPrefix,
    getUiNotificationClients,
    getBroadcastGlobalUiEvent,
    // Optional: in-process desktop shells (Electron main) inject a callback so
    // notifications are delivered as a direct function call instead of a stdout
    // stringly-typed IPC.
    onDesktopNotification: initialOnDesktopNotification,
  } = dependencies;

  // Late-bindable: main() in server/index.js may call setOnDesktopNotification
  // after runtime construction so the in-process shell can subscribe without
  // restructuring the module-level wiring.
  let onDesktopNotification = typeof initialOnDesktopNotification === 'function'
    ? initialOnDesktopNotification
    : null;

  const setOnDesktopNotification = (cb) => {
    onDesktopNotification = typeof cb === 'function' ? cb : null;
  };

  const writeSseEvent = (res, payload) => {
    if (!res || isSseResponseClosed(res)) {
      throw new Error('SSE response closed');
    }

    // Drop while backpressured — SSE is best-effort; authoritative data is HTTP pull.
    if (res.__ssePaused) {
      return false;
    }

    const data = `data: ${JSON.stringify(payload)}\n\n`;
    const byteLength = Buffer.byteLength(data);

    let ok;
    try {
      ok = res.write(data);
    } catch (error) {
      destroySseClientForBackpressure(res);
      throw error;
    }

    const bufferedBytes = ok === false
      ? Math.max(getSseBufferedBytes(res), (res.__sseBufferedBytes || 0) + byteLength)
      : getSseBufferedBytes(res);
    res.__sseBufferedBytes = bufferedBytes;

    if (bufferedBytes > SSE_CLIENT_MAX_BUFFERED_BYTES) {
      // Intentional resource protection: a slow client must not unbounded-buffer
      // response body in host memory. SSE is best-effort; authoritative data is
      // fetched over HTTP.
      destroySseClientForBackpressure(res);
      throw new Error('SSE client buffer exceeded');
    }

    if (ok === false) {
      res.__ssePaused = true;
      attachSseDrainListener(res);
      return false;
    }

    return true;
  };

  const emitDesktopNotification = (payload) => {
    const desktopNotifyEnabled = getDesktopNotifyEnabled();
    if (!desktopNotifyEnabled) {
      return false;
    }

    if (!payload || typeof payload !== 'object') {
      return false;
    }

    if (onDesktopNotification) {
      try {
        onDesktopNotification(payload);
        return true;
      } catch {
        // ignore host-side throw
      }
      return false;
    }

    try {
      // stdout fallback for runtimes that parse the one-line `${prefix}{json}` protocol.
      process.stdout.write(`${desktopNotifyPrefix}${JSON.stringify(payload)}\n`);
      return true;
    } catch {
      // ignore
    }

    return false;
  };

  const broadcastUiNotification = (payload, options = {}) => {
    const desktopNotifyEnabled = getDesktopNotifyEnabled();
    if (!payload || typeof payload !== 'object') {
      return;
    }

    const desktopNotificationDelivered = options.desktopNotificationDelivered === true;

    const syntheticPayload = {
      type: 'openchamber:notification',
      properties: {
        ...payload,
        // Tell local desktop UI whether a native channel already accepted this
        // notification. If so, the SSE/WS event is informational only and must
        // not create a second OS notification.
        desktopNotificationDelivered,
        // Legacy marker retained for older clients that only know about stdout.
        desktopStdoutActive: desktopNotifyEnabled,
      },
    };

    const broadcastGlobalUiEvent = typeof getBroadcastGlobalUiEvent === 'function'
      ? getBroadcastGlobalUiEvent()
      : null;
    if (broadcastGlobalUiEvent) {
      broadcastGlobalUiEvent(syntheticPayload);
      return;
    }

    const clients = getUiNotificationClients();
    if (clients.size === 0) {
      return;
    }

    for (const res of clients) {
      try {
        writeSseEvent(res, syntheticPayload);
      } catch {
        // ignore
      }
    }
  };

  return {
    writeSseEvent,
    emitDesktopNotification,
    broadcastUiNotification,
    setOnDesktopNotification,
  };
};
