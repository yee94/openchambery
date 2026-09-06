import { useEffect, useState } from 'react';

import type { LynxConnectionClient } from '../connection/client';
import type { LynxPendingConnection, LynxSavedConnection } from '../connection/types';
import { connectionDisplayUrl } from '../connection/urls';
import { loadAssistantSnapshot } from '../assistants/api';
import { lynxT } from '../i18n/catalog';
import { LynxInput, LynxText, LynxView } from '../lynx-elements';
import type { LynxRuntimeFetch } from '../runtime/fetch';
import { cssVar } from '../theme/tokens';
import { parsePastedPairingLink } from '../connect/pairingPaste';
import {
  appearancePatchFromThemeChoice,
  loadLynxSettings,
  loadLynxSystemInfo,
  saveLynxSettings,
  type LynxSettingsBlob,
  LYNX_APPEARANCE_THEME_IDS,
} from './api';
import {
  LYNX_RESPONSE_STYLE_PRESETS,
  loadLynxAgentsMd,
  loadLynxSmallModelCapabilities,
  sanitizeLynxResponseStylePreset,
  saveLynxAgentsMd,
  type LynxResponseStyleValue,
} from './behavior';
import {
  catalogLoaderForSlug,
  loadUsageRows,
  type LynxCatalogItem,
  type LynxUsageRow,
} from './catalogs';
import { LynxEntityEditor } from './EntityEditor';
import { isLynxEntityKind, type LynxEntityKind } from './entityApi';
import type { LynxMobileSettingsSlug } from './slugs';
import type { LynxSettingsBodyKind } from './metadata';

export type SettingsBodyContext = {
  locale: string;
  runtimeFetch: LynxRuntimeFetch | null;
  /** Package version for About — separate from instance openchamberVersion. */
  lynxClientVersion: string;
  connectionClient?: LynxConnectionClient | null;
  connections?: LynxSavedConnection[];
  onConnectionsChange?: (connections: LynxSavedConnection[]) => void;
  onConnected?: () => void;
};

function Banner({ text, muted }: { text: string; muted?: boolean }) {
  return (
    <LynxText
      style={{
        color: muted ? cssVar('surface.mutedForeground') : cssVar('surface.foreground'),
        marginBottom: '12px',
      }}
    >
      {text}
    </LynxText>
  );
}

function Row({ title, subtitle, onTap }: { title: string; subtitle?: string; onTap?: () => void }) {
  return (
    <LynxView
      bindtap={onTap}
      style={{
        padding: '12px 0',
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
      }}
    >
      <LynxView style={{ flexGrow: 1, minWidth: '0px' }}>
        <LynxText style={{ color: cssVar('surface.foreground'), fontSize: '15px' }}>{title}</LynxText>
        {subtitle ? (
          <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '12px' }}>{subtitle}</LynxText>
        ) : null}
      </LynxView>
      {onTap ? <LynxText style={{ color: cssVar('surface.mutedForeground') }}>›</LynxText> : null}
    </LynxView>
  );
}

function ToggleRow({
  label,
  value,
  onToggle,
}: {
  label: string;
  value: boolean;
  onToggle: () => void;
}) {
  return (
    <LynxView
      bindtap={onToggle}
      accessibility-role="button"
      style={{
        padding: '12px 0',
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
      }}
    >
      <LynxText style={{ color: cssVar('surface.foreground') }}>{label}</LynxText>
      <LynxText style={{ color: cssVar('primary.base'), fontWeight: '600' }}>
        {value ? 'ON' : 'OFF'}
      </LynxText>
    </LynxView>
  );
}

function useSettingsBlob(runtimeFetch: LynxRuntimeFetch | null) {
  const [settings, setSettings] = useState<LynxSettingsBlob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<'loading' | 'ok' | 'failed' | 'no-runtime'>('loading');
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await loadLynxSettings(runtimeFetch);
      if (cancelled) return;
      if (result.status === 'ok') {
        setSettings(result.settings);
        setStatus('ok');
        setError(null);
        return;
      }
      if (result.status === 'no-runtime') {
        setStatus('no-runtime');
        setSettings(null);
        return;
      }
      setStatus('failed');
      setError(result.error.message);
      setSettings(null);
    })();
    return () => {
      cancelled = true;
    };
  }, [runtimeFetch, reloadToken]);

  const patch = async (changes: Partial<LynxSettingsBlob>) => {
    const result = await saveLynxSettings(runtimeFetch, changes);
    if (result.status === 'ok') {
      setSettings(result.settings);
      setStatus('ok');
      setError(null);
      return true;
    }
    setError(result.status === 'failed' ? result.error.message : 'no-runtime');
    return false;
  };

  const reload = async () => {
    setReloadToken((value) => value + 1);
  };

  return { settings, error, status, patch, reload };
}

