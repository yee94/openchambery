import { describe, expect, it, vi } from 'vitest';

import type { RelayTunnelWebSocket } from '@/lib/relay/tunnel-client';
import { BrowserProviderSurfaceClient } from './surface-client';

class FakeSocket implements RelayTunnelWebSocket {
  readyState = 0;
  binaryType: 'blob' | 'arraybuffer' = 'arraybuffer';
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    this.sent.push(typeof data === 'string' ? data : '');
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.({ code: 1000, reason: '' });
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  receive(data: string | ArrayBuffer): void {
    this.onmessage?.({ data });
  }
}

describe('browser provider surface client', () => {
  it('sends takeover input and hands control back without running a browser action', async () => {
    const socket = new FakeSocket();
    const frames: unknown[] = [];
    const controls: unknown[] = [];
    const client = new BrowserProviderSurfaceClient('ext.chrome', {
      onFrame: (frame) => frames.push(frame),
      onControl: (state) => controls.push(state),
      onConnection: () => undefined,
    }, {
      refreshAuth: async () => 'token',
      clearUrlAuthToken: () => undefined,
      openSocket: () => socket,
    });

    client.start();
    await Promise.resolve();
    socket.open();
    socket.receive(JSON.stringify({
      type: 'frame',
      seq: 1,
      width: 2,
      height: 2,
      mime: 'image/png',
      bytes: 4,
      agentActive: true,
    }));
    socket.receive(new Uint8Array([1, 2, 3, 4]).buffer);
    socket.receive(JSON.stringify({ type: 'control', controller: 'user', mine: true }));

    expect(frames).toEqual([expect.objectContaining({ seq: 1, agentActive: true })]);
    expect(controls).toEqual([{ controller: 'user', mine: true }]);
    expect(client.sendInput([{
      type: 'pointer',
      action: 'down',
      x: 1,
      y: 2,
      button: 0,
      buttons: 1,
      modifiers: { alt: false, ctrl: false, meta: false, shift: false },
    }])).toBe(true);
    client.release();
    expect(socket.sent.map((entry) => JSON.parse(entry))).toEqual([
      expect.objectContaining({ type: 'input' }),
      { type: 'release' },
    ]);
    client.dispose();
  });

  it('does not reconnect after the host ends the surface', async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const states: string[] = [];
    const client = new BrowserProviderSurfaceClient('ext.chrome', {
      onFrame: () => undefined,
      onControl: () => undefined,
      onConnection: (state) => states.push(state.status),
    }, {
      refreshAuth: async () => 'token',
      clearUrlAuthToken: () => undefined,
      openSocket: () => socket,
    });
    client.start();
    await Promise.resolve();
    socket.open();
    socket.receive(JSON.stringify({ type: 'ended', reason: 'extension-unavailable' }));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(states).toEqual(['connecting', 'open', 'ended']);
    client.dispose();
    vi.useRealTimers();
  });
});
