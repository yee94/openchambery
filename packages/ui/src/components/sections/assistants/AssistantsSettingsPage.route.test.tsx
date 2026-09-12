import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const fixture = vi.hoisted(() => {
  const assistant = {
    id: 'asst_route', name: 'Route assistant', enabled: true,
    defaultPrompt: 'Route prompt', workspacePath: null, managedWorkspacePath: null,
    providerID: 'provider', modelID: 'model',
  };
  return {
    assistant,
    snapshot: { data: { revision: 1, assistants: [assistant] }, isSuccess: true, isPending: false, isError: false, refetch: vi.fn() },
    update: vi.fn().mockResolvedValue(assistant),
    create: vi.fn(),
    remove: vi.fn().mockResolvedValue(undefined),
    providers: { data: [] },
  };
});
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('@/components/chat/AgentAvatar', () => ({ AgentAvatar: () => null }));
vi.mock('@/components/sections/agents/ModelSelector', () => ({ ModelSelector: () => null }));
vi.mock('@/stores/useConfigStore', () => ({
  useConfigStore: { getState: () => ({ providers: [] }) },
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
  setAssistantsEnabled: vi.fn(),
}));

import { AssistantsSettingsPage } from './AssistantsSettingsPage';
import { useAssistantUIStore } from '@/stores/useAssistantUIStore';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
let previousSelection: string | null;
beforeEach(() => {
  vi.clearAllMocks();
  fixture.snapshot.data.assistants = [fixture.assistant];
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

test('route ID owns displayed and saved assistant while the Settings tab selection stays independent', async () => {
  await act(async () => root.render(<AssistantsSettingsPage assistantID="asst_route" />));
  expect(host.querySelector<HTMLInputElement>('#assistant-name')?.value).toBe('Route assistant');
  await act(async () => button('assistants.settings.save').click());
  expect(fixture.update).toHaveBeenCalledWith(fixture.assistant, expect.objectContaining({ name: 'Route assistant' }));
  expect(fixture.create).not.toHaveBeenCalled();
  expect(useAssistantUIStore.getState().settingsSelectedAssistantID).toBe('asst_settings_tab');
});

test('deleting the route assistant returns through its owner and preserves the Settings tab selection', async () => {
  vi.stubGlobal('confirm', vi.fn(() => true));
  const onItemDeleted = vi.fn();
  await act(async () => root.render(<AssistantsSettingsPage assistantID="asst_route" onItemDeleted={onItemDeleted} />));
  await act(async () => button('assistants.settings.delete').click());
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
