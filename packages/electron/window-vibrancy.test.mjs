import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { afterEach, expect, test, vi } from 'vitest';

const source = readFileSync(new URL('./main.mjs', import.meta.url), 'utf8');
afterEach(() => vi.useRealTimers());

const setup = () => {
  vi.useFakeTimers();
  const windows = [];
  const nativeTheme = { themeSource: 'system' };
  const context = vm.createContext({
    BrowserWindow: { getAllWindows: () => windows },
    process: { platform: 'darwin' }, setTimeout, nativeTheme,
    log: { warn: vi.fn() },
    emitToWindow: (window, event, detail) => window.webContents.send(event, detail),
  });
  vm.runInContext(source.slice(source.indexOf('const hasMultipleAppWindows ='), source.indexOf('const setTaskbarProgress ='))
    + '\nglobalThis.track = trackMacWindowVibrancy; globalThis.present = presentBrowserWindow;', context);
  const create = (enabled = true, labeled = true) => {
    const window = Object.assign(new EventEmitter(), {
      __ocLabel: labeled ? `window-${windows.length}` : undefined,
      isDestroyed: vi.fn(() => false), isVisible: vi.fn(() => true),
      isMinimized: vi.fn(() => false), setVibrancy: vi.fn(),
      show: vi.fn(), focus: vi.fn(),
      webContents: Object.assign(new EventEmitter(), { send: vi.fn() }),
    });
    windows.push(window);
    if (labeled) context.track(window, enabled);
    return window;
  };
  const close = (window) => {
    window.isDestroyed.mockReturnValue(true);
    window.emit('closed');
  };
  const lastState = (window) => window.webContents.send.mock.lastCall?.[1];
  return { create, close, lastState, nativeTheme, present: context.present };
};

test('opening a second app window disables both, including pending ready callbacks and reloads', () => {
  const { create, lastState, present } = setup();
  const first = create();
  const second = create();
  present(second, { useVibrancy: true });
  vi.runAllTimers();
  for (const window of [first, second]) {
    expect(window.setVibrancy.mock.lastCall).toEqual([null]);
    expect(lastState(window)).toEqual({ ready: false, suppressed: true });
  }
  second.webContents.emit('dom-ready');
  vi.runAllTimers();
  expect(lastState(second)).toEqual({ ready: false, suppressed: true });
});

test('closing back to one restores enabled vibrancy, but only after minimized window restores', () => {
  const { create, close, lastState, nativeTheme } = setup();
  const first = create();
  first.__ocThemeSource = 'light';
  const second = create();
  nativeTheme.themeSource = 'dark';
  first.isMinimized.mockReturnValue(true);
  close(second);
  expect(nativeTheme.themeSource).toBe('light');
  vi.runAllTimers();
  expect(lastState(first)).toEqual({ ready: false, suppressed: false });
  first.isMinimized.mockReturnValue(false);
  first.emit('restore');
  vi.runAllTimers();
  expect(first.setVibrancy.mock.lastCall).toEqual(['sidebar']);
  expect(lastState(first)).toEqual({ ready: true, suppressed: false });
});

test('disabled preference stays disabled and DevTools does not count as an app window', () => {
  const { create, close, lastState } = setup();
  create(true, false);
  const first = create(false);
  expect(first.setVibrancy).not.toHaveBeenCalled();
  const second = create();
  close(second);
  vi.runAllTimers();
  expect(first.setVibrancy).not.toHaveBeenCalledWith('sidebar');
  expect(lastState(first)).toEqual({ ready: false, suppressed: false });
});
