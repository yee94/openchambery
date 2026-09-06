import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, View as RNView } from 'react-native';

import {
  SettingsCard,
  SettingsChoiceRow,
  SettingsErrorState,
  SettingsLoading,
  SettingsPageScaffold,
  SettingsPrimaryButton,
  SettingsTextField,
  SettingsToggleRow,
  useSettingsTheme,
} from '@/components/settings/SettingsChrome';
import { Text } from '@/components/Themed';
import { useConnection } from '@/context/ConnectionContext';
import {
  createAssistant,
  deleteAssistant,
  fetchAssistantSnapshot,
  setAssistantsEnabled,
  updateAssistant,
  type AssistantDraft,
  type AssistantDTO,
  type AssistantSnapshot,
} from '@/lib/assistantsApi';
import { t } from '@/lib/i18n';

const emptyDraft = (): AssistantDraft => ({
  enabled: true,
  name: '',
  defaultPrompt: '',
  workspacePath: null,
  providerID: '',
  modelID: '',
  agent: null,
  mode: 'continuous',
});

const draftFrom = (assistant: AssistantDTO): AssistantDraft => ({
  enabled: assistant.enabled,
  name: assistant.name,
  defaultPrompt: assistant.defaultPrompt,
  workspacePath: assistant.workspacePath,
  providerID: assistant.providerID,
  modelID: assistant.modelID,
  agent: assistant.agent,
  mode: assistant.mode,
  variant: assistant.variant,
});

