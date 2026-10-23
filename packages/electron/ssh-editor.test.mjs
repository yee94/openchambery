import { describe, expect, test } from 'vitest';
import { buildSshEditorUrl, sshEditorAppIds } from './ssh-editor.mjs';
import { parseSshCommand } from './ssh-manager.mjs';
import { isRemoteIpcCommandAllowed } from './ipc-command-gate.mjs';

const urlFor = (command, appId = 'vscode', projectPath = '/srv/project') => buildSshEditorUrl({
  appId, projectPath, ssh: parseSshCommand(command),
});

describe('SSH editor handoff', () => {
  test.each(sshEditorAppIds().filter((id) => id !== 'zed'))('%s preserves SSH aliases and encodes remote paths', (id) => {
    const url = new URL(urlFor('ssh dev-box', id, '/srv/项目 #?%/folder.with.dot'));
    expect(url.protocol).toBe(`${id}:`);
    expect(url.hostname).toBe('vscode-remote');
    expect(decodeURIComponent(url.pathname)).toBe('/ssh-remote+dev-box/srv/项目 #?%/folder.with.dot');
    expect(url.searchParams.get('windowId')).toBe('_blank');
    expect(url.hash).toBe('');
  });

  test.each(['ssh -p 2222 -l developer server', 'ssh developer@server:2222', 'ssh developer@server -p2222'])('preserves user and explicit port: %s', (command) => {
    const uri = new URL(urlFor(command));
    const authority = uri.pathname.split('/')[1].slice('ssh-remote+'.length);
    expect(JSON.parse(Buffer.from(authority, 'hex').toString())).toEqual({ hostName: 'server', user: 'developer', port: 2222 });
  });

  test('Zed uses its native SSH link, including IPv6 and custom ports', () => {
    expect(urlFor('ssh -p 2200 dev@[::1]', 'zed', '/srv/a b')).toBe('zed://ssh/dev@[::1]:2200/srv/a%20b');
    expect(urlFor('ssh alias', 'zed')).toBe('zed://ssh/alias/srv/project');
  });

  test.each(['ssh -i key host', 'ssh -J bastion host', 'ssh -F config host', 'ssh -o ServerAliveInterval=30 host'])('never silently discards options: %s', (command) => {
    expect(() => urlFor(command)).toThrow('SSH_EDITOR_CONFIG_REQUIRED');
  });

  test('rejects local apps, invalid ports and non-absolute paths', () => {
    expect(() => urlFor('ssh host', 'finder')).toThrow('Unsupported');
    expect(() => urlFor('ssh -p 70000 host')).toThrow('port');
    expect(() => urlFor('ssh host', 'cursor', 'relative')).toThrow('absolute');
    expect(() => urlFor('ssh host', 'cursor', '/srv/\0')).toThrow('absolute');
  });

  test('remote pages cannot launch editors or enumerate local apps', () => {
    for (const command of ['desktop_open_ssh_in_app', 'desktop_ssh_editor_apps', 'desktop_get_installed_apps']) {
      expect(isRemoteIpcCommandAllowed(command)).toBe(false);
    }
  });
});
