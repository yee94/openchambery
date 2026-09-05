import http from 'node:http';

import { normalizePushRelayOptions, formatPushRelayUrl } from './config.js';
import { createPushRelayHandler } from './handler.js';

const STOP_DEADLINE_MS = 5_500;

export const createPushRelayServer = (options = {}) => {
  const config = normalizePushRelayOptions(options);
  const clock = { now: Date.now, setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, ...config.clock };
  const handler = createPushRelayHandler({ ...options, claimHealthEndpoints: true });
  let server = null; let startPromise = null; let stopPromise = null; let abortStart = null; let state = 'idle'; let generation = 0;

  const start = () => {
    if (state === 'running') return Promise.resolve();
    if (state === 'stopping') return stopPromise.then(() => start());
    if (startPromise) return startPromise;
    state = 'starting';
    const localGeneration = ++generation;
    const localServer = http.createServer((request, response) => {
      handler.handleRequest(request, response);
    });
    server = localServer;
    startPromise = new Promise((resolve, rejectStart) => {
      const failStart = (error) => {
        if (localGeneration !== generation) return;
        localServer.off('listening', ready);
        cleanupStart();
        rejectStart(error);
      };
      const ready = () => {
        localServer.off('error', failStart);
        if (localGeneration !== generation || state !== 'starting') return;
        handler.activate();
        state = 'running';
        resolve();
      };
      const cleanupStart = () => {
        localServer.close();
        if (server === localServer) server = null;
        state = 'stopped';
      };
      abortStart = () => {
        if (state === 'starting') { cleanupStart(); rejectStart(new Error('push relay stopped during start')); }
      };
      localServer.once('error', failStart);
      localServer.once('listening', ready);
      localServer.listen(config.port, config.host);
    }).finally(() => { startPromise = null; abortStart = null; });
    return startPromise;
  };

  const stop = () => {
    if (stopPromise) return stopPromise;
    if (state === 'idle' || state === 'stopped') { state = 'stopped'; return Promise.resolve(); }
    if (state === 'starting') abortStart?.();
    state = 'stopping';
    generation += 1;
    const localServer = server;
    stopPromise = Promise.resolve().then(async () => {
      let deadlineTimer = null;
      try {
        const closed = new Promise((resolve) => {
          if (!localServer) { resolve(); return; }
          localServer.close(() => resolve());
          try { localServer.closeIdleConnections?.(); } catch { /* ignore */ }
        });
        const deactivated = handler.deactivate();
        const graceful = Promise.all([closed, deactivated]);
        const deadline = new Promise((resolve) => {
          deadlineTimer = clock.setTimeout(() => resolve('deadline'), STOP_DEADLINE_MS);
        });
        const winner = await Promise.race([graceful.then(() => 'graceful'), deadline]);
        if (winner === 'deadline') {
          try { localServer?.closeAllConnections?.(); } catch { /* ignore */ }
          await deactivated;
        }
      } finally {
        if (deadlineTimer !== null) try { clock.clearTimeout(deadlineTimer); } catch { /* ignore */ }
      }
      if (server === localServer) { server = null; state = 'stopped'; }
      stopPromise = null;
    });
    return stopPromise;
  };

  return {
    start,
    stop,
    address: () => server?.address(),
    get url() {
      const address = server?.address();
      return address && typeof address === 'object' ? formatPushRelayUrl(config.host, address.port) : null;
    },
    getSnapshot: () => ({ ...handler.getSnapshot(), state }),
  };
};

export const startPushRelayServer = async (options) => {
  const server = createPushRelayServer(options);
  await server.start();
  return server;
};
