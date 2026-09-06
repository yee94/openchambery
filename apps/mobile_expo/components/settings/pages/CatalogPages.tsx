import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, View as RNView } from 'react-native';

import {
  SettingsCard,
  SettingsErrorState,
  SettingsLoading,
  SettingsPageScaffold,
  SettingsPrimaryButton,
  SettingsTextField,
  useSettingsTheme,
} from '@/components/settings/SettingsChrome';
import { Text } from '@/components/Themed';
import { useConnection } from '@/context/ConnectionContext';
import { loadAgents, type AgentListItem } from '@/lib/settings/agentsApi';
import { loadCommandsCatalog, type CommandItem } from '@/lib/settings/commandsApi';
import {
  authorizeProviderOAuth,
  completeProviderOAuth,
  loadProviderCatalog,
  openExternalOAuthUrl,
  putProviderApiKey,
  type CatalogProvider,
} from '@/lib/settings/providersApi';
import {
  deleteMcpServer,
  loadMcpServers,
  queueMcpOAuthPending,
  upsertMcpServer,
  type McpServerConfig,
} from '@/lib/settings/mcpApi';
import {
  createPluginEntry,
  deletePluginEntry,
  loadPluginFile,
  loadPlugins,
  putPluginFile,
  type PluginsList,
} from '@/lib/settings/pluginsApi';
import { loadInstalledSkills, type SkillSummary } from '@/lib/settings/skillsApi';
import { loadSnippets, upsertSnippet, type SnippetItem } from '@/lib/settings/snippetsApi';
import {
  loadMagicPrompts,
  putMagicPrompt,
  resetMagicPromptOverrides,
  type MagicPromptItem,
} from '@/lib/settings/magicPromptsApi';
import { loadProviderQuotas, type ProviderQuota } from '@/lib/settings/usageApi';
import { t } from '@/lib/i18n';

function useActive() {
  const { state } = useConnection();
  return state.active;
}

export function ProvidersSettingsPage({ onBack }: { onBack: () => void }) {
  const active = useActive();
  const theme = useSettingsTheme();
  const [providers, setProviders] = useState<CatalogProvider[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<CatalogProvider | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [oauthCode, setOauthCode] = useState('');
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    if (!active) {
      setError(t('settings.error.notConnected'));
      return;
    }
    setError(null);
    try {
      const catalog = await loadProviderCatalog(active);
      setProviders(catalog.providers);
    } catch (err) {
      setProviders(null);
      setError(err instanceof Error ? err.message : t('settings.error.loadFailed'));
    }
  }, [active]);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (selected) {
    return (
      <SettingsPageScaffold title={selected.name} onBack={() => setSelected(null)}>
        <ScrollView contentContainerStyle={{ paddingVertical: 16 }}>
          <SettingsCard>
            <SettingsTextField
              label={t('settings.providers.apiKey')}
              value={apiKey}
              onChangeText={setApiKey}
              secureTextEntry
              autoCapitalize="none"
              placeholder="sk-…"
            />
          </SettingsCard>
          <SettingsPrimaryButton
            label={t('settings.providers.saveKey')}
            disabled={busy || !apiKey.trim()}
            onPress={() => {
              if (!active) return;
              setBusy(true);
              void putProviderApiKey(active, selected.id, apiKey.trim())
                .then(() => {
                  setApiKey('');
                  Alert.alert(t('settings.providers.saved'));
                })
                .catch((err) => Alert.alert(err instanceof Error ? err.message : t('settings.error.saveFailed')))
                .finally(() => setBusy(false));
            }}
          />
          <SettingsPrimaryButton
            label={t('settings.providers.oauthStart')}
            disabled={busy}
            onPress={() => {
              if (!active) return;
              setBusy(true);
              void authorizeProviderOAuth(active, selected.id)
                .then(async (result) => {
                  if (result.url) await openExternalOAuthUrl(result.url);
                  if (result.userCode) setOauthCode(result.userCode);
                })
                .catch((err) => Alert.alert(err instanceof Error ? err.message : t('settings.error.loadFailed')))
                .finally(() => setBusy(false));
            }}
          />
          <SettingsCard>
            <SettingsTextField
              label={t('settings.providers.oauthCode')}
              value={oauthCode}
              onChangeText={setOauthCode}
              autoCapitalize="none"
            />
          </SettingsCard>
          <SettingsPrimaryButton
            label={t('settings.providers.oauthComplete')}
            disabled={busy || !oauthCode.trim()}
            onPress={() => {
              if (!active) return;
              setBusy(true);
              void completeProviderOAuth(active, selected.id, { code: oauthCode.trim() })
                .then(() => Alert.alert(t('settings.providers.oauthDone')))
                .catch((err) => Alert.alert(err instanceof Error ? err.message : t('settings.error.saveFailed')))
                .finally(() => setBusy(false));
            }}
          />
          <RNView style={{ padding: 16 }}>
            <Text style={{ color: theme.muted }}>
              {t('settings.providers.modelsCount', { count: selected.models.length })}
            </Text>
          </RNView>
        </ScrollView>
      </SettingsPageScaffold>
    );
  }

  return (
    <SettingsPageScaffold title={t('settings.pages.providers')} onBack={onBack}>
      <ScrollView contentContainerStyle={{ paddingVertical: 16 }}>
        {error ? (
          <SettingsErrorState message={error} onRetry={() => void reload()} />
        ) : providers == null ? (
          <SettingsLoading />
        ) : (
          <SettingsCard>
            {providers.map((p) => (
              <Pressable
                key={p.id}
                onPress={() => setSelected(p)}
                style={{ padding: 14, borderBottomWidth: 0.5, borderBottomColor: theme.border }}
              >
                <Text style={{ color: theme.text, fontWeight: '600' }}>{p.name}</Text>
                <Text style={{ color: theme.muted, fontSize: 12 }}>{p.id}</Text>
              </Pressable>
            ))}
          </SettingsCard>
        )}
      </ScrollView>
    </SettingsPageScaffold>
  );
}

