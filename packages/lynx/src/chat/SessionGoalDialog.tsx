/**
 * Cap SessionGoalDialog create/manage overlay for Lynx.
 * Centered Dialog via shell DialogPortal — objective + optional token budget;
 * manage status/usage + clear/save. Never auto-sends. Never fake-success.
 */
import { useCallback, useEffect, useState } from 'react';

import { lynxT, type LynxMessageKey } from '../i18n/catalog';
import { LynxInput, LynxText, LynxView } from '../lynx-elements';
import type { LynxRuntimeFetch } from '../runtime/fetch';
import {
  LynxCenteredDialog,
  LynxCenteredDialogAction,
} from '../shell/CenteredDialog';
import { LynxDialogPortal } from '../shell/DialogPortal';
import { cssVar } from '../theme/tokens';
import { abortSession } from './sessionApi';
import {
  SESSION_GOAL_OBJECTIVE_CHAR_LIMIT,
  clearLynxSessionGoal,
  fetchLynxGoalObjectiveContent,
  fetchLynxSessionGoal,
  fitLynxGoalObjective,
  formatLynxGoalDuration,
  formatLynxGoalTokens,
  lynxGoalElapsedMs,
  lynxSessionGoalStatusColor,
  lynxSessionGoalStatusLabelKey,
  setLynxSessionGoal,
  type LynxSessionGoalPayload,
} from './sessionGoal';

export type LynxSessionGoalDialogProps = {
  locale: string;
  open: boolean;
  sessionId: string;
  directory?: string | null;
  runtimeFetch?: LynxRuntimeFetch | null;
  onOpenChange: (open: boolean) => void;
  /** Called after successful set/clear so parent can refresh row. */
  onChanged?: () => void;
};