function useSettingsBlobWithReload(runtimeFetch: LynxRuntimeFetch | null) {
  return useSettingsBlob(runtimeFetch);
}

function AppearanceBody({ ctx }: { ctx: SettingsBodyContext }) {
  const { settings, error, status, patch } = useSettingsBlob(ctx.runtimeFetch);
  if (status === 'no-runtime') return <Banner text={lynxT(ctx.locale, 'lynx.settings.noRuntime')} muted />;
  if (status === 'failed') return <Banner text={error || lynxT(ctx.locale, 'lynx.settings.loadFailed')} />;
  if (status === 'loading' || !settings) return <Banner text={lynxT(ctx.locale, 'lynx.settings.loading')} muted />;

  const choice = settings.useSystemTheme
    ? 'system'
    : settings.themeVariant === 'dark' || settings.themeId === LYNX_APPEARANCE_THEME_IDS.dark
      ? 'dark'
      : 'light';

  const labels = {
    system: lynxT(ctx.locale, 'lynx.settings.appearance.system'),
    light: lynxT(ctx.locale, 'lynx.settings.appearance.light'),
    dark: lynxT(ctx.locale, 'lynx.settings.appearance.dark'),
  } as const;

  return (
    <LynxView>
      <Banner text={lynxT(ctx.locale, 'lynx.settings.appearance.hint')} muted />
      {(['system', 'light', 'dark'] as const).map((item) => (
        <Row
          key={item}
          title={labels[item]}
          subtitle={item === choice ? '✓' : undefined}
          onTap={() => {
            void patch(appearancePatchFromThemeChoice(item));
          }}
        />
      ))}
      <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '12px', marginTop: '8px' }}>
        {LYNX_APPEARANCE_THEME_IDS.light} / {LYNX_APPEARANCE_THEME_IDS.dark}
      </LynxText>
    </LynxView>
  );
}

function ChatBody({ ctx }: { ctx: SettingsBodyContext }) {
  const { settings, error, status, patch } = useSettingsBlob(ctx.runtimeFetch);
  if (status === 'no-runtime') return <Banner text={lynxT(ctx.locale, 'lynx.settings.noRuntime')} muted />;
  if (status === 'failed') return <Banner text={error || lynxT(ctx.locale, 'lynx.settings.loadFailed')} />;
  if (status === 'loading' || !settings) return <Banner text={lynxT(ctx.locale, 'lynx.settings.loading')} muted />;

  return (
    <LynxView>
      <ToggleRow
        label={lynxT(ctx.locale, 'lynx.settings.chat.reasoning')}
        value={Boolean(settings.showReasoningTraces)}
        onToggle={() => {
          void patch({ showReasoningTraces: !settings.showReasoningTraces });
        }}
      />
      <ToggleRow
        label={lynxT(ctx.locale, 'lynx.settings.chat.queue')}
        value={Boolean(settings.queueModeEnabled)}
        onToggle={() => {
          void patch({ queueModeEnabled: !settings.queueModeEnabled });
        }}
      />
      <Row
        title={lynxT(ctx.locale, 'lynx.settings.chat.followUp')}
        subtitle={settings.followUpBehavior === 'steer' ? 'steer' : 'queue'}
        onTap={() => {
          void patch({
            followUpBehavior: settings.followUpBehavior === 'steer' ? 'queue' : 'steer',
          });
        }}
      />
    </LynxView>
  );
}

function NotificationsBody({ ctx }: { ctx: SettingsBodyContext }) {
  const { settings, error, status, patch } = useSettingsBlob(ctx.runtimeFetch);
  if (status === 'no-runtime') return <Banner text={lynxT(ctx.locale, 'lynx.settings.noRuntime')} muted />;
  if (status === 'failed') return <Banner text={error || lynxT(ctx.locale, 'lynx.settings.loadFailed')} />;
  if (status === 'loading' || !settings) return <Banner text={lynxT(ctx.locale, 'lynx.settings.loading')} muted />;

  return (
    <LynxView>
      <ToggleRow
        label={lynxT(ctx.locale, 'lynx.settings.notifications.native')}
        value={Boolean(settings.nativeNotificationsEnabled)}
        onToggle={() => {
          void patch({ nativeNotificationsEnabled: !settings.nativeNotificationsEnabled });
        }}
      />
      <Row
        title={lynxT(ctx.locale, 'lynx.settings.notifications.mode')}
        subtitle={settings.notificationMode === 'always' ? 'always' : 'hidden-only'}
        onTap={() => {
          void patch({
            notificationMode: settings.notificationMode === 'always' ? 'hidden-only' : 'always',
          });
        }}
      />
      <Banner text={lynxT(ctx.locale, 'lynx.settings.notifications.hooks')} muted />
    </LynxView>
  );
}

