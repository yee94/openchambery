import http from 'node:http';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import {
  attachHttpServerConnectionTracker,
  forceCloseHttpServerConnections,
} from './http-server-connections.js';
import { createGracefulShutdownRuntime } from './shutdown-runtime.js';

const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close((error) => (error ? reject(error) : resolve(port)));
  });
});

const listen = (server, port) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, '127.0.0.1', () => resolve());
});

const closeQuiet = (server) => new Promise((resolve) => {
  try {
    server.closeAllConnections?.();
  } catch {
  }
  server.close(() => resolve());
  setTimeout(resolve, 2000);
});

describe('http server connection force-close', () => {
  /** @type {import('node:http').Server[]} */
  const servers = [];
  /** @type {import('node:net').Socket[]} */
  const sockets = [];

  afterEach(async () => {
    for (const socket of sockets.splice(0)) {
      try {
        socket.destroy();
      } catch {
      }
    }
    await Promise.all(servers.splice(0).map((server) => closeQuiet(server)));
  });

  it('red: hanging upgrade socket blocks server.close until force-destroy of tracked sockets', async () => {
    const port = await freePort();
    const server = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end('ok');
    });
    servers.push(server);
    // Intentionally leave upgrade hanging (no socket handoff) — Node keeps the
    // TCP connection open and server.close() will not fire.
    server.on('upgrade', () => {});
    const tracker = attachHttpServerConnectionTracker(server);
    await listen(server, port);

    const client = net.connect({ host: '127.0.0.1', port });
    sockets.push(client);
    await new Promise((resolve, reject) => {
      client.once('connect', resolve);
      client.once('error', reject);
    });
    client.write(
      'GET /ws HTTP/1.1\r\n'
      + 'Host: 127.0.0.1\r\n'
      + 'Connection: Upgrade\r\n'
      + 'Upgrade: websocket\r\n'
      + 'Sec-WebSocket-Version: 13\r\n'
      + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n'
      + '\r\n',
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(tracker.getOpenSocketCount()).toBeGreaterThanOrEqual(1);

    let closedFast = false;
    const closeStarted = Date.now();
    const closePromise = new Promise((resolve) => {
      server.close(() => {
        closedFast = true;
        resolve('closed');
      });
      // Baseline: closeAllConnections alone does not finish upgraded leftovers.
      server.closeAllConnections?.();
    });
    const early = await Promise.race([
      closePromise,
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 250)),
    ]);
    expect(early).toBe('timeout');
    expect(closedFast).toBe(false);

    const { destroyedTracked } = forceCloseHttpServerConnections(server);
    expect(destroyedTracked).toBeGreaterThanOrEqual(1);
    await expect(closePromise).resolves.toBe('closed');
    expect(Date.now() - closeStarted).toBeLessThan(2000);
    expect(tracker.getOpenSocketCount()).toBe(0);
  });

  it('forceCloseConnections destroys hanging upgrade and reaches HTTP closed without timeout race', async () => {
    const port = await freePort();
    const server = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end('ok');
    });
    servers.push(server);
    server.on('upgrade', () => {});
    attachHttpServerConnectionTracker(server);
    await listen(server, port);

    const client = net.connect({ host: '127.0.0.1', port });
    sockets.push(client);
    await new Promise((resolve, reject) => {
      client.once('connect', resolve);
      client.once('error', reject);
    });
    client.write(
      'GET /ws HTTP/1.1\r\n'
      + 'Host: 127.0.0.1\r\n'
      + 'Connection: Upgrade\r\n'
      + 'Upgrade: websocket\r\n'
      + 'Sec-WebSocket-Version: 13\r\n'
      + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n'
      + '\r\n',
    );
    await new Promise((r) => setTimeout(r, 50));

    const warn = [];
    const originalWarn = console.warn;
    console.warn = (...args) => {
      warn.push(args.map(String).join(' '));
    };

    const runtime = createGracefulShutdownRuntime({
      process: { exit: () => {} },
      shutdownTimeoutMs: 10_000,
      getExitOnShutdown: () => false,
      getIsShuttingDown: () => false,
      setIsShuttingDown: () => {},
      syncToHmrState: () => {},
      openCodeWatcherRuntime: { stop: () => {} },
      sessionRuntime: { dispose: () => {} },
      scheduledTasksRuntime: { stop: () => {} },
      getHealthCheckInterval: () => null,
      clearHealthCheckInterval: () => {},
      getTerminalRuntime: () => null,
      setTerminalRuntime: () => {},
      getMessageStreamRuntime: () => null,
      setMessageStreamRuntime: () => {},
      shouldSkipOpenCodeStop: () => true,
      getOpenCodePort: () => null,
      getOpenCodeProcess: () => null,
      setOpenCodeProcess: () => {},
      waitForPortRelease: async () => true,
      getServer: () => server,
      getUiAuthController: () => null,
      setUiAuthController: () => {},
      tunnelAuthController: { clearActiveTunnel: () => {} },
    });

    const started = Date.now();
    await runtime.gracefulShutdown({ exitProcess: false, forceCloseConnections: true });
    console.warn = originalWarn;

    expect(Date.now() - started).toBeLessThan(3000);
    expect(warn.some((line) => /Server close timeout reached/i.test(line))).toBe(false);
  });

  it('non-force path does not destroy hanging upgrade sockets', async () => {
    const port = await freePort();
    const server = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end('ok');
    });
    servers.push(server);
    server.on('upgrade', () => {});
    const tracker = attachHttpServerConnectionTracker(server);
    await listen(server, port);

    const client = net.connect({ host: '127.0.0.1', port });
    sockets.push(client);
    await new Promise((resolve, reject) => {
      client.once('connect', resolve);
      client.once('error', reject);
    });
    client.write(
      'GET /ws HTTP/1.1\r\n'
      + 'Host: 127.0.0.1\r\n'
      + 'Connection: Upgrade\r\n'
      + 'Upgrade: websocket\r\n'
      + 'Sec-WebSocket-Version: 13\r\n'
      + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n'
      + '\r\n',
    );
    await new Promise((r) => setTimeout(r, 50));
    const before = tracker.getOpenSocketCount();
    expect(before).toBeGreaterThanOrEqual(1);

    const runtime = createGracefulShutdownRuntime({
      process: { exit: () => {} },
      shutdownTimeoutMs: 300,
      getExitOnShutdown: () => false,
      getIsShuttingDown: () => false,
      setIsShuttingDown: () => {},
      syncToHmrState: () => {},
      openCodeWatcherRuntime: { stop: () => {} },
      sessionRuntime: { dispose: () => {} },
      scheduledTasksRuntime: { stop: () => {} },
      getHealthCheckInterval: () => null,
      clearHealthCheckInterval: () => {},
      getTerminalRuntime: () => null,
      setTerminalRuntime: () => {},
      getMessageStreamRuntime: () => null,
      setMessageStreamRuntime: () => {},
      shouldSkipOpenCodeStop: () => true,
      getOpenCodePort: () => null,
      getOpenCodeProcess: () => null,
      setOpenCodeProcess: () => {},
      waitForPortRelease: async () => true,
      getServer: () => server,
      getUiAuthController: () => null,
      setUiAuthController: () => {},
      tunnelAuthController: { clearActiveTunnel: () => {} },
    });

    await runtime.gracefulShutdown({ exitProcess: false, forceCloseConnections: false });
    // Non-force timed out without destroying tracked upgrade sockets.
    expect(tracker.getOpenSocketCount()).toBeGreaterThanOrEqual(1);
  });

  it('does not touch sockets belonging to a separate external HTTP server', async () => {
    const externalPort = await freePort();
    const external = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end('external');
    });
    servers.push(external);
    await listen(external, externalPort);

    const managedPort = await freePort();
    const managed = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end('managed');
    });
    servers.push(managed);
    managed.on('upgrade', () => {});
    attachHttpServerConnectionTracker(managed);
    await listen(managed, managedPort);

    const externalClient = net.connect({ host: '127.0.0.1', port: externalPort });
    sockets.push(externalClient);
    await new Promise((resolve, reject) => {
      externalClient.once('connect', resolve);
      externalClient.once('error', reject);
    });
    externalClient.write('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n');
    await new Promise((r) => setTimeout(r, 30));

    const managedClient = net.connect({ host: '127.0.0.1', port: managedPort });
    sockets.push(managedClient);
    await new Promise((resolve, reject) => {
      managedClient.once('connect', resolve);
      managedClient.once('error', reject);
    });
    managedClient.write(
      'GET /ws HTTP/1.1\r\n'
      + 'Host: 127.0.0.1\r\n'
      + 'Connection: Upgrade\r\n'
      + 'Upgrade: websocket\r\n'
      + 'Sec-WebSocket-Version: 13\r\n'
      + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n'
      + '\r\n',
    );
    await new Promise((r) => setTimeout(r, 30));

    const runtime = createGracefulShutdownRuntime({
      process: { exit: () => {} },
      shutdownTimeoutMs: 5000,
      getExitOnShutdown: () => false,
      getIsShuttingDown: () => false,
      setIsShuttingDown: () => {},
      syncToHmrState: () => {},
      openCodeWatcherRuntime: { stop: () => {} },
      sessionRuntime: { dispose: () => {} },
      scheduledTasksRuntime: { stop: () => {} },
      getHealthCheckInterval: () => null,
      clearHealthCheckInterval: () => {},
      getTerminalRuntime: () => null,
      setTerminalRuntime: () => {},
      getMessageStreamRuntime: () => null,
      setMessageStreamRuntime: () => {},
      shouldSkipOpenCodeStop: () => true,
      getOpenCodePort: () => null,
      getOpenCodeProcess: () => null,
      setOpenCodeProcess: () => {},
      waitForPortRelease: async () => true,
      getServer: () => managed,
      getUiAuthController: () => null,
      setUiAuthController: () => {},
      tunnelAuthController: { clearActiveTunnel: () => {} },
    });

    await runtime.gracefulShutdown({ exitProcess: false, forceCloseConnections: true });

    // External keep-alive client must still be connected to the other server.
    expect(externalClient.destroyed).toBe(false);
    const externalProbe = await new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port: externalPort, path: '/' }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on('error', () => resolve(null));
    });
    expect(externalProbe).toBe(200);
  });
});
