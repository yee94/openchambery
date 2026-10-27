import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('./main.mjs', import.meta.url), 'utf8');
const prepareSource = source.slice(source.indexOf('const prepareDesktopHost ='), source.indexOf('const handleInvoke ='));
const windowCases = source.slice(source.indexOf("    case 'desktop_new_window':"), source.indexOf("    case 'desktop_open_session_mini_chat_window':"));

const fixture = (ssh = true, packaged = true, local = true) => {
  let host = { id: 'ssh-test', url: 'http://127.0.0.1:4000', clientToken: 'old-test-token' };
  let finish;
  const connect = vi.fn(() => new Promise((resolve, reject) => {
    finish = (error) => {
      if (error) return reject(error);
      host = { ...host, url: 'http://127.0.0.1:5000', clientToken: 'new-test-token' };
      resolve();
    };
  }));
  const createWindow = vi.fn();
  const context = vm.createContext({
    browserWindow: { webContents: {} },
    isLocalSender: () => local,
    readDesktopHostsConfig: () => ({ hosts: [host], defaultHostId: host.id }),
    sshManager: { readInstances: () => ({ instances: ssh ? [{ id: host.id }] : [] }), connect },
    LOCAL_HOST_ID: 'local',
    state: { localUiOrigin: 'http://localhost:5173', unreachableHosts: new Set() },
    shouldUsePackagedUi: () => packaged,
    buildPackagedUiUrl: () => 'yuri-ui://app/index.html',
    normalizeHostUrl: (url) => url,
    sanitizeClientTokenForStorage: (token) => token,
    sanitizeRuntimeRequestHeaders: (headers) => headers,
    resolveStoredClientTokenForUrl: () => '',
    readDesktopLocalClientToken: () => '',
    createAdditionalWindow: createWindow,
  });
  vm.runInContext(`${prepareSource}\nglobalThis.invoke = async (command, args = {}) => { switch (command) { ${windowCases} } };`, context);
  return { invoke: context.invoke, connect, createWindow, finish: (error) => finish(error) };
};

describe('SSH preparation before opening desktop windows', () => {
  for (const packaged of [false, true]) {
    for (const command of ['desktop_new_window', 'desktop_new_window_for_host', 'desktop_new_window_at_url']) {
      it(`${command} waits for preparation and fresh runtime (${packaged ? 'bundled' : 'HMR'})`, async () => {
        const f = fixture(true, packaged);
        const pending = f.invoke(command, { hostId: 'ssh-test', url: 'http://127.0.0.1:4000', clientToken: 'old-test-token' });
        expect(f.connect).toHaveBeenCalledWith('ssh-test');
        expect(f.createWindow).not.toHaveBeenCalled();
        f.finish();
        await pending;
        expect(f.createWindow).toHaveBeenCalledWith(
          packaged ? 'yuri-ui://app/index.html' : 'http://127.0.0.1:5000',
          expect.objectContaining({ apiBaseUrl: 'http://127.0.0.1:5000', clientToken: 'new-test-token' }),
        );
      });

      it(`${command} does not open on preparation failure (${packaged})`, async () => {
        const f = fixture(true, packaged);
        const pending = f.invoke(command, { hostId: 'ssh-test', url: 'http://127.0.0.1:4000' });
        f.finish(new Error('Update failed'));
        await expect(pending).rejects.toThrow('Update failed');
        expect(f.createWindow).not.toHaveBeenCalled();
      });
    }
  }

  it('leaves non-SSH hosts on their ordinary connection path', async () => {
    const f = fixture(false);
    await f.invoke('desktop_new_window_for_host', { hostId: 'ssh-test' });
    expect(f.connect).not.toHaveBeenCalled();
    expect(f.createWindow).toHaveBeenCalledOnce();
  });

  it('preserves explicit credentials when opening a non-SSH URL', async () => {
    const f = fixture(false);
    await f.invoke('desktop_new_window_at_url', { url: 'http://127.0.0.1:4000', clientToken: 'explicit-test-token' });
    expect(f.connect).not.toHaveBeenCalled();
    expect(f.createWindow).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ clientToken: 'explicit-test-token' }));
  });

  it('blocks SSH preparation through otherwise remote-safe window commands', async () => {
    const f = fixture(true, true, false);
    await expect(f.invoke('desktop_new_window_for_host', { hostId: 'ssh-test' })).rejects.toThrow('local desktop page');
    expect(f.connect).not.toHaveBeenCalled();
    expect(f.createWindow).not.toHaveBeenCalled();
  });

  it('returns the refreshed host to the runtime switch only after preparation', async () => {
    const f = fixture();
    const pending = f.invoke('desktop_host_prepare', { hostId: 'ssh-test' });
    f.finish();
    await expect(pending).resolves.toMatchObject({ url: 'http://127.0.0.1:5000', clientToken: 'new-test-token' });
  });
});
