import React, { useCallback, useEffect, useState } from 'react';
import { Alert, ScrollView, View as RNView } from 'react-native';

import {
  SettingsCard,
  SettingsChoiceRow,
  SettingsErrorState,
  SettingsLoading,
  SettingsPageScaffold,
  SettingsPrimaryButton,
  SettingsTextField,
  SettingsToggleRow,
} from '@/components/settings/SettingsChrome';
import { useConnection } from '@/context/ConnectionContext';
import { getLocale, setLocale, t, type Locale } from '@/lib/i18n';
import { getMetaStoreBackend } from '@/lib/metaStore';
import {
  loadSettingsBlob,
  putSettingsBlobMerge,
  themeModeFromBlob,
  themeModeToPatch,
  type SettingsBlob,
  type ThemeMode,
} from '@/lib/settings/settingsBlobApi';
import { loadSmallModel } from '@/lib/settings/smallModelApi';
import { loadGitIdentities, type GitIdentity } from '@/lib/settings/gitIdentitiesApi';
import { loadAgentsMd, putAgentsMd } from '@/lib/settings/behaviorApi';

const LOCALE_KEY = 'openchamber.expo.locale';

async function persistLocale(locale: Locale) {
  setLocale(locale);
  await getMetaStoreBackend().setItem(LOCALE_KEY, locale);
}

export async function hydrateLocale() {
  const raw = await getMetaStoreBackend().getItem(LOCALE_KEY);
  if (raw === 'en' || raw === 'zh-CN') setLocale(raw);
}