function SessionsBody({ ctx }: { ctx: SettingsBodyContext }) {
  const { settings, error, status, patch } = useSettingsBlob(ctx.runtimeFetch);
  if (status === 'no-runtime') return <Banner text={lynxT(ctx.locale, 'lynx.settings.noRuntime')} muted />;
  if (status === 'failed') return <Banner text={error || lynxT(ctx.locale, 'lynx.settings.loadFailed')} />;
  if (status === 'loading' || !settings) return <Banner text={lynxT(ctx.locale, 'lynx.settings.loading')} muted />;

  return (
    <LynxView>
      <ToggleRow
        label={lynxT(ctx.locale, 'lynx.settings.sessions.autoDelete')}
        value={Boolean(settings.autoDeleteEnabled)}
        onToggle={() => {
          void patch({ autoDeleteEnabled: !settings.autoDeleteEnabled });
        }}
      />
      <Row
        title={lynxT(ctx.locale, 'lynx.settings.sessions.retention')}
        subtitle={settings.sessionRetentionAction === 'delete' ? 'delete' : 'archive'}
        onTap={() => {
          void patch({
            sessionRetentionAction: settings.sessionRetentionAction === 'delete' ? 'archive' : 'delete',
          });
        }}
      />
    </LynxView>
  );
}

function ProjectsSettingsBody({ ctx }: { ctx: SettingsBodyContext }) {
  const { settings, error, status, reload } = useSettingsBlobWithReload(ctx.runtimeFetch);
  const [selected, setSelected] = useState<LynxCatalogItem | null>(null);

  if (selected) {
    return (
      <LynxEntityEditor
        locale={ctx.locale}
        runtimeFetch={ctx.runtimeFetch}
        kind="projects"
        item={selected}
        onBack={() => setSelected(null)}
        onMutated={() => { void reload(); }}
      />
    );
  }

  if (status === 'no-runtime') return <Banner text={lynxT(ctx.locale, 'lynx.settings.noRuntime')} muted />;
  if (status === 'failed') return <Banner text={error || lynxT(ctx.locale, 'lynx.settings.loadFailed')} />;
  if (status === 'loading' || !settings) return <Banner text={lynxT(ctx.locale, 'lynx.settings.loading')} muted />;

  const projects = Array.isArray(settings.projects) ? settings.projects : [];
  if (projects.length === 0) {
    return <Banner text={lynxT(ctx.locale, 'lynx.settings.catalog.empty')} muted />;
  }
  return (
    <LynxView>
      {projects.map((project, index) => {
        const id = typeof project.id === 'string' && project.id.trim()
          ? project.id.trim()
          : (typeof project.path === 'string' ? project.path : `project-${index}`);
        const title = typeof project.name === 'string' ? project.name : (typeof project.path === 'string' ? project.path : id);
        const subtitle = typeof project.path === 'string' ? project.path : undefined;
        const item = { id, title, subtitle };
        return (
          <Row
            key={id}
            title={title}
            subtitle={subtitle}
            onTap={() => setSelected(item)}
          />
        );
      })}
    </LynxView>
  );
}

function CatalogBody({
  ctx,
  slug,
}: {
  ctx: SettingsBodyContext;
  slug: LynxMobileSettingsSlug;
}) {
  const [items, setItems] = useState<LynxCatalogItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<'loading' | 'ok' | 'failed' | 'no-runtime' | 'unsupported'>('loading');
  const [selected, setSelected] = useState<LynxCatalogItem | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const loader = catalogLoaderForSlug(slug);
    if (!loader) {
      setStatus('failed');
      setError('no loader');
      return;
    }
    void (async () => {
      const result = await loader(ctx.runtimeFetch);
      if (cancelled) return;
      if (result.status === 'ok') {
        setItems(result.items);
        setStatus('ok');
        return;
      }
      setItems(null);
      setStatus(result.status);
      if (result.status === 'failed') setError(result.error.message);
    })();
    return () => {
      cancelled = true;
    };
  }, [ctx.runtimeFetch, slug, reloadToken]);

  if (selected && isLynxEntityKind(slug)) {
    return (
      <LynxEntityEditor
        locale={ctx.locale}
        runtimeFetch={ctx.runtimeFetch}
        kind={slug as LynxEntityKind}
        item={selected}
        onBack={() => setSelected(null)}
        onMutated={() => {
          setSelected(null);
          setReloadToken((value) => value + 1);
        }}
      />
    );
  }

  if (status === 'no-runtime') return <Banner text={lynxT(ctx.locale, 'lynx.settings.noRuntime')} muted />;
  if (status === 'unsupported') return <Banner text={lynxT(ctx.locale, 'lynx.settings.unsupported')} muted />;
  if (status === 'failed') return <Banner text={error || lynxT(ctx.locale, 'lynx.settings.loadFailed')} />;
  if (status === 'loading' || !items) return <Banner text={lynxT(ctx.locale, 'lynx.settings.loading')} muted />;
  if (items.length === 0) {
    return (
      <LynxView>
        <Banner text={lynxT(ctx.locale, 'lynx.settings.catalog.empty')} muted />
      </LynxView>
    );
  }
  return (
    <LynxView>
      {items.map((item) => (
        <Row
          key={item.id}
          title={item.title}
          subtitle={item.subtitle}
          onTap={() => setSelected(item)}
        />
      ))}
    </LynxView>
  );
}

