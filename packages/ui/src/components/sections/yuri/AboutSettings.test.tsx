import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { dict as en } from '@/lib/i18n/messages/en';
import { dict as zh } from '@/lib/i18n/messages/zh-CN';
import { AboutSettings } from './AboutSettings';

const fixture = vi.hoisted(() => ({ locale: 'en', transport: 'host-a', generation: 1, mobile: false, native: false, nativeConfig: vi.fn(), fetch: vi.fn(), listeners: new Set<() => void>() }));
vi.mock('@/lib/i18n', () => ({ getCurrentIntlLocale: () => 'en-US', useI18n: () => ({ t: (key: keyof typeof en, params?: Record<string, string>) => {
  let text: string = (fixture.locale === 'en' ? en : zh)[key] ?? key;
  for (const [name, value] of Object.entries(params ?? {})) text = text.replace(`{${name}}`, value);
  return text;
} }) }));
vi.mock('@/lib/runtime-fetch', () => ({ runtimeFetch: (...args: unknown[]) => fixture.fetch(...args) }));
vi.mock('@/components/ui', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/runtime-switch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/runtime-switch')>()),
  getRuntimeTransportIdentity: () => fixture.transport,
  getRuntimeGeneration: () => fixture.generation,
  getRuntimeKey: () => fixture.transport,
  getRuntimeApiBaseUrl: () => 'http://127.0.0.1:4096',
  subscribeRuntimeEndpointChanged: (listener: () => void) => { fixture.listeners.add(listener); return () => fixture.listeners.delete(listener); },
}));
vi.mock('@/stores/useUpdateStore', () => ({ useUpdateStore: (select: (state: unknown) => unknown) => select({ checking: false, available: false }) }));
vi.mock('@/stores/useUIStore', () => ({ useUIStore: (select: (state: unknown) => unknown) => select({ otaChannelOverride: null }) }));
vi.mock('@/lib/device', () => ({ useDeviceInfo: () => ({ isMobile: fixture.mobile }) }));
vi.mock('@/lib/platform', () => ({ isCapacitorApp: () => fixture.native }));
vi.mock('@/lib/mobile-updates/native-config', () => ({ readNativeUpdateConfig: () => fixture.nativeConfig() }));
vi.mock('@/lib/desktop', () => ({ isElectronShell: () => !fixture.native, getDesktopAppVersion: async () => '2.0.7-beta.1', isVSCodeRuntime: () => false, isWebRuntime: () => true, isDesktopShell: () => !fixture.native }));
vi.mock('@/components/ui/UpdateDialog', () => ({ UpdateDialog: () => null }));
vi.mock('@/components/chat/MarkdownRenderer', () => ({ SimpleMarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div> }));
vi.mock('@/lib/mobileAppVersion', () => ({ getMobileClientVersion: async () => '2.0.0', getMobileClientBuildNumber: async () => null, formatMobileClientVersionLabel: (version: string) => version }));
vi.mock('@/sync/transcript-diagnostics-runtime', () => ({ isTranscriptDiagnosticsEnabled: () => false, setTranscriptDiagnosticsEnabled: vi.fn(), exportAndDownloadClientDiagnostics: vi.fn() }));
let root: Root;
let host: HTMLDivElement;
let client: QueryClient;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  fixture.locale = 'en'; fixture.transport = 'host-a'; fixture.generation = 1; fixture.mobile = false; fixture.fetch.mockReset();
  fixture.native = false;
  fixture.nativeConfig.mockReset().mockResolvedValue({ channel: 'stable', shellApiVersion: 3 });
  fixture.fetch.mockImplementation(async (path: string) => path.startsWith('/api/system/update') ? new Response('', { status: 501 }) : Response.json(path.includes('system/info')
    ? { yuriVersion: 'host-version' }
    : { serveVersion: '2.0.14', currentVersion: '2.0.12', canManage: false, management: 'manual-global', guidance: 'server English guidance' }));
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); host.remove(); });
async function render() {
  await act(async () => { root.render(<QueryClientProvider client={client}><AboutSettings /></QueryClientProvider>); await new Promise((resolve) => setTimeout(resolve, 20)); });
}
it('exposes desktop update, feedback, beta and diagnostic controls in the shared About page', async () => {
  await render(); await render();
  for (const item of ['about.check-updates', 'about.feedback', 'about.beta-updates', 'about.diagnostics']) {
    expect(host.querySelector(`[data-settings-item="${item}"]`)).not.toBeNull();
  }
  expect(host.querySelector('[data-settings-item="about.feedback"]')?.getAttribute('href')).toContain('/issues/new');
  expect(host.querySelector('[data-settings-item="about.export-diagnostics"]')).toBeNull();
});
it.each(['stable', 'beta'])('uses the installed native %s channel in About', async (channel) => {
  fixture.native = true;
  fixture.nativeConfig.mockResolvedValue({ channel, shellApiVersion: 3 });
  await render(); await render();
  const toggle = host.querySelector('[data-settings-item="about.beta-updates"] [role="checkbox"]');
  expect(toggle?.getAttribute('aria-checked')).toBe(String(channel === 'beta'));
  expect(fixture.nativeConfig).toHaveBeenCalledTimes(1);
  const updateChecks = fixture.fetch.mock.calls.filter(([path]) => path.startsWith('/api/system/update'));
  expect(updateChecks.at(-1)?.[0]).toBe(`/api/system/update?channel=${channel}`);
});
it('translates the raw snapshot on locale change without repeating requests', async () => {
  await render(); await render();
  expect(host.textContent).toContain('2.0.14'); expect(host.textContent).toContain('global CLI');
  expect(host.textContent).toContain(en['settings.yuri.about.opencodeGuidance.manualGlobal']);
  expect(host.textContent).not.toContain('server English guidance');
  const count = fixture.fetch.mock.calls.length;
  fixture.locale = 'zh'; await render();
  expect(host.textContent).toContain('全局 CLI'); expect(fixture.fetch).toHaveBeenCalledTimes(count);
  expect(host.textContent).toContain(zh['settings.yuri.about.opencodeGuidance.manualGlobal']);
  fixture.mobile = true; await render(); expect(host.textContent).toContain('全局 CLI');
});
it('keeps both missing webview endpoints as unknown and preserves a good snapshot after refresh failure', async () => {
  fixture.fetch.mockResolvedValue(new Response('', { status: 404 }));
  await render(); await render();
  expect(host.textContent?.match(/unknown/g)).toHaveLength(2);
  expect(fixture.fetch.mock.calls.filter(([path]) => path === '/api/system/info')).toHaveLength(1);
  expect(fixture.fetch.mock.calls.filter(([path]) => path === '/api/opencode/upgrade-status')).toHaveLength(1);
  fixture.fetch.mockImplementation(async () => Response.json({ serveVersion: '2.0.14', management: 'manual-external', canManage: false }));
  await act(async () => { await client.invalidateQueries(); }); await render();
  expect(host.textContent).toContain('2.0.14');
  expect(host.textContent).toContain(en['settings.yuri.about.opencodeGuidance.manualExternal']);
  fixture.fetch.mockRejectedValue(new Error('offline'));
  await act(async () => { await client.invalidateQueries(); }); await render();
  expect(host.textContent).toContain('2.0.14');
});
it('shows bundled guidance even when the version is unavailable', async () => {
  fixture.fetch.mockImplementation(async () => Response.json({ canManage: false, management: 'bundled' }));
  await render(); await render();
  expect(host.textContent).toContain(en['settings.yuri.about.opencodeGuidance.bundled']);
});
it('allowlists management tokens and preserves missing webview endpoint fallback', async () => {
  fixture.fetch.mockImplementation(async (path: string) => path.includes('system/info') ? new Response('', { status: 404 }) : Response.json({ currentVersion: '2.0.12', canManage: false, management: 'constructor' }));
  await render(); await render();
  expect(host.textContent).toContain('2.0.12'); expect(host.textContent).not.toContain('opencodeManagement'); expect(host.textContent).not.toContain('constructor');
  expect(host.textContent).toContain(en['settings.yuri.about.state.unknown']);
});
it('isolates runtime identities and aborts the old request on switch', async () => {
  let oldSignal: AbortSignal | undefined;
  fixture.fetch.mockImplementation((path: string, init: RequestInit) => {
    if (fixture.transport === 'host-a' && path.includes('upgrade-status')) {
      oldSignal = init.signal ?? undefined;
      return new Promise<Response>(() => {});
    }
    return Promise.resolve(Response.json(path.includes('system/info') ? { yuriVersion: 'host-b' } : { serveVersion: 'new-serve' }));
  });
  await render();
  await act(async () => { const previousTransport = fixture.transport; fixture.transport = 'host-b'; fixture.generation++; fixture.listeners.forEach((notify) => notify({ apiBaseUrl: 'http://127.0.0.1:4097', previousApiBaseUrl: 'http://127.0.0.1:4096', runtimeKey: fixture.transport, previousRuntimeKey: previousTransport, transportIdentityChanged: true })); });
  await render(); await render();
  expect(oldSignal?.aborted).toBe(true); expect(host.textContent).toContain('new-serve');
});
