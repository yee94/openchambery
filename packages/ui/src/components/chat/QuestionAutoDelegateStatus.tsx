import React from 'react';
import { useEvent, useInterval } from '@reactuses/core';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { ensureQuestionAutoDelegate, getQuestionAutoDelegateSnapshot, mutateQuestionAutoDelegate, refreshQuestionAutoDelegate, useQuestionAutoDelegate, type QuestionDelegateData } from '@/lib/questionAutoDelegate';
import { getRuntimeGeneration } from '@/lib/runtime-switch';
import type { QuestionRequest } from '@/types/question';

// eslint-disable-next-line react-refresh/only-export-components -- Hook is tightly coupled with QuestionAutoDelegateStatus / QuestionCard.
export function useQuestionDelegation(question: QuestionRequest) {
  const query = useQuestionAutoDelegate();
  const request = query.data?.snapshot.requests.find((item) => item.requestID === question.id && item.sessionID === question.sessionID);
  const scope = `${getRuntimeGeneration()}:${question.sessionID}:${question.id}`;
  const [ui, setUI] = React.useState<{ scope: string; pending: 'pause' | 'delegate' | null; failed: 'pause' | 'delegate' | null }>({ scope, pending: null, failed: null });
  const pending = ui.scope === scope ? ui.pending : null;
  const failed = ui.scope === scope ? ui.failed : null;
  const [claim, setClaim] = React.useState<{ scope: string; epoch?: string } | null>(null);
  const claimed = claim?.scope === scope && (!claim.epoch || claim.epoch === query.data?.snapshot.epoch);
  const awaitingClaim = claimed && (!request || !['submitting', 'uncertain', 'settled'].includes(request.state));
  const flight = React.useRef<string | null>(null);
  const failedScope = React.useRef<string | null>(null);
  const latestScope = React.useRef(scope);
  latestScope.current = scope;
  const run = useEvent(async (action: 'pause' | 'delegate', reason: 'interaction' | 'user' = 'user') => {
    if (claimed) return;
    if (flight.current === scope || (reason === 'interaction' && failedScope.current === scope)) return;
    const cached = getQuestionAutoDelegateSnapshot();
    const currentRequest = cached?.snapshot.requests.find((item) => item.requestID === question.id && item.sessionID === question.sessionID);
    if (currentRequest && ((action === 'pause' && currentRequest.state !== 'counting') ||
      ['submitting', 'uncertain', 'settled'].includes(currentRequest.state))) {
      if (reason === 'user') {
        setUI({ scope, pending: null, failed: null });
        failedScope.current = null;
        void refreshQuestionAutoDelegate();
      }
      return;
    }
    const generation = getRuntimeGeneration();
    flight.current = scope;
    failedScope.current = null;
    setUI({ scope, pending: action, failed: null });
    const startedScope = scope;
    try {
      const data = cached ?? await ensureQuestionAutoDelegate();
      if (generation !== getRuntimeGeneration()) throw new Error('Runtime changed');
      const identity = data.snapshot.requests.find((item) => item.requestID === question.id && item.sessionID === question.sessionID);
      if (!identity) throw new Error('Question identity unavailable');
      if ((action === 'pause' && identity.state !== 'counting') || ['submitting', 'uncertain', 'settled'].includes(identity.state)) return;
      const outcome = await mutateQuestionAutoDelegate(action, identity, action === 'pause' ? reason : undefined);
      if (['error', 'not_found', 'disabled'].includes(outcome)) throw new Error('Question operation failed');
    } catch {
      if (latestScope.current === startedScope) {
        failedScope.current = startedScope;
        setUI({ scope: startedScope, pending: action, failed: action });
      }
    } finally {
      if (flight.current === startedScope) flight.current = null;
      if (latestScope.current === startedScope) setUI((state) => ({ ...state, pending: null }));
    }
  });
  const interaction = useEvent((event: React.SyntheticEvent<HTMLElement>) => {
    if ((event.target as Element).closest('[data-question-delegation-controls]')) return;
    void run('pause', 'interaction');
  });
  const submissionClaimed = useEvent(async (submittedScope: string) => {
    if (submittedScope !== `${getRuntimeGeneration()}:${question.sessionID}:${question.id}`) return;
    setClaim({ scope, epoch: query.data?.snapshot.epoch });
    setUI({ scope, pending: null, failed: null });
    await refreshQuestionAutoDelegate();
  });
  return { query, request, pending, failed, run, interaction, submissionClaimed, claimed, awaitingClaim, scope };
}