function AssistantsSettingsBody({ ctx }: { ctx: SettingsBodyContext }) {
  const [items, setItems] = useState<LynxCatalogItem[] | null>(null);
  const [status, setStatus] = useState<'loading' | 'ok' | 'failed' | 'no-runtime' | 'unsupported' | 'disabled'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<LynxCatalogItem | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await loadAssistantSnapshot(ctx.runtimeFetch);
      if (cancelled) return;
      if (result.status === 'ok') {
        if (!result.snapshot.enabled) {
          setStatus('disabled');
          setItems([]);
          return;
        }
        setItems(result.snapshot.assistants.map((assistant) => ({
          id: assistant.id,
          title: assistant.name,
          subtitle: assistant.mode,
        })));
        setStatus('ok');
        return;
      }
      setItems(null);
      setStatus(result.status === 'failed' ? 'failed' : result.status);
      if (result.status === 'failed') setError(result.error.message);
    })();
    return () => {
      cancelled = true;
    };
  }, [ctx.runtimeFetch, reloadToken]);

  if (selected) {
    return (
      <LynxEntityEditor
        locale={ctx.locale}
        runtimeFetch={ctx.runtimeFetch}
        kind="assistants"
        item={selected}
        onBack={() => setSelected(null)}
        onMutated={() => {
          setSelected(null);
          setReloadToken((value) => value + 1);
        }}
      />
    );
  }

  if (status === 'no-runtime') return <Banner text={lynxT(ctx.locale, 'lynx.settings.noRuntime')} muted />;
  if (status === 'unsupported') return <Banner text={lynxT(ctx.locale, 'lynx.settings.unsupported')} muted />;
  if (status === 'disabled') return <Banner text={lynxT(ctx.locale, 'lynx.assistant.disabled')} muted />;
  if (status === 'failed') return <Banner text={error || lynxT(ctx.locale, 'lynx.settings.loadFailed')} />;
  if (status === 'loading' || !items) return <Banner text={lynxT(ctx.locale, 'lynx.settings.loading')} muted />;

  return (
    <LynxView>
      {items.length === 0 ? <Banner text={lynxT(ctx.locale, 'lynx.settings.catalog.empty')} muted /> : null}
      {items.map((item) => (
        <Row
          key={item.id}
          title={item.title}
          subtitle={item.subtitle}
          onTap={() => setSelected(item)}
        />
      ))}
    </LynxView>
  );
}

function UsageBody({ ctx }: { ctx: SettingsBodyContext }) {
  const [rows, setRows] = useState<LynxUsageRow[] | null>(null);
  const [status, setStatus] = useState<'loading' | 'ok' | 'failed' | 'no-runtime'>('loading');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await loadUsageRows(ctx.runtimeFetch);
      if (cancelled) return;
      if (result.status === 'ok') {
        setRows(result.rows);
        setStatus('ok');
        return;
      }
      setRows(null);
      setStatus(result.status);
      if (result.status === 'failed') setError(result.error.message);
    })();
    return () => {
      cancelled = true;
    };
  }, [ctx.runtimeFetch]);

  if (status === 'no-runtime') return <Banner text={lynxT(ctx.locale, 'lynx.settings.noRuntime')} muted />;
  if (status === 'failed') return <Banner text={error || lynxT(ctx.locale, 'lynx.settings.loadFailed')} />;
  if (status === 'loading' || !rows) return <Banner text={lynxT(ctx.locale, 'lynx.settings.loading')} muted />;

  return (
    <LynxView>
      {rows.map((row) => (
        <Row
          key={row.providerId}
          title={row.label}
          subtitle={row.status === 'ok' ? (row.detail || 'ok') : `failed: ${row.error || 'unknown'}`}
        />
      ))}
    </LynxView>
  );
}

