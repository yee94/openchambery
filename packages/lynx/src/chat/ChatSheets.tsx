import { useEffect, useState } from 'react';

import { GlassChrome } from '../glass/GlassChrome';
import type { LynxHostGlobalProps } from '../host/embedding';
import { lynxT } from '../i18n/catalog';
import { LynxInput, LynxScrollView, LynxText, LynxView } from '../lynx-elements';
import type { LynxRuntimeFetch } from '../runtime/fetch';
import {
  loadLynxMcpSheet,
  lynxMcpStatusTone,
  setLynxMcpConnected,
  type LynxMcpRuntimeStatus,
  type LynxMcpSheetRow,
} from './mcpSheet';
import { cssVar } from '../theme/tokens';
import {
  commitAndPushLynxGitChanges,
  commitLynxGitChanges,
  generateLynxCommitMessage,
  loadLynxGitFileDiff,
  loadLynxGitStatus,
  revertLynxGitFile,
  stageLynxGitFiles,
  syncLynxGit,
  unstageLynxGitFiles,
  type LynxGitChangeEntry,
  type LynxGitDiffStat,
  type LynxGitSyncAction,
} from './changesSurface';
import {
  requestLynxRevertConfirm,
  resolveLynxRevertConfirm,
  type LynxRevertConfirmRequest,
} from './revertConfirm';
import {
  LynxCenteredDialog,
  LynxCenteredDialogAction,
} from '../shell/CenteredDialog';
import { LynxDialogPortal } from '../shell/DialogPortal';
import { listLynxDirectory, readLynxFile, searchLynxFiles, type LynxFsEntry, type LynxFsSearchHit } from './filesSurface';
import { isLynxHtmlPath, planLynxHtmlPreview } from './htmlPreview';
import {
  LYNX_CAP_ARROW_GO_BACK_GLYPH,
  LYNX_CHANGE_ROW_SPACING,
  lynxChangeStatusCode,
  lynxChangeStatusToken,
  lynxPierreDiffLineToken,
  planLynxPierreDiff,
  type LynxPierreDiffPlan,
} from './pierreDiff';
import type { LynxChatSheetKind } from './overflowMenu';

export type ChatSheetProps = {
  locale: string;
  kind: LynxChatSheetKind;
  directory: string | null;
  runtimeFetch: LynxRuntimeFetch | null;
  onBack: () => void;
  /** Optional host for Changes stage/unstage/revert GlassChrome searchChip (outside transcript). */
  host?: LynxHostGlobalProps | null;
  fullPageAutoGlassSkin?: boolean;
};

/**
 * Files / Changes / MCP sheets — Cap MobileFilesSurface / MobileChangesSurface /
 * MCP catalog entry points with real list + preview/diff/commit/sync endpoints.
 */
