/**
 * Chat transcript store: structure (ids/order) vs live-tail text stay separate
 * so SSE tokens do not rebuild the whole list (关3 / pitfalls).
 */

import type { ChatMessagePart, ChatMessageRecord } from '@/lib/sessionMessages';

export type TranscriptRow = {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'other';
  /** Stable text snapshot for completed messages. */
  text: string;
  /** True while this row is the live streaming tail. */
  streaming: boolean;
  createdAt: number;
  /** Raw parts for tool cards / reasoning disclosure (Cap MessageBody subset). */
  parts: ChatMessagePart[];
};

export type TranscriptStructure = {
  /** Ordered message ids (oldest → newest). */
  ids: string[];
  /** Generation bumps only when ids/order/role structure changes. */
  structureEpoch: number;
};

export type TranscriptState = {
  structure: TranscriptStructure;
  /** Completed / baseline text by id. */
  texts: Record<string, string>;
  roles: Record<string, TranscriptRow['role']>;
  createdAt: Record<string, number>;
  /** Parts by message id — tools/reasoning update without structure rebuild when ids stable. */
  parts: Record<string, ChatMessagePart[]>;
  /** Live streaming tail — updated independently of structure. */
  live: { messageId: string; text: string } | null;
  busy: boolean;
};

export type TranscriptApplyStats = {
  structureRebuilds: number;
  neighborTouches: number;
  liveOnlyUpdates: number;
};

const roleOf = (raw?: string): TranscriptRow['role'] => {
  if (raw === 'user' || raw === 'assistant' || raw === 'system') return raw;
  return 'other';
};

export const extractTextFromParts = (parts: ChatMessagePart[] | undefined): string => {
  if (!parts?.length) return '';
  const chunks: string[] = [];
  for (const part of parts) {
    if (part.type === 'text' && typeof part.text === 'string') {
      chunks.push(part.text);
    } else if (part.type === 'reasoning' && typeof part.text === 'string') {
      // Reasoning kept out of primary bubble for foundation; skip.
      continue;
    }
  }
  return chunks.join('');
};

export const createEmptyTranscript = (): TranscriptState => ({
  structure: { ids: [], structureEpoch: 0 },
  texts: {},
  roles: {},
  createdAt: {},
  parts: {},
  live: null,
  busy: false,
});

export type TranscriptController = {
  getState: () => TranscriptState;
  getStats: () => TranscriptApplyStats;
  resetStats: () => void;
  replaceFromRecords: (records: ChatMessageRecord[]) => void;
  applyIdentical: (records: ChatMessageRecord[]) => void;
  upsertLiveTail: (messageId: string, text: string, role?: TranscriptRow['role']) => void;
  finalizeLiveTail: (messageId: string, text: string) => void;
  /** Merge a tool/reasoning part without touching primary live text. */
  upsertLivePart: (messageId: string, part: ChatMessagePart, role?: TranscriptRow['role']) => void;
  appendLocalUser: (messageId: string, text: string) => void;
  setBusy: (busy: boolean) => void;
  /** Rows for the list — live text substituted without changing structure ids. */
  getRows: () => TranscriptRow[];
  subscribe: (listener: () => void) => () => void;
};

