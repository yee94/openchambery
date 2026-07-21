import { describe, expect, test } from 'bun:test';
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
    expect(source).toContain('entry.serverInstanceID === target.serverInstanceID && entry.assistantID === target.assistantID');
  });

  test('persists catalog metadata and safely validates persisted composite defaults', async () => {
    const source = await readFile(join(directory, 'useAssistantUIStore.ts'), 'utf8');
    expect(source).toContain('partialize: (state) => ({ defaultShareAssistant: state.defaultShareAssistant, assistantCatalogByConnection: state.assistantCatalogByConnection })');
    expect(source).toContain('typeof (target as Record<string, unknown>).serverInstanceID === \'string\'');
    expect(source).toContain('removeCatalogPartition: (connectionKey)');
  });
});
