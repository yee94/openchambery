import { useEffect, useState } from 'react';

import { lynxT } from '../i18n/catalog';
import { LynxInput, LynxScrollView, LynxText, LynxView } from '../lynx-elements';
import type { LynxRuntimeFetch } from '../runtime/fetch';
import { loadLynxSettings } from '../settings/api';
import { cssVar } from '../theme/tokens';
import { deleteScheduledTask, runScheduledTaskNow, upsertScheduledTask } from './api';
import type { LynxGlobalScheduledTask, LynxScheduledTask } from './types';

export type ScheduledEditorProps = {
  locale: string;
  runtimeFetch: LynxRuntimeFetch | null;
  /** null = create; otherwise edit existing Cap task. */
  initial: LynxGlobalScheduledTask | null;
  onClose: () => void;
  onSaved?: () => void;
  /** Cap delete — refresh list after success. */
  onDeleted?: () => void;
  /** Cap Run now — optional sessionId for chat open. */
  onRan?: (result: { sessionId?: string }) => void;
};

type Draft = {
  projectId: string;
  name: string;
  enabled: boolean;
  scheduleKind: LynxScheduledTask['schedule']['kind'];
  time: string;
  date: string;
  cron: string;
  prompt: string;
  providerID: string;
  modelID: string;
  taskId?: string;
};

const emptyDraft = (): Draft => ({
  projectId: '',
  name: '',
  enabled: true,
  scheduleKind: 'daily',
  time: '09:00',
  date: '',
  cron: '0 9 * * *',
  prompt: '',
  providerID: '',
  modelID: '',
});

const draftFromInitial = (initial: LynxGlobalScheduledTask | null): Draft => {
  if (!initial) return emptyDraft();
  const { projectId, task } = initial;
  return {
    projectId,
    name: task.name,
    enabled: task.enabled,
    scheduleKind: task.schedule.kind,
    time: task.schedule.times?.[0] ?? task.schedule.time ?? '09:00',
    date: task.schedule.date ?? '',
    cron: task.schedule.cron ?? '0 9 * * *',
    prompt: task.execution.prompt,
    providerID: task.execution.providerID,
    modelID: task.execution.modelID,
    taskId: task.id,
  };
};

/**
 * Scheduled task editor — Cap PUT upsert + Run now (POST /run) + Delete.
 * Create requires a project id from settings projects list; never fake-success.
 */
