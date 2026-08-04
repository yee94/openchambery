import React from 'react';
import { useEvent } from '@reactuses/core';
import { Icon } from '@/components/icon/Icon';
import { useSessionStatus } from '@/sync/sync-context';
import { useGoalObjectiveContent, useSessionGoal } from '@/hooks/useSessionGoal';
import { formatGoalDuration, formatGoalTokens } from '@/lib/sessionGoalMetadata';
import { sessionGoalStatusColor, sessionGoalStatusLabelKey } from '@/lib/sessionGoalPresentation';
import { setSessionGoalStatus } from '@/lib/sessionGoalActions';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { cn } from '@/lib/utils';

interface SessionGoalRowProps {
  sessionId: string | null;
  directory?: string;
  className?: string;
}

// Compact goal strip near the composer: informational only — status,
// objective (or the latest audit note), elapsed time + token spend — plus
// an inline pause/resume action. Outer shell (border/surface/radius) is
// owned by the composer queue stack when rendered as its trailing strip.
export const SessionGoalRow: React.FC<SessionGoalRowProps> = React.memo(({ sessionId, directory, className }) => {
  const { t } = useI18n();
  const isMobile = useUIStore((state) => state.isMobile);
  const { goal, enabled } = useSessionGoal(sessionId ?? '', directory);
  const objectiveContent = useGoalObjectiveContent(sessionId ?? '', goal);
  const sessionStatus = useSessionStatus(sessionId ?? '', directory);
  const [busy, setBusy] = React.useState(false);
  // Tick so the elapsed label advances while the goal is live without
  // depending on session.updated fanout for wall-clock display.
  const [now, setNow] = React.useState(() => Date.now());

  React.useEffect(() => {
    if (!goal || goal.status === 'complete' || goal.status === 'blocked' || goal.status === 'budgetLimited') {
      return undefined;
    }
    const id = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, [goal?.id, goal?.status]);

  const handleToggleStatus = useEvent(async (nextStatus: 'active' | 'paused') => {
    if (!sessionId || busy) return;
    setBusy(true);
    try {
      await setSessionGoalStatus(sessionId, directory, nextStatus);
    } catch (error) {
      console.warn('[session-goal] status change failed:', error);
      toast.error(t('chat.goal.toast.actionFailed'));
    } finally {
      setBusy(false);
    }
  });

  if (!sessionId || !enabled || !goal) {
    return null;
  }

  const elapsedMs = Math.max(0, (goal.status === 'complete' || goal.status === 'blocked' || goal.status === 'budgetLimited'
    ? goal.updatedAt
    : now) - (goal.createdAt || now));
  const durationLabel = formatGoalDuration(elapsedMs);
  // Compact strip: just the abbreviated count (and optional budget). Dialog
  // keeps the fuller "tokens" phrasing via its own keys.
  const tokensLabel = goal.tokenBudget
    ? `${formatGoalTokens(goal.tokensUsed)}/${formatGoalTokens(goal.tokenBudget)}`
    : (goal.tokensUsed > 0 ? formatGoalTokens(goal.tokensUsed) : null);

  const pauseResume = goal.status === 'active'
    ? { icon: 'pause' as const, labelKey: 'chat.goal.action.pause' as const, next: 'paused' as const }
    : (goal.status === 'paused' || goal.status === 'blocked' || goal.status === 'budgetLimited'
      ? { icon: 'play' as const, labelKey: 'chat.goal.action.resume' as const, next: 'active' as const }
      : null);

  const metaClass = isMobile
    ? 'text-[11px] leading-none text-muted-foreground'
    : 'typography-meta text-muted-foreground';
  const titleClass = isMobile
    ? 'text-xs leading-5 text-foreground'
    : 'typography-ui-label leading-5 text-foreground';
  const iconClass = isMobile ? 'size-3' : 'size-3.5';

  return (
    <div
      className={cn(
        // Match queue chip row geometry: compact mobile heights, desktop label scale.
        'flex w-full min-w-0 items-center',
        isMobile ? 'gap-1 py-0.5' : 'gap-1.5 py-0.5 md:gap-2',
        className,
      )}
      aria-label={t('chat.goal.row.aria')}
      title={objectiveContent ?? undefined}
    >
      <Icon
        name="target"
        className={cn(iconClass, 'flex-shrink-0')}
        style={{ color: sessionGoalStatusColor[goal.status] }}
        aria-hidden="true"
      />
      <span className={cn('min-w-0 flex-1 truncate', titleClass)}>
        {goal.note || objectiveContent || ''}
      </span>
      {goal.status === 'active' && (!sessionStatus || sessionStatus.type === 'idle') ? (
        // The agent stopped but the goal is still active: the server is
        // sitting out the quiet window and running the audit — show that
        // instead of a static "Active" that looks stuck.
        <span className={cn('flex flex-shrink-0 items-center gap-1', metaClass)}>
          <Icon name="loader-4" className={cn(iconClass, 'animate-spin')} aria-hidden="true" />
          {t('chat.goal.status.evaluating')}
        </span>
      ) : (
        <span className={cn('flex-shrink-0', metaClass)}>
          {t(sessionGoalStatusLabelKey[goal.status] as never)}
        </span>
      )}
      <span className={cn('flex-shrink-0 tabular-nums', metaClass, 'text-muted-foreground/70')}>
        {durationLabel}
      </span>
      {tokensLabel ? (
        <span className={cn('flex-shrink-0 tabular-nums', metaClass, 'text-muted-foreground/70')}>
          {tokensLabel}
        </span>
      ) : null}
      {pauseResume ? (
        <button
          type="button"
          onClick={() => void handleToggleStatus(pauseResume.next)}
          disabled={busy}
          className={cn(
            'inline-flex flex-shrink-0 cursor-pointer items-center bg-transparent text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-50',
            isMobile ? 'h-7 gap-1.5 px-0 text-[11px]' : 'h-7 gap-1 px-0.5',
          )}
          aria-label={t(pauseResume.labelKey)}
        >
          <Icon name={pauseResume.icon} className={iconClass} aria-hidden="true" />
          <span className={cn('font-medium', isMobile ? 'leading-none' : 'typography-ui-label')}>
            {t(pauseResume.labelKey)}
          </span>
        </button>
      ) : null}
    </div>
  );
});

SessionGoalRow.displayName = 'SessionGoalRow';
