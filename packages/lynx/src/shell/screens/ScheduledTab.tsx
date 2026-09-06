import { useEffect, useState } from 'react';

import { lynxT, tabLabel } from '../../i18n/catalog';
import { LynxScrollView, LynxText, LynxView } from '../../lynx-elements';
import type { LynxRuntimeFetch } from '../../runtime/fetch';
import { loadGlobalScheduledTasks, loadScheduledTaskRuns } from '../../scheduled/api';
import type {
  LynxGlobalScheduledTask,
  LynxScheduledLoadResult,
  LynxScheduledTaskRun,
} from '../../scheduled/types';
import { cssVar } from '../../theme/tokens';

export type ScheduledTabProps = {
  locale: string;
  runtimeFetch?: LynxRuntimeFetch | null;
  resultOverride?: LynxScheduledLoadResult | null;
  onOpenEditorStub?: (task: LynxGlobalScheduledTask | null) => void;
  onOpenRunSession?: (run: LynxScheduledTaskRun) => void;
};

type HistoryState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ok'; runs: LynxScheduledTaskRun[] }
  | { status: 'failed'; error: Error }
  | { status: 'stub' };

/**
 * Scheduled tab: list + history hooks against Cap scheduled APIs.
 * Editor is a labeled stub until full editor chrome is ported — never fake-success empty.
 */
