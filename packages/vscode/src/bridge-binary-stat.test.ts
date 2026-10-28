import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const { workspace } = vi.hoisted(() => ({ workspace: { workspaceFolders: [] as { uri: { fsPath: string } }[] } }));
vi.mock('vscode', () => ({
  workspace,
  Uri: { file: (fsPath: string) => ({ fsPath }) },
}));

import { handleFsBridgeMessage } from './bridge-fs-runtime';
import { tryHandleLocalFsProxy } from './bridge-localfs-proxy-runtime';

describe('VS Code binary file stat', () => {
  for (const transport of ['bridge', 'proxy']) {
    it.each([
      ['Chinese crossing sample boundary', Buffer.from('a'.repeat(8191) + '好'), false],
      ['invalid UTF-8', Buffer.from([0xff]), true],
      ['NUL', Buffer.from([0x61, 0, 0x62]), true],
      ['incomplete UTF-8 at EOF', Buffer.from([0xe5]), true],
      ['incomplete UTF-8 at exact sample EOF', Buffer.concat([Buffer.alloc(8191, 0x61), Buffer.from([0xe5])]), true],
    ])(`${transport}: %s`, async (_name, bytes, expected) => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yuri-vscode-binary-'));
      const filePath = path.join(directory, 'report.eficy');
      try {
        workspace.workspaceFolders = [{ uri: { fsPath: directory } }];
        await fs.writeFile(filePath, bytes);
        if (transport === 'proxy') {
          const response = await tryHandleLocalFsProxy('GET', `/api/fs/stat?path=${encodeURIComponent(filePath)}`);
          expect(response?.status).toBe(200);
          expect(JSON.parse(Buffer.from(response!.bodyBase64, 'base64').toString('utf8'))).toMatchObject({ isBinary: expected });
        } else {
          const response = await handleFsBridgeMessage({ id: 'stat', type: 'api:fs:stat', payload: { path: filePath } }, {
            resolveUserPath: (value) => value,
            normalizeFsPath: (value) => value,
            resolveFileReadPath: async (value) => ({ ok: true, resolvedPath: value }),
            listDirectoryEntries: vi.fn(),
            execGit: vi.fn(),
            searchDirectory: vi.fn(),
            parseDroppedFileReference: vi.fn(),
            readUriAsAttachment: vi.fn(),
          });
          expect(response).toMatchObject({ success: true, data: { isBinary: expected } });
        }
      } finally {
        await fs.rm(directory, { recursive: true, force: true });
      }
    });
  }
});