export function LynxChatSheet({
  locale,
  kind,
  directory,
  runtimeFetch,
  onBack,
  host = null,
  fullPageAutoGlassSkin = true,
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
        <ChangesSheetBody
          locale={locale}
          directory={directory}
          runtimeFetch={runtimeFetch}
          host={host}
          fullPageAutoGlassSkin={fullPageAutoGlassSkin}
        />
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
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [previewNote, setPreviewNote] = useState<string | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [htmlViewMode, setHtmlViewMode] = useState<'preview' | 'source'>('source');
  /** Cap MobileFilesSurface search — empty = browse directory list. */
  const [searchQuery, setSearchQuery] = useState('');
  const [searchHits, setSearchHits] = useState<LynxFsSearchHit[] | null>(null);
  const [searchStatus, setSearchStatus] = useState<'idle' | 'loading' | 'ok' | 'failed' | 'no-runtime'>('idle');
  const [searchError, setSearchError] = useState<string | null>(null);

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

  // Cap: debounce ~250ms then GET /api/find/file while query non-empty.
  useEffect(() => {
    const trimmed = searchQuery.trim();
    if (!trimmed) {
      setSearchHits(null);
      setSearchStatus('idle');
      setSearchError(null);
      return;
    }
    let cancelled = false;
    setSearchStatus('loading');
    setSearchError(null);
    const timer = setTimeout(() => {
      void (async () => {
        const result = await searchLynxFiles(runtimeFetch, {
          directory: path,
          query: trimmed,
          maxResults: 40,
        });
        if (cancelled) return;
        if (result.status === 'ok') {
          setSearchHits(result.hits);
          setSearchStatus('ok');
          return;
        }
        setSearchHits(null);
        if (result.status === 'no-runtime') {
          setSearchStatus('no-runtime');
          return;
        }
        if (result.status === 'no-directory' || result.status === 'no-query') {
          setSearchHits(null);
          setSearchStatus('idle');
          return;
        }
        setSearchStatus('failed');
        setSearchError(result.error.message);
      })();
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [runtimeFetch, path, searchQuery]);

  const openPreview = async (filePath: string) => {
    setPreviewPath(filePath);
    setPreview(null);
    setPreviewNote(null);
    setHtmlViewMode(isLynxHtmlPath(filePath) ? 'preview' : 'source');
    setPreviewBusy(true);
    const result = await readLynxFile(runtimeFetch, filePath);
    setPreviewBusy(false);
    if (result.status === 'ok') {
      setPreview(result.content);
      setPreviewNote(result.truncated ? lynxT(locale, 'lynx.chat.sheet.files.truncated') : null);
      return;
    }
    if (result.status === 'no-runtime') {
      setPreviewNote(lynxT(locale, 'lynx.settings.noRuntime'));
      return;
    }
    setPreviewNote(result.status === 'failed' ? result.error.message : lynxT(locale, 'lynx.chat.sheet.files.previewFailed'));
  };

  if (previewPath) {
    return (
      <LynxScrollView style={{ flexGrow: 1, padding: '0 16px 24px' }}>
        <LynxView
          bindtap={() => { setPreviewPath(null); setPreview(null); setPreviewNote(null); }}
          style={{ padding: '8px 0' }}
        >
          <LynxText style={{ color: cssVar('primary.base') }}>
            {lynxT(locale, 'lynx.shell.back')}
          </LynxText>
        </LynxView>
        <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '12px', marginBottom: '8px' }}>
          {previewPath}
        </LynxText>
        {previewBusy ? <Banner text={lynxT(locale, 'lynx.settings.loading')} muted /> : null}
        {previewNote ? <Banner text={previewNote} muted /> : null}
        {planLynxHtmlPreview(previewPath).mode === 'html-stub' ? (
          <LynxView data-mobile-html-preview="stub" style={{ marginBottom: '8px' }}>
            <LynxView
              bindtap={() => setHtmlViewMode((m) => (m === 'preview' ? 'source' : 'preview'))}
              style={{ padding: '6px 0' }}
            >
              <LynxText style={{ color: cssVar('primary.base'), fontSize: '13px' }}>
                {htmlViewMode === 'preview'
                  ? lynxT(locale, 'lynx.chat.sheet.files.htmlViewSource')
                  : lynxT(locale, 'lynx.chat.sheet.files.htmlViewPreview')}
              </LynxText>
            </LynxView>
            {htmlViewMode === 'preview' ? (
              <Banner
                text={(() => {
                  const plan = planLynxHtmlPreview(previewPath);
                  return plan.mode === 'html-stub' ? plan.note : '';
                })()}
                muted
              />
            ) : null}
          </LynxView>
        ) : null}
        {preview !== null && (planLynxHtmlPreview(previewPath).mode !== 'html-stub' || htmlViewMode === 'source') ? (
          <LynxText style={{ color: cssVar('surface.foreground'), fontSize: '12px' }}>
            {preview}
          </LynxText>
        ) : null}
      </LynxScrollView>
    );
  }

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

  const searching = searchQuery.trim().length > 0;

  return (
    <LynxScrollView style={{ flexGrow: 1, padding: '0 16px 24px' }}>
      <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '12px', marginBottom: '8px' }}>
        {path}
      </LynxText>
      <LynxInput
        value={searchQuery}
        placeholder={lynxT(locale, 'lynx.chat.sheet.files.search.placeholder')}
        bindinput={(event) => setSearchQuery(event.detail?.value ?? '')}
        style={{
          marginBottom: '12px',
          padding: '10px 12px',
          borderRadius: '12px',
          backgroundColor: cssVar('surface.elevated'),
          color: cssVar('surface.foreground'),
          fontSize: '14px',
        }}
      />
      {searching ? (
        searchStatus === 'loading' || searchHits === null ? (
          <Banner text={lynxT(locale, 'lynx.settings.loading')} muted />
        ) : searchStatus === 'no-runtime' ? (
          <Banner text={lynxT(locale, 'lynx.settings.noRuntime')} muted />
        ) : searchStatus === 'failed' ? (
          <Banner text={searchError || lynxT(locale, 'lynx.chat.sheet.files.search.failed')} />
        ) : searchHits.length === 0 ? (
          <Banner text={lynxT(locale, 'lynx.chat.sheet.files.search.empty')} muted />
        ) : (
          searchHits.map((hit) => (
            <LynxView
              key={hit.path}
              style={{ padding: '10px 0' }}
              bindtap={() => { void openPreview(hit.path); }}
            >
              <LynxText style={{ color: cssVar('surface.foreground') }}>
                {'📄 '}
                {hit.name}
              </LynxText>
              <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '11px' }}>
                {hit.relativePath}
              </LynxText>
            </LynxView>
          ))
        )
      ) : entries.length === 0 ? (
        <Banner text={lynxT(locale, 'lynx.chat.sheet.files.empty')} muted />
      ) : (
        entries.map((entry) => (
          <LynxView
            key={entry.path}
            style={{ padding: '10px 0' }}
            bindtap={() => {
              if (entry.type === 'directory') {
                setSearchQuery('');
                setPath(entry.path);
              } else {
                void openPreview(entry.path);
              }
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
  host,
  fullPageAutoGlassSkin,
}: {
  locale: string;
  directory: string | null;
  runtimeFetch: LynxRuntimeFetch | null;
  host: LynxHostGlobalProps | null;
  fullPageAutoGlassSkin: boolean;
}) {
  const [entries, setEntries] = useState<LynxGitChangeEntry[] | null>(null);
  const [diffStats, setDiffStats] = useState<Record<string, LynxGitDiffStat>>({});
  const [branch, setBranch] = useState<string | null>(null);
  const [status, setStatus] = useState<'loading' | 'ok' | 'failed' | 'no-runtime' | 'no-directory'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [diffEntry, setDiffEntry] = useState<LynxGitChangeEntry | null>(null);
  const [diffPlan, setDiffPlan] = useState<LynxPierreDiffPlan | null>(null);
  const [diffNote, setDiffNote] = useState<string | null>(null);
  const [diffBusy, setDiffBusy] = useState(false);
  const [commitMessage, setCommitMessage] = useState('');
  const [actionNote, setActionNote] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);
  /** Cap ChangesPanel centered Dialog — confirm before destructive revert. */
  const [pendingRevert, setPendingRevert] = useState<LynxRevertConfirmRequest | null>(null);

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    setError(null);
    void (async () => {
      const result = await loadLynxGitStatus(runtimeFetch, directory, { mode: 'light' });
      if (cancelled) return;
      if (result.status === 'ok') {
        setEntries(result.entries);
        setDiffStats(result.diffStats);
        setBranch(result.branch);
        setStatus('ok');
        return;
      }
      setEntries(null);
      setDiffStats({});
      setStatus(result.status);
      if (result.status === 'failed') setError(result.error.message);
    })();
    return () => {
      cancelled = true;
    };
  }, [runtimeFetch, directory, reloadNonce]);

  const openDiff = async (entry: LynxGitChangeEntry) => {
    setDiffEntry(entry);
    setDiffPlan(null);
    setDiffNote(null);
    setDiffBusy(true);
    const result = await loadLynxGitFileDiff(runtimeFetch, directory, entry.path, {
      staged: entry.staged,
    });
    setDiffBusy(false);
    if (result.status === 'ok') {
      if (result.isBinary) {
        setDiffPlan(planLynxPierreDiff({ binary: true, preferPierre: true }));
        setDiffNote(lynxT(locale, 'lynx.chat.sheet.changes.binary'));
        return;
      }
      setDiffPlan(planLynxPierreDiff({
        unifiedDiff: result.unifiedDiff,
        original: result.original,
        modified: result.modified,
        path: entry.path,
        preferPierre: true,
      }));
      return;
    }
    if (result.status === 'no-runtime') {
      setDiffNote(lynxT(locale, 'lynx.settings.noRuntime'));
      return;
    }
    setDiffNote(result.status === 'failed' ? result.error.message : lynxT(locale, 'lynx.chat.sheet.changes.diffFailed'));
  };

  const runStageToggle = async (entry: LynxGitChangeEntry) => {
    setActionBusy(true);
    setActionNote(null);
    const result = entry.staged
      ? await unstageLynxGitFiles(runtimeFetch, directory, [entry.path])
      : await stageLynxGitFiles(runtimeFetch, directory, [entry.path]);
    setActionBusy(false);
    if (result.status === 'ok') {
      setActionNote(lynxT(
        locale,
        entry.staged ? 'lynx.chat.sheet.changes.unstageOk' : 'lynx.chat.sheet.changes.stageOk',
      ));
      setReloadNonce((n) => n + 1);
      return;
    }
    if (result.status === 'no-runtime') {
      setActionNote(lynxT(locale, 'lynx.settings.noRuntime'));
      return;
    }
    if (result.status === 'no-directory') {
      setActionNote(lynxT(locale, 'lynx.chat.sheet.noDirectory'));
      return;
    }
    setActionNote(result.error.message);
  };

  const runCommit = async () => {
    setActionBusy(true);
    setActionNote(null);
    const result = await commitLynxGitChanges(runtimeFetch, directory, commitMessage);
    setActionBusy(false);
    if (result.status === 'ok') {
      setActionNote(lynxT(locale, 'lynx.chat.sheet.changes.committed'));
      setCommitMessage('');
      setReloadNonce((n) => n + 1);
      return;
    }
    if (result.status === 'no-runtime') {
      setActionNote(lynxT(locale, 'lynx.settings.noRuntime'));
      return;
    }
    if (result.status === 'no-directory') {
      setActionNote(lynxT(locale, 'lynx.chat.sheet.noDirectory'));
      return;
    }
    setActionNote(result.error.message);
  };

  const runCommitAndPush = async () => {
    setActionBusy(true);
    setActionNote(null);
    const result = await commitAndPushLynxGitChanges(runtimeFetch, directory, commitMessage);
    setActionBusy(false);
    if (result.status === 'ok') {
      setActionNote(lynxT(locale, 'lynx.chat.sheet.changes.commitAndPushOk'));
      setCommitMessage('');
      setReloadNonce((n) => n + 1);
      return;
    }
    if (result.status === 'no-runtime') {
      setActionNote(lynxT(locale, 'lynx.settings.noRuntime'));
      return;
    }
    if (result.status === 'no-directory') {
      setActionNote(lynxT(locale, 'lynx.chat.sheet.noDirectory'));
      return;
    }
    setActionNote(result.error.message);
  };

  const runGenerateCommitMessage = async () => {
    setActionBusy(true);
    setActionNote(null);
    const stagedPaths = (entries ?? []).filter((entry) => entry.staged).map((entry) => entry.path);
    const result = await generateLynxCommitMessage(runtimeFetch, directory, stagedPaths);
    setActionBusy(false);
    if (result.status === 'ok') {
      setCommitMessage(result.message.subject);
      const highlights = result.message.highlights.filter(Boolean);
      setActionNote(highlights.length > 0
        ? `${lynxT(locale, 'lynx.chat.sheet.changes.generateOk')} · ${highlights.join(' · ')}`
        : lynxT(locale, 'lynx.chat.sheet.changes.generateOk'));
      return;
    }
    if (result.status === 'no-runtime') {
      setActionNote(lynxT(locale, 'lynx.settings.noRuntime'));
      return;
    }
    if (result.status === 'no-directory') {
      setActionNote(lynxT(locale, 'lynx.chat.sheet.noDirectory'));
      return;
    }
    setActionNote(result.error.message);
  };

  const askRevert = (entry: LynxGitChangeEntry) => {
    if (actionBusy) return;
    const next = requestLynxRevertConfirm(entry.path);
    if (next) setPendingRevert(next);
  };

  const dismissRevertConfirm = () => {
    setPendingRevert(resolveLynxRevertConfirm(pendingRevert, 'cancel').pending);
  };

  const runRevert = async (path: string) => {
    setActionBusy(true);
    setActionNote(null);
    const result = await revertLynxGitFile(runtimeFetch, directory, path);
    setActionBusy(false);
    if (result.status === 'ok') {
      setActionNote(lynxT(locale, 'lynx.chat.sheet.changes.revertOk'));
      if (diffEntry?.path === path) {
        setDiffEntry(null);
        setDiffPlan(null);
        setDiffNote(null);
      }
      setReloadNonce((n) => n + 1);
      return;
    }
    if (result.status === 'no-runtime') {
      setActionNote(lynxT(locale, 'lynx.settings.noRuntime'));
      return;
    }
    if (result.status === 'no-directory') {
      setActionNote(lynxT(locale, 'lynx.chat.sheet.noDirectory'));
      return;
    }
    setActionNote(result.error.message);
  };

  const confirmRevert = () => {
    const resolved = resolveLynxRevertConfirm(pendingRevert, 'confirm');
    setPendingRevert(resolved.pending);
    if (resolved.shouldRevert && resolved.path) {
      void runRevert(resolved.path);
    }
  };

  const runSync = async (action: LynxGitSyncAction) => {
    setActionBusy(true);
    setActionNote(null);
    const result = await syncLynxGit(runtimeFetch, directory, action);
    setActionBusy(false);
    if (result.status === 'ok') {
      const okKey = action === 'fetch'
        ? 'lynx.chat.sheet.changes.fetchOk'
        : action === 'pull'
          ? 'lynx.chat.sheet.changes.pullOk'
          : 'lynx.chat.sheet.changes.pushOk';
      setActionNote(lynxT(locale, okKey));
      setReloadNonce((n) => n + 1);
      return;
    }
    if (result.status === 'no-runtime') {
      setActionNote(lynxT(locale, 'lynx.settings.noRuntime'));
      return;
    }
    if (result.status === 'no-directory') {
      setActionNote(lynxT(locale, 'lynx.chat.sheet.noDirectory'));
      return;
    }
    setActionNote(result.error.message);
  };

  if (diffEntry) {
    return (
      <LynxScrollView style={{ flexGrow: 1, padding: '0 16px 24px' }}>
        <LynxView
          bindtap={() => { setDiffEntry(null); setDiffPlan(null); setDiffNote(null); }}
          style={{ padding: '8px 0' }}
        >
          <LynxText style={{ color: cssVar('primary.base') }}>
            {lynxT(locale, 'lynx.shell.back')}
          </LynxText>
        </LynxView>
        <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '12px', marginBottom: '8px' }}>
          {diffEntry.path}
          {diffEntry.staged ? ' · staged' : ''}
        </LynxText>
        {diffBusy ? <Banner text={lynxT(locale, 'lynx.settings.loading')} muted /> : null}
        {diffNote ? <Banner text={diffNote} muted /> : null}
        {diffPlan ? <Banner text={diffPlan.note} muted /> : null}
        {diffPlan?.hasTextPreview ? (
          <LynxView style={{ flexDirection: 'row', alignItems: 'center', marginBottom: '8px' }}>
            <LynxText style={{ color: cssVar('status.success'), fontSize: '12px' }}>
              +{diffPlan.stats.insertions}
            </LynxText>
            <LynxText
              style={{
                color: cssVar('surface.mutedForeground'),
                fontSize: '12px',
                marginLeft: `${LYNX_CHANGE_ROW_SPACING.statsSlashMarginPx}px`,
                marginRight: `${LYNX_CHANGE_ROW_SPACING.statsSlashMarginPx}px`,
              }}
            >
              /
            </LynxText>
            <LynxText style={{ color: cssVar('status.error'), fontSize: '12px' }}>
              -{diffPlan.stats.deletions}
            </LynxText>
          </LynxView>
        ) : null}
        {diffPlan?.lines.map((line, index) => (
          <LynxText
            key={`${index}:${line.kind}`}
            style={{
              color: cssVar(lynxPierreDiffLineToken(line.kind)),
              fontSize: '12px',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
            }}
          >
            {line.text.length ? line.text : ' '}
          </LynxText>
        ))}
      </LynxScrollView>
    );
  }

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
    <LynxView style={{ flexGrow: 1 }}>
    <LynxScrollView style={{ flexGrow: 1, padding: '0 16px 24px' }}>
      <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '12px', marginBottom: '8px' }}>
        {directory}
        {branch ? ` · ${branch}` : ''}
      </LynxText>
      <LynxView style={{ marginBottom: '12px' }}>
        <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '12px', marginBottom: '4px' }}>
          {lynxT(locale, 'lynx.chat.sheet.changes.commitMessage')}
        </LynxText>
        <LynxInput
          value={commitMessage}
          bindinput={(event) => setCommitMessage(event.detail?.value ?? '')}
          style={{ color: cssVar('surface.foreground'), fontSize: '14px' }}
        />
        <LynxView style={{ flexDirection: 'row', marginTop: '8px', flexWrap: 'wrap' }}>
          <ActionChip
            label={actionBusy ? lynxT(locale, 'lynx.chat.sheet.changes.busy') : lynxT(locale, 'lynx.chat.sheet.changes.generateMessage')}
            onTap={() => { if (!actionBusy) void runGenerateCommitMessage(); }}
          />
          <ActionChip
            label={actionBusy ? lynxT(locale, 'lynx.chat.sheet.changes.busy') : lynxT(locale, 'lynx.chat.sheet.changes.commit')}
            onTap={() => { if (!actionBusy) void runCommit(); }}
          />
          <ActionChip
            label={lynxT(locale, 'lynx.chat.sheet.changes.commitAndPush')}
            onTap={() => { if (!actionBusy) void runCommitAndPush(); }}
          />
          <ActionChip
            label={lynxT(locale, 'lynx.chat.sheet.changes.fetch')}
            onTap={() => { if (!actionBusy) void runSync('fetch'); }}
          />
          <ActionChip
            label={lynxT(locale, 'lynx.chat.sheet.changes.pull')}
            onTap={() => { if (!actionBusy) void runSync('pull'); }}
          />
          <ActionChip
            label={lynxT(locale, 'lynx.chat.sheet.changes.push')}
            onTap={() => { if (!actionBusy) void runSync('push'); }}
          />
        </LynxView>
        {actionNote ? (
          <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '12px', marginTop: '8px' }}>
            {actionNote}
          </LynxText>
        ) : null}
      </LynxView>
      {entries.length === 0 ? (
        <Banner text={lynxT(locale, 'lynx.chat.sheet.changes.empty')} muted />
      ) : (
        entries.map((entry) => {
          const statusCode = lynxChangeStatusCode(entry.status);
          const stats = diffStats[entry.path];
          return (
          <LynxView
            key={`${entry.staged ? 's' : 'u'}:${entry.path}`}
            style={{
              minHeight: `${LYNX_CHANGE_ROW_SPACING.rowMinHeightPx}px`,
              paddingTop: `${LYNX_CHANGE_ROW_SPACING.rowPaddingYPx}px`,
              paddingBottom: `${LYNX_CHANGE_ROW_SPACING.rowPaddingYPx}px`,
              flexDirection: 'row',
              alignItems: 'center',
            }}
          >
            <LynxView
              style={{
                flexGrow: 1,
                flexDirection: 'row',
                alignItems: 'center',
                minWidth: '0px',
              }}
              bindtap={() => { void openDiff(entry); }}
            >
              <LynxText
                style={{
                  color: cssVar(lynxChangeStatusToken(statusCode)),
                  fontSize: '12px',
                  fontWeight: '700',
                  width: `${LYNX_CHANGE_ROW_SPACING.statusCodeWidthPx}px`,
                  textAlign: 'center',
                  marginRight: `${LYNX_CHANGE_ROW_SPACING.contentGapPx}px`,
                  flexShrink: 0,
                }}
              >
                {statusCode}
              </LynxText>
              <LynxView style={{ flexGrow: 1, minWidth: '0px' }}>
                <LynxText style={{ color: cssVar('surface.foreground'), fontSize: '13px' }}>
                  {entry.path}
                </LynxText>
                <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '11px' }}>
                  {entry.status}
                  {entry.staged ? ' · staged' : ''}
                </LynxText>
              </LynxView>
              {stats ? (
                <LynxView
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    flexShrink: 0,
                    marginLeft: `${LYNX_CHANGE_ROW_SPACING.contentGapPx}px`,
                    marginRight: `${LYNX_CHANGE_ROW_SPACING.contentGapPx}px`,
                  }}
                >
                  <LynxText style={{ color: cssVar('status.success'), fontSize: '12px' }}>
                    +{stats.insertions}
                  </LynxText>
                  <LynxText
                    style={{
                      color: cssVar('surface.mutedForeground'),
                      fontSize: '12px',
                      marginLeft: `${LYNX_CHANGE_ROW_SPACING.statsSlashMarginPx}px`,
                      marginRight: `${LYNX_CHANGE_ROW_SPACING.statsSlashMarginPx}px`,
                    }}
                  >
                    /
                  </LynxText>
                  <LynxText style={{ color: cssVar('status.error'), fontSize: '12px' }}>
                    -{stats.deletions}
                  </LynxText>
                </LynxView>
              ) : null}
            </LynxView>
            <RevertGlassChip
              label={lynxT(locale, 'lynx.chat.sheet.changes.revert')}
              host={host}
              fullPageAutoGlassSkin={fullPageAutoGlassSkin}
              onTap={() => { askRevert(entry); }}
            />
            <StageGlassChip
              symbol={entry.staged ? '-' : '+'}
              label={entry.staged
                ? lynxT(locale, 'lynx.chat.sheet.changes.unstage')
                : lynxT(locale, 'lynx.chat.sheet.changes.stage')}
              host={host}
              fullPageAutoGlassSkin={fullPageAutoGlassSkin}
              onTap={() => { if (!actionBusy) void runStageToggle(entry); }}
            />
          </LynxView>
          );
        })
      )}
    </LynxScrollView>
      {/* Cap DialogPortal spirit — shell-root full-screen overlay, not nested absolute. */}
      <LynxDialogPortal>
        {pendingRevert != null ? (
          <LynxCenteredDialog
            locale={locale}
            open
            title={lynxT(locale, 'lynx.chat.sheet.changes.revertConfirmTitle')}
            description={lynxT(locale, 'lynx.chat.sheet.changes.revertConfirmDescription')}
            ariaLabel={lynxT(locale, 'lynx.chat.sheet.changes.revertConfirmTitle')}
            busy={actionBusy}
            onClose={() => { if (!actionBusy) dismissRevertConfirm(); }}
            footer={(
              <>
                <LynxCenteredDialogAction
                  label={lynxT(locale, 'lynx.chat.sheet.changes.cancel')}
                  disabled={actionBusy}
                  onTap={() => { dismissRevertConfirm(); }}
                />
                <LynxCenteredDialogAction
                  label={actionBusy
                    ? lynxT(locale, 'lynx.chat.sheet.changes.reverting')
                    : lynxT(locale, 'lynx.chat.sheet.changes.revertConfirmAction')}
                  destructive
                  disabled={actionBusy}
                  onTap={() => { confirmRevert(); }}
                />
              </>
            )}
          >
            <LynxText
              style={{
                color: cssVar('surface.foreground'),
                fontSize: '12px',
                marginBottom: '8px',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
              }}
            >
              {pendingRevert.path}
            </LynxText>
          </LynxCenteredDialog>
        ) : null}
      </LynxDialogPortal>
    </LynxView>
  );
}

