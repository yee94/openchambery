import { useEffect, useState } from 'react';

import { lynxT } from '../i18n/catalog';
import { LynxInput, LynxScrollView, LynxText, LynxView } from '../lynx-elements';
import type { LynxRuntimeFetch } from '../runtime/fetch';
import { loadMcpCatalog, type LynxCatalogItem } from '../settings/catalogs';
import { cssVar } from '../theme/tokens';
import {
  commitLynxGitChanges,
  loadLynxGitFileDiff,
  loadLynxGitStatus,
  stageLynxGitFiles,
  syncLynxGit,
  unstageLynxGitFiles,
  type LynxGitChangeEntry,
  type LynxGitSyncAction,
} from './changesSurface';
import { listLynxDirectory, readLynxFile, type LynxFsEntry } from './filesSurface';
import { isLynxHtmlPath, planLynxHtmlPreview } from './htmlPreview';
import {
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
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [previewNote, setPreviewNote] = useState<string | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [htmlViewMode, setHtmlViewMode] = useState<'preview' | 'source'>('source');

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
              else void openPreview(entry.path);
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
  const [diffEntry, setDiffEntry] = useState<LynxGitChangeEntry | null>(null);
  const [diffPlan, setDiffPlan] = useState<LynxPierreDiffPlan | null>(null);
  const [diffNote, setDiffNote] = useState<string | null>(null);
  const [diffBusy, setDiffBusy] = useState(false);
  const [commitMessage, setCommitMessage] = useState('');
  const [actionNote, setActionNote] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);

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
        setDiffPlan(planLynxPierreDiff({ binary: true }));
        setDiffNote(lynxT(locale, 'lynx.chat.sheet.changes.binary'));
        return;
      }
      setDiffPlan(planLynxPierreDiff({
        unifiedDiff: result.unifiedDiff,
        original: result.original,
        modified: result.modified,
        path: entry.path,
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
    const statsLabel = diffPlan
      ? lynxT(locale, 'lynx.chat.sheet.changes.diffStats')
        .replace('{insertions}', String(diffPlan.stats.insertions))
        .replace('{deletions}', String(diffPlan.stats.deletions))
      : null;
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
        {statsLabel && diffPlan?.hasTextPreview ? (
          <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '12px', marginBottom: '8px' }}>
            {statsLabel}
          </LynxText>
        ) : null}
        {diffPlan?.lines.map((line, index) => (
          <LynxText
            key={`${index}:${line.kind}`}
            style={{
              color: cssVar(lynxPierreDiffLineToken(line.kind)),
              fontSize: '12px',
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
            label={actionBusy ? lynxT(locale, 'lynx.chat.sheet.changes.busy') : lynxT(locale, 'lynx.chat.sheet.changes.commit')}
            onTap={() => { if (!actionBusy) void runCommit(); }}
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
        entries.map((entry) => (
          <LynxView
            key={`${entry.staged ? 's' : 'u'}:${entry.path}`}
            style={{ padding: '10px 0', flexDirection: 'row', alignItems: 'center' }}
          >
            <LynxView
              style={{ flexGrow: 1 }}
              bindtap={() => { void openDiff(entry); }}
            >
              <LynxText style={{ color: cssVar('surface.foreground') }}>{entry.path}</LynxText>
              <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '12px' }}>
                {entry.status}
                {entry.staged ? ' · staged' : ''}
              </LynxText>
            </LynxView>
            <ActionChip
              label={entry.staged
                ? lynxT(locale, 'lynx.chat.sheet.changes.unstage')
                : lynxT(locale, 'lynx.chat.sheet.changes.stage')}
              onTap={() => { if (!actionBusy) void runStageToggle(entry); }}
            />
          </LynxView>
        ))
      )}
    </LynxScrollView>
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
