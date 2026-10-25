import { beforeEach, describe, expect, it, mock } from 'bun:test';

const missingError = () => Object.assign(new Error('missing'), { code: 'ENOENT' });
const realpathMock = mock(async () => { throw missingError(); });
const statMock = mock(async () => { throw missingError(); });
const readFileMock = mock(async () => { throw missingError(); });

mock.module('fs', () => ({
  promises: {
    realpath: realpathMock,
    stat: statMock,
    readFile: readFileMock,
  },
  default: {
    promises: {
      realpath: realpathMock,
      stat: statMock,
      readFile: readFileMock,
    },
  },
}));

mock.module('vscode', () => ({
  Uri: {
    file: (fsPath) => ({ fsPath }),
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/workspace' } }],
  },
}));

const { tryHandleLocalFsProxy } = await import('./bridge-localfs-proxy-runtime');

describe('bridge local fs proxy', () => {
  beforeEach(() => {
    realpathMock.mockImplementation(async () => { throw missingError(); });
    statMock.mockImplementation(async () => { throw missingError(); });
    readFileMock.mockImplementation(async () => { throw missingError(); });
  });

  it('returns a quiet optional stat miss for missing files', async () => {
    const response = await tryHandleLocalFsProxy('GET', '/api/fs/stat?path=%2Fmissing.ts&optional=true');

    expect(response?.status).toBe(200);
    expect(JSON.parse(Buffer.from(response?.bodyBase64 ?? '', 'base64').toString('utf8'))).toEqual({
      path: '/missing.ts',
      exists: false,
    });
  });

  it('keeps regular stat miss behavior without optional flag', async () => {
    const response = await tryHandleLocalFsProxy('GET', '/api/fs/stat?path=%2Fmissing.ts');

    expect(response?.status).toBe(404);
  });

  it('signals optional missing reads with an empty plain-text body', async () => {
    const response = await tryHandleLocalFsProxy('GET', '/api/fs/read?path=%2Fmissing.ts&optional=true');

    expect(response?.status).toBe(200);
    expect(response?.headers['x-yuri-file-exists']).toBe('false');
    expect(Buffer.from(response?.bodyBase64 ?? '', 'base64').toString('utf8')).toBe('');
  });

  it('signals optional empty reads as existing', async () => {
    realpathMock.mockImplementation(async (targetPath) => targetPath);
    statMock.mockImplementation(async () => ({ isFile: () => true }));
    readFileMock.mockImplementation(async () => '');

    const response = await tryHandleLocalFsProxy('GET', '/api/fs/read?path=%2Fworkspace%2Fempty.ts&optional=true');

    expect(response?.status).toBe(200);
    expect(response?.headers['x-yuri-file-exists']).toBe('true');
    expect(Buffer.from(response?.bodyBase64 ?? '', 'base64').toString('utf8')).toBe('');
  });
});