export function ScheduledEditor({
  locale,
  runtimeFetch,
  initial,
  onClose,
  onSaved,
  onDeleted,
  onRan,
}: ScheduledEditorProps) {
  const [draft, setDraft] = useState<Draft>(() => draftFromInitial(initial));
  const [projects, setProjects] = useState<Array<{ id: string; label: string }>>([]);
  const [projectsStatus, setProjectsStatus] = useState<'idle' | 'loading' | 'ok' | 'failed' | 'no-runtime'>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [actionBusy, setActionBusy] = useState<'run' | 'delete' | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    setDraft(draftFromInitial(initial));
    setSaveError(null);
  }, [initial]);

  useEffect(() => {
    if (initial) return;
    let cancelled = false;
    setProjectsStatus('loading');
    void (async () => {
      const result = await loadLynxSettings(runtimeFetch);
      if (cancelled) return;
      if (result.status === 'no-runtime') {
        setProjectsStatus('no-runtime');
        return;
      }
      if (result.status === 'failed') {
        setProjectsStatus('failed');
        setSaveError(result.error.message);
        return;
      }
      const rows = (result.settings.projects ?? [])
        .map((project) => {
          const id = typeof project.id === 'string' && project.id.trim()
            ? project.id.trim()
            : (typeof project.path === 'string' ? project.path.trim() : '');
          if (!id) return null;
          const label = typeof project.name === 'string' && project.name.trim()
            ? project.name.trim()
            : id;
          return { id, label };
        })
        .filter((row): row is { id: string; label: string } => Boolean(row));
      setProjects(rows);
      setProjectsStatus('ok');
      if (rows[0] && !draft.projectId) {
        setDraft((current) => ({ ...current, projectId: current.projectId || rows[0]!.id }));
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load once when opening create
  }, [initial, runtimeFetch]);

  const patch = (partial: Partial<Draft>) => {
    setDraft((current) => ({ ...current, ...partial }));
  };

  const onSave = async () => {
    setSaveError(null);
    if (!runtimeFetch) {
      setSaveError(lynxT(locale, 'lynx.scheduled.noRuntime'));
      return;
    }
    const projectId = draft.projectId.trim();
    if (!projectId) {
      setSaveError(lynxT(locale, 'lynx.scheduled.editor.projectRequired'));
      return;
    }
    if (!draft.name.trim()) {
      setSaveError(lynxT(locale, 'lynx.scheduled.editor.nameRequired'));
      return;
    }
    if (!draft.prompt.trim()) {
      setSaveError(lynxT(locale, 'lynx.scheduled.editor.promptRequired'));
      return;
    }
    const schedule: LynxScheduledTask['schedule'] = (() => {
      switch (draft.scheduleKind) {
        case 'daily':
          return { kind: 'daily', times: [draft.time || '09:00'] };
        case 'weekly':
          return { kind: 'weekly', times: [draft.time || '09:00'], weekdays: [1] };
        case 'once':
          return { kind: 'once', time: draft.time || '09:00', date: draft.date || undefined };
        case 'cron':
          return { kind: 'cron', cron: draft.cron || '0 9 * * *' };
      }
    })();
    const task: Partial<LynxScheduledTask> = {
      ...(draft.taskId ? { id: draft.taskId } : {}),
      name: draft.name.trim(),
      enabled: draft.enabled,
      schedule,
      execution: {
        prompt: draft.prompt.trim(),
        providerID: draft.providerID.trim(),
        modelID: draft.modelID.trim(),
      },
    };
    setSaving(true);
    try {
      await upsertScheduledTask(runtimeFetch, projectId, task);
      onSaved?.();
      onClose();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const onRunNow = async () => {
    setSaveError(null);
    setConfirmDelete(false);
    if (!runtimeFetch) {
      setSaveError(lynxT(locale, 'lynx.scheduled.noRuntime'));
      return;
    }
    const projectId = draft.projectId.trim();
    const taskId = draft.taskId?.trim() ?? '';
    if (!projectId || !taskId) {
      setSaveError(lynxT(locale, 'lynx.scheduled.editor.runRequiresSaved'));
      return;
    }
    setActionBusy('run');
    try {
      const result = await runScheduledTaskNow(runtimeFetch, projectId, taskId);
      onRan?.(result);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setActionBusy(null);
    }
  };

  const onDelete = async () => {
    setSaveError(null);
    if (!runtimeFetch) {
      setSaveError(lynxT(locale, 'lynx.scheduled.noRuntime'));
      return;
    }
    const projectId = draft.projectId.trim();
    const taskId = draft.taskId?.trim() ?? '';
    if (!projectId || !taskId) {
      setSaveError(lynxT(locale, 'lynx.scheduled.editor.runRequiresSaved'));
      return;
    }
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setActionBusy('delete');
    try {
      await deleteScheduledTask(runtimeFetch, projectId, taskId);
      onDeleted?.();
      onClose();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
      setConfirmDelete(false);
    } finally {
      setActionBusy(null);
    }
  };

  return (
    <LynxScrollView
      style={{
        marginBottom: '16px',
        padding: '14px',
        borderRadius: '16px',
        backgroundColor: cssVar('surface.elevated'),
      }}
    >
      <LynxView style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: '12px' }}>
        <LynxText style={{ color: cssVar('surface.foreground'), fontWeight: '700', fontSize: '16px' }}>
          {initial
            ? lynxT(locale, 'lynx.scheduled.editor.title.edit')
            : lynxT(locale, 'lynx.scheduled.editor.title.new')}
        </LynxText>
        <LynxView bindtap={onClose} accessibility-role="button">
          <LynxText style={{ color: cssVar('primary.base') }}>
            {lynxT(locale, 'lynx.scheduled.editor.cancel')}
          </LynxText>
        </LynxView>
      </LynxView>

      {!initial ? (
        <LynxView style={{ marginBottom: '10px' }}>
          <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '12px', marginBottom: '4px' }}>
            {lynxT(locale, 'lynx.scheduled.editor.project')}
          </LynxText>
          {projectsStatus === 'loading' ? (
            <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '12px' }}>
              {lynxT(locale, 'lynx.scheduled.loading')}
            </LynxText>
          ) : null}
          {projectsStatus === 'ok' && projects.length === 0 ? (
            <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '12px' }}>
              {lynxT(locale, 'lynx.scheduled.editor.noProjects')}
            </LynxText>
          ) : null}
          {projects.map((project) => (
            <LynxView
              key={project.id}
              bindtap={() => patch({ projectId: project.id })}
              style={{ padding: '8px 0' }}
            >
              <LynxText
                style={{
                  color: draft.projectId === project.id
                    ? cssVar('primary.base')
                    : cssVar('surface.foreground'),
                }}
              >
                {draft.projectId === project.id ? '✓ ' : ''}
                {project.label}
              </LynxText>
            </LynxView>
          ))}
          <LynxInput
            value={draft.projectId}
            placeholder={lynxT(locale, 'lynx.scheduled.editor.projectPlaceholder')}
            bindinput={(event) => patch({ projectId: event.detail?.value ?? '' })}
            style={{ color: cssVar('surface.foreground'), fontSize: '14px', marginTop: '6px' }}
          />
        </LynxView>
      ) : (
        <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '12px', marginBottom: '10px' }}>
          {draft.projectId}
        </LynxText>
      )}

      <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '12px', marginBottom: '4px' }}>
        {lynxT(locale, 'lynx.scheduled.editor.name')}
      </LynxText>
      <LynxInput
        value={draft.name}
        bindinput={(event) => patch({ name: event.detail?.value ?? '' })}
        style={{ color: cssVar('surface.foreground'), fontSize: '14px', marginBottom: '10px' }}
      />

      <LynxView
        bindtap={() => patch({ enabled: !draft.enabled })}
        style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: '10px' }}
      >
        <LynxText style={{ color: cssVar('surface.foreground') }}>
          {lynxT(locale, 'lynx.scheduled.editor.enabled')}
        </LynxText>
        <LynxText style={{ color: cssVar('primary.base'), fontWeight: '600' }}>
          {draft.enabled ? 'ON' : 'OFF'}
        </LynxText>
      </LynxView>

      <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '12px', marginBottom: '4px' }}>
        {lynxT(locale, 'lynx.scheduled.editor.schedule')}
      </LynxText>
      {(['daily', 'weekly', 'once', 'cron'] as const).map((kind) => (
        <LynxView key={kind} bindtap={() => patch({ scheduleKind: kind })} style={{ padding: '6px 0' }}>
          <LynxText
            style={{
              color: draft.scheduleKind === kind ? cssVar('primary.base') : cssVar('surface.foreground'),
            }}
          >
            {draft.scheduleKind === kind ? '✓ ' : ''}
            {kind}
          </LynxText>
        </LynxView>
      ))}

      {draft.scheduleKind === 'cron' ? (
        <LynxInput
          value={draft.cron}
          bindinput={(event) => patch({ cron: event.detail?.value ?? '' })}
          style={{ color: cssVar('surface.foreground'), fontSize: '14px', marginBottom: '10px' }}
        />
      ) : (
        <LynxInput
          value={draft.time}
          placeholder="HH:MM"
          bindinput={(event) => patch({ time: event.detail?.value ?? '' })}
          style={{ color: cssVar('surface.foreground'), fontSize: '14px', marginBottom: '10px' }}
        />
      )}
      {draft.scheduleKind === 'once' ? (
        <LynxInput
          value={draft.date}
          placeholder="YYYY-MM-DD"
          bindinput={(event) => patch({ date: event.detail?.value ?? '' })}
          style={{ color: cssVar('surface.foreground'), fontSize: '14px', marginBottom: '10px' }}
        />
      ) : null}

      <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '12px', marginBottom: '4px' }}>
        {lynxT(locale, 'lynx.scheduled.editor.prompt')}
      </LynxText>
      <LynxInput
        value={draft.prompt}
        bindinput={(event) => patch({ prompt: event.detail?.value ?? '' })}
        style={{ color: cssVar('surface.foreground'), fontSize: '14px', marginBottom: '10px' }}
      />

      <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '12px', marginBottom: '4px' }}>
        {lynxT(locale, 'lynx.scheduled.editor.provider')}
      </LynxText>
      <LynxInput
        value={draft.providerID}
        bindinput={(event) => patch({ providerID: event.detail?.value ?? '' })}
        style={{ color: cssVar('surface.foreground'), fontSize: '14px', marginBottom: '10px' }}
      />
      <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '12px', marginBottom: '4px' }}>
        {lynxT(locale, 'lynx.scheduled.editor.model')}
      </LynxText>
      <LynxInput
        value={draft.modelID}
        bindinput={(event) => patch({ modelID: event.detail?.value ?? '' })}
        style={{ color: cssVar('surface.foreground'), fontSize: '14px', marginBottom: '12px' }}
      />

      {saveError ? (
        <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '12px', marginBottom: '8px' }}>
          {saveError}
        </LynxText>
      ) : null}

      <LynxView
        bindtap={() => {
          if (!saving && !actionBusy) void onSave();
        }}
        accessibility-role="button"
        style={{
          padding: '10px 12px',
          borderRadius: '12px',
          backgroundColor: cssVar('primary.base'),
          alignItems: 'center',
        }}
      >
        <LynxText style={{ color: '#fff', fontWeight: '600' }}>
          {saving
            ? lynxT(locale, 'lynx.scheduled.editor.saving')
            : lynxT(locale, 'lynx.scheduled.editor.save')}
        </LynxText>
      </LynxView>

      {initial && draft.taskId ? (
        <LynxView style={{ marginTop: '12px', gap: '8px' }}>
          <LynxView
            bindtap={() => {
              if (!saving && !actionBusy) void onRunNow();
            }}
            accessibility-role="button"
            accessibility-label={lynxT(locale, 'lynx.scheduled.editor.runNow')}
            style={{
              padding: '10px 12px',
              borderRadius: '12px',
              borderWidth: '1px',
              borderColor: cssVar('interactive.selection'),
              borderStyle: 'solid',
              alignItems: 'center',
            }}
          >
            <LynxText style={{ color: cssVar('primary.base'), fontWeight: '600' }}>
              {actionBusy === 'run'
                ? lynxT(locale, 'lynx.scheduled.editor.running')
                : lynxT(locale, 'lynx.scheduled.editor.runNow')}
            </LynxText>
          </LynxView>
          <LynxView
            bindtap={() => {
              if (!saving && !actionBusy) void onDelete();
            }}
            accessibility-role="button"
            accessibility-label={lynxT(locale, 'lynx.scheduled.editor.delete')}
            style={{
              padding: '10px 12px',
              borderRadius: '12px',
              borderWidth: '1px',
              borderColor: cssVar('interactive.selection'),
              borderStyle: 'solid',
              alignItems: 'center',
            }}
          >
            <LynxText style={{ color: cssVar('surface.mutedForeground'), fontWeight: '600' }}>
              {actionBusy === 'delete'
                ? lynxT(locale, 'lynx.scheduled.editor.deleting')
                : confirmDelete
                  ? lynxT(locale, 'lynx.scheduled.editor.deleteConfirm')
                  : lynxT(locale, 'lynx.scheduled.editor.delete')}
            </LynxText>
          </LynxView>
        </LynxView>
      ) : null}
    </LynxScrollView>
  );
}
