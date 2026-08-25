import { describe, expect, it, vi } from 'vitest';

import {
  createNotificationEmitterRuntime,
  SSE_CLIENT_MAX_BUFFERED_BYTES,
} from './emitter-runtime.js';

const createRuntime = (overrides = {}) => createNotificationEmitterRuntime({
  process: { stdout: { write: vi.fn() } },
  getDesktopNotifyEnabled: () => true,
  desktopNotifyPrefix: '[desktop-notify]',
  getUiNotificationClients: () => new Set(),
  getBroadcastGlobalUiEvent: () => null,
  ...overrides,
});

const createMockSseResponse = ({ writeImpl } = {}) => {
  const listeners = new Map();
  let destroyed = false;
  let writableEnded = false;
  let bufferedBytes = 0;

  const res = {
    get destroyed() {
      return destroyed;
    },
    get writableEnded() {
      return writableEnded;
    },
    get writableLength() {
      return bufferedBytes;
    },
    on(event, handler) {
      listeners.set(event, handler);
      return this;
    },
    once(event, handler) {
      listeners.set(event, handler);
      return this;
    },
    emit(event) {
      const handler = listeners.get(event);
      listeners.delete(event);
      if (typeof handler === 'function') {
        handler();
      }
    },
    write(chunk) {
      if (typeof writeImpl === 'function') {
        return writeImpl(chunk, {
          addBuffered(bytes) {
            bufferedBytes += bytes;
          },
          getBuffered() {
            return bufferedBytes;
          },
        });
      }
      return true;
    },
    destroy() {
      destroyed = true;
      this.emit('error');
    },
  };

  return res;
};

describe('notification emitter runtime', () => {
  it('reports desktop delivery through the injected native callback', () => {
    const onDesktopNotification = vi.fn();
    const runtime = createRuntime({ onDesktopNotification });
    const payload = { title: 'Ready', body: 'Done' };

    expect(runtime.emitDesktopNotification(payload)).toBe(true);
    expect(onDesktopNotification).toHaveBeenCalledWith(payload);
  });

  it('reports stdout desktop delivery for legacy shells', () => {
    const write = vi.fn();
    const runtime = createRuntime({ process: { stdout: { write } } });

    expect(runtime.emitDesktopNotification({ title: 'Ready' })).toBe(true);
    expect(write).toHaveBeenCalledWith('[desktop-notify]{"title":"Ready"}\n');
  });

  it('marks UI broadcasts that were already delivered natively', () => {
    const broadcastGlobalUiEvent = vi.fn();
    const runtime = createRuntime({ getBroadcastGlobalUiEvent: () => broadcastGlobalUiEvent });

    runtime.broadcastUiNotification({ title: 'Ready' }, { desktopNotificationDelivered: true });

    expect(broadcastGlobalUiEvent).toHaveBeenCalledWith({
      type: 'openchamber:notification',
      properties: {
        title: 'Ready',
        desktopNotificationDelivered: true,
        desktopStdoutActive: true,
      },
    });
  });

  it('pauses slow SSE clients when write returns false and skips further buffering until drain', () => {
    const runtime = createRuntime();
    let writeCount = 0;
    const res = createMockSseResponse({
      writeImpl(chunk, { addBuffered }) {
        writeCount += 1;
        addBuffered(Buffer.byteLength(String(chunk)));
        return false;
      },
    });

    expect(runtime.writeSseEvent(res, { type: 'a' })).toBe(false);
    expect(res.__ssePaused).toBe(true);
    expect(writeCount).toBe(1);

    expect(runtime.writeSseEvent(res, { type: 'b' })).toBe(false);
    expect(writeCount).toBe(1);

    res.emit('drain');
    expect(res.__ssePaused).toBe(false);
    expect(runtime.writeSseEvent(res, { type: 'c' })).toBe(false);
    expect(writeCount).toBe(2);
  });

  it('destroys an SSE client whose buffered bytes exceed the per-client cap', () => {
    const runtime = createRuntime();
    const res = createMockSseResponse({
      writeImpl(chunk, { addBuffered }) {
        addBuffered(SSE_CLIENT_MAX_BUFFERED_BYTES + Buffer.byteLength(String(chunk)));
        return false;
      },
    });

    expect(() => runtime.writeSseEvent(res, { type: 'overflow' })).toThrow(/buffer exceeded/);
    expect(res.destroyed).toBe(true);
  });
});
