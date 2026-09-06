import React, { useMemo, useState } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  TextInput,
  View as RNView,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Text, useThemeColor } from '@/components/Themed';
import { useColorScheme } from '@/components/useColorScheme';
import { t } from '@/lib/i18n';
import type { ProjectEntry } from '@/lib/projectsSettingsApi';
import type { ScheduledTask } from '@/lib/scheduledTasksApi';

type ScheduleKind = 'daily' | 'weekly' | 'cron';

type Draft = {
  id?: string;
  name: string;
  enabled: boolean;
  kind: ScheduleKind;
  times: string;
  weekdays: number[];
  cron: string;
  timezone: string;
  prompt: string;
  providerID: string;
  modelID: string;
  agent: string;
};

const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const;

const toDraft = (task: ScheduledTask | null): Draft => {
  if (!task) {
    return {
      name: '',
      enabled: true,
      kind: 'daily',
      times: '09:00',
      weekdays: [1],
      cron: '0 9 * * 1',
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      prompt: '',
      providerID: '',
      modelID: '',
      agent: '',
    };
  }
  const kind: ScheduleKind =
    task.schedule.kind === 'weekly' || task.schedule.kind === 'cron'
      ? task.schedule.kind
      : 'daily';
  const times = Array.isArray(task.schedule.times)
    ? task.schedule.times.join(', ')
    : task.schedule.time || '09:00';
  return {
    id: task.id,
    name: task.name,
    enabled: task.enabled,
    kind,
    times,
    weekdays: Array.isArray(task.schedule.weekdays) ? [...task.schedule.weekdays] : [1],
    cron: task.schedule.cron || '0 9 * * 1',
    timezone: task.schedule.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    prompt: task.execution.prompt || '',
    providerID: task.execution.providerID || '',
    modelID: task.execution.modelID || '',
    agent: task.execution.agent || '',
  };
};

const parseTimes = (raw: string): string[] =>
  raw
    .split(/[,，\s]+/)
    .map((v) => v.trim())
    .filter((v) => /^([01]\d|2[0-3]):([0-5]\d)$/.test(v));

