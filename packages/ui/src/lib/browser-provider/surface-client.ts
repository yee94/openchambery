/**
 * Viewer side of the host surface socket.
 *
 * Frames come in. Input and release go out. This client never runs a browser
 * action itself; the host decides who holds control and answers the agent.
 */

import { openRuntimeWebSocket } from '@/lib/relay/runtime-socket';
import type { RelayTunnelWebSocket } from '@/lib/relay/tunnel-client';
import { clearRuntimeUrlAuthToken, refreshRuntimeUrlAuthToken } from '@/lib/runtime-auth';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';

import {
  browserProviderSurfacePath,
  readSurfaceHostMessage,
  type SurfaceFrameMessage,
  type SurfaceHostMessage,
  type SurfaceInputEvent,
  type SurfaceViewerMessage,
} from './contract';

export type SurfaceFrame = Omit<SurfaceFrameMessage, 'bytes'> & { bytes: ArrayBuffer };
export type SurfaceControlState = { controller: 'none' | 'agent' | 'user'; mine: boolean };
export type SurfaceConnectionState =
  | { status: 'connecting' }
  | { status: 'open' }
  | { status: 'reconnecting'; attempt: number }
  | { status: 'ended'; reason: 'service-stopped' | 'extension-unavailable' | 'host-shutdown' };

export type SurfaceClientHandlers = {
  onFrame: (frame: SurfaceFrame) => void;
  onControl: (state: SurfaceControlState) => void;
  onConnection: (state: SurfaceConnectionState) => void;
  onEnded?: (reason: 'service-stopped' | 'extension-unavailable' | 'host-shutdown') => void;
};

type SurfaceClientDependencies = {
  refreshAuth: () => Promise<string>;
  clearUrlAuthToken: () => void;
  openSocket: (providerId: string) => RelayTunnelWebSocket;
};

const SOCKET_OPEN = 1;
const MAX_BACKOFF_MS = 8_000;

const defaultDependencies: SurfaceClientDependencies = {
  refreshAuth: () => refreshRuntimeUrlAuthToken(),
  clearUrlAuthToken: clearRuntimeUrlAuthToken,
  openSocket: (providerId) => openRuntimeWebSocket(
    getRuntimeUrlResolver().websocket(browserProviderSurfacePath(providerId)),
  ),
};

export class BrowserProviderSurfaceClient {
  private socket: RelayTunnelWebSocket | null = null;
  private pendingFrame: SurfaceFrameMessage | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;
  private generation = 0;
  private disposed = false;
  private ended = false;

  constructor(
    private readonly providerId: string,
    private readonly handlers: SurfaceClientHandlers,
    private readonly dependencies: SurfaceClientDependencies = defaultDependencies,
  ) {}

  start(): void {
    this.handlers.onConnection({ status: 'connecting' });
    void this.connect();
  }

  dispose(): void {
    this.disposed = true;
    this.generation += 1;
    this.cancelReconnect();
    const socket = this.socket;
    this.socket = null;
    socket?.close();
  }

  ack(seq: number): void {
    this.send({ type: 'ack', seq });
  }

  sendInput(events: SurfaceInputEvent[]): boolean {
    if (events.length === 0) return false;
    return this.send({ type: 'input', events });
  }

  /** Hand control back so the host can answer later browser actions. */
  release(): void {
    this.send({ type: 'release' });
  }

  resize(width: number, height: number): void {
    if (width < 1 || height < 1) return;
    this.send({ type: 'resize', width: Math.round(width), height: Math.round(height) });
  }

  retry(): void {
    if (this.disposed) return;
    this.ended = false;
    this.failures = 0;
    this.generation += 1;
    this.socket?.close();
    this.socket = null;
    this.handlers.onConnection({ status: 'connecting' });
    void this.connect();
  }

  private send(message: SurfaceViewerMessage): boolean {
    const socket = this.socket;
    if (!socket || socket.readyState !== SOCKET_OPEN) return false;
    try {
      socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  private async connect(): Promise<void> {
    if (this.disposed || this.ended) return;
    const generation = this.generation;
    try {
      await this.dependencies.refreshAuth();
    } catch {
      this.scheduleReconnect();
      return;
    }
    if (generation !== this.generation || this.disposed || this.ended) return;

    let socket: RelayTunnelWebSocket;
    try {
      socket = this.dependencies.openSocket(this.providerId);
    } catch {
      this.scheduleReconnect();
      return;
    }
    socket.binaryType = 'arraybuffer';
    this.socket = socket;
    let opened = false;

    socket.onopen = () => {
      if (this.socket !== socket) return;
      opened = true;
      this.failures = 0;
      this.pendingFrame = null;
      this.handlers.onConnection({ status: 'open' });
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      this.handleMessage(event.data);
    };
    socket.onerror = () => {
      this.dependencies.clearUrlAuthToken();
    };
    socket.onclose = () => {
      if (this.socket === socket) this.socket = null;
      if (this.disposed || this.ended) return;
      if (opened) this.failures = Math.max(this.failures, 1);
      this.scheduleReconnect();
    };
  }

  private handleMessage(data: unknown): void {
    if (data instanceof ArrayBuffer) {
      const pending = this.pendingFrame;
      this.pendingFrame = null;
      if (!pending || data.byteLength !== pending.bytes) return;
      this.handlers.onFrame({ ...pending, bytes: data });
      return;
    }
    if (typeof data !== 'string') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    const message = readSurfaceHostMessage(parsed);
    if (!message) return;
    this.applyHostMessage(message);
  }

  private applyHostMessage(message: SurfaceHostMessage): void {
    if (message.type === 'frame') {
      this.pendingFrame = message;
      return;
    }
    if (message.type === 'control') {
      this.handlers.onControl({ controller: message.controller, mine: message.mine });
      return;
    }
    if (message.type === 'ended') {
      this.ended = true;
      this.cancelReconnect();
      this.handlers.onConnection({ status: 'ended', reason: message.reason });
      this.handlers.onEnded?.(message.reason);
      this.socket?.close();
    }
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.ended || this.reconnectTimer) return;
    this.failures += 1;
    const attempt = this.failures;
    this.handlers.onConnection({ status: 'reconnecting', attempt });
    const delay = Math.min(MAX_BACKOFF_MS, 250 * (2 ** Math.min(attempt, 5)));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  private cancelReconnect(): void {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }
}
