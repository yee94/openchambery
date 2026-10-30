import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const fixture = vi.hoisted(() => {
  const assistant = {
    id: 'asst_route', name: 'Route assistant', enabled: true,
    defaultPrompt: 'Route prompt', workspacePath: null, managedWorkspacePath: null,
    providerID: 'provider', modelID: 'model', variant: 'medium',
  };
  return {
    assistant,
    snapshot: { data: { revision: 1, assistants: [assistant] }, isSuccess: true, isPending: false, isError: false, refetch: vi.fn() },
    update: vi.fn().mockResolvedValue(assistant),
    create: vi.fn(),
    remove: vi.fn().mockResolvedValue(undefined),
    providers: { data: [] },
    config: { providers: [], opencodeDefaultModel: undefined as string | undefined },
  };
});
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('@/components/chat/AgentAvatar', () => ({ AgentAvatar: ({ name }: { name: string }) => <span data-avatar-seed={name} /> }));
vi.mock('@/components/sections/agents/ModelSelector', () => ({
  ModelSelector: ({ variant, onChange }: { variant?: string; onChange: (provider: string, model: string, variant?: string) => void }) => (
    <div data-testid="model-picker" data-variant={variant}>
      <button onClick={() => onChange('provider', 'model', 'high')}>pick-high</button>
      <button onClick={() => onChange('provider', 'plain-model', '')}>pick-plain</button>
    </div>
  ),
}));
vi.mock('@/stores/useConfigStore', () => ({
  useConfigStore: { getState: () => fixture.config },
}));
vi.mock('@/stores/useProjectsStore', () => ({
  useProjectsStore: (selector: (state: { projects: never[] }) => unknown) => selector({ projects: [] }),
}));
vi.mock('@/apps/MobileShareBridge', () => ({ publishNativeAssistantCatalog: vi.fn(), refreshNativeAssistantCatalog: vi.fn() }));
vi.mock('@/queries/agentQueries', () => ({ useScopedProvidersQuery: () => fixture.providers }));
vi.mock('@/queries/assistantQueries', () => ({
  useAssistantSnapshotQuery: () => fixture.snapshot,
  useAssistantCapabilityQuery: () => ({ data: { supported: true, enabled: true }, isSuccess: true }),
  useAssistantScheduledTasksQuery: () => ({ data: { tasks: [] } }),
  useAssistantContactMessagesQuery: () => ({}),
  useGlobalScheduledTasksQuery: () => ({}),
  updateAssistant: fixture.update,
  createAssistant: fixture.create,
  deleteAssistant: fixture.remove,
  fetchAssistantCapability: vi.fn(),
}));