export function LynxSessionGoalDialog({
  locale,
  open,
  sessionId,
  directory = null,
  runtimeFetch = null,
  onOpenChange,
  onChanged,
}: LynxSessionGoalDialogProps) {
  const [goal, setGoal] = useState<LynxSessionGoalPayload | null>(null);
  const [objectiveContent, setObjectiveContent] = useState<string | null>(null);
  const [objective, setObjective] = useState('');
  const [budgetEnabled, setBudgetEnabled] = useState(false);
  const [tokenBudget, setTokenBudget] = useState(200_000);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [now] = useState(() => Date.now());

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      const result = await fetchLynxSessionGoal(runtimeFetch, { sessionId, directory });
      if (cancelled) return;
      if (result.status !== 'ok') {
        setGoal(null);
        setObjective('');
        setBudgetEnabled(false);
        setTokenBudget(200_000);
        setObjectiveContent(null);
        if (result.status === 'no-runtime') {
          setActionError(lynxT(locale, 'lynx.chat.goal.unavailable'));
        }
        return;
      }
      setGoal(result.goal);
      setActionError(null);
      if (result.goal?.objectiveFile) {
        const objectiveResult = await fetchLynxGoalObjectiveContent(runtimeFetch, sessionId);
        const content = objectiveResult.status === 'ok' ? objectiveResult.content : null;
        if (cancelled) return;
        setObjectiveContent(content);
        setObjective(content ?? '');
      } else {
        setObjectiveContent(result.goal?.objective ?? null);
        setObjective(result.goal?.objective ?? '');
      }
      setBudgetEnabled(Boolean(result.goal?.tokenBudget));
      setTokenBudget(result.goal?.tokenBudget ?? 200_000);
    })();
    return () => { cancelled = true; };
  }, [open, runtimeFetch, sessionId, directory, locale]);

  const run = useCallback(async (action: () => Promise<boolean>, closeAfter: boolean) => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    const ok = await action();
    setBusy(false);
    if (!ok) return;
    onChanged?.();
    if (closeAfter) onOpenChange(false);
  }, [busy, onChanged, onOpenChange]);

  const trimmedObjective = objective.trim();
  const savedObjective = goal?.objectiveFile
    ? (objectiveContent ?? '')
    : (goal?.objective ?? '');
  const objectiveChanged = trimmedObjective !== savedObjective;
  const budgetValue = budgetEnabled ? tokenBudget : null;
  const budgetChanged = budgetValue !== (goal?.tokenBudget ?? null);
  const isCompleted = goal?.status === 'complete';
  const canSave = !isCompleted
    && trimmedObjective.length > 0
    && (!goal || objectiveChanged || budgetChanged);

  const handleSave = () => run(async () => {
    const result = await setLynxSessionGoal(runtimeFetch, {
      sessionId,
      directory,
      objective: fitLynxGoalObjective(trimmedObjective),
      tokenBudget: budgetValue,
      existing: goal,
    });
    if (result.status !== 'ok') {
      setActionError(
        result.status === 'no-runtime'
          ? lynxT(locale, 'lynx.chat.goal.unavailable')
          : lynxT(locale, 'lynx.chat.goal.actionFailed'),
      );
      return false;
    }
    return true;
  }, true);

  const handleClear = () => run(async () => {
    const result = await clearLynxSessionGoal(runtimeFetch, { sessionId, directory });
    if (result.status !== 'ok') {
      setActionError(
        result.status === 'no-runtime'
          ? lynxT(locale, 'lynx.chat.goal.unavailable')
          : lynxT(locale, 'lynx.chat.goal.actionFailed'),
      );
      return false;
    }
    if (result.wasActive && runtimeFetch) {
      void abortSession({ runtimeFetch }, { sessionId, directory });
    }
    return true;
  }, true);

  const title = goal
    ? lynxT(locale, 'lynx.chat.goal.dialog.titleManage')
    : lynxT(locale, 'lynx.chat.goal.dialog.titleCreate');

  const statusKey = goal
    ? lynxSessionGoalStatusLabelKey[goal.status] as LynxMessageKey
    : null;

  return (
    <LynxDialogPortal>
      <LynxCenteredDialog
        locale={locale}
        open={open}
        title={title}
        ariaLabel={title}
        busy={busy}
        onClose={() => onOpenChange(false)}
        footer={(
          <>
            {goal ? (
              <LynxCenteredDialogAction
                label={lynxT(locale, 'lynx.chat.goal.action.clear')}
                destructive
                disabled={busy}
                onTap={() => { void handleClear(); }}
              />
            ) : null}
            <LynxCenteredDialogAction
              label={lynxT(locale, 'lynx.chat.goal.action.cancel')}
              disabled={busy}
              onTap={() => onOpenChange(false)}
            />
            {!isCompleted ? (
              <LynxCenteredDialogAction
                label={lynxT(
                  locale,
                  goal ? 'lynx.chat.goal.action.save' : 'lynx.chat.goal.action.start',
                )}
                disabled={busy || !canSave}
                onTap={() => { void handleSave(); }}
              />
            ) : null}
          </>
        )}
      >
        <LynxView data-lynx-session-goal-dialog="body" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {goal ? (
            <LynxView
              style={{
                padding: '8px',
                borderRadius: '8px',
                backgroundColor: cssVar('surface.elevated'),
                display: 'flex',
                flexDirection: 'column',
                gap: '4px',
              }}
            >
              <LynxView style={{ flexDirection: 'row', alignItems: 'center', gap: '8px' }}>
                <LynxText style={{ color: lynxSessionGoalStatusColor[goal.status], fontSize: '12px' }}>
                  ◎
                </LynxText>
                <LynxText style={{ color: cssVar('surface.foreground'), fontSize: '12px', fontWeight: '600' }}>
                  {statusKey ? lynxT(locale, statusKey) : goal.status}
                </LynxText>
                <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '11px' }}>
                  {formatLynxGoalDuration(lynxGoalElapsedMs(goal, now))}
                  {goal.tokensUsed > 0 || goal.tokenBudget
                    ? ` · ${goal.tokenBudget
                      ? `${formatLynxGoalTokens(goal.tokensUsed)}/${formatLynxGoalTokens(goal.tokenBudget)}`
                      : formatLynxGoalTokens(goal.tokensUsed)}`
                    : ''}
                </LynxText>
              </LynxView>
              {goal.note ? (
                <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '11px' }}>
                  {goal.note}
                </LynxText>
              ) : null}
              {goal.statusReason && (goal.status === 'blocked' || goal.status === 'budgetLimited') ? (
                <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '11px', opacity: 0.7 }}>
                  {goal.statusReason}
                </LynxText>
              ) : null}
            </LynxView>
          ) : null}

          {isCompleted ? (
            <LynxText
              style={{
                color: cssVar('surface.mutedForeground'),
                fontSize: '13px',
                maxHeight: '160px',
              }}
            >
              {objectiveContent ?? goal?.objective ?? ''}
            </LynxText>
          ) : (
            <>
              <LynxView style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <LynxText style={{ color: cssVar('surface.foreground'), fontSize: '12px', fontWeight: '600' }}>
                  {lynxT(locale, 'lynx.chat.goal.dialog.objectiveLabel')}
                </LynxText>
                <LynxText
                  style={{ color: cssVar('surface.mutedForeground'), fontSize: '10px', opacity: 0.7 }}
                  accessibility-label={lynxT(locale, 'lynx.chat.goal.counter.aria')}
                >
                  {Math.min(objective.length, SESSION_GOAL_OBJECTIVE_CHAR_LIMIT)}/{SESSION_GOAL_OBJECTIVE_CHAR_LIMIT}
                </LynxText>
              </LynxView>
              <LynxInput
                value={objective}
                placeholder={lynxT(locale, 'lynx.chat.goal.dialog.objectivePlaceholder')}
                bindinput={(event) => {
                  const next = event.detail?.value ?? '';
                  setObjective(next.slice(0, SESSION_GOAL_OBJECTIVE_CHAR_LIMIT));
                }}
                accessibility-label={lynxT(locale, 'lynx.chat.goal.dialog.objectiveLabel')}
                style={{
                  color: cssVar('surface.foreground'),
                  fontSize: '14px',
                  minHeight: '88px',
                  padding: '8px',
                  borderRadius: '8px',
                  backgroundColor: cssVar('surface.elevated'),
                }}
              />
              <LynxView
                bindtap={() => setBudgetEnabled((value) => !value)}
                accessibility-role="button"
                accessibility-label={lynxT(locale, 'lynx.chat.goal.dialog.budgetLabel')}
                style={{ flexDirection: 'row', alignItems: 'center', gap: '8px', paddingTop: '4px' }}
              >
                <LynxText style={{ color: cssVar('surface.foreground'), fontSize: '14px' }}>
                  {budgetEnabled ? '☑' : '☐'}
                </LynxText>
                <LynxText style={{ color: cssVar('surface.foreground'), fontSize: '12px', fontWeight: '600' }}>
                  {lynxT(locale, 'lynx.chat.goal.dialog.budgetLabel')}
                </LynxText>
              </LynxView>
              {budgetEnabled ? (
                <LynxInput
                  value={String(tokenBudget)}
                  bindinput={(event) => {
                    const parsed = Number.parseInt(event.detail?.value ?? '', 10);
                    setTokenBudget(
                      Number.isFinite(parsed) && parsed > 0
                        ? Math.min(100_000_000, Math.max(1000, Math.floor(parsed)))
                        : 1000,
                    );
                  }}
                  accessibility-label={lynxT(locale, 'lynx.chat.goal.dialog.budgetLabel')}
                  style={{
                    color: cssVar('surface.foreground'),
                    fontSize: '14px',
                    padding: '8px',
                    borderRadius: '8px',
                    backgroundColor: cssVar('surface.elevated'),
                  }}
                />
              ) : null}
            </>
          )}

          {actionError ? (
            <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '11px' }}>
              {actionError}
            </LynxText>
          ) : null}
        </LynxView>
      </LynxCenteredDialog>
    </LynxDialogPortal>
  );
}

