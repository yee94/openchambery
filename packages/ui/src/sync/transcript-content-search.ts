import {
  createIndexedDBTranscriptDurableDriver,
  createIndexedDBTranscriptDurableStore,
  type TranscriptDurableStoreDriver,
} from './transcript-durable-store-indexeddb';
import { queryClient } from '@/lib/queryRuntime';
import type { Message, Part } from '@/lib/opencode/v2-types';
import type { TranscriptDurableStore } from './transcript-durable-store';
import { isTranscriptSettled, transcriptDurableGenerationKey, transcriptPartCompleteness, type TranscriptDurableScope } from './transcript-durable-store';

const SEARCH_DATABASE = 'openchamber-transcript-search';

const searchableText = (info: Message, parts: readonly Part[]) => {
  const role = info.clientRole ?? info.role;
  if ((role !== 'user' && role !== 'assistant') || !isTranscriptSettled(info)) return '';
  let body = parts.filter((part) => part.type === 'text' && !part.synthetic && !part.ignored
    && transcriptPartCompleteness(part) === 'full').map((part) => part.text ?? '').join('\n').trim();
  if (role === 'assistant' && body.length > 2048) body = body.slice(0, 1024) + '\n' + body.slice(-1023);
  return body;
};

/** Separate excerpts remain writable when full transcript persistence is gated by reasoning visibility. */
export function createTranscriptContentSearchStore(driver?: TranscriptDurableStoreDriver): TranscriptDurableStore {
  const store = createIndexedDBTranscriptDurableStore({ databaseName: SEARCH_DATABASE, driver });
  const invalidate = (scope?: Partial<TranscriptDurableScope>) => {
    void queryClient.invalidateQueries({ predicate: ({ queryKey: key }) => key[1] === 'sessionContentSearch'
      && (!scope?.transport || key[0] === scope.transport)
      && (!scope?.directory || key[3] === scope.directory)
      && (scope?.generation === undefined || key[4] === scope.generation) });
  };
  return {
    ...store,
    async upsertSettled(scope, info, parts) {
      if (!isTranscriptSettled(info)) return { status: 'skipped', reason: 'not-settled' };
      // A slim projection cannot authoritatively replace previously indexed full text.
      if (parts.some((part) => part.type === 'text' && transcriptPartCompleteness(part) === 'slim')) {
        return { status: 'skipped', reason: 'slim-downgrade' };
      }
      const text = searchableText(info, parts);
      const result = await store.upsertSettled(scope,
        { id: info.id, sessionID: info.sessionID, role: info.role, clientRole: info.clientRole, time: info.time, finish: info.finish },
        text ? [{ id: `${info.id}:search`, sessionID: info.sessionID, messageID: info.id, type: 'text', text }] : []);
      if (result.status === 'written') invalidate(scope);
      return result;
    },
    async removeMessage(scope, id) { await store.removeMessage(scope, id); invalidate(scope); },
    async clearSession(scope) { await store.clearSession(scope); invalidate(scope); },
    async clearGeneration(scope) { await store.clearGeneration(scope); invalidate(scope); },
    async clearAll() { await store.clearAll(); invalidate(); },
  };
}

/** Search the same local records that hydration and settled events persist. */
export async function searchIndexedDBTranscriptContent(input: {
  scope: Omit<TranscriptDurableScope, 'sessionID'>;
  query: string;
  limit?: number;
  signal?: AbortSignal;
  driver?: TranscriptDurableStoreDriver;
}) {
  const terms = input.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const hits: Array<{ sessionID: string; messageID: string; directory: string; role: 'user' | 'assistant'; createdAt: number; snippet: string }> = [];
  input.signal?.throwIfAborted();
  if (!terms.length) return hits;
  const limit = Math.max(1, Math.min(50, input.limit ?? 30));
  const driver = input.driver ?? createIndexedDBTranscriptDurableDriver(SEARCH_DATABASE);
  return driver.transaction(async (transaction) => {
    const indexes = (await transaction.getIndexesByGeneration(transcriptDurableGenerationKey(input.scope)))
      .filter((row) => row.scope.directory === input.scope.directory)
      .sort((a, b) => b.sortKey.created - a.sortKey.created || b.messageID.localeCompare(a.messageID));
    // Only one message body is materialized at a time; never load all tool outputs.
    for (const index of indexes) {
      input.signal?.throwIfAborted();
      const content = await transaction.getContent(index.id);
      if (!content || !isTranscriptSettled(content.info)) continue;
      const role = content.info.clientRole ?? content.info.role;
      if (role !== 'user' && role !== 'assistant') continue;
      const body = searchableText(content.info, content.parts);
      const lower = body.toLowerCase();
      if (!terms.every((term) => lower.includes(term))) continue;
      const start = Math.max(0, Math.min(...terms.map((term) => lower.indexOf(term))) - 60);
      const end = Math.min(body.length, start + Math.max(240, terms[0].length + 60));
      hits.push({ sessionID: index.scope.sessionID, messageID: index.messageID, directory: input.scope.directory,
        role, createdAt: index.sortKey.created,
        snippet: (start ? '…' : '') + body.slice(start, end) + (end < body.length ? '…' : '') });
      if (hits.length >= limit) break;
    }
    input.signal?.throwIfAborted();
    return hits;
  }, 'readonly');
}