function AboutBody({ ctx }: { ctx: SettingsBodyContext }) {
  const [instanceVersion, setInstanceVersion] = useState<string | null>(null);
  const [status, setStatus] = useState<'loading' | 'ok' | 'failed' | 'no-runtime'>('loading');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await loadLynxSystemInfo(ctx.runtimeFetch);
      if (cancelled) return;
      if (result.status === 'ok') {
        setInstanceVersion(result.info.openchamberVersion);
        setStatus('ok');
        return;
      }
      setInstanceVersion(null);
      setStatus(result.status);
    })();
    return () => {
      cancelled = true;
    };
  }, [ctx.runtimeFetch]);

  return (
    <LynxView>
      <Row
        title={lynxT(ctx.locale, 'lynx.settings.about.lynxVersion')}
        subtitle={ctx.lynxClientVersion}
      />
      {status === 'no-runtime' ? (
        <Banner text={lynxT(ctx.locale, 'lynx.settings.noRuntime')} muted />
      ) : status === 'failed' ? (
        <Banner text={lynxT(ctx.locale, 'lynx.settings.about.instanceFailed')} />
      ) : status === 'loading' ? (
        <Banner text={lynxT(ctx.locale, 'lynx.settings.loading')} muted />
      ) : (
        <Row
          title={lynxT(ctx.locale, 'lynx.settings.about.instanceVersion')}
          subtitle={instanceVersion || '—'}
        />
      )}
    </LynxView>
  );
}

function InstancesBody({ ctx }: { ctx: SettingsBodyContext }) {
  const client = ctx.connectionClient ?? null;
  const [connections, setConnections] = useState<LynxSavedConnection[]>(
    ctx.connections ?? client?.loadConnections() ?? [],
  );
  const [pending, setPending] = useState<LynxPendingConnection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pasteValue, setPasteValue] = useState('');

  useEffect(() => {
    if (ctx.connections) setConnections(ctx.connections);
  }, [ctx.connections]);

  if (!client) {
    return <Banner text={lynxT(ctx.locale, 'lynx.settings.instances.noClient')} muted />;
  }

  return (
    <LynxView>
      {error ? <Banner text={error} /> : null}
      {connections.map((connection) => (
        <LynxView
          key={connection.id}
          style={{ flexDirection: 'row', justifyContent: 'space-between', padding: '12px 0' }}
        >
          <LynxView
            style={{ flexGrow: 1 }}
            bindtap={() => {
              void (async () => {
                const result = await client.connect({
                  id: connection.id,
                  candidates: connection.candidates,
                });
                if (result.status === 'connected') {
                  const next = client.loadConnections();
                  setConnections(next);
                  ctx.onConnectionsChange?.(next);
                  ctx.onConnected?.();
                  return;
                }
                if (result.status === 'needs-login') {
                  setPending(result.pending);
                  return;
                }
                setError(result.error);
              })();
            }}
          >
            <LynxText style={{ color: cssVar('surface.foreground'), fontWeight: '600' }}>
              {connection.label}
            </LynxText>
            <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '12px' }}>
              {connectionDisplayUrl(connection)}
            </LynxText>
          </LynxView>
          <LynxView
            bindtap={() => {
              void (async () => {
                const next = await client.remove(connection.id);
                setConnections(next);
                ctx.onConnectionsChange?.(next);
              })();
            }}
          >
            <LynxText style={{ color: cssVar('surface.mutedForeground') }}>
              {lynxT(ctx.locale, 'lynx.connect.instances.delete')}
            </LynxText>
          </LynxView>
        </LynxView>
      ))}
      {pending ? (
        <Banner text={`${lynxT(ctx.locale, 'lynx.connect.password.title')}: ${pending.label}`} />
      ) : null}
      <LynxView style={{ marginTop: '12px', padding: '12px', borderRadius: '12px', backgroundColor: cssVar('surface.elevated') }}>
        <LynxText style={{ color: cssVar('surface.foreground'), fontWeight: '600', marginBottom: '8px' }}>
          {lynxT(ctx.locale, 'lynx.connect.paste.title')}
        </LynxText>
        <LynxText
          style={{ color: pasteValue ? cssVar('surface.foreground') : cssVar('surface.mutedForeground') }}
          bindtap={() => setPasteValue(pasteValue ? '' : 'openchamber://')}
        >
          {pasteValue || lynxT(ctx.locale, 'lynx.connect.paste.placeholder')}
        </LynxText>
        <LynxView
          style={{ marginTop: '8px' }}
          bindtap={() => {
            void (async () => {
              const parsed = parsePastedPairingLink(pasteValue);
              if (parsed.status !== 'pairing') {
                setError(lynxT(ctx.locale, 'lynx.connect.paste.invalid'));
                return;
              }
              const result = await client.redeemPairingConnection(parsed.pairing);
              if (result.status === 'connected') {
                const next = client.loadConnections();
                setConnections(next);
                ctx.onConnectionsChange?.(next);
                ctx.onConnected?.();
                return;
              }
              if (result.status === 'needs-login') {
                setPending(result.pending);
                return;
              }
              setError(result.error);
            })();
          }}
        >
          <LynxText style={{ color: cssVar('primary.base'), fontWeight: '600' }}>
            {lynxT(ctx.locale, 'lynx.connect.paste.submit')}
          </LynxText>
        </LynxView>
      </LynxView>
      <Banner text={lynxT(ctx.locale, 'lynx.connect.qr.stub')} muted />
    </LynxView>
  );
}

