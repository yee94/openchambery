import { expect, test } from 'vitest';
import type { Message, Part } from '@/lib/opencode/v2-types';
import { createIndexedDBTranscriptDurableStore, MemoryTranscriptDurableTwoStoreDriver } from './transcript-durable-store-indexeddb';
import { createTranscriptContentSearchStore, searchIndexedDBTranscriptContent } from './transcript-content-search';

test('searches committed messages immediately, isolates scope, and follows deletion', async () => {
  const driver = new MemoryTranscriptDurableTwoStoreDriver();
  const store = createTranscriptContentSearchStore(driver);
  const scope = { transport: 'local', generation: 1, directory: '/repo', sessionID: 's1' };
  const info: Message = { id: 'm1', sessionID: 's1', role: 'user', time: { created: 10 } };
  const parts: Part[] = [{ id: 'p1', sessionID: 's1', messageID: 'm1', type: 'text', text: '青柠验收Q7319' }];
  const search = (query = '青柠') => searchIndexedDBTranscriptContent({ scope, query, driver });
  expect(await search()).toEqual([]);
  await store.upsertSettled(scope, info, parts);
  expect(await search('青柠 Q7319')).toMatchObject([{ messageID: 'm1', sessionID: 's1', snippet: '青柠验收Q7319' }]);
  expect(await searchIndexedDBTranscriptContent({ scope: { ...scope, generation: 2 }, query: '青柠', driver })).toEqual([]);
  expect(await searchIndexedDBTranscriptContent({ scope: { ...scope, directory: '/other' }, query: '青柠', driver })).toEqual([]);
  await store.removeMessage(scope, 'm1');
  expect(await search()).toEqual([]);
});

test('excludes streaming, synthetic and reasoning text and caps assistant excerpts', async () => {
  const driver = new MemoryTranscriptDurableTwoStoreDriver();
  const store = createTranscriptContentSearchStore(driver);
  const scope = { transport: 'local', generation: 1, directory: '/repo', sessionID: 's1' };
  const info: Message = { id: 'a1', sessionID: 's1', role: 'assistant', time: { created: 20 } };
  const parts: Part[] = [
    { id: 'p1', sessionID: 's1', messageID: 'a1', type: 'text', text: 'opening ' + 'x'.repeat(3000) + ' closing' },
    { id: 'p2', sessionID: 's1', messageID: 'a1', type: 'text', text: 'synthetic-secret', synthetic: true },
    { id: 'p3', sessionID: 's1', messageID: 'a1', type: 'reasoning', text: 'reasoning-secret' },
  ];
  const search = (query: string) => searchIndexedDBTranscriptContent({ scope, query, driver });
  await store.upsertSettled(scope, info, parts);
  expect(await search('opening')).toEqual([]);
  await store.upsertSettled(scope, { ...info, finish: 'stop' }, parts);
  const persisted = await createIndexedDBTranscriptDurableStore({ driver }).readMessage(scope, info.id);
  expect(persisted?.parts).toHaveLength(1);
  expect(persisted?.parts[0]?.text?.length).toBeLessThanOrEqual(2048);
  expect(await search('closing')).toMatchObject([{ role: 'assistant' }]);
  expect(await search('synthetic-secret')).toEqual([]);
  expect(await search('reasoning-secret')).toEqual([]);
  const controller = new AbortController();
  controller.abort();
  await expect(searchIndexedDBTranscriptContent({ scope, query: 'opening', driver, signal: controller.signal })).rejects.toThrow();
});