export const createTranscriptController = (): TranscriptController => {
  let state = createEmptyTranscript();
  const stats: TranscriptApplyStats = {
    structureRebuilds: 0,
    neighborTouches: 0,
    liveOnlyUpdates: 0,
  };
  const listeners = new Set<() => void>();

  const emit = () => {
    listeners.forEach((l) => l());
  };

  const setState = (next: TranscriptState) => {
    state = next;
    emit();
  };

  const recordsToMaps = (records: ChatMessageRecord[]) => {
    const ids: string[] = [];
    const texts: Record<string, string> = {};
    const roles: Record<string, TranscriptRow['role']> = {};
    const createdAt: Record<string, number> = {};
    const parts: Record<string, ChatMessagePart[]> = {};
    for (const record of records) {
      const id = record.info.id;
      ids.push(id);
      texts[id] = extractTextFromParts(record.parts);
      roles[id] = roleOf(typeof record.info.role === 'string' ? record.info.role : undefined);
      const created = record.info.time?.created;
      createdAt[id] = typeof created === 'number' ? created : 0;
      parts[id] = record.parts ?? [];
    }
    return { ids, texts, roles, createdAt, parts };
  };

  const sameIds = (a: string[], b: string[]) =>
    a.length === b.length && a.every((id, i) => id === b[i]);

  return {
    getState: () => state,
    getStats: () => ({ ...stats }),
    resetStats: () => {
      stats.structureRebuilds = 0;
      stats.neighborTouches = 0;
      stats.liveOnlyUpdates = 0;
    },
    replaceFromRecords: (records) => {
      const mapped = recordsToMaps(records);
      const structureChanged = !sameIds(state.structure.ids, mapped.ids);
      if (structureChanged) stats.structureRebuilds += 1;
      setState({
        structure: {
          ids: mapped.ids,
          structureEpoch: structureChanged
            ? state.structure.structureEpoch + 1
            : state.structure.structureEpoch,
        },
        texts: mapped.texts,
        roles: mapped.roles,
        createdAt: mapped.createdAt,
        parts: mapped.parts,
        live: null,
        busy: state.busy,
      });
    },
    applyIdentical: (records) => {
      const mapped = recordsToMaps(records);
      if (sameIds(state.structure.ids, mapped.ids)) {
        // Same structure — update texts only; no structure rebuild.
        setState({
          ...state,
          texts: mapped.texts,
          roles: { ...state.roles, ...mapped.roles },
          createdAt: { ...state.createdAt, ...mapped.createdAt },
          parts: mapped.parts,
        });
        return;
      }
      stats.structureRebuilds += 1;
      setState({
        structure: {
          ids: mapped.ids,
          structureEpoch: state.structure.structureEpoch + 1,
        },
        texts: mapped.texts,
        roles: mapped.roles,
        createdAt: mapped.createdAt,
        parts: mapped.parts,
        live: state.live,
        busy: state.busy,
      });
    },
    upsertLiveTail: (messageId, text, role = 'assistant') => {
      const hasId = state.structure.ids.includes(messageId);
      if (!hasId) {
        stats.structureRebuilds += 1;
        stats.neighborTouches += 0; // new row at end — neighbors not rebuilt by id list append
        setState({
          structure: {
            ids: [...state.structure.ids, messageId],
            structureEpoch: state.structure.structureEpoch + 1,
          },
          texts: { ...state.texts, [messageId]: '' },
          roles: { ...state.roles, [messageId]: role },
          createdAt: { ...state.createdAt, [messageId]: Date.now() },
          parts: {
            ...state.parts,
            [messageId]: state.parts[messageId] ?? [{ type: 'text', text: '' }],
          },
          live: { messageId, text },
          busy: true,
        });
        stats.liveOnlyUpdates += 1;
        return;
      }
      // Same ids — only live pointer changes; neighbors untouched.
      stats.liveOnlyUpdates += 1;
      setState({
        ...state,
        roles: state.roles[messageId] ? state.roles : { ...state.roles, [messageId]: role },
        live: { messageId, text },
        busy: true,
      });
    },
    finalizeLiveTail: (messageId, text) => {
      stats.liveOnlyUpdates += 1;
      const existingParts = state.parts[messageId] ?? [];
      const withoutText = existingParts.filter((p) => p.type !== 'text');
      const nextParts = text
        ? [...withoutText, { type: 'text', text }]
        : withoutText;
      setState({
        ...state,
        texts: { ...state.texts, [messageId]: text },
        parts: { ...state.parts, [messageId]: nextParts },
        live: state.live?.messageId === messageId ? null : state.live,
        busy: false,
      });
    },
    upsertLivePart: (messageId, part, role = 'assistant') => {
      const hasId = state.structure.ids.includes(messageId);
      const existing = state.parts[messageId] ?? [];
      const id = typeof part.id === 'string' ? part.id : null;
      let nextParts: ChatMessagePart[];
      if (id) {
        const idx = existing.findIndex((p) => p.id === id);
        if (idx >= 0) {
          nextParts = existing.slice();
          nextParts[idx] = { ...existing[idx], ...part };
        } else {
          nextParts = [...existing, part];
        }
      } else {
        nextParts = [...existing, part];
      }
      stats.liveOnlyUpdates += 1;
      if (!hasId) {
        stats.structureRebuilds += 1;
        setState({
          structure: {
            ids: [...state.structure.ids, messageId],
            structureEpoch: state.structure.structureEpoch + 1,
          },
          texts: { ...state.texts, [messageId]: state.texts[messageId] ?? '' },
          roles: { ...state.roles, [messageId]: role },
          createdAt: { ...state.createdAt, [messageId]: Date.now() },
          parts: { ...state.parts, [messageId]: nextParts },
          live: state.live,
          busy: true,
        });
        return;
      }
      setState({
        ...state,
        roles: state.roles[messageId] ? state.roles : { ...state.roles, [messageId]: role },
        parts: { ...state.parts, [messageId]: nextParts },
        busy: true,
      });
    },
    appendLocalUser: (messageId, text) => {
      if (state.structure.ids.includes(messageId)) return;
      stats.structureRebuilds += 1;
      setState({
        structure: {
          ids: [...state.structure.ids, messageId],
          structureEpoch: state.structure.structureEpoch + 1,
        },
        texts: { ...state.texts, [messageId]: text },
        roles: { ...state.roles, [messageId]: 'user' },
        createdAt: { ...state.createdAt, [messageId]: Date.now() },
        parts: { ...state.parts, [messageId]: [{ type: 'text', text }] },
        live: state.live,
        busy: true,
      });
    },
    setBusy: (busy) => {
      if (state.busy === busy) return;
      setState({ ...state, busy });
    },
    getRows: () => {
      const { structure, texts, roles, createdAt, parts, live } = state;
      return structure.ids.map((id) => {
        const streaming = live?.messageId === id;
        const baseParts = parts[id] ?? [];
        // While streaming text, keep tool/reasoning parts and replace/append primary text.
        let rowParts = baseParts;
        if (streaming) {
          const nonText = baseParts.filter((p) => p.type !== 'text');
          rowParts = [...nonText, { type: 'text', text: live!.text }];
        }
        return {
          id,
          role: roles[id] ?? 'other',
          text: streaming ? live!.text : (texts[id] ?? ''),
          streaming,
          createdAt: createdAt[id] ?? 0,
          parts: rowParts,
        };
      });
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};
