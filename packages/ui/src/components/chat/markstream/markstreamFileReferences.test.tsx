import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { MarkstreamFileReferenceProvider, MarkstreamLinkNode } from './markstreamFileReferences';
import { handleMarkstreamPointerEvent } from './markstreamInteractions';
import { resetFileReferenceStatCacheForTests } from '../fileReferenceActions';

const { openContextFile, runtimeFetch } = vi.hoisted(() => ({ openContextFile: vi.fn(), runtimeFetch: vi.fn() }));
vi.mock('@/lib/runtime-fetch', () => ({ runtimeFetch }));
vi.mock('@/stores/useUIStore', () => ({ useUIStore: Object.assign(
  (select: (state: { isMobile: boolean }) => unknown) => select({ isMobile: false }),
  { getState: () => ({ openContextFile }) },
) }));
vi.mock('@/hooks/useEffectiveDirectory', () => ({ useEffectiveDirectory: () => '/repo' }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/contexts/useThemeSystem', () => ({ useOptionalThemeSystem: () => undefined }));
vi.mock('@/hooks/useRuntimeAPIs', () => ({ useRuntimeAPIs: () => ({ runtime: { isVSCode: false } }) }));
vi.mock('../message/toolRenderers', () => ({}));
vi.mock('../message/parts/VirtualizedCodeBlock', () => ({ VirtualizedCodeBlock: () => null }));
vi.mock('@/components/code/WorkerHighlightedCode', () => ({ WorkerHighlightedCode: () => null }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  window.__YURI_SURFACE__ = 'mobile';
  runtimeFetch.mockRejectedValue(new Error('Relay disconnected'));
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.clearAllMocks();
  resetFileReferenceStatCacheForTests();
  delete window.__YURI_SURFACE__;
});

async function renderLink(path: string, onShowPopup = vi.fn()) {
  await act(async () => root.render(
    <div onClick={(event) => handleMarkstreamPointerEvent(event.nativeEvent, { fileReference: { effectiveDirectory: '/repo', onShowPopup } })}>
      <MarkstreamFileReferenceProvider enabled effectiveDirectory="/repo" preferRuntimeEditor={false} content={path}>
        <MarkstreamLinkNode node={{ type: 'link', href: path, title: null, text: 'report', children: [] }} />
      </MarkstreamFileReferenceProvider>
    </div>,
  ));
  return host.querySelector('a')!;
}

test('a failed relay probe does not block mobile markdown preview navigation', async () => {
  const link = await renderLink('/repo/docs/report.md');
  const event = new MouseEvent('click', { bubbles: true, cancelable: true });
  await act(async () => link.dispatchEvent(event));
  expect(event.defaultPrevented).toBe(true);
  expect(openContextFile).toHaveBeenCalledWith('/repo', '/repo/docs/report.md');
});

test('legacy markdown opens an explicit custom-extension link before probing succeeds', async () => {
  const { MarkdownRenderer } = await import('../MarkdownRendererImpl');
  await act(async () => root.render(<MarkdownRenderer content="[report](/repo/report.eficy)" messageId="file-link" isAnimated={false} />));
  const link = host.querySelector('a')!;
  expect(link).toBeTruthy();
  await act(async () => link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
  expect(openContextFile).toHaveBeenCalledWith('/repo', '/repo/report.eficy');
});

test.each(['markstream', 'legacy'] as const)('%s probes and opens the decoded Chinese/emoji filename', async (renderer) => {
  const path = '30 📚 Learning/📚 Knowledge/相机画幅图解.eficy';
  runtimeFetch.mockResolvedValue({ ok: true, json: async () => ({ exists: true, isBinary: false }) });
  if (renderer === 'markstream') {
    await renderLink(encodeURI(path));
  } else {
    const { MarkdownRenderer } = await import('../MarkdownRendererImpl');
    await act(async () => root.render(<MarkdownRenderer content={`[图解](<${path}>)`} messageId="encoded-file-link" isAnimated={false} />));
  }
  await act(async () => {
    await vi.waitFor(() => expect(runtimeFetch.mock.calls.some(([url]) => new URL(url, 'https://example.com').searchParams.get('path') === `/repo/${path}`)).toBe(true));
  });
  const link = host.querySelector('a')!;
  expect(link).not.toBeNull();
  await act(async () => link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
  expect(openContextFile).toHaveBeenCalledWith('/repo', `/repo/${path}`);
});

test.each(['mobile', 'desktop'] as const)('directory anchors cannot reload the %s application', async (surface) => {
  window.__YURI_SURFACE__ = surface;
  for (const path of ['/repo/src/', '/repo/src', './src/', 'packages/ui', '/']) {
    const link = await renderLink(path);
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    await act(async () => link.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
  }
  expect(openContextFile).not.toHaveBeenCalled();
});

test('image file links still open the image preview after a failed probe', async () => {
  const showPopup = vi.fn();
  const link = await renderLink('/repo/docs/image.png', showPopup);
  await act(async () => link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
  expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({ open: true, image: expect.objectContaining({ url: '/repo/docs/image.png' }) }));
  expect(openContextFile).not.toHaveBeenCalled();
});

test('touch-generated mouse hover cannot leave a global tooltip after leaving the page', async () => {
  const link = await renderLink('/repo/docs/report.md');
  await act(async () => link.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
  await new Promise((resolve) => setTimeout(resolve, 150));
  await act(async () => root.render(null));
  expect(document.querySelector('[role="tooltip"]')).toBeNull();
});
