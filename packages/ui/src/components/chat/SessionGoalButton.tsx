import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';
import { useSessionGoal } from '@/hooks/useSessionGoal';
import { useSessionGoalArmStore } from '@/stores/useSessionGoalArmStore';
import { SESSION_GOAL_OBJECTIVE_CHAR_LIMIT } from '@/lib/sessionGoalMetadata';
import { clearSessionGoal } from '@/lib/sessionGoalActions';
import { isVSCodeRuntime } from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

interface SessionGoalButtonProps {
  sessionId: string | null;
  directory?: string;
  /** Session draft is open — the goal arms for the session the draft creates. */
  draftOpen?: boolean;
}

// Goal mode starts through /goal (arm only — never auto-sends). This compact
// chip is visible only while the next message is armed or the session has a
// goal, and provides direct removal.
export const SessionGoalButton: React.FC<SessionGoalButtonProps> = React.memo(({
  sessionId,
  directory,
  draftOpen = false,
}) => {
  const { t } = useI18n();
  const { goal, enabled } = useSessionGoal(sessionId ?? '', directory);
  const armed = useSessionGoalArmStore((state) => state.armed);
  const setArmed = useSessionGoalArmStore((state) => state.setArmed);
  const [busy, setBusy] = React.useState(false);

  if (isVSCodeRuntime() || !enabled || (!sessionId && !draftOpen) || (!armed && !goal)) {
    return null;
  }

  const colorClass = (() => {
    if (goal?.status === 'complete') return 'text-[var(--status-success)]';
    if (goal?.status === 'blocked' || goal?.status === 'budgetLimited') return 'text-[var(--status-error)]';
    if (armed || goal?.status === 'active' || goal?.status === 'paused') return 'text-[var(--status-info)]';
    return '';
  })();

  const handleRemove = async () => {
    if (armed) {
      setArmed(false);
      return;
    }
    if (!sessionId || busy) return;
    setBusy(true);
    try {
      await clearSessionGoal(sessionId, directory);
    } catch (error) {
      console.warn('[session-goal] clear failed:', error);
      toast.error(t('chat.goal.toast.actionFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className={cn('inline-flex h-7 items-center gap-1 rounded-full bg-[var(--surface-muted)] py-1 pl-2 pr-1 typography-ui-label', colorClass)}>
      <Icon name="target" className="h-4 w-4" aria-hidden="true" />
      <span>{t('chat.goal.chip.label')}</span>
      <button
        type="button"
        className="flex h-5 w-5 items-center justify-center rounded-full text-current hover:bg-[var(--interactive-hover)] disabled:opacity-50"
        onClick={() => void handleRemove()}
        disabled={busy}
        aria-label={armed ? t('chat.goal.button.disarmAria') : t('chat.goal.action.clear')}
        title={armed ? t('chat.goal.button.disarmAria') : t('chat.goal.action.clear')}
      >
        <Icon name="close" className="h-3 w-3" aria-hidden="true" />
      </button>
    </span>
  );
});

SessionGoalButton.displayName = 'SessionGoalButton';

interface SessionGoalObjectiveCounterProps {
  /** Current composer text length — the armed message becomes the objective. */
  length: number;
}

// Tiny hot-path leaf next to the target button: while goal mode is armed the
// typed message becomes the objective, which the server clamps to 2000
// chars — surface that limit during typing instead of truncating silently.
// Renders null when not armed, so normal typing shows nothing.
export const SessionGoalObjectiveCounter: React.FC<SessionGoalObjectiveCounterProps> = React.memo(({ length }) => {
  const { t } = useI18n();
  const armed = useSessionGoalArmStore((state) => state.armed);

  if (!armed || length === 0) {
    return null;
  }

  const over = length > SESSION_GOAL_OBJECTIVE_CHAR_LIMIT;
  return (
    <span
      className={cn(
        'flex-shrink-0 self-center typography-micro tabular-nums',
        over ? 'text-[var(--status-error)]' : 'text-muted-foreground/70',
      )}
      aria-label={t('chat.goal.counter.aria')}
      title={t('chat.goal.counter.aria')}
    >
      {length}/{SESSION_GOAL_OBJECTIVE_CHAR_LIMIT}
    </span>
  );
});

SessionGoalObjectiveCounter.displayName = 'SessionGoalObjectiveCounter';