export function ScheduledTab({
  locale,
  runtimeFetch = null,
  resultOverride = null,
  onOpenEditorStub,
  onOpenRunSession,
}: ScheduledTabProps) {
  const [result, setResult] = useState<LynxScheduledLoadResult | null>(resultOverride);
  const [view, setView] = useState<'tasks' | 'history'>('tasks');
  const [history, setHistory] = useState<HistoryState>({ status: 'idle' });
  const [editorStubVisible, setEditorStubVisible] = useState(false);

  useEffect(() => {
    if (resultOverride) {
      setResult(resultOverride);
      return;
    }
    let cancelled = false;
    setResult(null);
    void (async () => {
      const next = await loadGlobalScheduledTasks(runtimeFetch);
      if (!cancelled) setResult(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [runtimeFetch, resultOverride]);

  useEffect(() => {
    if (view !== 'history') return;
    if (!runtimeFetch) {
      setHistory({ status: 'stub' });
      return;
    }
    let cancelled = false;
    setHistory({ status: 'loading' });
    void (async () => {
      try {
        const page = await loadScheduledTaskRuns(runtimeFetch, { limit: 20 });
        if (!cancelled) setHistory({ status: 'ok', runs: page.runs });
      } catch (error) {
        if (!cancelled) {
          setHistory({
            status: 'failed',
            error: error instanceof Error ? error : new Error(String(error)),
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [view, runtimeFetch]);

  const openEditor = (task: LynxGlobalScheduledTask | null) => {
    setEditorStubVisible(true);
    onOpenEditorStub?.(task);
  };

  return (
    <LynxScrollView
      style={{
        flexGrow: 1,
        padding: '24px 16px',
        backgroundColor: cssVar('surface.background'),
      }}
    >
      <LynxView
        style={{
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '12px',
        }}
      >
        <LynxText
          style={{
            fontSize: '28px',
            fontWeight: '700',
            color: cssVar('surface.foreground'),
          }}
        >
          {tabLabel(locale, 'scheduled')}
        </LynxText>
        <LynxView
          bindtap={() => openEditor(null)}
          accessibility-role="button"
          accessibility-label={lynxT(locale, 'lynx.scheduled.editor.stub')}
        >
          <LynxText style={{ color: cssVar('primary.base'), fontWeight: '600' }}>+</LynxText>
        </LynxView>
      </LynxView>

      <LynxView style={{ flexDirection: 'row', marginBottom: '16px', gap: '12px' }}>
        <LynxView bindtap={() => setView('tasks')}>
          <LynxText
            style={{
              color: view === 'tasks' ? cssVar('primary.base') : cssVar('surface.mutedForeground'),
              fontWeight: '600',
            }}
          >
            {lynxT(locale, 'lynx.scheduled.views.tasks')}
          </LynxText>
        </LynxView>
        <LynxView bindtap={() => setView('history')}>
          <LynxText
            style={{
              color: view === 'history' ? cssVar('primary.base') : cssVar('surface.mutedForeground'),
              fontWeight: '600',
            }}
          >
            {lynxT(locale, 'lynx.scheduled.history')}
          </LynxText>
        </LynxView>
      </LynxView>

      {editorStubVisible ? (
        <LynxView
          style={{
            marginBottom: '12px',
            padding: '10px 12px',
            borderRadius: '12px',
            backgroundColor: cssVar('surface.elevated'),
          }}
        >
          <LynxText style={{ color: cssVar('surface.foreground') }}>
            {lynxT(locale, 'lynx.scheduled.editor.stub')}
          </LynxText>
        </LynxView>
      ) : null}

      {view === 'tasks' ? (
        <>
          {!result ? (
            <LynxText style={{ color: cssVar('surface.mutedForeground') }}>
              {lynxT(locale, 'lynx.scheduled.loading')}
            </LynxText>
          ) : null}

          {result?.status === 'no-runtime' ? (
            <LynxText style={{ color: cssVar('surface.mutedForeground') }}>
              {lynxT(locale, 'lynx.scheduled.noRuntime')}
            </LynxText>
          ) : null}

          {result?.status === 'failed' ? (
            <LynxView
              style={{
                marginBottom: '12px',
                padding: '10px 12px',
                borderRadius: '12px',
                backgroundColor: cssVar('surface.elevated'),
              }}
            >
              <LynxText style={{ color: cssVar('surface.foreground'), fontWeight: '600' }}>
                {lynxT(locale, 'lynx.scheduled.failure')}
              </LynxText>
              <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '12px', marginTop: '4px' }}>
                {result.error.message}
              </LynxText>
            </LynxView>
          ) : null}

          {result?.status === 'ok' && result.response.failedProjectIds.length > 0 ? (
            <LynxText style={{ color: cssVar('surface.mutedForeground'), marginBottom: '12px' }}>
              {lynxT(locale, 'lynx.scheduled.partialFailure')}
              {': '}
              {result.response.failedProjectIds.join(', ')}
            </LynxText>
          ) : null}

          {result?.status === 'ok' && result.response.tasks.length === 0 ? (
            <LynxText style={{ color: cssVar('surface.mutedForeground') }}>
              {lynxT(locale, 'lynx.scheduled.empty')}
            </LynxText>
          ) : null}

          {result?.status === 'ok'
            ? result.response.tasks.map(({ projectId, task }) => (
              <LynxView
                key={`${projectId}:${task.id}`}
                bindtap={() => openEditor({ projectId, task })}
                accessibility-role="button"
                accessibility-label={task.name}
                style={{
                  marginBottom: '12px',
                  padding: '14px',
                  borderRadius: '16px',
                  backgroundColor: cssVar('surface.elevated'),
                }}
              >
                <LynxView style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                  <LynxText style={{ color: cssVar('surface.foreground'), fontWeight: '700' }}>
                    {task.name}
                  </LynxText>
                  <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '12px' }}>
                    {task.enabled ? task.schedule.kind : 'paused'}
                  </LynxText>
                </LynxView>
                <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '12px', marginTop: '4px' }}>
                  {projectId}
                </LynxText>
              </LynxView>
            ))
            : null}
        </>
      ) : (
        <>
          {history.status === 'loading' || history.status === 'idle' ? (
            <LynxText style={{ color: cssVar('surface.mutedForeground') }}>
              {lynxT(locale, 'lynx.scheduled.loading')}
            </LynxText>
          ) : null}
          {history.status === 'stub' ? (
            <LynxText style={{ color: cssVar('surface.mutedForeground') }}>
              {lynxT(locale, 'lynx.scheduled.noRuntime')}
            </LynxText>
          ) : null}
          {history.status === 'failed' ? (
            <LynxText style={{ color: cssVar('surface.mutedForeground') }}>
              {lynxT(locale, 'lynx.scheduled.failure')}
              {': '}
              {history.error.message}
            </LynxText>
          ) : null}
          {history.status === 'ok' && history.runs.length === 0 ? (
            <LynxText style={{ color: cssVar('surface.mutedForeground') }}>
              {lynxT(locale, 'lynx.scheduled.empty')}
            </LynxText>
          ) : null}
          {history.status === 'ok'
            ? history.runs.map((run) => (
              <LynxView
                key={run.id}
                bindtap={() => {
                  if (run.sessionId) onOpenRunSession?.(run);
                }}
                style={{
                  marginBottom: '10px',
                  padding: '12px',
                  borderRadius: '14px',
                  backgroundColor: cssVar('surface.elevated'),
                }}
              >
                <LynxText style={{ color: cssVar('surface.foreground'), fontWeight: '600' }}>
                  {run.taskName}
                </LynxText>
                <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '12px', marginTop: '4px' }}>
                  {run.status} · {run.trigger}
                </LynxText>
              </LynxView>
            ))
            : null}
        </>
      )}
    </LynxScrollView>
  );
}