export function AssistantsSettingsPage({
  onBack,
  assistantId,
  create,
}: {
  onBack: () => void;
  assistantId?: string;
  create?: boolean;
}) {
  const { state } = useConnection();
  const active = state.active;
  const theme = useSettingsTheme();
  const [snapshot, setSnapshot] = useState<AssistantSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | 'new' | null>(
    create ? 'new' : assistantId ?? null,
  );
  const [draft, setDraft] = useState<AssistantDraft>(emptyDraft());

  const reload = useCallback(async () => {
    if (!active) {
      setError(t('settings.error.notConnected'));
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const next = await fetchAssistantSnapshot(active);
      setSnapshot(next);
    } catch (err) {
      setSnapshot(null);
      setError(err instanceof Error ? err.message : t('settings.error.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [active]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (!snapshot) return;
    if (editingId === 'new') {
      setDraft(emptyDraft());
      return;
    }
    if (editingId) {
      const found = snapshot.assistants.find((a) => a.id === editingId);
      if (found) setDraft(draftFrom(found));
    }
  }, [editingId, snapshot]);

  const selected = useMemo(
    () => (editingId && editingId !== 'new'
      ? snapshot?.assistants.find((a) => a.id === editingId) ?? null
      : null),
    [editingId, snapshot],
  );

  const save = async () => {
    if (!active || !snapshot) return;
    if (!draft.name.trim() || !draft.providerID.trim() || !draft.modelID.trim()) {
      Alert.alert(t('settings.assistants.validation'));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (editingId === 'new') {
        const created = await createAssistant(active, draft);
        await reload();
        setEditingId(created.id);
      } else if (selected) {
        await updateAssistant(active, selected, draft);
        await reload();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('settings.error.saveFailed'));
      Alert.alert(t('settings.error.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (assistant: AssistantDTO) => {
    if (!active) return;
    setSaving(true);
    try {
      await deleteAssistant(active, assistant);
      setEditingId(null);
      await reload();
    } catch (err) {
      Alert.alert(err instanceof Error ? err.message : t('settings.error.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <SettingsPageScaffold title={t('settings.pages.assistants')} onBack={onBack}>
        <SettingsLoading />
      </SettingsPageScaffold>
    );
  }

  if (error && !snapshot) {
    return (
      <SettingsPageScaffold title={t('settings.pages.assistants')} onBack={onBack}>
        <SettingsErrorState message={error} onRetry={() => void reload()} />
      </SettingsPageScaffold>
    );
  }

  if (editingId) {
    return (
      <SettingsPageScaffold
        title={editingId === 'new' ? t('settings.assistants.create') : t('settings.assistants.edit')}
        onBack={() => setEditingId(null)}
      >
        <ScrollView contentContainerStyle={{ paddingVertical: 16 }}>
          <SettingsCard>
            <SettingsToggleRow
              label={t('settings.assistants.enabled')}
              value={draft.enabled}
              onValueChange={(next) => setDraft((d) => ({ ...d, enabled: next }))}
            />
            <SettingsTextField
              label={t('settings.assistants.name')}
              value={draft.name}
              onChangeText={(name) => setDraft((d) => ({ ...d, name }))}
            />
            <SettingsTextField
              label={t('settings.assistants.prompt')}
              value={draft.defaultPrompt}
              onChangeText={(defaultPrompt) => setDraft((d) => ({ ...d, defaultPrompt }))}
              multiline
              style={{ minHeight: 100, textAlignVertical: 'top' }}
            />
            <SettingsTextField
              label={t('settings.assistants.provider')}
              value={draft.providerID}
              onChangeText={(providerID) => setDraft((d) => ({ ...d, providerID }))}
              autoCapitalize="none"
            />
            <SettingsTextField
              label={t('settings.assistants.model')}
              value={draft.modelID}
              onChangeText={(modelID) => setDraft((d) => ({ ...d, modelID }))}
              autoCapitalize="none"
            />
            <SettingsTextField
              label={t('settings.assistants.agent')}
              value={draft.agent ?? ''}
              onChangeText={(agent) => setDraft((d) => ({ ...d, agent: agent.trim() || null }))}
              autoCapitalize="none"
            />
            <SettingsChoiceRow
              label={t('settings.assistants.mode')}
              value={draft.mode}
              options={[
                { value: 'continuous', label: t('settings.assistants.mode.continuous') },
                { value: 'stateless', label: t('settings.assistants.mode.stateless') },
              ]}
              onChange={(mode) =>
                setDraft((d) => ({ ...d, mode: mode as 'continuous' | 'stateless' }))
              }
            />
            <SettingsTextField
              label={t('settings.assistants.workspace')}
              value={draft.workspacePath ?? ''}
              onChangeText={(workspacePath) =>
                setDraft((d) => ({ ...d, workspacePath: workspacePath.trim() || null }))
              }
              autoCapitalize="none"
            />
          </SettingsCard>
          <SettingsPrimaryButton
            label={t('settings.actions.save')}
            disabled={saving}
            onPress={() => void save()}
          />
          {selected ? (
            <Pressable
              onPress={() =>
                Alert.alert(
                  t('assistants.settings.delete'),
                  t('assistants.settings.deleteConfirm', { name: selected.name }),
                  [
                    { text: t('mobile.projects.actions.cancel'), style: 'cancel' },
                    {
                      text: t('assistants.settings.delete'),
                      style: 'destructive',
                      onPress: () => void remove(selected),
                    },
                  ],
                )
              }
              style={{ alignItems: 'center', padding: 12 }}
            >
              <Text style={{ color: theme.danger, fontWeight: '700' }}>
                {t('assistants.settings.delete')}
              </Text>
            </Pressable>
          ) : null}
          {error ? <SettingsErrorState message={error} /> : null}
        </ScrollView>
      </SettingsPageScaffold>
    );
  }

  return (
    <SettingsPageScaffold title={t('settings.pages.assistants')} onBack={onBack}>
      <ScrollView contentContainerStyle={{ paddingVertical: 16 }}>
        <SettingsCard>
          <SettingsToggleRow
            label={t('settings.assistants.instanceEnabled')}
            value={snapshot?.enabled ?? false}
            onValueChange={(next) => {
              if (!active || !snapshot) return;
              void setAssistantsEnabled(active, next, snapshot.revision)
                .then(() => reload())
                .catch((err) =>
                  Alert.alert(err instanceof Error ? err.message : t('settings.error.saveFailed')),
                );
            }}
          />
        </SettingsCard>
        <SettingsCard>
          {(snapshot?.assistants ?? []).map((assistant) => (
            <Pressable
              key={assistant.id}
              onPress={() => setEditingId(assistant.id)}
              style={{ paddingHorizontal: 14, paddingVertical: 14, borderBottomWidth: 0.5, borderBottomColor: theme.border }}
            >
              <Text style={{ color: theme.text, fontWeight: '600' }}>{assistant.name}</Text>
              <Text style={{ color: theme.muted, marginTop: 2, fontSize: 12 }}>
                {assistant.providerID}/{assistant.modelID}
              </Text>
            </Pressable>
          ))}
          {(snapshot?.assistants.length ?? 0) === 0 ? (
            <RNView style={{ padding: 16 }}>
              <Text style={{ color: theme.muted, textAlign: 'center' }}>
                {t('settings.assistants.empty')}
              </Text>
            </RNView>
          ) : null}
        </SettingsCard>
        <SettingsPrimaryButton
          label={t('settings.assistants.create')}
          onPress={() => setEditingId('new')}
        />
      </ScrollView>
    </SettingsPageScaffold>
  );
}