export function AgentsSettingsPage({ onBack }: { onBack: () => void }) {
  const active = useActive();
  const theme = useSettingsTheme();
  const [agents, setAgents] = useState<AgentListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!active) {
      setError(t('settings.error.notConnected'));
      return;
    }
    setError(null);
    try {
      setAgents(await loadAgents(active));
    } catch (err) {
      setAgents(null);
      setError(err instanceof Error ? err.message : t('settings.error.loadFailed'));
    }
  }, [active]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <SettingsPageScaffold title={t('settings.pages.agents')} onBack={onBack}>
      <ScrollView contentContainerStyle={{ paddingVertical: 16 }}>
        {error ? (
          <SettingsErrorState message={error} onRetry={() => void reload()} />
        ) : agents == null ? (
          <SettingsLoading />
        ) : (
          <SettingsCard>
            {agents.map((agent) => (
              <RNView key={agent.name} style={{ padding: 14, borderBottomWidth: 0.5, borderBottomColor: theme.border }}>
                <Text style={{ color: theme.text, fontWeight: '600' }}>{agent.name}</Text>
                {agent.description ? (
                  <Text style={{ color: theme.muted, fontSize: 12, marginTop: 2 }}>{agent.description}</Text>
                ) : null}
              </RNView>
            ))}
          </SettingsCard>
        )}
      </ScrollView>
    </SettingsPageScaffold>
  );
}

