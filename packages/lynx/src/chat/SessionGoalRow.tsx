/**
 * Cap SessionGoalRow compact strip for Lynx — status / objective / elapsed /
 * tokens + pause/resume when Cap HTTP APIs exist.
 *
 * Outer shell is owned by LynxQueuedMessageChips when used as trailing.
 * No goal / no runtime → null (never fake a goal).
 */
import { useCallback, useEffect, useState } from 'react';

import { lynxT, type LynxMessageKey } from '../i18n/catalog';
import { LynxText, LynxView } from '../lynx-elements';
import type { LynxRuntimeFetch } from '../runtime/fetch';
import { cssVar } from '../theme/tokens';
import { abortSession } from './sessionApi';
import {
  fetchLynxGoalObjectiveContent,
  fetchLynxSessionGoal,
  formatLynxGoalDuration,
  lynxGoalElapsedMs,
  lynxGoalPauseResumeAction,
  lynxGoalTitleText,
  lynxGoalTokensLabel,
  lynxSessionGoalStatusColor,
  lynxSessionGoalStatusLabelKey,
  setLynxSessionGoalStatus,
  type LynxSessionGoalPayload,
} from './sessionGoal';

export type LynxSessionGoalRowProps = {
  locale: string;
  sessionId: string;
  directory?: string | null;
  runtimeFetch?: LynxRuntimeFetch | null;
  /** Cap session.status idle while goal active → "evaluating". */
  sessionIsWorking?: boolean;
  /** Refresh tick from parent (e.g. after live events). */
  refreshKey?: number | string;
  /** Cap row tap → open SessionGoalDialog manage. */
  onOpenManage?: () => void;
};

export function LynxSessionGoalRow({
  locale,
  sessionId,
  directory = null,
  runtimeFetch = null,
  sessionIsWorking = false,
  refreshKey = 0,
  onOpenManage,
}: LynxSessionGoalRowProps) {
  const [goal, setGoal] = useState<LynxSessionGoalPayload | null>(null);
  const [objectiveContent, setObjectiveContent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [loadState, setLoadState] = useState<'idle' | 'ok' | 'no-runtime' | 'failed'>('idle');

  const reload = useCallback(async () => {
    const result = await fetchLynxSessionGoal(runtimeFetch, { sessionId, directory });
    if (result.status === 'no-runtime') {
      setLoadState('no-runtime');
      setGoal(null);
      return;
    }
    if (result.status === 'failed') {
      setLoadState('failed');
      setGoal(null);
      return;
    }
    setLoadState('ok');
    setGoal(result.goal);
    if (result.goal?.objectiveFile) {
      const objective = await fetchLynxGoalObjectiveContent(runtimeFetch, sessionId);
      setObjectiveContent(objective.status === 'ok' ? objective.content : null);
    } else {
      setObjectiveContent(result.goal?.objective ?? null);
    }
  }, [runtimeFetch, sessionId, directory]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (cancelled) return;
      await reload();
    })();
    return () => { cancelled = true; };
  }, [reload, refreshKey]);

  useEffect(() => {
    if (!goal || goal.status === 'complete' || goal.status === 'blocked' || goal.status === 'budgetLimited') {
      return undefined;
    }
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [goal?.id, goal?.status]);

  const onToggle = useCallback(async (next: 'active' | 'paused') => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    // Cap pause also aborts the current turn.
    if (next === 'paused' && runtimeFetch) {
      void abortSession({ runtimeFetch }, { sessionId, directory });
    }
    const result = await setLynxSessionGoalStatus(runtimeFetch, {
      sessionId,
      directory,
      nextStatus: next,
    });
    setBusy(false);
    if (result.status !== 'ok') {
      setActionError(
        result.status === 'no-runtime'
          ? lynxT(locale, 'lynx.chat.goal.unavailable')
          : lynxT(locale, 'lynx.chat.goal.actionFailed'),
      );
      return;
    }
    await reload();
  }, [busy, runtimeFetch, sessionId, directory, locale, reload]);

  if (!sessionId || loadState === 'no-runtime' || loadState === 'failed' || !goal) {
    return null;
  }

  const pauseResume = lynxGoalPauseResumeAction(goal.status);
  const durationLabel = formatLynxGoalDuration(lynxGoalElapsedMs(goal, now));
  const tokensLabel = lynxGoalTokensLabel(goal);
  const title = lynxGoalTitleText(goal, objectiveContent);
  const statusKey = lynxSessionGoalStatusLabelKey[goal.status] as LynxMessageKey;
  const showEvaluating = goal.status === 'active' && !sessionIsWorking;

  return (
    <LynxView
      data-lynx-session-goal-row="true"
      accessibility-label={lynxT(locale, 'lynx.chat.goal.aria')}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: '6px',
        paddingTop: '4px',
        paddingBottom: '4px',
      }}
    >
      <LynxText
        style={{
          color: lynxSessionGoalStatusColor[goal.status],
          fontSize: '12px',
          flexShrink: 0,
        }}
      >
        ◎
      </LynxText>
      <LynxView
        bindtap={() => { onOpenManage?.(); }}
        accessibility-role={onOpenManage ? 'button' : undefined}
        accessibility-label={onOpenManage ? lynxT(locale, 'lynx.chat.goal.dialog.titleManage') : undefined}
        style={{
          flexGrow: 1,
          flexShrink: 1,
          flexDirection: 'row',
          alignItems: 'center',
          minWidth: '0',
        }}
      >
        <LynxText
          style={{
            flexGrow: 1,
            flexShrink: 1,
            color: cssVar('surface.foreground'),
            fontSize: '12px',
            lineHeight: '18px',
          }}
        >
          {title}
        </LynxText>
      </LynxView>
      <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '11px', flexShrink: 0 }}>
        {showEvaluating
          ? lynxT(locale, 'lynx.chat.goal.status.evaluating')
          : lynxT(locale, statusKey)}
      </LynxText>
      <LynxText style={{
        color: cssVar('surface.mutedForeground'),
        fontSize: '11px',
        flexShrink: 0,
        opacity: 0.85,
      }}
      >
        {durationLabel}
      </LynxText>
      {tokensLabel ? (
        <LynxText style={{
          color: cssVar('surface.mutedForeground'),
          fontSize: '11px',
          flexShrink: 0,
          opacity: 0.85,
        }}
        >
          {tokensLabel}
        </LynxText>
      ) : null}
      {pauseResume ? (
        <LynxView
          bindtap={() => { void onToggle(pauseResume.next); }}
          accessibility-role="button"
          accessibility-label={lynxT(
            locale,
            pauseResume.kind === 'pause' ? 'lynx.chat.goal.pause' : 'lynx.chat.goal.resume',
          )}
          style={{ padding: '4px 6px', flexShrink: 0, opacity: busy ? 0.5 : 1 }}
        >
          <LynxText style={{
            color: cssVar('surface.mutedForeground'),
            fontSize: '11px',
            fontWeight: '600',
          }}
          >
            {lynxT(
              locale,
              pauseResume.kind === 'pause' ? 'lynx.chat.goal.pause' : 'lynx.chat.goal.resume',
            )}
          </LynxText>
        </LynxView>
      ) : null}
      {actionError ? (
        <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '10px', flexShrink: 0 }}>
          {actionError}
        </LynxText>
      ) : null}
    </LynxView>
  );
}