function GitBody({ ctx }: { ctx: SettingsBodyContext }) {
  const { settings, error, status, patch } = useSettingsBlob(ctx.runtimeFetch);
  if (status === 'no-runtime') return <Banner text={lynxT(ctx.locale, 'lynx.settings.noRuntime')} muted />;
  if (status === 'failed') return <Banner text={error || lynxT(ctx.locale, 'lynx.settings.loadFailed')} />;
  if (status === 'loading' || !settings) return <Banner text={lynxT(ctx.locale, 'lynx.settings.loading')} muted />;
  return (
    <LynxView>
      <ToggleRow
        label={lynxT(ctx.locale, 'lynx.settings.git.gitmoji')}
        value={Boolean(settings.gitmojiEnabled)}
        onToggle={() => {
          void patch({ gitmojiEnabled: !settings.gitmojiEnabled });
        }}
      />
      <Banner text={lynxT(ctx.locale, 'lynx.settings.editor.stub')} muted />
    </LynxView>
  );
}


function SummaryAiBody({ ctx }: { ctx: SettingsBodyContext }) {
  const { settings, error, status, patch } = useSettingsBlob(ctx.runtimeFetch);
  const [capabilities, setCapabilities] = useState<Record<string, string[]> | null>(null);
  const [capStatus, setCapStatus] = useState<'loading' | 'ok' | 'empty' | 'failed' | 'no-runtime'>('loading');
  const [capError, setCapError] = useState<string | null>(null);
  const [commitPrompt, setCommitPrompt] = useState('');
  const [titlePrompt, setTitlePrompt] = useState('');
  const [promptsReady, setPromptsReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await loadLynxSmallModelCapabilities(ctx.runtimeFetch);
      if (cancelled) return;
      if (result.status === 'ok') {
        setCapabilities(result.callableModels);
        setCapStatus('ok');
        setCapError(null);
        return;
      }
      if (result.status === 'empty') {
        setCapabilities(result.callableModels);
        setCapStatus('empty');
        setCapError(null);
        return;
      }
      if (result.status === 'no-runtime') {
        setCapStatus('no-runtime');
        setCapabilities(null);
        return;
      }
      setCapStatus('failed');
      setCapError(result.error.message);
      setCapabilities(null);
    })();
    return () => {
      cancelled = true;
    };
  }, [ctx.runtimeFetch]);

  useEffect(() => {
    if (!settings || promptsReady) return;
    setCommitPrompt(typeof settings.summaryCommitPrompt === 'string' ? settings.summaryCommitPrompt : '');
    setTitlePrompt(typeof settings.summarySessionTitlePrompt === 'string' ? settings.summarySessionTitlePrompt : '');
    setPromptsReady(true);
  }, [settings, promptsReady]);

  if (status === 'no-runtime' || capStatus === 'no-runtime') {
    return <Banner text={lynxT(ctx.locale, 'lynx.settings.noRuntime')} muted />;
  }
  if (status === 'failed') return <Banner text={error || lynxT(ctx.locale, 'lynx.settings.loadFailed')} />;
  if (capStatus === 'failed') {
    return <Banner text={capError || lynxT(ctx.locale, 'lynx.settings.summary.capabilitiesFailed')} />;
  }
  if (status === 'loading' || !settings || capStatus === 'loading') {
    return <Banner text={lynxT(ctx.locale, 'lynx.settings.loading')} muted />;
  }

  const mode = settings.summaryModelMode === 'custom' ? 'custom' : 'provider';
  const providerID = typeof settings.summaryProviderID === 'string' ? settings.summaryProviderID : '';
  const modelID = typeof settings.summaryModelID === 'string' ? settings.summaryModelID : '';
  const providerIds = Object.keys(capabilities ?? {});

  return (
    <LynxView>
      <Banner text={lynxT(ctx.locale, 'lynx.settings.summary.hint')} muted />
      <Row
        title={lynxT(ctx.locale, 'lynx.settings.summary.mode.provider')}
        subtitle={mode === 'provider' ? '✓' : undefined}
        onTap={() => { void patch({ summaryModelMode: 'provider' }); }}
      />
      <Row
        title={lynxT(ctx.locale, 'lynx.settings.summary.mode.custom')}
        subtitle={mode === 'custom' ? '✓' : undefined}
        onTap={() => { void patch({ summaryModelMode: 'custom' }); }}
      />
      {mode === 'provider' ? (
        capStatus === 'empty' || providerIds.length === 0 ? (
          <Banner text={lynxT(ctx.locale, 'lynx.settings.summary.providerUnavailable')} muted />
        ) : (
          providerIds.map((id) => (
            <Row
              key={id}
              title={id}
              subtitle={providerID === id ? (modelID || '✓') : (capabilities?.[id]?.[0] ?? '')}
              onTap={() => {
                const nextModel = capabilities?.[id]?.includes(modelID)
                  ? modelID
                  : (capabilities?.[id]?.[0] ?? '');
                void patch({ summaryProviderID: id, summaryModelID: nextModel });
              }}
            />
          ))
        )
      ) : (
        <>
          <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '12px' }}>
            {lynxT(ctx.locale, 'lynx.settings.summary.baseUrl')}
          </LynxText>
          <LynxInput
            value={typeof settings.summaryCustomBaseURL === 'string' ? settings.summaryCustomBaseURL : ''}
            bindinput={(event) => {
              void patch({ summaryCustomBaseURL: event.detail?.value ?? '' });
            }}
            style={{ color: cssVar('surface.foreground'), fontSize: '14px', marginBottom: '8px' }}
          />
          <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '12px' }}>
            {lynxT(ctx.locale, 'lynx.settings.summary.modelId')}
          </LynxText>
          <LynxInput
            value={modelID}
            bindinput={(event) => {
              void patch({ summaryModelID: event.detail?.value ?? '' });
            }}
            style={{ color: cssVar('surface.foreground'), fontSize: '14px', marginBottom: '8px' }}
          />
        </>
      )}
      <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '12px', marginTop: '8px' }}>
        {lynxT(ctx.locale, 'lynx.settings.summary.commitPrompt')}
      </LynxText>
      <LynxInput
        value={commitPrompt}
        bindinput={(event) => setCommitPrompt(event.detail?.value ?? '')}
        style={{ color: cssVar('surface.foreground'), fontSize: '13px', marginBottom: '8px' }}
      />
      <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '12px' }}>
        {lynxT(ctx.locale, 'lynx.settings.summary.titlePrompt')}
      </LynxText>
      <LynxInput
        value={titlePrompt}
        bindinput={(event) => setTitlePrompt(event.detail?.value ?? '')}
        style={{ color: cssVar('surface.foreground'), fontSize: '13px', marginBottom: '8px' }}
      />
      <LynxView
        bindtap={() => {
          void patch({
            summaryCommitPrompt: commitPrompt,
            summarySessionTitlePrompt: titlePrompt,
          });
        }}
        style={{ padding: '8px 0' }}
      >
        <LynxText style={{ color: cssVar('primary.base'), fontWeight: '600' }}>
          {lynxT(ctx.locale, 'lynx.scheduled.editor.save')}
        </LynxText>
      </LynxView>
    </LynxView>
  );
}