type Delegation = ReturnType<typeof useQuestionDelegation>;

function Countdown({ data, deadlineAt }: { data: QuestionDelegateData; deadlineAt: number }) {
  const { t } = useI18n();
  const [, tick] = React.useReducer((value: number) => value + 1, 0);
  const remaining = Math.max(0, deadlineAt - data.snapshot.serverNow - (performance.now() - data.receivedAt));
  useInterval(tick, remaining > 0 ? 250 : null);
  return <>
    <span className="typography-micro tabular-nums text-muted-foreground">
      {remaining > 0 ? t('chat.questionDelegate.countdown', { seconds: Math.ceil(remaining / 1000) }) : t('chat.questionDelegate.awaiting')}
    </span>
    <div aria-hidden className="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden rounded-b-xl bg-muted/30">
      <div className="h-full origin-left bg-primary/60 transition-transform duration-300 ease-linear motion-reduce:transition-none" style={{ transform: `scaleX(${Math.min(1, remaining / data.snapshot.delayMs)})` }} />
    </div>
  </>;
}

export function QuestionAutoDelegateStatus({ delegation }: { delegation: Delegation }) {
  const { t } = useI18n();
  const { query, request, pending, failed, run, claimed, awaitingClaim } = delegation;
  const locked = claimed || request?.state === 'submitting' || request?.state === 'uncertain' || request?.state === 'settled';
  const stale = query.isError || query.data?.snapshot.coverage.state !== 'ready';
  return <div data-question-delegation-controls className="relative flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-border/20 px-2 py-1.5 pb-2">
    <div className="min-w-0 flex-1 basis-40 typography-micro text-muted-foreground">
      {awaitingClaim ? <span role="status">{t('chat.questionDelegate.uncertain')}</span>
        : pending ? <span role="status">{t(pending === 'pause' ? 'chat.questionDelegate.pausing' : 'chat.questionDelegate.submitting')}</span>
        : request?.state === 'counting' && request.deadlineAt !== null && query.data
          ? <Countdown data={query.data} deadlineAt={request.deadlineAt} />
          : <span role="status">{t(request?.state === 'paused' ? 'chat.questionDelegate.paused'
            : request?.state === 'disabled' ? 'chat.questionDelegate.disabled'
              : request?.state === 'submitting' ? 'chat.questionDelegate.submitting'
                : request?.state === 'uncertain' ? 'chat.questionDelegate.uncertain'
                  : request?.state === 'settled' ? (request.submittedBy === 'auto' && request.resolution === 'replied' ? 'chat.questionDelegate.success' : 'chat.questionDelegate.settled')
                    : 'common.loading')}</span>}
      {stale && query.data ? <div role="status">{t('chat.questionDelegate.stale')}</div> : null}
      {query.isError || failed ? <div role="alert" className="text-[var(--status-error)]">{t(failed === 'pause' ? 'chat.questionDelegate.pauseFailed' : failed === 'delegate' ? 'chat.questionDelegate.delegateFailed' : 'chat.questionDelegate.loadFailed')}</div> : null}
    </div>
    {(query.isError || failed || awaitingClaim) && <Button variant="ghost" size="xs" disabled={Boolean(pending) || query.isFetching} onClick={() => failed && !claimed ? void run(failed) : void query.refetch()}>{t(claimed ? 'chat.questionDelegate.refreshStatus' : 'chat.questionDelegate.retry')}</Button>}
    {request?.state === 'counting' && !locked && <Button variant="ghost" size="xs" disabled={Boolean(pending)} onClick={() => void run('pause')}>{t('chat.questionDelegate.pause')}</Button>}
    {request && !locked && <Button variant="outline" size="xs" disabled={Boolean(pending)} onClick={() => void run('delegate')}>{t('chat.questionDelegate.delegate')}</Button>}
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
