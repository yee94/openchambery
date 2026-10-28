import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const {
  runtimeFetchMock,
  openDesktopPathMock,
  openContextFileMock,
  openContextFileAtLineMock,
  editorOpenFileMock,
  toastWarningMock,
} = vi.hoisted(() => ({
  runtimeFetchMock: vi.fn(),
  openDesktopPathMock: vi.fn(async () => false),
  openContextFileMock: vi.fn(),
  openContextFileAtLineMock: vi.fn(),
  editorOpenFileMock: vi.fn(async () => undefined),
  toastWarningMock: vi.fn(),
}));

vi.mock('@/lib/runtime-fetch', () => ({
  runtimeFetch: (...args: unknown[]) => runtimeFetchMock(...args),
}));

vi.mock('@/components/ui', () => ({
  toast: { warning: toastWarningMock },
}));

vi.mock('@/lib/i18n', () => ({
  useI18nStore: { getState: () => ({ dictionary: {} }) },
  formatMessage: (_dictionary: unknown, key: string) => key,
}));

vi.mock('@/lib/desktop', () => ({
  isDesktopBinaryPath: vi.fn(async () => false),
  isDesktopLocalOriginActive: () => false,
  isDesktopShell: () => false,
  isVSCodeRuntime: () => false,
  openDesktopPath: openDesktopPathMock,
}));

vi.mock('@/stores/useUIStore', () => ({
  useUIStore: {
    getState: () => ({
      openContextFile: openContextFileMock,
      openContextFileAtLine: openContextFileAtLineMock,
    }),
  },
}));

import {
  getFileReferenceInfo,
  getResolvedReference,
  probeFileReference,
  openFileReference,
  openFileReferenceFromElement,
  resetFileReferenceStatCacheForTests,
  shouldOfferFileReference,
  type OpenFileReferenceOptions,
} from './fileReferenceActions';

