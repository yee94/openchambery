import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, test, vi } from 'vitest';
import ToolOutputDialog from './ToolOutputDialog';
import { mobileBackNavigationCoordinator } from '@/mobile/mobileBackNavigation';
import type { ToolPopupContent } from './types';

vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('../MarkdownRenderer', () => ({ SimpleMarkdownRenderer: () => <svg viewBox="0 0 200 800" /> }));
vi.mock('@/hooks/useEffectiveDirectory', () => ({ useEffectiveDirectory: () => '/workspace' }));
vi.mock('../imageSource', () => ({ useResolvedImageResource: () => ({ source: 'data:image/png;base64,AA==', key: 'image' }) }));
vi.mock('@/contexts/useThemeSystem', () => ({ useOptionalThemeSystem: () => null }));
vi.mock('@/lib/shiki/appThemeRegistry', () => ({ ensurePierreThemeRegistered: () => {} }));
vi.mock('@/lib/native-ios-composer-leave', () => ({ concealNativeComposerIfLeavingChat: () => {} }));
vi.mock('@/components/ui/dialog', () => ({ Dialog: () => null, DialogContent: () => null }));
vi.mock('./toolRenderers', () => ({}));
vi.mock('@/lib/toolHelpers', () => ({ getLanguageFromExtension: () => 'text' }));
vi.mock('./parts/VirtualizedCodeBlock', () => ({ VirtualizedCodeBlock: () => null }));
vi.mock('@/components/code/WorkerHighlightedCode', () => ({ WorkerHighlightedCode: () => null }));
vi.mock('../imageSave', () => ({ blobFromImageElement: vi.fn() }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const host = document.createElement('div');
let root: ReturnType<typeof createRoot>;
afterEach(async () => { await act(async () => root?.unmount()); vi.restoreAllMocks(); });

test.each(['image', 'mermaid'] as const)('%s Back closes preview immediately and preserves the underlying route', async (kind) => {
  const close = vi.fn();
  const underlyingBack = vi.fn();
  const unregister = mobileBackNavigationCoordinator.register({ id: 'test-chat', layer: 'root', onBack: underlyingBack, getSurface: () => null, getUnderlay: () => null });
  root = createRoot(host);
  const popup = { open: true, title: 'Preview', content: '', [kind]: { url: 'data:text/plain,test', source: 'graph TD; A-->B' } } as ToolPopupContent;
  function Preview() {
    const [open, setOpen] = React.useState(true);
    return <ToolOutputDialog popup={{ ...popup, open }} onOpenChange={(next) => { close(next); setOpen(next); }} isMobile />;
  }
  try {
    await act(async () => root.render(<Preview />));
    await act(async () => { expect(mobileBackNavigationCoordinator.backImmediately('overlay')).toBe(true); });
    expect(close).toHaveBeenCalledWith(false);
    expect(underlyingBack).not.toHaveBeenCalled();
    expect(mobileBackNavigationCoordinator.getTopRoute()?.id).toBe('test-chat');
  } finally { unregister(); }
});

test('Mermaid preview occupies the full viewport rather than a square dialog', async () => {
  root = createRoot(host);
  await act(async () => root.render(<ToolOutputDialog popup={{ open: true, title: 'Diagram', content: '', mermaid: { url: 'data:text/plain,test', source: 'graph TD; A-->B' } }} onOpenChange={() => {}} isMobile />));
  const surface = document.querySelector('[data-mermaid-preview="true"]') as HTMLElement | null;
  expect(surface).not.toBeNull();
  expect(surface?.style.width).toBe('100%');
  expect(surface?.style.height).toBe('100%');
});

test.each(['image', 'mermaid'] as const)('%s has a visible close icon that dismisses the preview', async (kind) => {
  const close = vi.fn();
  root = createRoot(host);
  const popup = { open: true, title: 'Preview', content: '', [kind]: { url: 'data:text/plain,test', source: 'graph TD; A-->B' } } as ToolPopupContent;
  await act(async () => root.render(<ToolOutputDialog popup={popup} onOpenChange={close} isMobile />));
  const button = document.querySelector('[role="dialog"] button') as HTMLButtonElement;
  expect(button).not.toBeNull();
  expect(button.classList.contains('sr-only')).toBe(false);
  expect(button.querySelector('svg')).not.toBeNull();
  await act(async () => button.click());
  expect(close).toHaveBeenCalledWith(false);
});
