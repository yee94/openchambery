import React from 'react';
import { useEvent, useInterval } from '@reactuses/core';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { refreshQuestionAutoDelegate, useQuestionAutoDelegate, type QuestionDelegateData } from '@/lib/questionAutoDelegate';
import { getRuntimeGeneration } from '@/lib/runtime-switch';
import type { QuestionRequest } from '@/types/question';
import { discardQuestionDraft, useQuestionDraftStore } from './questionDraftStore';

const DEFAULT_DELAY_MS = 30_000;

const matchRequest = (requests: QuestionDelegateData['snapshot']['requests'] | undefined, question: QuestionRequest) =>
  requests?.find((item) => item.requestID === question.id);

// eslint-disable-next-line react-refresh/only-export-components -- Hook is tightly coupled with QuestionAutoDelegateStatus / QuestionCard.
export function useQuestionDelegation(question: QuestionRequest) {
  const query = useQuestionAutoDelegate();
  const request = matchRequest(query.data?.snapshot.requests, question);
  const scope = `${getRuntimeGeneration()}:${question.sessionID}:${question.id}`;
  const [claim, setClaim] = React.useState<{ scope: string; epoch?: string } | null>(null);
  const claimed = claim?.scope === scope && (!claim.epoch || claim.epoch === query.data?.snapshot.epoch);
  const awaitingClaim = claimed && (!request || !['submitting', 'uncertain', 'settled'].includes(request.state));
  const submissionClaimed = useEvent(async (submittedScope: string) => {
    if (submittedScope !== `${getRuntimeGeneration()}:${question.sessionID}:${question.id}`) return;
    setClaim({ scope, epoch: query.data?.snapshot.epoch });
    await refreshQuestionAutoDelegate();
  });
  return { query, request, submissionClaimed, claimed, awaitingClaim, scope };
}

type Delegation = ReturnType<typeof useQuestionDelegation>;

function DelegateBar({ remaining, delayMs }: { remaining: number; delayMs: number }) {
  return <div data-question-delegate-bar aria-hidden className="h-1 w-full overflow-hidden rounded-full bg-muted/40">
    <div className="h-full origin-left bg-primary/70 transition-transform duration-300 ease-linear motion-reduce:transition-none" style={{ transform: `scaleX(${delayMs > 0 ? Math.min(1, remaining / delayMs) : 0})` }} />
  </div>;
}

function LiveCountdown({ data, deadlineAt, startedAt, delayMs }: {
  data?: QuestionDelegateData;
  deadlineAt: number | null;
  startedAt: number;
  delayMs: number;
}) {
  const { t } = useI18n();
  const [, tick] = React.useReducer((value: number) => value + 1, 0);
  const remaining = Math.max(0, deadlineAt != null && data
    ? deadlineAt - data.snapshot.serverNow - (performance.now() - data.receivedAt)
    : delayMs - (performance.now() - startedAt));
  useInterval(tick, remaining > 0 ? 250 : null);
  return <div className="flex min-w-0 flex-1 flex-col gap-1">
    <span className="typography-micro tabular-nums text-muted-foreground" role="status">
      {remaining > 0 ? t('chat.questionDelegate.countdown', { seconds: Math.ceil(remaining / 1000) }) : t('chat.questionDelegate.awaiting')}
    </span>
    <DelegateBar remaining={remaining} delayMs={delayMs} />
  </div>;
}

export function QuestionAutoDelegateStatus({ delegation }: { delegation: Delegation }) {
  const { t } = useI18n();
  const { query, request, claimed, awaitingClaim, scope } = delegation;
  const startedAt = React.useRef(performance.now());
  const startedScope = React.useRef(scope);
  if (startedScope.current !== scope) {
    startedScope.current = scope;
    startedAt.current = performance.now();
  }
  const enabled = query.data?.snapshot.enabled !== false;
  const showCountdown = enabled && !awaitingClaim && (!request || request.state === 'counting');
  const delayMs = query.data?.snapshot.delayMs ?? DEFAULT_DELAY_MS;
  const status = awaitingClaim ? 'chat.questionDelegate.uncertain'
    : request?.state === 'submitting' ? 'chat.questionDelegate.submitting'
    : request?.state === 'uncertain' ? 'chat.questionDelegate.uncertain'
    : request?.state === 'settled' && request.submittedBy === 'auto' && request.resolution === 'replied' ? 'chat.questionDelegate.success'
    : request?.state === 'settled' ? 'chat.questionDelegate.settled'
    : !enabled ? 'chat.questionDelegate.disabled'
    : request?.state === 'disabled' ? 'chat.questionDelegate.disabled'
    : 'chat.questionDelegate.settled';
  if (request?.state === 'paused' && !awaitingClaim && !query.isError) return null;
  return <div data-question-delegation-controls className="flex flex-col gap-1.5 border-t border-border/20 px-2 py-1.5">
    {showCountdown ? <LiveCountdown data={query.data} deadlineAt={request?.deadlineAt ?? null} startedAt={startedAt.current} delayMs={delayMs} /> : request?.state !== 'paused' || awaitingClaim ? (
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span role="status" className="typography-micro text-muted-foreground">{t(status)}</span>
        <div aria-hidden className="h-1" />
      </div>
    ) : null}
    {query.isError ? <div role="alert" className="typography-micro text-[var(--status-error)]">{t('chat.questionDelegate.loadFailed')}</div> : null}
    {(query.isError || awaitingClaim) && <div className="flex min-h-6 flex-wrap items-center gap-x-2 gap-y-1">
      <Button variant="ghost" size="xs" disabled={query.isFetching} onClick={() => void query.refetch()}>{t(claimed ? 'chat.questionDelegate.refreshStatus' : 'chat.questionDelegate.retry')}</Button>
    </div>}
  </div>;
}

// Lives alongside the transcript so question.replied can remove a card before the GET settles.
export function QuestionAutoDelegateNotifications() {
  const query = useQuestionAutoDelegate();
  const { t } = useI18n();
  const generation = getRuntimeGeneration();
  const previous = React.useRef<{ generation: number; data: QuestionDelegateData } | undefined>(undefined);
  React.useEffect(() => {
    const next = query.data;
    if (!next) return;
    const settledIDs = new Set(next.snapshot.requests.filter((request) => request.state === 'settled').map((request) => request.requestID));
    for (const scope of Object.keys(useQuestionDraftStore.getState().drafts)) {
      if (scope.startsWith(`${generation}:`) && settledIDs.has(scope.slice(scope.lastIndexOf(':') + 1))) discardQuestionDraft(scope);
    }
    const prior = previous.current;
    previous.current = { generation, data: next };
    if (!prior || prior.generation !== generation) return;
    const before = prior.data;
    if (before.snapshot.epoch !== next.snapshot.epoch || before.snapshot.revision === next.snapshot.revision) return;
    if (document.visibilityState !== 'visible') return;
    const previousRequests = new Map(before.snapshot.requests.map((item) => [item.requestID, item]));
    for (const request of next.snapshot.requests) {
      const old = previousRequests.get(request.requestID);
      if (old?.state !== 'settled' && request.state === 'settled' && request.submittedBy === 'auto' && request.resolution === 'replied') {
        toast.success(t('chat.questionDelegate.success'), { id: `question-delegate:${next.snapshot.epoch}:${request.requestID}` });
      }
    }
  }, [generation, query.data, t]);
  return null;
}
