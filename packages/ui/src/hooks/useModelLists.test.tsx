import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import { useModelLists, type ModelListItem } from './useModelLists';

const providers = [
  {
    id: 'openai',
    name: 'OpenAI',
    models: [
      { id: 'gpt-4.1', name: 'GPT-4.1' },
      { id: 'o3', name: 'o3' },
      { id: 'gpt-5', name: 'GPT-5' },
    ],
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    models: [
      { id: 'claude-sonnet-4', name: 'Claude Sonnet 4' },
      { id: 'claude-opus-4', name: 'Claude Opus 4' },
    ],
  },
] as never;

beforeEach(() => {
  useConfigStore.setState({ providers } as never);
  useUIStore.setState({
    favoriteModels: [],
    recentModels: [],
    hiddenModels: [],
  });
});

afterEach(() => {
  document.body.innerHTML = '';
});

type ModelListsResult = {
  favoriteModelsList: ModelListItem[];
  recentModelsList: ModelListItem[];
};

async function renderLists(options?: {
  currentProviderID?: string | null;
  currentModelID?: string | null;
}): Promise<ModelListsResult> {
  const box: { current: ModelListsResult | null } = { current: null };
  const Probe = () => {
    box.current = useModelLists(options);
    return null;
  };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<Probe />);
  });
  await act(async () => {
    root.unmount();
  });
  if (!box.current) throw new Error('hook did not render');
  return box.current;
}

describe('useModelLists current selection pin', () => {
  test('pins the current session model to the top of recent when it is missing', async () => {
    useUIStore.setState({
      recentModels: [
        { providerID: 'openai', modelID: 'gpt-4.1' },
        { providerID: 'openai', modelID: 'o3' },
      ],
    });

    const { recentModelsList } = await renderLists({
      currentProviderID: 'anthropic',
      currentModelID: 'claude-opus-4',
    });

    expect(recentModelsList.map((item) => `${item.providerID}/${item.modelID}`)).toEqual([
      'anthropic/claude-opus-4',
      'openai/gpt-4.1',
      'openai/o3',
    ]);
  });

  test('moves an existing recent model to the top when it is current', async () => {
    useUIStore.setState({
      recentModels: [
        { providerID: 'openai', modelID: 'gpt-4.1' },
        { providerID: 'anthropic', modelID: 'claude-sonnet-4' },
        { providerID: 'openai', modelID: 'o3' },
      ],
    });

    const { recentModelsList } = await renderLists({
      currentProviderID: 'anthropic',
      currentModelID: 'claude-sonnet-4',
    });

    expect(recentModelsList.map((item) => `${item.providerID}/${item.modelID}`)).toEqual([
      'anthropic/claude-sonnet-4',
      'openai/gpt-4.1',
      'openai/o3',
    ]);
  });

  test('does not duplicate current model into recent when it is already a favorite', async () => {
    useUIStore.setState({
      favoriteModels: [{ providerID: 'anthropic', modelID: 'claude-opus-4' }],
      recentModels: [{ providerID: 'openai', modelID: 'gpt-4.1' }],
    });

    const { favoriteModelsList, recentModelsList } = await renderLists({
      currentProviderID: 'anthropic',
      currentModelID: 'claude-opus-4',
    });

    expect(favoriteModelsList.map((item) => `${item.providerID}/${item.modelID}`)).toEqual([
      'anthropic/claude-opus-4',
    ]);
    expect(recentModelsList.map((item) => `${item.providerID}/${item.modelID}`)).toEqual([
      'openai/gpt-4.1',
    ]);
  });

  test('leaves recent unchanged when no current selection is provided', async () => {
    useUIStore.setState({
      recentModels: [{ providerID: 'openai', modelID: 'gpt-4.1' }],
    });

    const { recentModelsList } = await renderLists();

    expect(recentModelsList.map((item) => `${item.providerID}/${item.modelID}`)).toEqual([
      'openai/gpt-4.1',
    ]);
  });

  test('passes remembered variants through favorite and recent list items', async () => {
    useUIStore.setState({
      favoriteModels: [{ providerID: 'anthropic', modelID: 'claude-opus-4', variant: 'high' }],
      recentModels: [{ providerID: 'openai', modelID: 'gpt-4.1', variant: 'low' }],
    });

    const { favoriteModelsList, recentModelsList } = await renderLists();

    expect(favoriteModelsList).toEqual([
      expect.objectContaining({
        providerID: 'anthropic',
        modelID: 'claude-opus-4',
        variant: 'high',
      }),
    ]);
    expect(recentModelsList).toEqual([
      expect.objectContaining({
        providerID: 'openai',
        modelID: 'gpt-4.1',
        variant: 'low',
      }),
    ]);
  });
});