function BehaviorBody({ ctx }: { ctx: SettingsBodyContext }) {
  const { settings, error, status, patch } = useSettingsBlob(ctx.runtimeFetch);
  const [prompt, setPrompt] = useState('');
  const [promptStatus, setPromptStatus] = useState<'loading' | 'ok' | 'failed' | 'no-runtime'>('loading');
  const [promptError, setPromptError] = useState<string | null>(null);
  const [promptDirty, setPromptDirty] = useState(false);
  const [saveNote, setSaveNote] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await loadLynxAgentsMd(ctx.runtimeFetch);
      if (cancelled) return;
      if (result.status === 'ok') {
        setPrompt(result.content);
        setPromptStatus('ok');
        setPromptError(null);
        setPromptDirty(false);
        return;
      }
      if (result.status === 'no-runtime') {
        setPromptStatus('no-runtime');
        return;
      }
      setPromptStatus('failed');
      setPromptError(result.error.message);
    })();
    return () => {
      cancelled = true;
    };
  }, [ctx.runtimeFetch]);

  if (status === 'no-runtime' || promptStatus === 'no-runtime') {
    return <Banner text={lynxT(ctx.locale, 'lynx.settings.noRuntime')} muted />;
  }
  if (status === 'failed') return <Banner text={error || lynxT(ctx.locale, 'lynx.settings.loadFailed')} />;
  if (promptStatus === 'failed') {
    return <Banner text={promptError || lynxT(ctx.locale, 'lynx.settings.behavior.agentsFailed')} />;
  }
  if (status === 'loading' || !settings || promptStatus === 'loading') {
    return <Banner text={lynxT(ctx.locale, 'lynx.settings.loading')} muted />;
  }

  const enabled = Boolean(settings.responseStyleEnabled);
  const preset = sanitizeLynxResponseStylePreset(settings.responseStylePreset);
  const custom = typeof settings.responseStyleCustomInstructions === 'string'
    ? settings.responseStyleCustomInstructions
    : '';

  const savePrompt = async () => {
    setSaveNote(null);
    const result = await saveLynxAgentsMd(ctx.runtimeFetch, prompt);
    if (result.status === 'ok') {
      setPromptDirty(false);
      setSaveNote(lynxT(ctx.locale, 'lynx.settings.behavior.saved'));
      return;
    }
    setSaveNote(result.status === 'failed' ? result.error.message : lynxT(ctx.locale, 'lynx.settings.noRuntime'));
  };

  const setPreset = (next: LynxResponseStyleValue) => {
    void patch({
      responseStylePreset: next,
      responseStyleEnabled: true,
    });
  };

  return (
    <LynxView>
      <Banner text={lynxT(ctx.locale, 'lynx.settings.behavior.hint')} muted />
      <ToggleRow
        label={lynxT(ctx.locale, 'lynx.settings.behavior.responseStyle')}
        value={enabled}
        onToggle={() => {
          void patch({ responseStyleEnabled: !enabled });
        }}
      />
      {([...LYNX_RESPONSE_STYLE_PRESETS, 'custom'] as const).map((item) => (
        <Row
          key={item}
          title={item}
          subtitle={preset === item ? '✓' : undefined}
          onTap={() => setPreset(item)}
        />
      ))}
      {preset === 'custom' ? (
        <LynxInput
          value={custom}
          bindinput={(event) => {
            void patch({ responseStyleCustomInstructions: event.detail?.value ?? '' });
          }}
          style={{ color: cssVar('surface.foreground'), fontSize: '13px', marginBottom: '12px' }}
        />
      ) : null}
      <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '12px', marginTop: '8px' }}>
        {lynxT(ctx.locale, 'lynx.settings.behavior.agentsMd')}
      </LynxText>
      <LynxInput
        value={prompt}
        bindinput={(event) => {
          setPrompt(event.detail?.value ?? '');
          setPromptDirty(true);
        }}
        style={{ color: cssVar('surface.foreground'), fontSize: '13px', marginBottom: '8px' }}
      />
      <LynxView
        bindtap={() => { void savePrompt(); }}
        style={{ padding: '8px 0' }}
      >
        <LynxText style={{ color: cssVar('primary.base'), fontWeight: '600' }}>
          {lynxT(ctx.locale, 'lynx.settings.behavior.saveAgents')}
        </LynxText>
      </LynxView>
      {saveNote ? <Banner text={saveNote} muted /> : null}
    </LynxView>
  );
}

