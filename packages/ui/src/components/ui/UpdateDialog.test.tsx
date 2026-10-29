import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { dict as en } from '@/lib/i18n/messages/en';
import { UpdateDialog } from './UpdateDialog';
import type { UpdateInfo } from '@/lib/desktop';

const fixture = vi.hoisted(() => ({ dismiss: vi.fn(), openExternal: vi.fn(), otaSkipped: false }));
vi.mock('@/lib/i18n', () => ({ getCurrentIntlLocale: () => 'en-US', useI18n: () => ({ t: (key: keyof typeof en) => en[key] ?? key }) }));
vi.mock('@/components/chat/MarkdownRenderer', () => ({ SimpleMarkdownRenderer: ({ content }: { content: string }) => <div data-markdown>{content}</div> }));
vi.mock('@/stores/useUpdateStore', () => ({ useUpdateStore: Object.assign(
  (select: (state: { otaDownloadSkipped: boolean }) => unknown) => select({ otaDownloadSkipped: fixture.otaSkipped }),
  { getState: () => ({ dismiss: fixture.dismiss }) },
) }));
vi.mock('@/lib/url', () => ({ openExternalUrl: (url: string) => fixture.openExternal(url) }));

let root: Root;
let container: HTMLDivElement;
const onDownload = vi.fn();
const onRestart = vi.fn();
const onOpenChange = vi.fn();
const info: UpdateInfo = { available: true, currentVersion: '2.0.0', version: '2.0.1', body: 'Fixes from @contributor' };
type Props = React.ComponentProps<typeof UpdateDialog>;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks(); fixture.otaSkipped = false;
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
async function render(overrides: Partial<Props> = {}) {
  await act(async () => { root.render(<UpdateDialog open onOpenChange={onOpenChange} info={info} downloading={false} downloaded={false} progress={null} error={null} onDownload={onDownload} onRestart={onRestart} {...overrides} />); });
}
async function click(label: string) {
  const button = Array.from(document.body.querySelectorAll('button')).find((node) => node.textContent?.trim() === label);
  expect(button).toBeDefined();
  await act(async () => { button?.click(); });
}

it('preserves desktop download-and-dismiss behavior in the shared renderer', async () => {
  await render();
  expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain('2.0.0');
  expect(document.body.textContent).toContain('2.0.1');
  expect(document.body.querySelector('[data-markdown]')?.textContent).toContain('[@contributor](https://github.com/contributor)');
  await click(en['updateDialog.actions.downloadUpdate']);
  expect(onDownload).toHaveBeenCalledOnce();
  expect(onOpenChange).toHaveBeenCalledWith(false);
  expect(onRestart).not.toHaveBeenCalled();
});

it('preserves mobile OTA apply, reused-bundle notice, later and restart actions', async () => {
  const otaInfo = { ...info, inAppApply: true };
  await render({ runtimeType: 'mobile', info: otaInfo });
  await click(en['updateDialog.actions.applyOtaNow']);
  expect(onDownload).toHaveBeenCalledOnce();
  expect(onOpenChange).not.toHaveBeenCalled();
  fixture.otaSkipped = true;
  await render({ runtimeType: 'mobile', info: otaInfo, downloaded: true });
  expect(document.body.textContent).toContain(en['updateDialog.status.otaBundleReused']);
  await click(en['updateDialog.actions.restartToUpdate']);
  expect(onRestart).toHaveBeenCalledOnce();
  await click(en['updateDialog.actions.later']);
  expect(fixture.dismiss).toHaveBeenCalledOnce();
  expect(onOpenChange).toHaveBeenCalledWith(false);
});

it('preserves the native progress bar, errors and disabled download action', async () => {
  await render({ downloading: true, progress: { downloaded: 32, total: 100 }, error: 'Download failed' });
  expect(document.body.querySelector('[role="status"]')?.textContent).toContain('32%');
  expect(document.body.querySelector('[role="alert"]')?.textContent).toBe('Download failed');
  const button = Array.from(document.body.querySelectorAll('button')).find((node) => node.textContent === en['updateDialog.status.downloading']);
  expect(button?.disabled).toBe(true);
});

it('only offers mobile external installation for the URL provided by the decision', async () => {
  await render({ runtimeType: 'mobile', info: { ...info, manualUpdate: true } });
  expect(document.body.querySelector('a')).toBeNull();
  expect(document.body.textContent).not.toContain(en['updateDialog.actions.openMobileUpdate']);
  const url = 'https://downloads.example.com/native';
  await render({ runtimeType: 'mobile', info: { ...info, manualUpdate: true, downloadUrl: url } });
  await click(en['updateDialog.actions.openMobileUpdate']);
  expect(fixture.openExternal).toHaveBeenCalledWith(url);
});

it('retains versioned changelog sorting, date labels and Markdown content', async () => {
  await render({ info: { ...info, body: '## [2.0.1] - 2026-10-29\nNew fix\n\n## [2.0.2] - 2026-10-30\nNewest fix' } });
  const sections = Array.from(document.body.querySelectorAll('[data-markdown]'));
  expect(sections.map((node) => node.textContent)).toEqual(['Newest fix', 'New fix']);
  expect(document.body.textContent).toContain('Oct 30, 2026');
});

it('retains the web update action without starting an update on dialog open', async () => {
  await render({ runtimeType: 'web' });
  expect(document.body.textContent).toContain(en['updateDialog.actions.updateNow']);
  expect(onDownload).not.toHaveBeenCalled();
  expect(onRestart).not.toHaveBeenCalled();
});
