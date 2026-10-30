import { describe, expect, test } from 'vitest';
import { useAssistantUIStore, type AssistantCatalogEntry } from './useAssistantUIStore';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));

describe('Assistant catalog persistence contract', () => {
  test('partitions complete snapshots by connection and keeps default identity globally unique', async () => {
    const source = await readFile(join(directory, 'useAssistantUIStore.ts'), 'utf8');
    expect(source).toContain('assistantCatalogByConnection: Record<string, AssistantCatalogPartition>');
    expect(source).toContain('defaultShareAssistant: { serverInstanceID: string; assistantID: string } | null');
    expect(source).toContain('[partition.connectionKey]');
    expect(source).toContain('entries: withFirstShareTarget(partition.entries)');
  });

  test('persists catalog metadata and safely validates persisted composite defaults', async () => {
    const source = await readFile(join(directory, 'useAssistantUIStore.ts'), 'utf8');
    expect(source).toContain('partialize: (state) => ({ assistantByTransport: state.assistantByTransport, defaultShareAssistant: state.defaultShareAssistant, assistantCatalogByConnection: state.assistantCatalogByConnection })');
    expect(source).toContain('const parseCatalogPartitions');
    expect(source).toContain('version: 4');
    expect(source).toContain('removeCatalogPartition: (connectionKey)');
  });
});

test('share default follows the first enabled catalog entry, ignoring the retired manual choice', () => {
  const state = useAssistantUIStore.getState();
  const entry = (assistantID: string, enabled = true): AssistantCatalogEntry => ({
    serverInstanceID: 'server', connectionKey: 'test-first', assistantID, enabled,
    name: assistantID, avatarSeed: assistantID, serverLabel: 'Server', isDefaultShareTarget: false,
  });
  const publish = (entries: AssistantCatalogEntry[]) => state.replaceCatalogPartition({
    serverInstanceID: 'server', connectionKey: 'test-first', revision: 1, lastLoadedAt: 1, entries,
  });
  const defaults = () => useAssistantUIStore.getState().assistantCatalogByConnection['test-first'].entries.filter((item) => item.isDefaultShareTarget).map((item) => item.assistantID);
  try {
    state.setDefaultShareAssistant({ serverInstanceID: 'server', assistantID: 'a' });
    publish([entry('z'), entry('a')]);
    expect(defaults()).toEqual(['z']);
    state.setDefaultShareAssistant(null);
    expect(defaults()).toEqual(['z']);
    publish([entry('z', false), entry('a')]);
    expect(defaults()).toEqual(['a']);
    publish([entry('z', false)]);
    expect(defaults()).toEqual([]);
    publish([]);
    expect(defaults()).toEqual([]);
  } finally {
    state.removeCatalogPartition('test-first');
    state.setDefaultShareAssistant(null);
  }
});
