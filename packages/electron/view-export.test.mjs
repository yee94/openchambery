import { EventEmitter } from 'node:events';
import { describe, expect, test, vi } from 'vitest';
import { createViewExportHost, isViewExportSender, VIEW_EXPORT_LIMITS } from './view-export.mjs';

const input = (extra = {}) => ({ taskId: 'task-1', filename: 'report', snapshot: { html: '<h1>Report</h1>', width: 800, height: 2400 }, ...extra });
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

function fixture(options = {}) {
  const owner = Object.assign(new EventEmitter(), { isDestroyed: () => false, getURL: () => 'yuri-ui://app/', mainFrame: { url: 'yuri-ui://app/' } });
  const event = { sender: owner, senderFrame: owner.mainFrame };
  const windows = [];
  class Window {
    static fromWebContents(contents) { return contents === owner ? { id: 1 } : null; }
    constructor(config) {
      this.config = config;
      this.destroyed = false;
      this.webContents = Object.assign(new EventEmitter(), {
        setWindowOpenHandler: vi.fn(),
        debugger: { attach: vi.fn(), sendCommand: vi.fn(async () => ({ result: { value: true } })) },
        printToPDF: options.print || vi.fn(async () => Buffer.from('%PDF-fixture')),
      });
      windows.push(this);
    }
    async loadURL() {}
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; }
  }
  const isolated = Object.assign(new EventEmitter(), { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(),
    protocol: { handle: vi.fn(), unhandle: vi.fn() }, webRequest: { onBeforeRequest: vi.fn() }, clearStorageData: vi.fn(async () => {}) });
  const dialog = { showSaveDialog: options.picker || vi.fn(async () => ({ filePath: '/exports/report.pdf' })) };
  const files = { writeFile: vi.fn(async () => {}), rename: vi.fn(async () => {}), rm: vi.fn(async () => {}), ...options.files };
  const events = [];
  const host = createViewExportHost({ BrowserWindow: Window, session: { fromPartition: () => isolated }, dialog, files,
    authorize: (received) => isViewExportSender(received, Window, []), send: (_owner, payload) => events.push(payload), ...options.host });
  return { host, owner, event, windows, files, events, isolated, dialog };
}

