import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { expect, test, vi } from 'vitest';

const source = readFileSync(new URL('./main.mjs', import.meta.url), 'utf8');

const setup = () => {
  let nextId = 0;
  const makeWindow = (apiBaseUrl) => ({
    id: ++nextId,
    __ocRuntimeConfig: { apiBaseUrl },
    isDestroyed: vi.fn(() => false), isFocused: () => false,
    isVisible: () => true, isMinimized: () => false,
    show: vi.fn(), focus: vi.fn(), webContents: { send: vi.fn() },
  });
  const main = makeWindow('https://host-a.example');
  const owner = makeWindow('http://127.0.0.1:3901');
  const notifications = [];
  class Notification {
    static isSupported() { return true; }
    constructor() { this.handlers = {}; notifications.push(this); }
    on(event, handler) { this.handlers[event] = handler; }
    show() {}
  }
  const context = vm.createContext({
    Notification, BrowserWindow: { getAllWindows: () => [main, owner] },
    state: { mainWindow: main, sidecarUrl: 'http://127.0.0.1:3901' },
    process: { platform: 'linux' },
    sameOrigin: (a, b) => Boolean(a && b && new URL(a).origin === new URL(b).origin),
    emitToWindow: (window, event, detail) => window?.webContents.send(event, detail),
    emitToAllWindows: (event, detail) => main.webContents.send(event, detail),
  });
  vm.runInContext(source.slice(source.indexOf('const normalizeNotificationInput ='), source.indexOf('const mapUpdaterProgressEvent =')) + '\nglobalThis.notify = maybeShowNativeNotification;', context);
  const ipcBody = source.slice(source.indexOf("    case 'desktop_notify':"), source.indexOf("    case 'desktop_tray_update':"));
  vm.runInContext(`globalThis.invokeNotify = (browserWindow, args) => { switch ('desktop_notify') { ${ipcBody} } };`, context);
  return { main, owner, notifications, notify: context.notify, invokeNotify: context.invokeNotify };
};

test('notification click focuses and navigates only its originating window', () => {
  const { main, owner, notifications, invokeNotify } = setup();
  invokeNotify(owner, { payload: { sessionId: 'session-b', title: 'Done' } });
  notifications[0].handlers.click();
  expect(owner.focus).toHaveBeenCalledOnce();
  expect(owner.webContents.send).toHaveBeenCalledWith('openchamber:open-session', { sessionId: 'session-b', directory: null });
  expect(main.focus).not.toHaveBeenCalled();
  expect(main.webContents.send).not.toHaveBeenCalled();
});

test('backend notifications target the local runtime rather than the remote main window', () => {
  const { main, owner, notifications, notify } = setup();
  notify({ assistantID: 'assistant-local', title: 'Done' });
  notifications[0].handlers.click();
  expect(owner.webContents.send).toHaveBeenCalledWith('openchamber:open-assistant', { assistantID: 'assistant-local' });
  expect(main.webContents.send).not.toHaveBeenCalled();
});

test('closing the owner does not redirect a notification to another instance', () => {
  const { main, owner, notifications, notify } = setup();
  notify({ sessionId: 'session-b' }, owner);
  owner.isDestroyed.mockReturnValue(true);
  notifications[0].handlers.click();
  expect(main.webContents.send).not.toHaveBeenCalled();
});

test('switching the owner runtime does not open an old session on the new instance', () => {
  const { main, owner, notifications, notify } = setup();
  notify({ sessionId: 'session-b' }, owner);
  owner.__ocRuntimeConfig = { apiBaseUrl: 'https://host-c.example' };
  notifications[0].handlers.click();
  expect(owner.webContents.send).not.toHaveBeenCalled();
  expect(main.webContents.send).not.toHaveBeenCalled();
});

test('identical tags from different windows do not suppress each other', () => {
  const { main, owner, notifications, notify } = setup();
  notify({ tag: 'done', sessionId: 'same-id' }, main);
  notify({ tag: 'done', sessionId: 'same-id' }, owner);
  notify({ tag: 'done', sessionId: 'same-id' }, owner);
  expect(notifications).toHaveLength(2);
  notifications[1].handlers.click();
  expect(owner.focus).toHaveBeenCalledOnce();
  expect(main.focus).not.toHaveBeenCalled();
});

test('a relay window using local UI is not mistaken for the local backend', () => {
  const { main, owner, notifications, notify } = setup();
  main.__ocRuntimeConfig = { ...owner.__ocRuntimeConfig, relayHostId: 'remote-relay' };
  notify({ sessionId: 'local-session' });
  notifications[0].handlers.click();
  expect(owner.focus).toHaveBeenCalledOnce();
  expect(main.focus).not.toHaveBeenCalled();
});
