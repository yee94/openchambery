import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  updateDesktopSettings: vi.fn(),
  modelSelectorProps: [] as Array<Record<string, unknown>>,
}));

vi.mock('@/lib/runtime-fetch', () => ({ runtimeFetch: mocks.fetch }));
vi.mock('@/lib/persistence', () => ({ updateDesktopSettings: mocks.updateDesktopSettings }));
vi.mock('@/contexts/runtimeAPIRegistry', () => ({ getRegisteredRuntimeAPIs: () => null }));
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
  ModelSelector: (props: { modelId: string } & Record<string, unknown>) => {
    mocks.modelSelectorProps.push(props);
    return <div data-testid="provider-model">{props.modelId}</div>;
  },
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
  mocks.modelSelectorProps.length = 0;
  mocks.fetch.mockImplementation(async (path: string) => {
    if (path === '/api/config/settings') return Response.json(settings);
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

test('an unsaved provider model stays empty so the server follows the OpenCode default model', async () => {
  settings = { summaryModelMode: 'provider' };
  await act(async () => {
    root.unmount();
  });
  root = createRoot(host);
  await act(async () => {
    root.render(<SummarySettings />);
  });
  await flush();

  expect(host.querySelector('[data-testid="provider-model"]')?.textContent).toBe('');
  expect(mocks.fetch).not.toHaveBeenCalledWith('/api/small-model', expect.anything());
});

test('provider picker uses the shared chat model catalog without a custom provider list or allowlist', async () => {
  settings = { summaryModelMode: 'provider', summaryProviderID: 'opencode-go', summaryModelID: 'deepseek-v4-flash' };
  await act(async () => {
    root.unmount();
  });
  root = createRoot(host);
  await act(async () => {
    root.render(<SummarySettings />);
  });
  await flush();

  const props = mocks.modelSelectorProps.at(-1);
  expect(props?.modelId).toBe('deepseek-v4-flash');
  expect(props?.providers).toBeUndefined();
  expect(props?.allowedProviderIds).toBeUndefined();
  expect(props?.allowedModelIdsByProvider).toBeUndefined();
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
