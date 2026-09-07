import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const {
  runtimeFetchMock,
  openDesktopPathMock,
  openContextFileMock,
  openContextFileAtLineMock,
  editorOpenFileMock,
} = vi.hoisted(() => ({
  runtimeFetchMock: vi.fn(),
  openDesktopPathMock: vi.fn(async () => false),
  openContextFileMock: vi.fn(),
  openContextFileAtLineMock: vi.fn(),
  editorOpenFileMock: vi.fn(async () => undefined),
}));

vi.mock('@/lib/runtime-fetch', () => ({
  runtimeFetch: (...args: unknown[]) => runtimeFetchMock(...args),
}));

vi.mock('@/lib/desktop', () => ({
  isDesktopBinaryPath: vi.fn(async () => false),
  isDesktopLocalOriginActive: () => false,
  isDesktopShell: () => false,
  isVSCodeRuntime: () => false,
  openDesktopPath: openDesktopPathMock,
}));

vi.mock('@/lib/outsideFileGrants', () => ({
  ensureOutsideFileGrantForDesktop: vi.fn(async () => undefined),
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
  openFileReference,
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

  test('routes non-preview binary paths through the desktop opener first', async () => {
    openDesktopPathMock.mockResolvedValueOnce(true);
    await openFileReference('/tmp/notes.bin', true, {
      effectiveDirectory: '/tmp',
    });
    expect(openDesktopPathMock).toHaveBeenCalledWith('/tmp/notes.bin');
    expect(openContextFileMock).not.toHaveBeenCalled();
  });
});
