import { useEffect, useState } from 'react';

import { lynxT } from '../i18n/catalog';
import { LynxScrollView, LynxText, LynxView } from '../lynx-elements';
import type { LynxRuntimeFetch } from '../runtime/fetch';
import { loadMcpCatalog, type LynxCatalogItem } from '../settings/catalogs';
import { cssVar } from '../theme/tokens';
import { loadLynxGitStatus, type LynxGitChangeEntry } from './changesSurface';
import { listLynxDirectory, type LynxFsEntry } from './filesSurface';
import type { LynxChatSheetKind } from './overflowMenu';

export type ChatSheetProps = {
  locale: string;
  kind: LynxChatSheetKind;
  directory: string | null;
  runtimeFetch: LynxRuntimeFetch | null;
  onBack: () => void;
};

/**
 * Files / Changes / MCP sheets — Cap MobileFilesSurface / MobileChangesSurface /
 * MCP catalog entry points with real list endpoints (not labeled empty stubs).
 */
export function LynxChatSheet({
  locale,
  kind,
  directory,
  runtimeFetch,
  onBack,
}: ChatSheetProps) {
  const titleKey = kind === 'files'
    ? 'lynx.chat.menu.files'
    : kind === 'changes'
      ? 'lynx.chat.menu.changes'
      : 'lynx.chat.menu.mcp';

  return (
    <LynxView
      style={{ flexGrow: 1, backgroundColor: cssVar('surface.background') }}
      accessibility-label={lynxT(locale, titleKey)}
    >
      <LynxView style={{ flexDirection: 'row', padding: '12px 16px', alignItems: 'center' }}>
        <LynxView bindtap={onBack} accessibility-label={lynxT(locale, 'lynx.shell.back')}>
          <LynxText style={{ color: cssVar('primary.base') }}>
            {lynxT(locale, 'lynx.shell.back')}
          </LynxText>
        </LynxView>
        <LynxText
          style={{
            marginLeft: '12px',
            color: cssVar('surface.foreground'),
            fontWeight: '600',
            flexGrow: 1,
          }}
        >
          {lynxT(locale, titleKey)}
        </LynxText>
      </LynxView>
      {kind === 'files' ? (
        <FilesSheetBody locale={locale} directory={directory} runtimeFetch={runtimeFetch} />
      ) : kind === 'changes' ? (
        <ChangesSheetBody locale={locale} directory={directory} runtimeFetch={runtimeFetch} />
      ) : (
        <McpSheetBody locale={locale} directory={directory} runtimeFetch={runtimeFetch} />
      )}
    </LynxView>
  );
}

function FilesSheetBody({
  locale,
  directory,
  runtimeFetch,
}: {
  locale: string;
  directory: string | null;
  runtimeFetch: LynxRuntimeFetch | null;
}) {
  const [entries, setEntries] = useState<LynxFsEntry[] | null>(null);
  const [status, setStatus] = useState<'loading' | 'ok' | 'failed' | 'no-runtime' | 'no-directory'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [path, setPath] = useState(directory);

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    setError(null);
    void (async () => {
      const result = await listLynxDirectory(runtimeFetch, path);
      if (cancelled) return;
      if (result.status === 'ok') {
        setEntries(result.entries);
        setStatus('ok');
        return;
      }
      setEntries(null);
      setStatus(result.status);
      if (result.status === 'failed') setError(result.error.message);
    })();
    return () => {
      cancelled = true;
    };
  }, [runtimeFetch, path]);

  if (status === 'no-runtime') {
    return <Banner text={lynxT(locale, 'lynx.settings.noRuntime')} muted />;
  }
  if (status === 'no-directory') {
    return <Banner text={lynxT(locale, 'lynx.chat.sheet.noDirectory')} muted />;
  }
  if (status === 'failed') {
    return <Banner text={error || lynxT(locale, 'lynx.chat.sheet.files.failed')} />;
  }
  if (status === 'loading' || !entries) {
    return <Banner text={lynxT(locale, 'lynx.settings.loading')} muted />;
  }

  return (
    <LynxScrollView style={{ flexGrow: 1, padding: '0 16px 24px' }}>
      <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '12px', marginBottom: '8px' }}>
        {path}
      </LynxText>
      {entries.length === 0 ? (
        <Banner text={lynxT(locale, 'lynx.chat.sheet.files.empty')} muted />
      ) : (
        entries.map((entry) => (
          <LynxView
            key={entry.path}
            style={{ padding: '10px 0' }}
            bindtap={() => {
              if (entry.type === 'directory') setPath(entry.path);
            }}
          >
            <LynxText style={{ color: cssVar('surface.foreground') }}>
              {entry.type === 'directory' ? '📁 ' : '📄 '}
              {entry.name}
            </LynxText>
          </LynxView>
        ))
      )}
    </LynxScrollView>
  );
}