export function renderLynxSettingsBody(
  slug: LynxMobileSettingsSlug,
  body: LynxSettingsBodyKind,
  ctx: SettingsBodyContext,
) {
  if (body === 'list-only-until-routes') {
    return <Banner text={lynxT(ctx.locale, 'lynx.settings.voice.listOnly')} muted />;
  }
  if (body === 'stub') {
    return <Banner text={lynxT(ctx.locale, 'lynx.settings.page.stub')} muted />;
  }

  switch (slug) {
    case 'instances':
      return <InstancesBody ctx={ctx} />;
    case 'appearance':
      return <AppearanceBody ctx={ctx} />;
    case 'chat':
      return <ChatBody ctx={ctx} />;
    case 'notifications':
      return <NotificationsBody ctx={ctx} />;
    case 'sessions':
      return <SessionsBody ctx={ctx} />;
    case 'projects':
      return <ProjectsSettingsBody ctx={ctx} />;
    case 'git':
      return <GitBody ctx={ctx} />;
    case 'providers':
    case 'agents':
    case 'commands':
    case 'mcp':
    case 'plugins':
    case 'magic-prompts':
    case 'snippets':
    case 'skills.installed':
      return <CatalogBody ctx={ctx} slug={slug} />;
    case 'assistants':
      return <AssistantsSettingsBody ctx={ctx} />;
    case 'usage':
      return <UsageBody ctx={ctx} />;
    case 'about':
      return <AboutBody ctx={ctx} />;
    case 'summary-ai':
      return <SummaryAiBody ctx={ctx} />;
    case 'behavior':
      return <BehaviorBody ctx={ctx} />;
    default:
      return <Banner text={lynxT(ctx.locale, 'lynx.settings.page.stub')} muted />;
  }
}
