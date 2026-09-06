import { useEffect, useState } from 'react';

import { lynxT } from '../i18n/catalog';
import { LynxScrollView, LynxText, LynxView } from '../lynx-elements';
import type { LynxRuntimeFetch } from '../runtime/fetch';
import { loadLynxSettings } from '../settings/api';
import { cssVar } from '../theme/tokens';
import {
  addLynxProjectFromPath,
  appendLynxBrowsePathSegment,
  browseLynxDirectory,
  buildLynxBrowseRows,
  collectLynxAddedProjectPaths,
  ensureLynxBrowseDirectoryPath,
  getLynxBrowseParentPath,
  loadLynxFsHome,
  type LynxBrowseRow,
} from './directoryExplorer';

export type DirectoryExplorerSheetProps = {
  locale: string;
  runtimeFetch: LynxRuntimeFetch | null;
  open: boolean;
  onClose: () => void;
  onAdded?: (path: string) => void;
};

/**
 * Cap DirectoryExplorerDialog spirit — browse via /api/fs/home + /api/fs/list,
 * add via settings projects[].
 */
export function DirectoryExplorerSheet({
  locale,
  runtimeFetch,
  open,
  onClose,
  onAdded,
}: DirectoryExplorerSheetProps) {
  const [path, setPath] = useState('/');
  const [rows, setRows] = useState<LynxBrowseRow[]>([]);
  const [status, setStatus] = useState<'idle' | 'loading' | 'failed' | 'no-runtime'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      setStatus('loading');
      setError(null);
      const home = await loadLynxFsHome(runtimeFetch);
      if (cancelled) return;
      if (home.status === 'no-runtime') {
        setStatus('no-runtime');
        return;
      }
      if (home.status === 'failed') {
        setStatus('failed');
        setError(home.error.message);
        return;
      }
      const start = ensureLynxBrowseDirectoryPath(home.home);
      setPath(start);
      await refresh(start);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, runtimeFetch]);

  const refresh = async (directory: string) => {
    setStatus('loading');
    setError(null);
    const [list, settings] = await Promise.all([
      browseLynxDirectory(runtimeFetch, directory),
      loadLynxSettings(runtimeFetch),
    ]);
    if (list.status === 'no-runtime' || settings.status === 'no-runtime') {
      setStatus('no-runtime');
      return;
    }
    if (list.status !== 'ok') {
      setStatus('failed');
      setError(list.status === 'failed' ? list.error.message : list.status);
      return;
    }
    const added = settings.status === 'ok'
      ? collectLynxAddedProjectPaths(settings.settings.projects)
      : new Set<string>();
    setRows(buildLynxBrowseRows(list.entries, directory, added));
    setStatus('idle');
  };

  if (!open) return null;

  const onRow = async (row: LynxBrowseRow) => {
    if (row.type === 'up') {
      const parent = row.path ?? getLynxBrowseParentPath(path);
      if (!parent) return;
      setPath(parent);
      await refresh(parent);
      return;
    }
    const next = appendLynxBrowsePathSegment(path, row.name);
    setPath(next);
    await refresh(next);
  };

  const onAdd = async () => {
    const absolute = path.replace(/\/$/, '') || path;
    const result = await addLynxProjectFromPath(runtimeFetch, absolute);
    if (result.status === 'ok') {
      setNote(result.created
        ? lynxT(locale, 'lynx.projects.explorer.added')
        : lynxT(locale, 'lynx.projects.explorer.alreadyAdded'));
      onAdded?.(result.path);
      await refresh(path);
      return;
    }
    if (result.status === 'no-runtime') {
      setStatus('no-runtime');
      return;
    }
    setError(result.status === 'failed' ? result.error.message : result.status);
  };

  return (
    <LynxView
      style={{
        position: 'absolute',
        left: '0',
        right: '0',
        top: '0',
        bottom: '0',
        backgroundColor: cssVar('surface.background'),
        padding: '16px',
      }}
      accessibility-label={lynxT(locale, 'lynx.projects.explorer.title')}
    >
      <LynxView style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: '12px' }}>
        <LynxText style={{ color: cssVar('surface.foreground'), fontWeight: '700', fontSize: '18px' }}>
          {lynxT(locale, 'lynx.projects.explorer.title')}
        </LynxText>
        <LynxView bindtap={onClose} accessibility-role="button">
          <LynxText style={{ color: cssVar('primary.base') }}>{lynxT(locale, 'lynx.shell.back')}</LynxText>
        </LynxView>
      </LynxView>
      <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '12px', marginBottom: '8px' }}>
        {path}
      </LynxText>
      {status === 'no-runtime' ? (
        <LynxText style={{ color: cssVar('surface.mutedForeground') }}>
          {lynxT(locale, 'lynx.projects.noRuntime')}
        </LynxText>
      ) : null}
      {status === 'failed' || error ? (
        <LynxText style={{ color: cssVar('surface.foreground'), marginBottom: '8px' }}>
          {error || lynxT(locale, 'lynx.projects.failure')}
        </LynxText>
      ) : null}
      {note ? (
        <LynxText style={{ color: cssVar('primary.base'), marginBottom: '8px' }}>{note}</LynxText>
      ) : null}
      <LynxView
        bindtap={() => { void onAdd(); }}
        style={{ marginBottom: '12px', padding: '10px 12px', borderRadius: '12px', backgroundColor: cssVar('surface.elevated') }}
        accessibility-role="button"
      >
        <LynxText style={{ color: cssVar('primary.base'), fontWeight: '600' }}>
          {lynxT(locale, 'lynx.projects.explorer.add')}
        </LynxText>
      </LynxView>
      <LynxScrollView style={{ flexGrow: 1 }}>
        {status === 'loading' ? (
          <LynxText style={{ color: cssVar('surface.mutedForeground') }}>
            {lynxT(locale, 'lynx.projects.loading')}
          </LynxText>
        ) : null}
        {rows.map((row) => (
          <LynxView
            key={row.type === 'up' ? 'up' : row.path}
            bindtap={() => {
              if (row.type === 'up' && row.disabled) return;
              void onRow(row);
            }}
            style={{
              padding: '10px 0',
              opacity: row.type === 'up' && row.disabled ? 0.4 : 1,
            }}
          >
            <LynxText style={{ color: cssVar('surface.foreground') }}>
              {row.type === 'up'
                ? lynxT(locale, 'lynx.projects.explorer.up')
                : `${row.name}${row.alreadyAdded ? ' ✓' : ''}`}
            </LynxText>
          </LynxView>
        ))}
      </LynxScrollView>
    </LynxView>
  );
}