describe('container view export', () => {
  test('authorizes app main frames independently of runtime, rejects preview, remote and subframes', () => {
    const f = fixture();
    f.owner.__runtime = { relayHostId: 'remote', windowOnly: true };
    expect(isViewExportSender(f.event, { fromWebContents: () => ({}) }, [])).toBe(true);
    for (const url of ['yuri-ui://app/api/fs/raw', 'yuri-ui://app/preview.html', 'https://remote.invalid/', 'file:///index.html']) {
      f.owner.getURL = () => url;
      f.owner.mainFrame.url = url;
      expect(isViewExportSender(f.event, { fromWebContents: () => ({}) }, [])).toBe(false);
    }
    f.owner.getURL = () => 'http://127.0.0.1:4321/session/one';
    f.owner.mainFrame.url = f.owner.getURL();
    expect(isViewExportSender(f.event, { fromWebContents: () => ({}) }, ['http://127.0.0.1:4321'])).toBe(true);
    expect(isViewExportSender({ ...f.event, senderFrame: { url: f.owner.getURL() } }, { fromWebContents: () => ({}) }, ['http://127.0.0.1:4321'])).toBe(false);
  });

  test('advertises independent methods and validates the native input boundary', async () => {
    const f = fixture();
    expect((await f.host.dispatch(f.event, 'capabilities')).value).toEqual({ version: 1, exportPDF: true, exportLongImage: true, limits: VIEW_EXPORT_LIMITS });
    for (const invalid of [input({ format: 'pdf' }), input({ filename: '../file' }), input({ taskId: '' }), input({ pageSize: 'A3' }), input({ snapshot: { html: 'x', width: 0, height: 4 } })]) {
      expect((await f.host.dispatch(f.event, 'exportPDF', invalid)).error.code).toBe('EXPORT_INVALID_INPUT');
    }
    for (const snapshot of [{ html: 'x', width: 8193, height: 1 }, { html: 'x', width: 1, height: 32769 }, { html: 'x', width: 8192, height: 8192 }, { html: '中'.repeat(6 * 1024 * 1024), width: 1, height: 1 }]) {
      expect((await f.host.dispatch(f.event, 'exportPDF', input({ snapshot }))).error.code).toBe('EXPORT_TOO_LARGE');
    }
    expect(f.windows).toHaveLength(0);
    expect((await f.host.dispatch(f.event, 'save', input())).error.code).toBe('EXPORT_UNSUPPORTED');
  });

  test('waits for atomic save completion, emits correlated stages and cleans the isolated renderer', async () => {
    const commit = deferred();
    const f = fixture({ files: { rename: vi.fn(() => commit.promise) } });
    const result = f.host.dispatch(f.event, 'exportPDF', input({ pageSize: 'letter' }));
    await vi.waitFor(() => expect(f.files.rename).toHaveBeenCalled());
    let settled = false;
    void result.then(() => { settled = true; });
    expect(settled).toBe(false);
    await f.host.dispatch(f.event, 'cancel', { taskId: 'task-1' });
    commit.resolve();
    expect(await result).toEqual({ ok: true, value: { status: 'saved' } });
    expect(f.events).toEqual(['preparing', 'rendering', 'encoding', 'saving'].map((stage) => ({ taskId: 'task-1', stage })));
    expect(f.windows[0].config.webPreferences).toMatchObject({ javascript: false, sandbox: true, nodeIntegration: false });
    expect(f.windows[0].webContents.printToPDF).toHaveBeenCalledWith(expect.objectContaining({
      pageSize: 'Letter', margins: { top: 1 / 3, bottom: 1 / 3, left: 1 / 3, right: 1 / 3 },
    }));
    expect(f.windows[0].isDestroyed()).toBe(true);
    expect(f.owner.listenerCount('did-start-navigation')).toBe(0);
  });

  test('one owner cannot overlap tasks; wrong task cancellation cannot stop its export', async () => {
    const print = deferred();
    const f = fixture({ print: () => print.promise });
    const result = f.host.dispatch(f.event, 'exportPDF', input());
    expect((await f.host.dispatch(f.event, 'exportPDF', input({ taskId: 'other' }))).error.code).toBe('EXPORT_BUSY');
    await f.host.dispatch(f.event, 'cancel', { taskId: 'other' });
    expect(f.windows[0].isDestroyed()).toBe(false);
    await f.host.dispatch(f.event, 'cancel', { taskId: 'task-1' });
    expect(await result).toEqual({ ok: true, value: { status: 'cancelled' } });
    expect(f.files.writeFile).not.toHaveBeenCalled();
    expect(f.windows[0].isDestroyed()).toBe(true);
  });

  test.each(['navigate', 'destroy', 'runtime', 'dispose'])('%s cancels owner work and suppresses writes', async (kind) => {
    const print = deferred();
    const f = fixture({ print: () => print.promise });
    const result = f.host.dispatch(f.event, 'exportPDF', input());
    if (kind === 'navigate') f.owner.emit('did-start-navigation', {}, 'yuri-ui://app/new', false, true);
    if (kind === 'destroy') f.owner.emit('destroyed');
    if (kind === 'runtime') f.host.invalidateOwner(f.owner);
    if (kind === 'dispose') f.host.dispose();
    expect((await result).value.status).toBe('cancelled');
    expect(f.files.writeFile).not.toHaveBeenCalled();
  });

  test('cancelled pending chooser cannot save later or open a second chooser', async () => {
    const picker = deferred();
    const f = fixture({ picker: vi.fn(() => picker.promise) });
    const result = f.host.dispatch(f.event, 'exportPDF', input());
    await vi.waitFor(() => expect(f.dialog.showSaveDialog).toHaveBeenCalled());
    await f.host.dispatch(f.event, 'cancel', { taskId: 'task-1' });
    expect((await result).value.status).toBe('cancelled');
    expect((await f.host.dispatch(f.event, 'exportPDF', input())).error.code).toBe('EXPORT_BUSY');
    picker.resolve({ filePath: '/exports/late.pdf' });
    await Promise.resolve();
    expect(f.files.writeFile).not.toHaveBeenCalled();
  });

  test('save failure preserves destination, removes staging and hides native path errors', async () => {
    const f = fixture({ files: { writeFile: vi.fn(async () => { throw new Error('secret destination'); }) } });
    expect(await f.host.dispatch(f.event, 'exportPDF', input())).toEqual({ ok: false, error: { code: 'EXPORT_SAVE_FAILED', message: 'Unable to save export' } });
    expect(f.files.rename).not.toHaveBeenCalled();
    expect(f.files.rm).toHaveBeenCalledWith(expect.stringContaining('.yuri-export-'), { force: true });
  });

  test('shutdown waits for an interrupted write and removes its partial staging file without committing', async () => {
    const write = deferred();
    const f = fixture({ files: { writeFile: vi.fn(() => write.promise) } });
    const result = f.host.dispatch(f.event, 'exportPDF', input());
    await vi.waitFor(() => expect(f.files.writeFile).toHaveBeenCalled());
    let shutdownFinished = false;
    const shutdown = f.host.dispose().then(() => { shutdownFinished = true; });
    await Promise.resolve();
    expect(shutdownFinished).toBe(false);
    expect(f.files.writeFile.mock.calls[0][2].signal.aborted).toBe(true);
    write.resolve();
    expect((await result).value.status).toBe('cancelled');
    await shutdown;
    expect(f.files.rename).not.toHaveBeenCalled();
    expect(f.files.rm).toHaveBeenCalled();
  });

  test('a stalled renderer times out with a render error and releases its window', async () => {
    const f = fixture({ print: () => new Promise(() => {}), host: { timeoutMs: 10 } });
    expect((await f.host.dispatch(f.event, 'exportPDF', input())).error.code).toBe('EXPORT_RENDER_FAILED');
    expect(f.windows[0].isDestroyed()).toBe(true);
    expect(f.dialog.showSaveDialog).not.toHaveBeenCalled();
  });
});
