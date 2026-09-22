/**
 * Track sockets owned by an HTTP server so force-close can destroy upgraded
 * WebSocket/SSE sockets that Node's `server.closeAllConnections()` leaves open
 * (those keep `server.close()` from firing until SHUTDOWN_TIMEOUT).
 */

export const HTTP_SERVER_CONNECTIONS = Symbol.for('openchamber.httpServerConnections');

/**
 * @param {import('node:http').Server} server
 * @returns {{
 *   getOpenSocketCount: () => number,
 *   destroyRemainingSockets: () => number,
 *   dispose: () => void,
 * }}
 */
export const attachHttpServerConnectionTracker = (server) => {
  if (!server || typeof server.on !== 'function') {
    return {
      getOpenSocketCount: () => 0,
      destroyRemainingSockets: () => 0,
      dispose: () => {},
    };
  }

  const existing = server[HTTP_SERVER_CONNECTIONS];
  if (existing && typeof existing.destroyRemainingSockets === 'function') {
    return existing;
  }

  /** @type {Set<import('node:net').Socket>} */
  const sockets = new Set();

  const track = (socket) => {
    if (!socket || sockets.has(socket)) return;
    sockets.add(socket);
    const release = () => {
      sockets.delete(socket);
    };
    socket.once('close', release);
    socket.once('error', release);
  };

  // Plain HTTP and pre-upgrade TCP both emit `connection`. After `upgrade`, the
  // same socket object remains; tracking it here covers WS/SSE leftovers.
  const onConnection = (socket) => {
    track(socket);
  };
  server.on('connection', onConnection);

  const api = {
    getOpenSocketCount: () => sockets.size,
    destroyRemainingSockets: () => {
      let destroyed = 0;
      for (const socket of [...sockets]) {
        try {
          if (!socket.destroyed) {
            socket.destroy();
            destroyed += 1;
          }
        } catch {
        }
        sockets.delete(socket);
      }
      return destroyed;
    },
    dispose: () => {
      server.off?.('connection', onConnection);
      sockets.clear();
      try {
        delete server[HTTP_SERVER_CONNECTIONS];
      } catch {
      }
    },
  };

  server[HTTP_SERVER_CONNECTIONS] = api;
  return api;
};

/**
 * Stop accepting new connections, drop Node-tracked HTTP connections, then
 * destroy any remaining server-owned sockets (including upgraded ones).
 * @param {import('node:http').Server | null | undefined} server
 * @returns {{ destroyedTracked: number }}
 */
export const forceCloseHttpServerConnections = (server) => {
  if (!server) return { destroyedTracked: 0 };
  try {
    server.closeAllConnections?.();
  } catch {
  }
  const tracker = server[HTTP_SERVER_CONNECTIONS];
  const destroyedTracked = typeof tracker?.destroyRemainingSockets === 'function'
    ? tracker.destroyRemainingSockets()
    : 0;
  return { destroyedTracked };
};
