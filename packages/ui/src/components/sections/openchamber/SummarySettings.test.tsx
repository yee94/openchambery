import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  updateDesktopSettings: vi.fn(),
}));

vi.mock('@/lib/runtime-fetch', () => ({ runtimeFetch: mocks.fetch }));
vi.mock('@/lib/persistence', () => ({ updateDesktopSettings: mocks.updateDesktopSettings }));
vi.mock('@/contexts/runtimeAPIRegistry', () => ({ getRegisteredRuntimeAPIs: () => null }));
vi.mock('@/stores/useConfigStore', () => ({
  useConfigStore: (selector: (state: { providers: readonly unknown[] }) => unknown) => selector({ providers: [] }),
}));
vi.mock('@/contexts/useThemeSystem', () => ({
  useThemeSystem: () => ({ currentTheme: {} }),
}));
vi.mock('@/components/ui/CodeMirrorEditor', () => ({
  CodeMirrorEditor: () => null,
}));
vi.mock('@/lib/codemirror/flexokiTheme', () => ({
  createFlexokiCodeMirrorTheme: () => [],
}));
vi.mock('@/components/sections/agents/ModelSelector', () => ({
  ModelSelector: ({ modelId }: { modelId: string }) => <div data-testid="provider-model">{modelId}</div>,
}));
vi.mock('@/lib/i18n', async () => {
  const { dict } = await import('@/lib/i18n/messages/en');
  return { useI18n: () => ({ t: (key: keyof typeof dict) => dict[key] }) };
});

import { SummarySettings } from './SummarySettings';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let settings: Record<string, unknown>;

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

const modelInput = () => host.querySelector<HTMLInputElement>('input[placeholder="gpt-4.1-mini"]');
const customRadio = () => host.querySelector<HTMLElement>('[aria-label="Custom OpenAI-compatible API"]');
const providerRadio = () => host.querySelector<HTMLElement>('[aria-label="OpenCode provider"]');

beforeEach(async () => {
  settings = {
    summaryModelMode: 'custom',
    summaryProviderID: 'openai',
    summaryModelID: 'gpt-5.4-mini',
    summaryCustomBaseURL: 'https://api.example.test/v1',
    hasSummaryCustomAPIToken: true,
  };
  mocks.fetch.mockReset();
  mocks.updateDesktopSettings.mockReset();
  mocks.fetch.mockImplementation(async (path: string) => {
    if (path === '/api/config/settings') return Response.json(settings);
    if (path === '/api/small-model') {
      return Response.json({ callableModels: { openai: ['gpt-5.4-mini'] } });
    }
    if (path === '/api/small-model/custom-models') return Response.json({ models: [] });
    return Response.json({});
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root.render(<SummarySettings />);
  });
  await flush();
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  host.remove();
});

test('custom mode model ID stays editable and is not snapped back to a callable provider model', async () => {
  const input = modelInput();
  expect(input).toBeTruthy();
  expect(input?.value).toBe('gpt-5.4-mini');

  await act(async () => {
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    nativeInputValueSetter?.call(input, 'my-custom-model');
    input?.dispatchEvent(new Event('input', { bubbles: true }));
    input?.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await flush();

  expect(modelInput()?.value).toBe('my-custom-model');
});

test('switching modes round-trips without losing custom or provider configuration', async () => {
  const input = modelInput();
  expect(input?.value).toBe('gpt-5.4-mini');

  await act(async () => {
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    nativeInputValueSetter?.call(input, 'kept-custom-model');
    input?.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await flush();

  await act(async () => {
    providerRadio()?.click();
  });
  await flush();
  expect(host.querySelector('[data-testid="provider-model"]')?.textContent).toBe('gpt-5.4-mini');
  expect(modelInput()).toBeNull();

  await act(async () => {
    customRadio()?.click();
  });
  await flush();
  expect(modelInput()?.value).toBe('kept-custom-model');
});