export function ScheduledTaskEditor({
  open,
  mode,
  task,
  projects,
  projectId,
  onProjectChange,
  onClose,
  onSave,
}: {
  open: boolean;
  mode: 'create' | 'edit';
  task: ScheduledTask | null;
  projects: ProjectEntry[];
  projectId: string;
  onProjectChange: (id: string) => void;
  onClose: () => void;
  onSave: (draft: Partial<ScheduledTask>) => Promise<void>;
}) {
  const insets = useSafeAreaInsets();
  const dark = useColorScheme() === 'dark';
  const text = useThemeColor({}, 'text');
  const muted = useThemeColor({}, 'muted');
  const background = useThemeColor({}, 'background');
  const [draft, setDraft] = useState<Draft>(() => toDraft(task));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  React.useEffect(() => {
    if (open) {
      setDraft(toDraft(task));
      setError(null);
      setSaving(false);
    }
  }, [open, task]);

  const cardBg = dark ? '#171717' : '#ffffff';
  const inputBg = dark ? '#262626' : '#f4f4f5';
  const border = dark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)';

  const weekdayLabels = useMemo(
    () =>
      WEEKDAYS.map((d) =>
        t(
          [
            'sessions.scheduledTasks.dialog.schedule.weekdayShort.sun',
            'sessions.scheduledTasks.dialog.schedule.weekdayShort.mon',
            'sessions.scheduledTasks.dialog.schedule.weekdayShort.tue',
            'sessions.scheduledTasks.dialog.schedule.weekdayShort.wed',
            'sessions.scheduledTasks.dialog.schedule.weekdayShort.thu',
            'sessions.scheduledTasks.dialog.schedule.weekdayShort.fri',
            'sessions.scheduledTasks.dialog.schedule.weekdayShort.sat',
          ][d],
        ),
      ),
    [],
  );

  const validate = (): string | null => {
    if (!draft.name.trim()) return t('sessions.scheduledTasks.editor.validation.taskNameRequired');
    if (!draft.prompt.trim()) return t('sessions.scheduledTasks.editor.validation.promptRequired');
    if (!draft.providerID.trim() || !draft.modelID.trim()) {
      return t('sessions.scheduledTasks.editor.validation.modelRequired');
    }
    if (draft.kind === 'cron') {
      if (!draft.cron.trim()) return t('sessions.scheduledTasks.editor.validation.cronRequired');
    } else {
      const times = parseTimes(draft.times);
      if (times.length === 0) return t('sessions.scheduledTasks.editor.validation.atLeastOneTime');
      if (draft.kind === 'weekly' && draft.weekdays.length === 0) {
        return t('sessions.scheduledTasks.editor.validation.atLeastOneWeekday');
      }
    }
    if (mode === 'create' && !projectId) {
      return t('sessions.scheduledTasks.dialog.error.chooseProjectFirst');
    }
    return null;
  };

  const handleSave = async () => {
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }
    setSaving(true);
    setError(null);
    const times = parseTimes(draft.times);
    const payload: Partial<ScheduledTask> = {
      ...(draft.id ? { id: draft.id } : {}),
      name: draft.name.trim(),
      enabled: draft.enabled,
      schedule: {
        kind: draft.kind,
        timezone: draft.timezone.trim() || undefined,
        ...(draft.kind === 'cron'
          ? { cron: draft.cron.trim() }
          : {
              times,
              ...(draft.kind === 'weekly' ? { weekdays: [...draft.weekdays].sort() } : {}),
            }),
      },
      execution: {
        prompt: draft.prompt,
        providerID: draft.providerID.trim(),
        modelID: draft.modelID.trim(),
        ...(draft.agent.trim() ? { agent: draft.agent.trim() } : {}),
      },
    };
    try {
      await onSave(payload);
      onClose();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : t('sessions.scheduledTasks.editor.toast.saveFailed'),
      );
    } finally {
      setSaving(false);
    }
  };

  const Field = ({
    label,
    children,
  }: {
    label: string;
    children: React.ReactNode;
  }) => (
    <RNView style={styles.field}>
      <Text style={[styles.label, { color: muted }]}>{label}</Text>
      {children}
    </RNView>
  );

  return (
    <Modal visible={open} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <RNView style={[styles.root, { backgroundColor: background, paddingTop: insets.top }]}>
        <RNView style={styles.header}>
          <Pressable onPress={onClose} hitSlop={12}>
            <Text style={{ color: muted, fontWeight: '600' }}>
              {t('sessions.scheduledTasks.editor.actions.cancel')}
            </Text>
          </Pressable>
          <Text style={[styles.title, { color: text }]}>
            {mode === 'edit'
              ? t('sessions.scheduledTasks.editor.title.edit')
              : t('sessions.scheduledTasks.editor.title.new')}
          </Text>
          <Pressable onPress={() => void handleSave()} disabled={saving} hitSlop={12}>
            <Text style={{ color: text, fontWeight: '700', opacity: saving ? 0.5 : 1 }}>
              {saving
                ? t('sessions.scheduledTasks.editor.actions.saving')
                : t('sessions.scheduledTasks.editor.actions.save')}
            </Text>
          </Pressable>
        </RNView>

        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 40 }}>
          {mode === 'create' ? (
            <Field label={t('sessions.scheduledTasks.editor.project.label')}>
              {projects.length === 0 ? (
                <Text style={{ color: muted }}>{t('sessions.scheduledTasks.dialog.project.empty')}</Text>
              ) : (
                <RNView style={styles.chipRow}>
                  {projects.map((p) => {
                    const selected = p.id === projectId;
                    const label = p.label || p.path.split('/').filter(Boolean).pop() || p.id;
                    return (
                      <Pressable
                        key={p.id}
                        onPress={() => onProjectChange(p.id)}
                        style={[
                          styles.chip,
                          {
                            backgroundColor: selected ? (dark ? '#3f3f46' : '#e4e4e7') : inputBg,
                            borderColor: border,
                          },
                        ]}
                      >
                        <Text style={{ color: text, fontSize: 13, fontWeight: selected ? '700' : '500' }}>
                          {label}
                        </Text>
                      </Pressable>
                    );
                  })}
                </RNView>
              )}
            </Field>
          ) : null}

          <Field label={t('sessions.scheduledTasks.editor.taskName.label')}>
            <TextInput
              value={draft.name}
              onChangeText={(name) => setDraft((d) => ({ ...d, name }))}
              placeholder={t('sessions.scheduledTasks.editor.taskName.placeholder')}
              placeholderTextColor={muted}
              style={[styles.input, { backgroundColor: inputBg, color: text, borderColor: border }]}
            />
          </Field>

          <RNView style={[styles.switchRow, { backgroundColor: cardBg, borderColor: border }]}>
            <Text style={{ color: text, fontWeight: '600' }}>
              {t('sessions.scheduledTasks.editor.enabled.label')}
            </Text>
            <Switch
              value={draft.enabled}
              onValueChange={(enabled) => setDraft((d) => ({ ...d, enabled }))}
            />
          </RNView>

          <Field label={t('sessions.scheduledTasks.editor.scheduleType.label')}>
            <RNView style={styles.chipRow}>
              {(['daily', 'weekly', 'cron'] as const).map((kind) => {
                const selected = draft.kind === kind;
                return (
                  <Pressable
                    key={kind}
                    onPress={() => setDraft((d) => ({ ...d, kind }))}
                    style={[
                      styles.chip,
                      {
                        backgroundColor: selected ? (dark ? '#3f3f46' : '#e4e4e7') : inputBg,
                        borderColor: border,
                      },
                    ]}
                  >
                    <Text style={{ color: text, fontWeight: selected ? '700' : '500', fontSize: 13 }}>
                      {t(`sessions.scheduledTasks.editor.scheduleType.${kind}`)}
                    </Text>
                  </Pressable>
                );
              })}
            </RNView>
          </Field>

          {draft.kind === 'cron' ? (
            <Field label={t('sessions.scheduledTasks.editor.cron.label')}>
              <TextInput
                value={draft.cron}
                onChangeText={(cron) => setDraft((d) => ({ ...d, cron }))}
                placeholder={t('sessions.scheduledTasks.editor.cron.placeholder')}
                placeholderTextColor={muted}
                autoCapitalize="none"
                style={[styles.input, { backgroundColor: inputBg, color: text, borderColor: border }]}
              />
            </Field>
          ) : (
            <>
              <Field label={t('sessions.scheduledTasks.editor.times.label')}>
                <TextInput
                  value={draft.times}
                  onChangeText={(times) => setDraft((d) => ({ ...d, times }))}
                  placeholder="09:00, 18:30"
                  placeholderTextColor={muted}
                  autoCapitalize="none"
                  style={[styles.input, { backgroundColor: inputBg, color: text, borderColor: border }]}
                />
              </Field>
              {draft.kind === 'weekly' ? (
                <Field label={t('sessions.scheduledTasks.editor.weekdays.label')}>
                  <RNView style={styles.chipRow}>
                    {WEEKDAYS.map((day) => {
                      const selected = draft.weekdays.includes(day);
                      return (
                        <Pressable
                          key={day}
                          onPress={() =>
                            setDraft((d) => ({
                              ...d,
                              weekdays: selected
                                ? d.weekdays.filter((v) => v !== day)
                                : [...d.weekdays, day],
                            }))
                          }
                          style={[
                            styles.chip,
                            {
                              backgroundColor: selected ? (dark ? '#3f3f46' : '#e4e4e7') : inputBg,
                              borderColor: border,
                            },
                          ]}
                        >
                          <Text style={{ color: text, fontSize: 12, fontWeight: selected ? '700' : '500' }}>
                            {weekdayLabels[day]}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </RNView>
                </Field>
              ) : null}
            </>
          )}

          <Field label={t('sessions.scheduledTasks.editor.timezone.label')}>
            <TextInput
              value={draft.timezone}
              onChangeText={(timezone) => setDraft((d) => ({ ...d, timezone }))}
              autoCapitalize="none"
              style={[styles.input, { backgroundColor: inputBg, color: text, borderColor: border }]}
            />
          </Field>

          <Field label={t('sessions.scheduledTasks.editor.provider.label')}>
            <TextInput
              value={draft.providerID}
              onChangeText={(providerID) => setDraft((d) => ({ ...d, providerID }))}
              autoCapitalize="none"
              style={[styles.input, { backgroundColor: inputBg, color: text, borderColor: border }]}
            />
          </Field>

          <Field label={t('sessions.scheduledTasks.editor.model.label')}>
            <TextInput
              value={draft.modelID}
              onChangeText={(modelID) => setDraft((d) => ({ ...d, modelID }))}
              autoCapitalize="none"
              style={[styles.input, { backgroundColor: inputBg, color: text, borderColor: border }]}
            />
          </Field>

          <Field label={t('sessions.scheduledTasks.editor.agent.label')}>
            <TextInput
              value={draft.agent}
              onChangeText={(agent) => setDraft((d) => ({ ...d, agent }))}
              autoCapitalize="none"
              style={[styles.input, { backgroundColor: inputBg, color: text, borderColor: border }]}
            />
          </Field>

          <Field label={t('sessions.scheduledTasks.editor.prompt.label')}>
            <TextInput
              value={draft.prompt}
              onChangeText={(prompt) => setDraft((d) => ({ ...d, prompt }))}
              placeholder={t('sessions.scheduledTasks.editor.prompt.placeholder')}
              placeholderTextColor={muted}
              multiline
              style={[
                styles.input,
                styles.prompt,
                { backgroundColor: inputBg, color: text, borderColor: border },
              ]}
            />
          </Field>

          {error ? (
            <Text style={{ color: '#dc2626', marginTop: 8, fontSize: 13 }}>{error}</Text>
          ) : null}
        </ScrollView>
      </RNView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  title: { fontSize: 17, fontWeight: '700' },
  field: { marginBottom: 14 },
  label: { fontSize: 12, fontWeight: '600', marginBottom: 6 },
  input: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
  },
  prompt: { minHeight: 110, textAlignVertical: 'top' },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginBottom: 14,
  },
});