export function CommandsSettingsPage({ onBack }: { onBack: () => void }) {
  const active = useActive();
  const theme = useSettingsTheme();
  const [commands, setCommands] = useState<CommandItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!active) {
      setError(t('settings.error.notConnected'));
      return;
    }
    try {
      setCommands(await loadCommandsCatalog(active));
    } catch (err) {
      setCommands(null);
      setError(err instanceof Error ? err.message : t('settings.error.loadFailed'));
    }
  }, [active]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <SettingsPageScaffold title={t('settings.pages.commands')} onBack={onBack}>
      <ScrollView contentContainerStyle={{ paddingVertical: 16 }}>
        {error ? (
          <SettingsErrorState message={error} onRetry={() => void reload()} />
        ) : commands == null ? (
          <SettingsLoading />
        ) : (
          <SettingsCard>
            {commands.map((cmd) => (
              <RNView key={cmd.name} style={{ padding: 14, borderBottomWidth: 0.5, borderBottomColor: theme.border }}>
                <Text style={{ color: theme.text, fontWeight: '600' }}>/{cmd.name}</Text>
                {cmd.description ? (
                  <Text style={{ color: theme.muted, fontSize: 12 }}>{cmd.description}</Text>
                ) : null}
              </RNView>
            ))}
          </SettingsCard>
        )}
      </ScrollView>
    </SettingsPageScaffold>
  );
}