/** Cap /goal arm entry when no session goal — opens create dialog; never auto-sends. */
export type LynxSessionGoalCreateEntryProps = {
  locale: string;
  armed?: boolean;
  onOpenCreate: () => void;
  onToggleArm?: () => void;
};

export function LynxSessionGoalCreateEntry({
  locale,
  armed = false,
  onOpenCreate,
  onToggleArm,
}: LynxSessionGoalCreateEntryProps) {
  return (
    <LynxView
      data-lynx-session-goal-create-entry="true"
      data-lynx-session-goal-armed={armed ? 'true' : 'false'}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: '6px',
        paddingTop: '4px',
        paddingBottom: '4px',
      }}
    >
      <LynxView
        bindtap={onOpenCreate}
        accessibility-role="button"
        accessibility-label={lynxT(locale, 'lynx.chat.goal.createEntryAria')}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: '4px',
          padding: '4px 6px',
          borderRadius: '999px',
          backgroundColor: cssVar('surface.muted'),
        }}
      >
        <LynxText style={{
          color: armed ? '#4387be' : cssVar('surface.mutedForeground'),
          fontSize: '12px',
        }}
        >
          ◎
        </LynxText>
        <LynxText style={{
          color: armed ? '#4387be' : cssVar('surface.foreground'),
          fontSize: '12px',
          fontWeight: '600',
        }}
        >
          {lynxT(locale, 'lynx.chat.goal.createEntry')}
        </LynxText>
      </LynxView>
      {onToggleArm ? (
        <LynxView
          bindtap={onToggleArm}
          accessibility-role="button"
          accessibility-label={lynxT(
            locale,
            armed ? 'lynx.chat.goal.disarmAria' : 'lynx.chat.goal.armAria',
          )}
          style={{ padding: '4px 6px', flexShrink: 0 }}
        >
          <LynxText style={{
            color: armed ? '#4387be' : cssVar('surface.mutedForeground'),
            fontSize: '11px',
            fontWeight: '600',
          }}
          >
            {lynxT(locale, armed ? 'lynx.chat.goal.disarm' : 'lynx.chat.goal.arm')}
          </LynxText>
        </LynxView>
      ) : null}
    </LynxView>
  );
}