import { AssistantsSettingsPage } from './AssistantsSettingsPage';
import { useAssistantUIStore } from '@/stores/useAssistantUIStore';
import { normalizeModelIdentifier } from '@/lib/modelIdentifier';
import { resolveAssistantAvatar } from '@/lib/assistant-avatar/recipe';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
let previousSelection: string | null;
beforeEach(() => {
  vi.clearAllMocks();
  fixture.snapshot.data.assistants = [fixture.assistant];
  fixture.config.opencodeDefaultModel = undefined;
  previousSelection = useAssistantUIStore.getState().settingsSelectedAssistantID;
  useAssistantUIStore.getState().selectSettingsAssistant('asst_settings_tab');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  useAssistantUIStore.getState().selectSettingsAssistant(previousSelection);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const button = (label: string) => Array.from(host.querySelectorAll('button')).find((item) => item.textContent === label)!;

test('random avatar previews only in the draft, saves the seed, and discards unsaved edits on leaving', async () => {
  const render = () => root.render(<AssistantsSettingsPage assistantID="asst_route" />);
  const seed = () => host.querySelector('[data-avatar-seed]')?.getAttribute('data-avatar-seed');
  const shuffle = () => host.querySelector<HTMLButtonElement>('[aria-label="assistants.settings.randomAvatar"]')!.click();
  await act(async () => render());
  expect(seed()).toBe('asst_route');
  await act(async () => shuffle());
  const first = seed();
  expect(first).not.toBe('asst_route');
  await act(async () => shuffle());
  const second = seed();
  expect(second).not.toBe(first);
  expect(fixture.update).not.toHaveBeenCalled();
  await act(async () => button('assistants.settings.save').click());
  expect(fixture.update).toHaveBeenCalledWith(fixture.assistant, expect.objectContaining({ avatarSeed: second }));
  fixture.update.mockClear();
  await act(async () => shuffle());
  await act(async () => root.render(null));
  await act(async () => render());
  expect(seed()).toBe('asst_route');
  expect(fixture.update).not.toHaveBeenCalled();
});

test('route ID owns displayed and saved assistant while the Settings tab selection stays independent', async () => {
  await act(async () => root.render(<AssistantsSettingsPage assistantID="asst_route" />));
  expect(host.querySelector<HTMLInputElement>('#assistant-name')?.value).toBe('Route assistant');
  await act(async () => button('assistants.settings.save').click());
  expect(fixture.update).toHaveBeenCalledWith(fixture.assistant, expect.objectContaining({ name: 'Route assistant' }));
  expect(fixture.create).not.toHaveBeenCalled();
  expect(useAssistantUIStore.getState().settingsSelectedAssistantID).toBe('asst_settings_tab');
});

test('model selection shares the name/enabled card and no manual share-default control remains', async () => {
  await act(async () => root.render(<AssistantsSettingsPage assistantID="asst_route" />));
  const card = host.querySelector('#assistant-name')?.closest('.yuri-settings-group-card');
  expect(card?.querySelector('[data-settings-item="assistants.model"]')).not.toBeNull();
  expect(card?.textContent).toContain('assistants.settings.enabled');
  expect(host.querySelector('[data-settings-item="assistants.default-share"]')).toBeNull();
  expect(host.textContent).not.toContain('assistants.settings.defaultShare');
});

test('custom avatar configuration saves atomically with the draft; failed saves preserve the preview', async () => {
  await act(async () => root.render(<AssistantsSettingsPage assistantID="asst_route" />));
  await act(async () => host.querySelector<HTMLButtonElement>('[data-avatar-color-option="iris"]')!.click());
  await act(async () => host.querySelector<HTMLButtonElement>('[data-avatar-shape-option="flower"]')!.click());
  const seed = host.querySelector('[data-avatar-seed]')?.getAttribute('data-avatar-seed') ?? '';
  expect(resolveAssistantAvatar(seed)).toMatchObject({ color: 'iris', shape: 'flower' });
  expect(fixture.update).not.toHaveBeenCalled();
  fixture.update.mockRejectedValueOnce(new Error('revision conflict'));
  await act(async () => button('assistants.settings.save').click());
  expect(host.querySelector('[data-avatar-seed]')?.getAttribute('data-avatar-seed')).toBe(seed);
  await act(async () => button('assistants.settings.save').click());
  expect(fixture.update).toHaveBeenLastCalledWith(fixture.assistant, expect.objectContaining({ avatarSeed: seed }));
});

test('mounted settings rehydrates and saves a variant selected inside the model picker', async () => {
  await act(async () => root.render(<AssistantsSettingsPage assistantID="asst_route" />));
  expect(host.querySelector('[data-testid="model-picker"]')?.getAttribute('data-variant')).toBe('medium');
  await act(async () => button('pick-high').click());
  expect(host.querySelector('[data-testid="model-picker"]')?.getAttribute('data-variant')).toBe('high');
  await act(async () => button('assistants.settings.save').click());
  expect(fixture.update).toHaveBeenCalledWith(fixture.assistant, expect.objectContaining({
    providerID: 'provider', modelID: 'model', variant: 'high',
  }));
});

test.each(['plugin/custom#high', { providerID: 'plugin', model: 'custom', variant: 'high' }])(
  'new assistant preserves the configured default variant with a cold catalog: %j', async (model) => {
    fixture.snapshot.data.assistants = [];
    fixture.config.opencodeDefaultModel = normalizeModelIdentifier(model);
    fixture.create.mockResolvedValue(fixture.assistant);
    useAssistantUIStore.getState().requestCreate();
    await act(async () => root.render(<AssistantsSettingsPage />));
    expect(host.querySelector('[data-testid="model-picker"]')?.getAttribute('data-variant')).toBe('high');
    await act(async () => button('assistants.settings.save').click());
    expect(fixture.create).toHaveBeenCalledWith(expect.objectContaining({
      providerID: 'plugin', modelID: 'custom', variant: 'high',
    }));
  },
);

test('switching to a plain model clears the previous variant when saved', async () => {
  await act(async () => root.render(<AssistantsSettingsPage assistantID="asst_route" />));
  await act(async () => button('pick-plain').click());
  expect(host.querySelector('[data-testid="model-picker"]')?.getAttribute('data-variant')).toBe('');
  await act(async () => button('assistants.settings.save').click());
  expect(fixture.update).toHaveBeenCalledWith(fixture.assistant, expect.objectContaining({
    modelID: 'plain-model', variant: null,
  }));
});

test('new Bot draft defaults to the round capsule face and saves the customized preview', async () => {
  fixture.snapshot.data.assistants = [];
  fixture.config.opencodeDefaultModel = 'provider/model';
  fixture.create.mockResolvedValue(fixture.assistant);
  useAssistantUIStore.getState().requestCreate();
  await act(async () => root.render(<AssistantsSettingsPage />));
  const seed = () => host.querySelector('[data-avatar-seed]')?.getAttribute('data-avatar-seed') ?? '';
  const initial = seed();
  expect(resolveAssistantAvatar(initial)).toMatchObject({ shape: 'round', eyes: 'capsule', expression: 'neutral', animate: true });
  expect(host.querySelector('[data-avatar-shape-option="round"]')?.getAttribute('aria-pressed')).toBe('true');
  await act(async () => host.querySelector<HTMLButtonElement>('[data-avatar-shape-option="flower"]')!.click());
  expect(resolveAssistantAvatar(seed()).shape).toBe('flower');
  const customized = seed();
  await act(async () => button('assistants.settings.save').click());
  expect(fixture.create).toHaveBeenLastCalledWith(expect.objectContaining({ avatarSeed: customized }));
});

test('deleting the route assistant returns through its owner and preserves the Settings tab selection', async () => {
  vi.stubGlobal('confirm', vi.fn(() => true));
  const onItemDeleted = vi.fn();
  await act(async () => root.render(<AssistantsSettingsPage assistantID="asst_route" onItemDeleted={onItemDeleted} />));
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="assistants.settings.delete"]')!.click());
  expect(fixture.remove).toHaveBeenCalledWith(fixture.assistant);
  expect(onItemDeleted).toHaveBeenCalledOnce();
  expect(useAssistantUIStore.getState().settingsSelectedAssistantID).toBe('asst_settings_tab');
});

test('a missing route assistant exposes the unavailable state and keeps global selection intact', async () => {
  fixture.snapshot.data.assistants = [];
  await act(async () => root.render(<AssistantsSettingsPage assistantID="asst_route" />));
  expect(host.textContent).toContain('assistants.state.unavailable');
  expect(host.querySelector('#assistant-name')).toBeNull();
  expect(fixture.create).not.toHaveBeenCalled();
  expect(useAssistantUIStore.getState().settingsSelectedAssistantID).toBe('asst_settings_tab');
});