export function McpSettingsPage({ onBack }: { onBack: () => void }) {
  const active = useActive();
  const theme = useSettingsTheme();
  const [servers, setServers] = useState<McpServerConfig[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [url, setUrl] = useState('');

  const reload = useCallback(async () => {
    if (!active) {
      setError(t('settings.error.notConnected'));
      return;
    }
    try {
      setServers(await loadMcpServers(active));
      setError(null);
    } catch (err) {
      setServers(null);
      setError(err instanceof Error ? err.message : t('settings.error.loadFailed'));
    }
  }, [active]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <SettingsPageScaffold title={t('settings.pages.mcp')} onBack={onBack}>
      <ScrollView contentContainerStyle={{ paddingVertical: 16 }}>
        {error ? <SettingsErrorState message={error} onRetry={() => void reload()} /> : null}
        {servers == null && !error ? <SettingsLoading /> : null}
        {servers ? (
          <SettingsCard>
            {servers.map((server) => (
              <RNView key={server.name} style={{ padding: 14, borderBottomWidth: 0.5, borderBottomColor: theme.border }}>
                <Text style={{ color: theme.text, fontWeight: '600' }}>{server.name}</Text>
                <Text style={{ color: theme.muted, fontSize: 12 }}>
                  {server.type || (server.url ? 'remote' : 'stdio')}
                </Text>
                <Pressable
                  onPress={() => {
                    if (!active) return;
                    void deleteMcpServer(active, server.name)
                      .then(reload)
                      .catch((err) => Alert.alert(err instanceof Error ? err.message : t('settings.error.saveFailed')));
                  }}
                >
                  <Text style={{ color: theme.danger, marginTop: 8 }}>{t('settings.actions.delete')}</Text>
                </Pressable>
              </RNView>
            ))}
          </SettingsCard>
        ) : null}
        <SettingsCard>
          <SettingsTextField label={t('settings.mcp.name')} value={name} onChangeText={setName} autoCapitalize="none" />
          <SettingsTextField label={t('settings.mcp.command')} value={command} onChangeText={setCommand} autoCapitalize="none" />
          <SettingsTextField label={t('settings.mcp.url')} value={url} onChangeText={setUrl} autoCapitalize="none" />
        </SettingsCard>
        <SettingsPrimaryButton
          label={t('settings.mcp.add')}
          onPress={() => {
            if (!active || !name.trim()) return;
            const config: Record<string, unknown> = url.trim()
              ? { type: 'remote', url: url.trim(), enabled: true }
              : { type: 'local', command: command.trim(), enabled: true };
            void upsertMcpServer(active, name.trim(), config)
              .then(() => {
                setName('');
                setCommand('');
                setUrl('');
                return reload();
              })
              .catch((err) => Alert.alert(err instanceof Error ? err.message : t('settings.error.saveFailed')));
          }}
        />
        <SettingsPrimaryButton
          label={t('settings.mcp.oauthPending')}
          onPress={() => {
            if (!active || !name.trim()) return;
            const stateKey = `mcp-${Date.now()}`;
            void queueMcpOAuthPending(active, { state: stateKey, name: name.trim() })
              .then(() => Alert.alert(t('settings.mcp.oauthQueued')))
              .catch((err) => Alert.alert(err instanceof Error ? err.message : t('settings.error.saveFailed')));
          }}
        />
      </ScrollView>
    </SettingsPageScaffold>
  );
}

export function PluginsSettingsPage({ onBack }: { onBack: () => void }) {
  const active = useActive();
  const theme = useSettingsTheme();
  const [list, setList] = useState<PluginsList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [spec, setSpec] = useState('');
  const [fileId, setFileId] = useState('');
  const [fileContent, setFileContent] = useState('');

  const reload = useCallback(async () => {
    if (!active) {
      setError(t('settings.error.notConnected'));
      return;
    }
    try {
      setList(await loadPlugins(active));
      setError(null);
    } catch (err) {
      setList(null);
      setError(err instanceof Error ? err.message : t('settings.error.loadFailed'));
    }
  }, [active]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <SettingsPageScaffold title={t('settings.pages.plugins')} onBack={onBack}>
      <ScrollView contentContainerStyle={{ paddingVertical: 16 }}>
        {error ? <SettingsErrorState message={error} onRetry={() => void reload()} /> : null}
        {list == null && !error ? <SettingsLoading /> : null}
        {list ? (
          <SettingsCard>
            {list.entries.map((entry) => (
              <RNView key={entry.id} style={{ padding: 14, borderBottomWidth: 0.5, borderBottomColor: theme.border }}>
                <Text style={{ color: theme.text, fontWeight: '600' }}>{entry.spec || entry.id}</Text>
                <Pressable
                  onPress={() => {
                    if (!active) return;
                    void deletePluginEntry(active, entry.id)
                      .then(reload)
                      .catch((err) => Alert.alert(err instanceof Error ? err.message : t('settings.error.saveFailed')));
                  }}
                >
                  <Text style={{ color: theme.danger, marginTop: 8 }}>{t('settings.actions.delete')}</Text>
                </Pressable>
              </RNView>
            ))}
            {list.files.map((file) => (
              <Pressable
                key={file.id}
                onPress={() => {
                  if (!active) return;
                  setFileId(file.id);
                  void loadPluginFile(active, file.id)
                    .then((f) => setFileContent(f.content))
                    .catch((err) => Alert.alert(err instanceof Error ? err.message : t('settings.error.loadFailed')));
                }}
                style={{ padding: 14, borderBottomWidth: 0.5, borderBottomColor: theme.border }}
              >
                <Text style={{ color: theme.text }}>{file.fileName || file.id}</Text>
              </Pressable>
            ))}
          </SettingsCard>
        ) : null}
        <SettingsCard>
          <SettingsTextField label={t('settings.plugins.spec')} value={spec} onChangeText={setSpec} autoCapitalize="none" />
        </SettingsCard>
        <SettingsPrimaryButton
          label={t('settings.plugins.add')}
          onPress={() => {
            if (!active || !spec.trim()) return;
            void createPluginEntry(active, { spec: spec.trim() })
              .then(() => {
                setSpec('');
                return reload();
              })
              .catch((err) => Alert.alert(err instanceof Error ? err.message : t('settings.error.saveFailed')));
          }}
        />
        {fileId ? (
          <>
            <SettingsCard>
              <SettingsTextField
                label={t('settings.plugins.fileContent')}
                value={fileContent}
                onChangeText={setFileContent}
                multiline
                style={{ minHeight: 160, textAlignVertical: 'top' }}
              />
            </SettingsCard>
            <SettingsPrimaryButton
              label={t('settings.actions.save')}
              onPress={() => {
                if (!active) return;
                void putPluginFile(active, fileId, fileContent)
                  .then(() => Alert.alert(t('settings.providers.saved')))
                  .catch((err) => Alert.alert(err instanceof Error ? err.message : t('settings.error.saveFailed')));
              }}
            />
          </>
        ) : null}
      </ScrollView>
    </SettingsPageScaffold>
  );
}

export function SkillsSettingsPage({ onBack }: { onBack: () => void }) {
  const active = useActive();
  const theme = useSettingsTheme();
  const [skills, setSkills] = useState<SkillSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!active) {
      setError(t('settings.error.notConnected'));
      return;
    }
    try {
      setSkills(await loadInstalledSkills(active));
      setError(null);
    } catch (err) {
      setSkills(null);
      setError(err instanceof Error ? err.message : t('settings.error.loadFailed'));
    }
  }, [active]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <SettingsPageScaffold title={t('settings.pages.skills')} onBack={onBack}>
      <ScrollView contentContainerStyle={{ paddingVertical: 16 }}>
        {error ? (
          <SettingsErrorState message={error} onRetry={() => void reload()} />
        ) : skills == null ? (
          <SettingsLoading />
        ) : (
          <SettingsCard>
            {skills.map((skill) => (
              <RNView key={skill.name} style={{ padding: 14, borderBottomWidth: 0.5, borderBottomColor: theme.border }}>
                <Text style={{ color: theme.text, fontWeight: '600' }}>{skill.name}</Text>
                {skill.description ? (
                  <Text style={{ color: theme.muted, fontSize: 12 }}>{skill.description}</Text>
                ) : null}
              </RNView>
            ))}
          </SettingsCard>
        )}
      </ScrollView>
    </SettingsPageScaffold>
  );
}