function useSettingsBlobEditor(onBack: () => void) {
  const { state } = useConnection();
  const active = state.active;
  const [blob, setBlob] = useState<SettingsBlob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const reload = useCallback(async () => {
    if (!active) {
      setError(t('settings.error.notConnected'));
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setBlob(await loadSettingsBlob(active));
    } catch (err) {
      setBlob(null);
      setError(err instanceof Error ? err.message : t('settings.error.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [active]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const save = async (patch: Partial<SettingsBlob>) => {
    if (!active || !blob) return;
    setSaving(true);
    setError(null);
    try {
      const next = await putSettingsBlobMerge(active, patch);
      setBlob(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('settings.error.saveFailed'));
      Alert.alert(t('settings.error.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  return { active, blob, error, loading, saving, reload, save, onBack };
}

export function AppearanceSettingsPage({ onBack }: { onBack: () => void }) {
  const editor = useSettingsBlobEditor(onBack);
  const [locale, setLocaleState] = useState<Locale>(getLocale());

  if (editor.loading) {
    return (
      <SettingsPageScaffold title={t('settings.pages.appearance')} onBack={onBack}>
        <SettingsLoading />
      </SettingsPageScaffold>
    );
  }
  if (editor.error && !editor.blob) {
    return (
      <SettingsPageScaffold title={t('settings.pages.appearance')} onBack={onBack}>
        <SettingsErrorState message={editor.error} onRetry={() => void editor.reload()} />
      </SettingsPageScaffold>
    );
  }

  const mode = editor.blob ? themeModeFromBlob(editor.blob) : 'system';

  return (
    <SettingsPageScaffold title={t('settings.pages.appearance')} onBack={onBack}>
      <ScrollView contentContainerStyle={{ paddingVertical: 16 }}>
        <SettingsCard>
          <SettingsChoiceRow
            label={t('settings.appearance.language')}
            value={locale}
            options={[
              { value: 'zh-CN', label: '中文' },
              { value: 'en', label: 'English' },
            ]}
            onChange={(next) => {
              const value = next as Locale;
              setLocaleState(value);
              void persistLocale(value);
            }}
          />
          <SettingsChoiceRow
            label={t('settings.appearance.theme')}
            value={mode}
            showDivider={false}
            options={[
              { value: 'system', label: t('settings.appearance.theme.system') },
              { value: 'light', label: t('settings.appearance.theme.light') },
              { value: 'dark', label: t('settings.appearance.theme.dark') },
            ]}
            onChange={(next) => void editor.save(themeModeToPatch(next as ThemeMode))}
          />
        </SettingsCard>
        <RNView style={{ paddingHorizontal: 20 }}>
          <RNView>
            {/* Explicitly no iosNativeUi row */}
          </RNView>
          {editor.error ? (
            <RNView>
              <SettingsErrorState message={editor.error} />
            </RNView>
          ) : null}
          {editor.saving ? (
            <RNView>
              <SettingsLoading />
            </RNView>
          ) : null}
        </RNView>
      </ScrollView>
    </SettingsPageScaffold>
  );
}

export function ChatSettingsPage({ onBack }: { onBack: () => void }) {
  const editor = useSettingsBlobEditor(onBack);
  if (editor.loading) {
    return (
      <SettingsPageScaffold title={t('settings.pages.chat')} onBack={onBack}>
        <SettingsLoading />
      </SettingsPageScaffold>
    );
  }
  if (editor.error && !editor.blob) {
    return (
      <SettingsPageScaffold title={t('settings.pages.chat')} onBack={onBack}>
        <SettingsErrorState message={editor.error} onRetry={() => void editor.reload()} />
      </SettingsPageScaffold>
    );
  }
  const blob = editor.blob!;
  return (
    <SettingsPageScaffold title={t('settings.pages.chat')} onBack={onBack}>
      <ScrollView contentContainerStyle={{ paddingVertical: 16 }}>
        <SettingsCard>
          <SettingsChoiceRow
            label={t('settings.chat.transport')}
            value={blob.messageStreamTransport ?? 'auto'}
            options={[
              { value: 'auto', label: 'Auto' },
              { value: 'ws', label: 'WebSocket' },
              { value: 'sse', label: 'SSE' },
            ]}
            onChange={(next) =>
              void editor.save({ messageStreamTransport: next as 'auto' | 'ws' | 'sse' })
            }
          />
          <SettingsChoiceRow
            label={t('settings.chat.followUp')}
            value={blob.followUpBehavior ?? 'queue'}
            options={[
              { value: 'queue', label: t('settings.chat.followUp.queue') },
              { value: 'steer', label: t('settings.chat.followUp.steer') },
            ]}
            onChange={(next) => void editor.save({ followUpBehavior: next as 'queue' | 'steer' })}
          />
          <SettingsToggleRow
            label={t('settings.chat.reasoning')}
            value={blob.showReasoningTraces ?? true}
            onValueChange={(next) => void editor.save({ showReasoningTraces: next })}
          />
          <SettingsToggleRow
            label={t('settings.chat.wrap')}
            value={blob.codeBlockLineWrap ?? false}
            onValueChange={(next) => void editor.save({ codeBlockLineWrap: next })}
          />
          <SettingsToggleRow
            label={t('settings.chat.persistDrafts')}
            value={blob.persistDraftMessages ?? true}
            onValueChange={(next) => void editor.save({ persistDraftMessages: next })}
          />
        </SettingsCard>
        {editor.error ? <SettingsErrorState message={editor.error} /> : null}
      </ScrollView>
    </SettingsPageScaffold>
  );
}

export function NotificationsSettingsPage({ onBack }: { onBack: () => void }) {
  const editor = useSettingsBlobEditor(onBack);
  if (editor.loading) {
    return (
      <SettingsPageScaffold title={t('settings.pages.notifications')} onBack={onBack}>
        <SettingsLoading />
      </SettingsPageScaffold>
    );
  }
  if (editor.error && !editor.blob) {
    return (
      <SettingsPageScaffold title={t('settings.pages.notifications')} onBack={onBack}>
        <SettingsErrorState message={editor.error} onRetry={() => void editor.reload()} />
      </SettingsPageScaffold>
    );
  }
  const blob = editor.blob!;
  const enabled = blob.nativeNotificationsEnabled ?? false;
  return (
    <SettingsPageScaffold title={t('settings.pages.notifications')} onBack={onBack}>
      <ScrollView contentContainerStyle={{ paddingVertical: 16 }}>
        <SettingsCard>
          <SettingsToggleRow
            label={t('settings.notifications.enabled')}
            value={enabled}
            onValueChange={(next) => void editor.save({ nativeNotificationsEnabled: next })}
          />
          <SettingsToggleRow
            label={t('settings.notifications.completion')}
            value={blob.notifyOnCompletion ?? true}
            disabled={!enabled}
            onValueChange={(next) => void editor.save({ notifyOnCompletion: next })}
          />
          <SettingsToggleRow
            label={t('settings.notifications.subtasks')}
            value={blob.notifyOnSubtasks ?? false}
            disabled={!enabled}
            onValueChange={(next) => void editor.save({ notifyOnSubtasks: next })}
          />
          <SettingsToggleRow
            label={t('settings.notifications.error')}
            value={blob.notifyOnError ?? true}
            disabled={!enabled}
            onValueChange={(next) => void editor.save({ notifyOnError: next })}
          />
          <SettingsToggleRow
            label={t('settings.notifications.question')}
            value={blob.notifyOnQuestion ?? true}
            disabled={!enabled}
            onValueChange={(next) => void editor.save({ notifyOnQuestion: next })}
          />
        </SettingsCard>
        {editor.error ? <SettingsErrorState message={editor.error} /> : null}
      </ScrollView>
    </SettingsPageScaffold>
  );
}

export function SessionsSettingsPage({ onBack }: { onBack: () => void }) {
  const editor = useSettingsBlobEditor(onBack);
  const [defaultModel, setDefaultModel] = useState('');
  const [defaultAgent, setDefaultAgent] = useState('');
  const [days, setDays] = useState('30');

  useEffect(() => {
    if (!editor.blob) return;
    setDefaultModel(editor.blob.defaultModel ?? '');
    setDefaultAgent(editor.blob.defaultAgent ?? '');
    setDays(String(editor.blob.autoDeleteAfterDays ?? 30));
  }, [editor.blob]);

  if (editor.loading) {
    return (
      <SettingsPageScaffold title={t('settings.pages.sessions')} onBack={onBack}>
        <SettingsLoading />
      </SettingsPageScaffold>
    );
  }
  if (editor.error && !editor.blob) {
    return (
      <SettingsPageScaffold title={t('settings.pages.sessions')} onBack={onBack}>
        <SettingsErrorState message={editor.error} onRetry={() => void editor.reload()} />
      </SettingsPageScaffold>
    );
  }
  const blob = editor.blob!;
  return (
    <SettingsPageScaffold title={t('settings.pages.sessions')} onBack={onBack}>
      <ScrollView contentContainerStyle={{ paddingVertical: 16 }}>
        <SettingsCard>
          <SettingsTextField
            label={t('settings.sessions.defaultModel')}
            value={defaultModel}
            onChangeText={setDefaultModel}
            placeholder="provider/model"
            autoCapitalize="none"
          />
          <SettingsTextField
            label={t('settings.sessions.defaultAgent')}
            value={defaultAgent}
            onChangeText={setDefaultAgent}
            autoCapitalize="none"
          />
          <SettingsToggleRow
            label={t('settings.sessions.showDeletionDialog')}
            value={blob.showDeletionDialog ?? true}
            onValueChange={(next) => void editor.save({ showDeletionDialog: next })}
          />
          <SettingsToggleRow
            label={t('settings.sessions.autoCleanup')}
            value={blob.autoDeleteEnabled ?? false}
            onValueChange={(next) => void editor.save({ autoDeleteEnabled: next })}
          />
          <SettingsTextField
            label={t('settings.sessions.retentionDays')}
            value={days}
            onChangeText={setDays}
            keyboardType="number-pad"
          />
          <SettingsChoiceRow
            label={t('settings.sessions.retentionAction')}
            value={blob.sessionRetentionAction ?? 'archive'}
            options={[
              { value: 'archive', label: t('settings.sessions.archive') },
              { value: 'delete', label: t('settings.sessions.delete') },
            ]}
            onChange={(next) =>
              void editor.save({ sessionRetentionAction: next as 'archive' | 'delete' })
            }
          />
        </SettingsCard>
        <SettingsPrimaryButton
          label={t('settings.actions.save')}
          disabled={editor.saving}
          onPress={() =>
            void editor.save({
              defaultModel: defaultModel.trim() || undefined,
              defaultAgent: defaultAgent.trim() || undefined,
              autoDeleteAfterDays: Number.parseInt(days, 10) || 30,
            })
          }
        />
        {editor.error ? <SettingsErrorState message={editor.error} /> : null}
      </ScrollView>
    </SettingsPageScaffold>
  );
}

export function SummaryAiSettingsPage({ onBack }: { onBack: () => void }) {
  const editor = useSettingsBlobEditor(onBack);
  const { state } = useConnection();
  const [smallModelLabel, setSmallModelLabel] = useState<string>('');
  const [tokenDraft, setTokenDraft] = useState('');

  useEffect(() => {
    if (!state.active) return;
    void loadSmallModel(state.active)
      .then((info) => {
        setSmallModelLabel(
          [info.providerID, info.modelID].filter(Boolean).join('/') || t('settings.summary.smallModelUnknown'),
        );
      })
      .catch(() => setSmallModelLabel(t('settings.summary.smallModelUnavailable')));
  }, [state.active]);

  if (editor.loading) {
    return (
      <SettingsPageScaffold title={t('settings.pages.summaryAi')} onBack={onBack}>
        <SettingsLoading />
      </SettingsPageScaffold>
    );
  }
  if (editor.error && !editor.blob) {
    return (
      <SettingsPageScaffold title={t('settings.pages.summaryAi')} onBack={onBack}>
        <SettingsErrorState message={editor.error} onRetry={() => void editor.reload()} />
      </SettingsPageScaffold>
    );
  }
  const blob = editor.blob!;
  return (
    <SettingsPageScaffold title={t('settings.pages.summaryAi')} onBack={onBack}>
      <ScrollView contentContainerStyle={{ paddingVertical: 16 }}>
        <SettingsCard>
          <SettingsToggleRow
            label={t('settings.summary.useDefault')}
            value={blob.smallModelUseDefault ?? true}
            onValueChange={(next) => void editor.save({ smallModelUseDefault: next })}
          />
          <SettingsToggleRow
            label={t('settings.summary.titleRefresh')}
            value={blob.sessionTitleRefreshEnabled ?? true}
            onValueChange={(next) => void editor.save({ sessionTitleRefreshEnabled: next })}
          />
          <SettingsTextField
            label={t('settings.summary.smallModel')}
            value={smallModelLabel}
            editable={false}
          />
          <SettingsTextField
            label={t('settings.summary.customToken')}
            value={tokenDraft}
            onChangeText={setTokenDraft}
            placeholder={blob.hasSummaryCustomAPIToken ? '••••••••' : ''}
            secureTextEntry
            autoCapitalize="none"
          />
        </SettingsCard>
        <SettingsPrimaryButton
          label={t('settings.actions.save')}
          disabled={editor.saving}
          onPress={() => {
            const patch: Partial<SettingsBlob> = {};
            if (tokenDraft.trim()) {
              // Official merge PUT accepts summaryCustomAPIToken; never log it.
              (patch as Record<string, unknown>).summaryCustomAPIToken = tokenDraft.trim();
            }
            void editor.save(patch).then(() => setTokenDraft(''));
          }}
        />
        {editor.error ? <SettingsErrorState message={editor.error} /> : null}
      </ScrollView>
    </SettingsPageScaffold>
  );
}

export function GitSettingsPage({ onBack }: { onBack: () => void }) {
  const editor = useSettingsBlobEditor(onBack);
  const { state } = useConnection();
  const [identities, setIdentities] = useState<GitIdentity[] | null>(null);
  const [idError, setIdError] = useState<string | null>(null);

  const reloadIds = useCallback(async () => {
    if (!state.active) return;
    setIdError(null);
    try {
      setIdentities(await loadGitIdentities(state.active));
    } catch (err) {
      setIdentities(null);
      setIdError(err instanceof Error ? err.message : t('settings.error.loadFailed'));
    }
  }, [state.active]);

  useEffect(() => {
    void reloadIds();
  }, [reloadIds]);

  if (editor.loading) {
    return (
      <SettingsPageScaffold title={t('settings.pages.git')} onBack={onBack}>
        <SettingsLoading />
      </SettingsPageScaffold>
    );
  }
  if (editor.error && !editor.blob) {
    return (
      <SettingsPageScaffold title={t('settings.pages.git')} onBack={onBack}>
        <SettingsErrorState message={editor.error} onRetry={() => void editor.reload()} />
      </SettingsPageScaffold>
    );
  }
  const blob = editor.blob!;
  return (
    <SettingsPageScaffold title={t('settings.pages.git')} onBack={onBack}>
      <ScrollView contentContainerStyle={{ paddingVertical: 16 }}>
        <SettingsCard>
          <SettingsToggleRow
            label={t('settings.git.gitmoji')}
            value={blob.gitmojiEnabled ?? false}
            onValueChange={(next) => void editor.save({ gitmojiEnabled: next })}
          />
          <SettingsToggleRow
            label={t('settings.git.showIgnored')}
            value={blob.showGitignored ?? false}
            onValueChange={(next) => void editor.save({ showGitignored: next })}
          />
        </SettingsCard>
        <SettingsCard>
          {idError ? (
            <SettingsErrorState message={idError} onRetry={() => void reloadIds()} />
          ) : identities == null ? (
            <SettingsLoading />
          ) : identities.length === 0 ? (
            <SettingsErrorState message={t('settings.git.identitiesEmpty')} />
          ) : (
            identities.map((id) => (
              <SettingsToggleRow
                key={id.id}
                label={id.name || id.email || id.id}
                description={id.email}
                value={(blob.defaultGitIdentityId ?? '') === id.id}
                onValueChange={(next) =>
                  void editor.save({ defaultGitIdentityId: next ? id.id : '' })
                }
              />
            ))
          )}
        </SettingsCard>
        {editor.error ? <SettingsErrorState message={editor.error} /> : null}
      </ScrollView>
    </SettingsPageScaffold>
  );
}

export function BehaviorSettingsPage({ onBack }: { onBack: () => void }) {
  const editor = useSettingsBlobEditor(onBack);
  const { state } = useConnection();
  const [agentsMd, setAgentsMd] = useState('');
  const [mdError, setMdError] = useState<string | null>(null);
  const [mdLoading, setMdLoading] = useState(true);
  const [mdSaving, setMdSaving] = useState(false);

  const reloadMd = useCallback(async () => {
    if (!state.active) return;
    setMdLoading(true);
    setMdError(null);
    try {
      setAgentsMd(await loadAgentsMd(state.active));
    } catch (err) {
      setMdError(err instanceof Error ? err.message : t('settings.error.loadFailed'));
    } finally {
      setMdLoading(false);
    }
  }, [state.active]);

  useEffect(() => {
    void reloadMd();
  }, [reloadMd]);

  return (
    <SettingsPageScaffold title={t('settings.pages.behavior')} onBack={onBack}>
      <ScrollView contentContainerStyle={{ paddingVertical: 16 }}>
        <SettingsCard>
          <SettingsChoiceRow
            label={t('settings.behavior.responseStyle')}
            value={(editor.blob?.responseStyle as string) || 'default'}
            options={[
              { value: 'default', label: t('settings.behavior.style.default') },
              { value: 'concise', label: t('settings.behavior.style.concise') },
              { value: 'detailed', label: t('settings.behavior.style.detailed') },
              { value: 'custom', label: t('settings.behavior.style.custom') },
            ]}
            onChange={(next) => void editor.save({ responseStyle: next })}
          />
        </SettingsCard>
        <SettingsCard>
          {mdLoading ? (
            <SettingsLoading />
          ) : mdError ? (
            <SettingsErrorState message={mdError} onRetry={() => void reloadMd()} />
          ) : (
            <SettingsTextField
              label={t('settings.behavior.agentsMd')}
              value={agentsMd}
              onChangeText={setAgentsMd}
              multiline
              style={{ minHeight: 180, textAlignVertical: 'top' }}
            />
          )}
        </SettingsCard>
        <SettingsPrimaryButton
          label={t('settings.actions.save')}
          disabled={mdSaving || !state.active}
          onPress={() => {
            if (!state.active) return;
            setMdSaving(true);
            void putAgentsMd(state.active, agentsMd)
              .catch((err) => {
                setMdError(err instanceof Error ? err.message : t('settings.error.saveFailed'));
                Alert.alert(t('settings.error.saveFailed'));
              })
              .finally(() => setMdSaving(false));
          }}
        />
      </ScrollView>
    </SettingsPageScaffold>
  );
}
