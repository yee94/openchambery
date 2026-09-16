import { queryOptions, useQuery } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { z } from 'zod';
import type { QuestionAutoDelegateSnapshot, QuestionAutoDelegateMutationResult } from '../../../web/server/lib/question-auto-delegate/core';
import { runtimeFetch } from './runtime-fetch';
import { queryClient } from './queryRuntime';
import { getRuntimeGeneration, getRuntimeTransportIdentity, subscribeRuntimeEndpointChanged } from './runtime-switch';

const snapshotSchema = z.object({
  epoch: z.string().min(1), revision: z.number().int().nonnegative(), serverNow: z.number(),
  enabled: z.boolean(), delayMs: z.literal(30000),
  coverage: z.object({ state: z.enum(['ready', 'reconciling', 'partial']), failedDirectories: z.array(z.string()) }),
  requests: z.array(z.object({
    requestID: z.string(), sessionID: z.string(), directory: z.string(), questionCount: z.number(),
    state: z.enum(['counting', 'paused', 'disabled', 'submitting', 'uncertain', 'settled']),
    deadlineAt: z.number().nullable(), pauseReason: z.enum(['interaction', 'user', 'goal']).nullable(),
    submittedBy: z.enum(['manual', 'auto']).nullable(), resolution: z.enum(['replied', 'rejected', 'external']).nullable(),
  })),
});
const mutationSchema = z.object({
  outcome: z.enum(['ok', 'paused', 'delegated', 'submitted', 'claimed', 'uncertain', 'settled', 'not_found', 'disabled', 'error']),
  snapshot: snapshotSchema,
});

export interface QuestionDelegateData {
  snapshot: QuestionAutoDelegateSnapshot;
  receivedAt: number;
  sequence: number;
  retiredEpochs: string[];
}

let sequence = 0;
const capture = () => ({ transport: getRuntimeTransportIdentity(), generation: getRuntimeGeneration() });
type Runtime = ReturnType<typeof capture>;
const current = (runtime: Runtime) => runtime.transport === getRuntimeTransportIdentity() && runtime.generation === getRuntimeGeneration();
const key = (runtime: Runtime) => [runtime.transport, 'question-auto-delegate', runtime.generation] as const;

// Revisions order one host lifetime; request sequence and retired epochs guard host restarts.
export function mergeQuestionDelegateData(previous: QuestionDelegateData | undefined, next: QuestionDelegateData): QuestionDelegateData {
  if (!previous) return next;
  if (previous.snapshot.epoch === next.snapshot.epoch) {
    if (next.snapshot.revision < previous.snapshot.revision ||
      (next.snapshot.revision === previous.snapshot.revision && next.sequence < previous.sequence)) return previous;
    return { ...next, sequence: Math.max(previous.sequence, next.sequence), retiredEpochs: previous.retiredEpochs };
  }
  if (next.sequence < previous.sequence || previous.retiredEpochs.includes(next.snapshot.epoch)) return previous;
  return { ...next, retiredEpochs: [...previous.retiredEpochs, previous.snapshot.epoch] };
}

const dataFrom = (snapshot: QuestionAutoDelegateSnapshot, requestSequence: number): QuestionDelegateData => ({
  snapshot, receivedAt: performance.now(), sequence: requestSequence, retiredEpochs: [],
});

export function questionAutoDelegateQueryOptions(runtime = capture()) {
  return queryOptions({
    queryKey: key(runtime),
    queryFn: async ({ signal }) => {
      if (!current(runtime)) throw new Error('Runtime changed');
      const requestSequence = ++sequence;
      const response = await runtimeFetch('/api/question-auto-delegate', { signal });
      if (!response.ok) throw new Error(`Question snapshot: ${response.status}`);
      const snapshot = snapshotSchema.parse(await response.json());
      if (!current(runtime) || signal.aborted) throw new Error('Runtime changed');
      return dataFrom(snapshot, requestSequence);
    },
    structuralSharing: (previous, next) => mergeQuestionDelegateData(previous as QuestionDelegateData | undefined, next as QuestionDelegateData),
    staleTime: Infinity,
    retry: 1,
    refetchOnWindowFocus: 'always',
  });
}

export function useQuestionAutoDelegate() {
  useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeGeneration, getRuntimeGeneration);
  return useQuery(questionAutoDelegateQueryOptions(), queryClient);
}

export const getQuestionAutoDelegateSnapshot = () => queryClient.getQueryData(questionAutoDelegateQueryOptions().queryKey);
export const ensureQuestionAutoDelegate = () => queryClient.ensureQueryData(questionAutoDelegateQueryOptions());
export const refreshQuestionAutoDelegate = async () => {
  const queryKey = key(capture());
  await queryClient.cancelQueries({ queryKey, exact: true }, { revert: false });
  await queryClient.invalidateQueries({ queryKey, exact: true });
};

export async function mutateQuestionAutoDelegate(
  action: 'pause' | 'delegate',
  identity: { requestID: string; sessionID: string; directory: string },
  reason?: 'interaction' | 'user',
): Promise<QuestionAutoDelegateMutationResult['outcome']> {
  const runtime = capture();
  const requestSequence = ++sequence;
  const response = await runtimeFetch(`/api/question-auto-delegate/requests/${encodeURIComponent(identity.requestID)}/${action}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionID: identity.sessionID, directory: identity.directory, ...(reason ? { reason } : {}) }),
  });
  const result = mutationSchema.parse(await response.json());
  if (!current(runtime)) throw new Error('Runtime changed');
  queryClient.setQueryData(key(runtime), (previous: QuestionDelegateData | undefined) =>
    mergeQuestionDelegateData(previous, dataFrom(result.snapshot, requestSequence)));
  void refreshQuestionAutoDelegate();
  if (!response.ok && !['claimed', 'uncertain'].includes(result.outcome)) throw new Error(`Question ${action}: ${response.status}`);
  return result.outcome;
}