export function SnippetsSettingsPage({ onBack }: { onBack: () => void }) {
  const active = useActive();
  const theme = useSettingsTheme();
  const [snippets, setSnippets] = useState<SnippetItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [content, setContent] = useState('');

  const reload = useCallback(async () => {
    if (!active) {
      setError(t('settings.error.notConnected'));
      return;
    }
    try {
      setSnippets(await loadSnippets(active));
      setError(null);
    } catch (err) {
      setSnippets(null);
      setError(err instanceof Error ? err.message : t('settings.error.loadFailed'));
    }
  }, [active]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <SettingsPageScaffold title={t('settings.pages.snippets')} onBack={onBack}>
      <ScrollView contentContainerStyle={{ paddingVertical: 16 }}>
        {error ? <SettingsErrorState message={error} onRetry={() => void reload()} /> : null}
        {snippets == null && !error ? <SettingsLoading /> : null}
        {snippets ? (
          <SettingsCard>
            {snippets.map((s) => (
              <Pressable
                key={s.name}
                onPress={() => {
                  setName(s.name);
                  setContent(s.content ?? '');
                }}
                style={{ padding: 14, borderBottomWidth: 0.5, borderBottomColor: theme.border }}
              >
                <Text style={{ color: theme.text, fontWeight: '600' }}>{s.name}</Text>
              </Pressable>
            ))}
          </SettingsCard>
        ) : null}
        <SettingsCard>
          <SettingsTextField label={t('settings.snippets.name')} value={name} onChangeText={setName} autoCapitalize="none" />
          <SettingsTextField
            label={t('settings.snippets.content')}
            value={content}
            onChangeText={setContent}
            multiline
            style={{ minHeight: 120, textAlignVertical: 'top' }}
          />
        </SettingsCard>
        <SettingsPrimaryButton
          label={t('settings.actions.save')}
          onPress={() => {
            if (!active || !name.trim()) return;
            void upsertSnippet(active, name.trim(), { content })
              .then(reload)
              .catch((err) => Alert.alert(err instanceof Error ? err.message : t('settings.error.saveFailed')));
          }}
        />
      </ScrollView>
    </SettingsPageScaffold>
  );
}