describe('fileReferenceActions', () => {
  beforeEach(() => {
    resetFileReferenceStatCacheForTests();
    runtimeFetchMock.mockReset();
    openDesktopPathMock.mockReset();
    openDesktopPathMock.mockResolvedValue(false);
    toastWarningMock.mockReset();
    openContextFileMock.mockReset();
    openContextFileAtLineMock.mockReset();
    editorOpenFileMock.mockReset();
  });

  afterEach(() => {
    resetFileReferenceStatCacheForTests();
  });

  test('resolves absolute paths without the session directory', () => {
    expect(getResolvedReference('/tmp/report.html', '/Users/dev/project')).toEqual({
      path: '/tmp/report.html',
      resolvedPath: '/tmp/report.html',
    });
  });

  test('resolves relative paths against the session directory', () => {
    expect(getResolvedReference('src/app.ts', '/Users/dev/project')).toEqual({
      path: 'src/app.ts',
      resolvedPath: '/Users/dev/project/src/app.ts',
    });
  });

  test('stats through /api/fs/stat and remembers existence', async () => {
    runtimeFetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ exists: true, isBinary: false }),
    });

    await expect(getFileReferenceInfo('/tmp/report.html')).resolves.toEqual({
      exists: true,
      isBinary: false,
    });
    expect(runtimeFetchMock).toHaveBeenCalledWith(
      '/api/fs/stat?path=%2Ftmp%2Freport.html&optional=true',
      { method: 'GET', cache: 'no-store' },
    );
  });

  test('hides mobile binary paths that are not images or html', () => {
    expect(shouldOfferFileReference('/tmp/notes.bin', { exists: true, isBinary: true }, true)).toBe(false);
    expect(shouldOfferFileReference('/tmp/photo.png', { exists: true, isBinary: true }, true)).toBe(true);
    expect(shouldOfferFileReference('/tmp/report.html', { exists: true, isBinary: false }, true)).toBe(true);
  });

  test('probes in the session workspace rather than the host active project', async () => {
    runtimeFetchMock.mockResolvedValue({ ok: true, json: async () => ({ exists: true, isBinary: false }) });
    await probeFileReference('/repo/docs/report.md', '/repo');
    const [url, options] = runtimeFetchMock.mock.calls[0];
    const params = new URL(url, 'https://example.com').searchParams;
    expect(params.get('directory') ?? options.query?.directory).toBe('/repo');
  });

  test('a failed probe can recover instead of caching a missing file', async () => {
    runtimeFetchMock.mockRejectedValueOnce(new Error('Relay disconnected'));
    await expect(probeFileReference('/repo/docs/report.md', '/repo')).rejects.toThrow('Relay disconnected');
    runtimeFetchMock.mockResolvedValue({ ok: true, json: async () => ({ exists: true, isBinary: false }) });
    await expect(probeFileReference('/repo/docs/report.md', '/repo')).resolves.toEqual({ exists: true, isBinary: false });
    expect(runtimeFetchMock).toHaveBeenCalledTimes(2);
  });

  test('accepts the server stat payload without an exists field', async () => {
    runtimeFetchMock.mockResolvedValue({ ok: true, json: async () => ({ isFile: true, size: 42, isBinary: false }) });
    await expect(probeFileReference('/repo/docs/report.md', '/repo')).resolves.toEqual({ exists: true, isBinary: false });
  });

  test('workspace rejection does not poison probes in another directory', async () => {
    runtimeFetchMock.mockResolvedValueOnce({ ok: false, status: 400 });
    await expect(probeFileReference('/repo/docs/report.md', '/other')).rejects.toThrow('400');
    runtimeFetchMock.mockResolvedValue({ ok: true, json: async () => ({ isFile: true, isBinary: false }) });
    await expect(probeFileReference('/repo/docs/report.md', '/repo')).resolves.toEqual({ exists: true, isBinary: false });
  });

  test('opens image paths through the shared image preview', async () => {
    const onShowPopup = vi.fn();
    await openFileReference('/tmp/photo.png', false, {
      effectiveDirectory: '/tmp',
      onShowPopup,
    });
    expect(onShowPopup).toHaveBeenCalledWith({
      open: true,
      title: 'photo.png',
      content: '',
      metadata: {
        tool: 'image-preview',
        filename: 'photo.png',
        mime: 'image/png',
      },
      image: {
        url: '/tmp/photo.png',
        filename: 'photo.png',
        mimeType: 'image/png',
      },
    });
    expect(openContextFileMock).not.toHaveBeenCalled();
  });

  test('opens html paths in preview instead of the runtime editor', async () => {
    await openFileReference('/tmp/report.html', false, {
      effectiveDirectory: '/tmp',
      editor: { openFile: editorOpenFileMock } as unknown as OpenFileReferenceOptions['editor'],
      preferRuntimeEditor: true,
    });
    expect(editorOpenFileMock).not.toHaveBeenCalled();
    expect(openContextFileMock).toHaveBeenCalledWith('/tmp', '/tmp/report.html', { viewerMode: 'preview' });
  });

  test.each([
    ['/work/中文 report.eficy', '/work/中文 report.eficy'],
    ['file:///work/%E4%B8%AD%E6%96%87%20report.eficy', '/work/中文 report.eficy'],
    ['file:///C:/work/%E4%B8%AD%E6%96%87%20report.eficy', 'C:/work/中文 report.eficy'],
    ['C:\\work\\中文 report.eficy', 'C:/work/中文 report.eficy'],
    ['\\\\server\\share\\report.eficy', '//server/share/report.eficy'],
    ['file://server/share/report.eficy', '//server/share/report.eficy'],
  ])('opens local plugin file %s in the existing file tab', async (href, path) => {
    const anchor = document.createElement('a');
    anchor.setAttribute('href', href);
    anchor.textContent = '查看预览';
    await openFileReferenceFromElement(anchor, { effectiveDirectory: '/session' });
    expect(openContextFileMock).toHaveBeenCalledWith('/session', path);
  });

  test.each(['https://example.com/a.eficy', 'mailto:a.eficy', 'file:///work/%ZZ.eficy'])('does not treat %s as a local file', async (href) => {
    await openFileReference(href, false, { effectiveDirectory: '/session' });
    expect(openContextFileMock).not.toHaveBeenCalled();
  });

  test('opens a file outside the session directory with no grant and no warning', async () => {
    await openFileReference('/private/var/folders/x/report.md', false, {
      effectiveDirectory: '/Users/dev/project',
    });
    expect(toastWarningMock).not.toHaveBeenCalled();
    expect(openContextFileMock).toHaveBeenCalledWith(
      '/Users/dev/project',
      '/private/var/folders/x/report.md',
    );
  });

  test('opens a worktree file in the context panel', async () => {
    await openFileReference(
      '/Users/dev/.local/share/opencode/worktree/abc/wechat-gui/src/app.ts',
      false,
      { effectiveDirectory: '/Users/dev/project' },
    );
    expect(toastWarningMock).not.toHaveBeenCalled();
    expect(openContextFileMock).toHaveBeenCalledWith(
      '/Users/dev/project',
      '/Users/dev/.local/share/opencode/worktree/abc/wechat-gui/src/app.ts',
    );
  });

  test('opens a workspace-relative markdown link in the context panel', async () => {
    await openFileReference(
      'app/wxaaiagentnodelogicsvr/test/yi/stochastic/reports/kf-full-review.md',
      false,
      { effectiveDirectory: '/Users/dev/project' },
    );
    expect(openContextFileMock).toHaveBeenCalledWith(
      '/Users/dev/project',
      '/Users/dev/project/app/wxaaiagentnodelogicsvr/test/yi/stochastic/reports/kf-full-review.md',
    );
  });

  test('routes non-preview binary paths through the desktop opener first', async () => {
    openDesktopPathMock.mockResolvedValueOnce(true);
    await openFileReference('/tmp/notes.bin', true, {
      effectiveDirectory: '/tmp',
    });
    expect(openDesktopPathMock).toHaveBeenCalledWith('/tmp/notes.bin');
    expect(openContextFileMock).not.toHaveBeenCalled();
  });

  test('falls through to the context panel when the desktop opener cannot handle a binary', async () => {
    openDesktopPathMock.mockResolvedValueOnce(false);
    await openFileReference('/private/var/folders/x/evidence-bundle.tar.gz', true, {
      effectiveDirectory: '/Users/dev/project',
    });
    expect(openDesktopPathMock).toHaveBeenCalledWith('/private/var/folders/x/evidence-bundle.tar.gz');
    expect(toastWarningMock).toHaveBeenCalledWith('chat.fileReference.notice.binaryExternal');
    expect(openContextFileMock).toHaveBeenCalledWith(
      '/Users/dev/project',
      '/private/var/folders/x/evidence-bundle.tar.gz',
    );
  });
});
