import React from 'react';
import { useEvent, useInterval } from '@reactuses/core';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { ensureQuestionAutoDelegate, getQuestionAutoDelegateSnapshot, mutateQuestionAutoDelegate, refreshQuestionAutoDelegate, useQuestionAutoDelegate, type QuestionDelegateData } from '@/lib/questionAutoDelegate';
import { getRuntimeGeneration } from '@/lib/runtime-switch';
import type { QuestionRequest } from '@/types/question';

const DEFAULT_DELAY_MS = 30_000;

const matchRequest = (requests: QuestionDelegateData['snapshot']['requests'] | undefined, question: QuestionRequest) =>
  requests?.find((item) => item.requestID === question.id);

// eslint-disable-next-line react-refresh/only-export-components -- Hook is tightly coupled with QuestionAutoDelegateStatus / QuestionCard.
export function useQuestionDelegation(question: QuestionRequest) {
  const query = useQuestionAutoDelegate();
  const request = matchRequest(query.data?.snapshot.requests, question);
  const scope = `${getRuntimeGeneration()}:${question.sessionID}:${question.id}`;
  const [ui, setUI] = React.useState<{ scope: string; pending: 'pause' | 'delegate' | null; failed: 'pause' | 'delegate' | null }>({ scope, pending: null, failed: null });
  const pending = ui.scope === scope ? ui.pending : null;
  const failed = ui.scope === scope ? ui.failed : null;
  const [claim, setClaim] = React.useState<{ scope: string; epoch?: string } | null>(null);
  const claimed = claim?.scope === scope && (!claim.epoch || claim.epoch === query.data?.snapshot.epoch);
  const awaitingClaim = claimed && (!request || !['submitting', 'uncertain', 'settled'].includes(request.state));
  const [held, setHeld] = React.useState<{ scope: string } | null>(null);
  const heldForScope = held?.scope === scope;
  const flight = React.useRef<string | null>(null);
  const failedScope = React.useRef<string | null>(null);
  const latestScope = React.useRef(scope);
  latestScope.current = scope;
  const hold = useEvent(() => {
    if (claimed) return;
    setHeld((current) => (current?.scope === scope ? current : { scope }));
  });
  const run = useEvent(async (action: 'pause' | 'delegate', reason: 'interaction' | 'user' = 'user') => {
    if (claimed) return;
    if (action === 'pause') hold();
    if (flight.current === scope || (reason === 'interaction' && failedScope.current === scope)) return;
    const cached = getQuestionAutoDelegateSnapshot();
    const currentRequest = matchRequest(cached?.snapshot.requests, question);
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
      let identity = {
        requestID: question.id,
        sessionID: currentRequest?.sessionID || question.sessionID,
        directory: currentRequest?.directory || '',
      };
      if (action === 'delegate' && !currentRequest) {
        const data = cached ?? await ensureQuestionAutoDelegate();
        if (generation !== getRuntimeGeneration()) throw new Error('Runtime changed');
        const matched = matchRequest(data.snapshot.requests, question);
        if (!matched) throw new Error('Question identity unavailable');
        identity = { requestID: matched.requestID, sessionID: matched.sessionID, directory: matched.directory };
      }
      const outcome = await mutateQuestionAutoDelegate(action, identity, action === 'pause' ? reason : undefined);
      if (outcome === 'not_found' && action === 'pause' && reason === 'interaction') return;
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
    // First interaction holds locally and the effect below sends one pause.
    // Further input (e.g. custom textarea keystrokes) must not re-enter pause.
    if (heldForScope) return;
    hold();
  });
  const submissionClaimed = useEvent(async (submittedScope: string) => {
    if (submittedScope !== `${getRuntimeGeneration()}:${question.sessionID}:${question.id}`) return;
    setClaim({ scope, epoch: query.data?.snapshot.epoch });
    setUI({ scope, pending: null, failed: null });
    await refreshQuestionAutoDelegate();
  });
  React.useEffect(() => {
    if (!heldForScope || claimed) return;
    if (request && request.state !== 'counting') return;
    void run('pause', 'interaction');
  }, [heldForScope, claimed, request?.state, request?.requestID]);
  return { query, request, pending, failed, run, interaction, submissionClaimed, claimed, awaitingClaim, scope, held: heldForScope };
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
  const { query, request, pending, failed, run, claimed, awaitingClaim, scope, held } = delegation;
  const startedAt = React.useRef(performance.now());
  const startedScope = React.useRef(scope);
  if (startedScope.current !== scope) {
    startedScope.current = scope;
    startedAt.current = performance.now();
  }
  const locked = claimed || request?.state === 'submitting' || request?.state === 'uncertain' || request?.state === 'settled';
  const enabled = query.data?.snapshot.enabled !== false;
  const showCountdown = enabled && !awaitingClaim && !pending && !held && (!request || request.state === 'counting');
  const delayMs = query.data?.snapshot.delayMs ?? DEFAULT_DELAY_MS;
  const status = awaitingClaim ? 'chat.questionDelegate.uncertain'
    : pending ? (pending === 'pause' ? 'chat.questionDelegate.pausing' : 'chat.questionDelegate.submitting')
    : request?.state === 'submitting' ? 'chat.questionDelegate.submitting'
    : request?.state === 'uncertain' ? 'chat.questionDelegate.uncertain'
    : request?.state === 'settled' && request.submittedBy === 'auto' && request.resolution === 'replied' ? 'chat.questionDelegate.success'
    : request?.state === 'settled' ? 'chat.questionDelegate.settled'
    : !enabled ? 'chat.questionDelegate.disabled'
    : held || request?.state === 'paused' ? 'chat.questionDelegate.paused'
    : request?.state === 'disabled' ? 'chat.questionDelegate.disabled'
    : 'chat.questionDelegate.settled';
  return <div data-question-delegation-controls className="flex flex-col gap-1.5 border-t border-border/20 px-2 py-1.5">
    {showCountdown ? <LiveCountdown data={query.data} deadlineAt={request?.deadlineAt ?? null} startedAt={startedAt.current} delayMs={delayMs} /> : null}
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      {!showCountdown ? <div className="min-w-0 flex-1 basis-40 typography-micro text-muted-foreground">
        <span role="status">{t(status)}</span>
      </div> : null}
      {query.isError || failed ? <div role="alert" className="min-w-0 flex-1 basis-40 typography-micro text-[var(--status-error)]">{t(failed === 'pause' ? 'chat.questionDelegate.pauseFailed' : failed === 'delegate' ? 'chat.questionDelegate.delegateFailed' : 'chat.questionDelegate.loadFailed')}</div> : null}
      {(query.isError || failed || awaitingClaim) && <Button variant="ghost" size="xs" disabled={Boolean(pending) || query.isFetching} onClick={() => failed && !claimed ? void run(failed) : void query.refetch()}>{t(claimed ? 'chat.questionDelegate.refreshStatus' : 'chat.questionDelegate.retry')}</Button>}
      {request?.state === 'counting' && !locked && enabled && !held && <Button variant="ghost" size="xs" disabled={Boolean(pending)} onClick={() => void run('pause')}>{t('chat.questionDelegate.pause')}</Button>}
      {request && !locked && <Button variant="outline" size="xs" disabled={Boolean(pending)} onClick={() => void run('delegate')}>{t('chat.questionDelegate.delegate')}</Button>}
    </div>
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