function ChangesSheetBody({
  locale,
  directory,
  runtimeFetch,
}: {
  locale: string;
  directory: string | null;
  runtimeFetch: LynxRuntimeFetch | null;
}) {
  const [entries, setEntries] = useState<LynxGitChangeEntry[] | null>(null);
  const [branch, setBranch] = useState<string | null>(null);
  const [status, setStatus] = useState<'loading' | 'ok' | 'failed' | 'no-runtime' | 'no-directory'>('loading');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    setError(null);
    void (async () => {
      const result = await loadLynxGitStatus(runtimeFetch, directory, { mode: 'light' });
      if (cancelled) return;
      if (result.status === 'ok') {
        setEntries(result.entries);
        setBranch(result.branch);
        setStatus('ok');
        return;
      }
      setEntries(null);
      setStatus(result.status);
      if (result.status === 'failed') setError(result.error.message);
    })();
    return () => {
      cancelled = true;
    };
  }, [runtimeFetch, directory]);

  if (status === 'no-runtime') {
    return <Banner text={lynxT(locale, 'lynx.settings.noRuntime')} muted />;
  }
  if (status === 'no-directory') {
    return <Banner text={lynxT(locale, 'lynx.chat.sheet.noDirectory')} muted />;
  }
  if (status === 'failed') {
    return <Banner text={error || lynxT(locale, 'lynx.chat.sheet.changes.failed')} />;
  }
  if (status === 'loading' || !entries) {
    return <Banner text={lynxT(locale, 'lynx.settings.loading')} muted />;
  }

  return (
    <LynxScrollView style={{ flexGrow: 1, padding: '0 16px 24px' }}>
      <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '12px', marginBottom: '8px' }}>
        {directory}
        {branch ? ` · ${branch}` : ''}
      </LynxText>
      {entries.length === 0 ? (
        <Banner text={lynxT(locale, 'lynx.chat.sheet.changes.empty')} muted />
      ) : (
        entries.map((entry) => (
          <LynxView key={`${entry.staged ? 's' : 'u'}:${entry.path}`} style={{ padding: '10px 0' }}>
            <LynxText style={{ color: cssVar('surface.foreground') }}>{entry.path}</LynxText>
            <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '12px' }}>
              {entry.status}
              {entry.staged ? ' · staged' : ''}
            </LynxText>
          </LynxView>
        ))
      )}
    </LynxScrollView>
  );
}

function McpSheetBody({
  locale,
  directory,
  runtimeFetch,
}: {
  locale: string;
  directory: string | null;
  runtimeFetch: LynxRuntimeFetch | null;
}) {
  const [items, setItems] = useState<LynxCatalogItem[] | null>(null);
  const [status, setStatus] = useState<'loading' | 'ok' | 'failed' | 'no-runtime' | 'unsupported'>('loading');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    setError(null);
    void (async () => {
      const result = await loadMcpCatalog(runtimeFetch, { directory });
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
  }, [runtimeFetch, directory]);

  if (status === 'no-runtime') {
    return <Banner text={lynxT(locale, 'lynx.settings.noRuntime')} muted />;
  }
  if (status === 'unsupported') {
    return <Banner text={lynxT(locale, 'lynx.settings.unsupported')} muted />;
  }
  if (status === 'failed') {
    return <Banner text={error || lynxT(locale, 'lynx.chat.sheet.mcp.failed')} />;
  }
  if (status === 'loading' || !items) {
    return <Banner text={lynxT(locale, 'lynx.settings.loading')} muted />;
  }

  return (
    <LynxScrollView style={{ flexGrow: 1, padding: '0 16px 24px' }}>
      {items.length === 0 ? (
        <Banner text={lynxT(locale, 'lynx.chat.sheet.mcp.empty')} muted />
      ) : (
        items.map((item) => (
          <LynxView key={item.id} style={{ padding: '10px 0' }}>
            <LynxText style={{ color: cssVar('surface.foreground') }}>{item.title}</LynxText>
            {item.subtitle ? (
              <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '12px' }}>
                {item.subtitle}
              </LynxText>
            ) : null}
          </LynxView>
        ))
      )}
    </LynxScrollView>
  );
}

function Banner({ text, muted }: { text: string; muted?: boolean }) {
  return (
    <LynxText
      style={{
        padding: '16px',
        color: muted ? cssVar('surface.mutedForeground') : cssVar('surface.foreground'),
      }}
    >
      {text}
    </LynxText>
  );
}
