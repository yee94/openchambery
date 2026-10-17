import { describe, expect, it } from 'vitest';
import { discoverLocalMagpie } from './magpie-local.js';

const missing = () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); };
const directory = async () => ({ isDirectory: () => true });

describe('local Magpie address discovery', () => {
  it('does not probe a default port without installation evidence', async () => {
    expect(await discoverLocalMagpie({ env: {}, home: '/home/example', stat: missing })).toEqual({ urls: [], incomplete: false });
  });
  it('reads the saved custom port without requiring OpenCode provider configuration', async () => {
    const result = await discoverLocalMagpie({ env: {}, home: '/home/example', stat: directory,
      readFile: async (file) => { expect(file).toBe('/home/example/.config/magpie/settings.json'); return '{"port":43210}'; } });
    expect(result).toEqual({ urls: ['http://127.0.0.1:43210'], incomplete: false });
  });
  it('uses Magpie’s documented default for an installed app with no saved port', async () => {
    expect(await discoverLocalMagpie({ env: {}, home: '/home/example', stat: directory, readFile: missing }))
      .toEqual({ urls: ['http://127.0.0.1:3425'], incomplete: false });
  });
  it('includes XDG and explicit address hints and converts wildcard binds to loopback', async () => {
    const result = await discoverLocalMagpie({ env: { XDG_CONFIG_HOME: '/config', MAGPIE_ADDR: '0.0.0.0:43212' },
      home: '/home/example', stat: directory, readFile: async (file) => JSON.stringify({ port: file.startsWith('/config/') ? 43211 : 43210 }) });
    expect(result.urls).toEqual(['http://127.0.0.1:43212/', 'http://127.0.0.1:43210', 'http://127.0.0.1:43211']);
  });
  it('does not mistake unreadable settings for an absent installation', async () => {
    expect(await discoverLocalMagpie({ env: {}, home: '/home/example', stat: directory, readFile: async () => '{invalid' }))
      .toEqual({ urls: [], incomplete: true });
  });
});