export function MagicPromptsSettingsPage({ onBack }: { onBack: () => void }) {
  const active = useActive();
  const theme = useSettingsTheme();
  const [items, setItems] = useState<MagicPromptItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<MagicPromptItem | null>(null);

  const reload = useCallback(async () => {
    if (!active) {
      setError(t('settings.error.notConnected'));
      return;
    }
    try {
      setItems(await loadMagicPrompts(active));
      setError(null);
    } catch (err) {
      setItems(null);
      setError(err instanceof Error ? err.message : t('settings.error.loadFailed'));
    }
  }, [active]);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (selected) {
    return (
      <SettingsPageScaffold title={selected.title || selected.id} onBack={() => setSelected(null)}>
        <ScrollView contentContainerStyle={{ paddingVertical: 16 }}>
          <SettingsCard>
            <SettingsTextField
              label={t('settings.magic.visible')}
              value={selected.visiblePrompt ?? ''}
              onChangeText={(visiblePrompt) => setSelected({ ...selected, visiblePrompt })}
              multiline
              style={{ minHeight: 80, textAlignVertical: 'top' }}
            />
            <SettingsTextField
              label={t('settings.magic.instructions')}
              value={selected.instructions ?? ''}
              onChangeText={(instructions) => setSelected({ ...selected, instructions })}
              multiline
              style={{ minHeight: 120, textAlignVertical: 'top' }}
            />
          </SettingsCard>
          <SettingsPrimaryButton
            label={t('settings.actions.save')}
            onPress={() => {
              if (!active) return;
              void putMagicPrompt(active, selected.id, {
                visiblePrompt: selected.visiblePrompt,
                instructions: selected.instructions,
              })
                .then(() => reload().then(() => setSelected(null)))
                .catch((err) => Alert.alert(err instanceof Error ? err.message : t('settings.error.saveFailed')));
            }}
          />
        </ScrollView>
      </SettingsPageScaffold>
    );
  }

  return (
    <SettingsPageScaffold title={t('settings.pages.magicPrompts')} onBack={onBack}>
      <ScrollView contentContainerStyle={{ paddingVertical: 16 }}>
        {error ? (
          <SettingsErrorState message={error} onRetry={() => void reload()} />
        ) : items == null ? (
          <SettingsLoading />
        ) : (
          <SettingsCard>
            {items.map((item) => (
              <Pressable
                key={item.id}
                onPress={() => setSelected(item)}
                style={{ padding: 14, borderBottomWidth: 0.5, borderBottomColor: theme.border }}
              >
                <Text style={{ color: theme.text, fontWeight: '600' }}>{item.title || item.id}</Text>
              </Pressable>
            ))}
          </SettingsCard>
        )}
        <SettingsPrimaryButton
          label={t('settings.magic.reset')}
          onPress={() => {
            if (!active) return;
            void resetMagicPromptOverrides(active)
              .then(reload)
              .catch((err) => Alert.alert(err instanceof Error ? err.message : t('settings.error.saveFailed')));
          }}
        />
      </ScrollView>
    </SettingsPageScaffold>
  );
}

export function UsageSettingsPage({ onBack }: { onBack: () => void }) {
  const active = useActive();
  const theme = useSettingsTheme();
  const [rows, setRows] = useState<ProviderQuota[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!active) {
      setError(t('settings.error.notConnected'));
      return;
    }
    setError(null);
    try {
      const catalog = await loadProviderCatalog(active);
      const ids = catalog.providers.map((p) => p.id).slice(0, 12);
      setRows(await loadProviderQuotas(active, ids));
    } catch (err) {
      setRows(null);
      setError(err instanceof Error ? err.message : t('settings.error.loadFailed'));
    }
  }, [active]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <SettingsPageScaffold title={t('settings.pages.usage')} onBack={onBack}>
      <ScrollView contentContainerStyle={{ paddingVertical: 16 }}>
        {error ? (
          <SettingsErrorState message={error} onRetry={() => void reload()} />
        ) : rows == null ? (
          <SettingsLoading />
        ) : (
          <SettingsCard>
            {rows.map((row) => (
              <RNView key={row.providerId} style={{ padding: 14, borderBottomWidth: 0.5, borderBottomColor: theme.border }}>
                <Text style={{ color: theme.text, fontWeight: '600' }}>{row.providerId}</Text>
                {row.ok ? (
                  <Text style={{ color: theme.muted, fontSize: 12 }}>{t('settings.usage.ok')}</Text>
                ) : (
                  <Text style={{ color: theme.danger, fontSize: 12 }}>{row.error}</Text>
                )}
              </RNView>
            ))}
          </SettingsCard>
        )}
      </ScrollView>
    </SettingsPageScaffold>
  );
}