function ActionChip({ label, onTap }: { label: string; onTap: () => void }) {
  return (
    <LynxView
      bindtap={onTap}
      style={{ padding: '8px 12px', marginRight: '8px', marginBottom: '8px' }}
      accessibility-role="button"
      accessibility-label={label}
    >
      <LynxText style={{ color: cssVar('primary.base'), fontWeight: '600', fontSize: '13px' }}>
        {label}
      </LynxText>
    </LynxView>
  );
}

/**
 * Cap ChangeRow +/− stage control as GlassChrome `searchChip` (outside transcript
 * glass rules). Falls back to a plain chip when host is absent.
 */
function StageGlassChip({
  symbol,
  label,
  host,
  fullPageAutoGlassSkin,
  onTap,
}: {
  symbol: '+' | '-';
  label: string;
  host: LynxHostGlobalProps | null;
  fullPageAutoGlassSkin: boolean;
  onTap: () => void;
}) {
  // Cap ChangeRow action: size-6 (24px). Still GlassChrome searchChip surface.
  const size = LYNX_CHANGE_ROW_SPACING.actionSizePx;
  const inner = (
    <LynxView
      bindtap={onTap}
      accessibility-role="button"
      accessibility-label={label}
      style={{
        width: '100%',
        height: '100%',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <LynxText
        style={{
          color: cssVar('surface.foreground'),
          fontWeight: '700',
          fontSize: '14px',
        }}
      >
        {symbol}
      </LynxText>
    </LynxView>
  );

  const chipStyle: Record<string, string | number | undefined> = {
    width: `${size}px`,
    height: `${size}px`,
    borderRadius: '4px', // Cap action is rounded (not full pill)
    marginLeft: `${LYNX_CHANGE_ROW_SPACING.chipMarginLeftPx}px`,
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
  };

  if (!host) {
    return (
      <LynxView style={{ ...chipStyle, backgroundColor: cssVar('surface.elevated') }}>
        {inner}
      </LynxView>
    );
  }

  return (
    <GlassChrome
      surface="searchChip"
      host={host}
      fullPageAutoGlassSkin={fullPageAutoGlassSkin}
      style={chipStyle}
      accessibilityLabel={label}
    >
      {inner}
    </GlassChrome>
  );
}

/**
 * Cap ChangeRow revert control — GlassChrome `searchChip` size-6 like stage +/−.
 * Glyph = Cap Icon `arrow-go-back` unicode stand-in (↩ / U+21A9); Cap SVG sprite
 * needs DOM and is unavailable on Lynx — do not invent brand icons.
 */
function RevertGlassChip({
  label,
  host,
  fullPageAutoGlassSkin,
  onTap,
}: {
  label: string;
  host: LynxHostGlobalProps | null;
  fullPageAutoGlassSkin: boolean;
  onTap: () => void;
}) {
  const size = LYNX_CHANGE_ROW_SPACING.actionSizePx;
  const inner = (
    <LynxView
      bindtap={onTap}
      accessibility-role="button"
      accessibility-label={label}
      style={{
        width: '100%',
        height: '100%',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <LynxText
        style={{
          color: cssVar('surface.mutedForeground'),
          fontWeight: '700',
          fontSize: '14px',
        }}
      >
        {LYNX_CAP_ARROW_GO_BACK_GLYPH}
      </LynxText>
    </LynxView>
  );

  const chipStyle: Record<string, string | number | undefined> = {
    width: `${size}px`,
    height: `${size}px`,
    borderRadius: '4px',
    marginLeft: `${LYNX_CHANGE_ROW_SPACING.chipMarginLeftPx}px`,
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
  };

  if (!host) {
    return (
      <LynxView style={{ ...chipStyle, backgroundColor: cssVar('surface.elevated') }}>
        {inner}
      </LynxView>
    );
  }

  return (
    <GlassChrome
      surface="searchChip"
      host={host}
      fullPageAutoGlassSkin={fullPageAutoGlassSkin}
      style={chipStyle}
      accessibilityLabel={label}
    >
      {inner}
    </GlassChrome>
  );
}

function mcpStatusLabel(locale: string, status: LynxMcpRuntimeStatus): string {
  switch (status.kind) {
    case 'connected':
      return lynxT(locale, 'lynx.chat.sheet.mcp.status.connected');
    case 'disabled':
      return lynxT(locale, 'lynx.chat.sheet.mcp.status.disabled');
    case 'failed':
      return status.error
        ? lynxT(locale, 'lynx.chat.sheet.mcp.status.failedWithError', { error: status.error })
        : lynxT(locale, 'lynx.chat.sheet.mcp.status.failed');
    case 'needs_auth':
      return lynxT(locale, 'lynx.chat.sheet.mcp.status.needsAuth');
    case 'needs_client_registration':
      return status.error
        ? lynxT(locale, 'lynx.chat.sheet.mcp.status.needsRegistrationWithError', { error: status.error })
        : lynxT(locale, 'lynx.chat.sheet.mcp.status.needsRegistration');
    default:
      return lynxT(locale, 'lynx.chat.sheet.mcp.status.unknown');
  }
}

function mcpToneColor(tone: ReturnType<typeof lynxMcpStatusTone>): string {
  switch (tone) {
    case 'success':
      return cssVar('status.success');
    case 'error':
      return cssVar('status.error');
    case 'warning':
      return cssVar('primary.base');
    default:
      return cssVar('surface.mutedForeground');
  }
}

/**
 * Cap `McpDropdownContent` spirit: config ∪ status rows, status disc, Cap Switch
 * connect/disconnect via POST `/mcp/{name}/connect|disconnect`, refresh.
 * OAuth needs_auth stays labeled — host browser not invented.
 */
function McpSheetBody({
  locale,
  directory,
  runtimeFetch,
}: {
  locale: string;
  directory: string | null;
  runtimeFetch: LynxRuntimeFetch | null;
}) {
  const [rows, setRows] = useState<LynxMcpSheetRow[] | null>(null);
  const [status, setStatus] = useState<'loading' | 'ok' | 'failed' | 'no-runtime' | 'unsupported'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyName, setBusyName] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    setError(null);
    void (async () => {
      const result = await loadLynxMcpSheet(runtimeFetch, { directory });
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
  }, [runtimeFetch, directory, reloadToken]);

  const refresh = () => {
    if (busyName) return;
    setActionError(null);
    setReloadToken((n) => n + 1);
  };

  const toggle = async (row: LynxMcpSheetRow) => {
    if (busyName) return;
    setBusyName(row.name);
    setActionError(null);
    try {
      const result = await setLynxMcpConnected(runtimeFetch, {
        name: row.name,
        directory,
        connected: !row.connected,
      });
      if (result.status === 'no-runtime') {
        setActionError(lynxT(locale, 'lynx.settings.noRuntime'));
        return;
      }
      if (result.status === 'failed') {
        setActionError(result.error || lynxT(locale, 'lynx.chat.sheet.mcp.actionFailed'));
        // Cap refreshes status after failure too — keep honest disc.
      }
      setReloadToken((n) => n + 1);
    } finally {
      setBusyName(null);
    }
  };

  if (status === 'no-runtime') {
    return <Banner text={lynxT(locale, 'lynx.settings.noRuntime')} muted />;
  }
  if (status === 'unsupported') {
    return <Banner text={lynxT(locale, 'lynx.settings.unsupported')} muted />;
  }
  if (status === 'failed') {
    return <Banner text={error || lynxT(locale, 'lynx.chat.sheet.mcp.failed')} />;
  }
  if (status === 'loading' || !rows) {
    return <Banner text={lynxT(locale, 'lynx.settings.loading')} muted />;
  }

  return (
    <LynxScrollView style={{ flexGrow: 1, padding: '0 16px 24px' }}>
      <LynxView
        style={{
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'center',
          paddingTop: '8px',
          paddingBottom: '4px',
        }}
      >
        {directory ? (
          <LynxText
            style={{
              color: cssVar('surface.mutedForeground'),
              fontSize: '12px',
              flexGrow: 1,
              minWidth: '0px',
            }}
          >
            {directory.split('/').filter(Boolean).pop() || directory}
          </LynxText>
        ) : (
          <LynxView style={{ flexGrow: 1 }} />
        )}
        <LynxView
          bindtap={refresh}
          accessibility-role="button"
          accessibility-label={lynxT(locale, 'lynx.chat.sheet.mcp.refresh')}
          style={{ padding: '6px 8px', opacity: busyName ? 0.5 : 1 }}
        >
          <LynxText style={{ color: cssVar('primary.base'), fontSize: '13px', fontWeight: '600' }}>
            {lynxT(locale, 'lynx.chat.sheet.mcp.refresh')}
          </LynxText>
        </LynxView>
      </LynxView>
      {actionError ? <Banner text={actionError} /> : null}
      {rows.length === 0 ? (
        <Banner text={lynxT(locale, 'lynx.chat.sheet.mcp.empty')} muted />
      ) : (
        rows.map((row) => {
          const tone = lynxMcpStatusTone(row.status);
          const busy = busyName === row.name;
          return (
            <LynxView
              key={row.name}
              style={{
                padding: '12px 0',
                flexDirection: 'row',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <LynxView style={{ flexGrow: 1, minWidth: '0px', flexDirection: 'row', alignItems: 'center' }}>
                <LynxView
                  style={{
                    width: '10px',
                    height: '10px',
                    borderRadius: '5px',
                    marginRight: '10px',
                    flexShrink: 0,
                    backgroundColor: mcpToneColor(tone),
                  }}
                  accessibility-label={mcpStatusLabel(locale, row.status)}
                />
                <LynxView style={{ flexGrow: 1, minWidth: '0px' }}>
                  <LynxText style={{ color: cssVar('surface.foreground'), fontSize: '15px' }}>
                    {row.title}
                  </LynxText>
                  <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '12px' }}>
                    {mcpStatusLabel(locale, row.status)}
                    {row.subtitle ? ` · ${row.subtitle}` : ''}
                  </LynxText>
                </LynxView>
              </LynxView>
              <LynxView
                bindtap={() => { void toggle(row); }}
                accessibility-role="button"
                accessibility-label={row.connected
                  ? lynxT(locale, 'lynx.chat.sheet.mcp.disconnect')
                  : lynxT(locale, 'lynx.chat.sheet.mcp.connect')}
                style={{ padding: '6px 8px', opacity: busy ? 0.5 : 1, flexShrink: 0 }}
              >
                <LynxText style={{ color: cssVar('primary.base'), fontWeight: '600' }}>
                  {busy
                    ? lynxT(locale, 'lynx.chat.sheet.mcp.busy')
                    : row.connected
                      ? 'ON'
                      : 'OFF'}
                </LynxText>
              </LynxView>
            </LynxView>
          );
        })
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
