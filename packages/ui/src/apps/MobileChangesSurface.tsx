import React from 'react';
import { useEvent } from '@reactuses/core';
import { Icon } from '@/components/icon/Icon';

import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { ScrollShadow } from '@/components/ui/ScrollShadow';
import { ChangesPanel, type ChangesGroupConfig } from '@/components/views/git/ChangesPanel';
import { CommitSection } from '@/components/views/git/CommitSection';
import { SyncActions } from '@/components/views/git/SyncActions';
import { PierreDiffViewer } from '@/components/views/PierreDiffViewer';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import type { GitStatus } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';
import { generateCommitMessage, stageGitFile, stageGitFiles, unstageGitFile, unstageGitFiles } from '@/lib/gitApi';
import type { GitRemote } from '@/lib/gitApi';
import { getLanguageFromExtension, isImageFile } from '@/lib/toolHelpers';
import {
  useGitStore,
  useGitStatus,
  useIsGitRepo,
  useGitLoadingStatus,
} from '@/stores/useGitStore';
import { useMobileBackRoute } from '@/mobile/mobileBackNavigation';

type SyncAction = 'fetch' | 'pull' | 'push' | 'sync' | null;
type CommitAction = 'commit' | 'commitAndPush' | null;
type DiffLoadState = {
  key: string | null;
  loading: boolean;
  error: string | null;
  resolved: boolean;
};

const normalizePath = (value?: string | null): string => (value || '').replace(/\\/g, '/').replace(/\/+$/g, '');

const isStagedStatusFile = (file: GitStatus['files'][number]): boolean => {
  const indexStatus = file.index?.trim();
  return Boolean(indexStatus && indexStatus !== '?');
};

const isUnstagedStatusFile = (file: GitStatus['files'][number]): boolean => {
  const workingStatus = file.working_dir?.trim();
  const indexStatus = file.index?.trim();
  return Boolean(workingStatus || indexStatus === '?');
};

const diffCacheKey = (path: string, staged: boolean): string => staged ? `${path}\u0000staged` : path;

type MobileChangesSurfaceProps = {
  /** When provided, the list header gets a close X that calls this; used when the surface is hosted in MobileSurfaceShell. */
  onClose?: () => void;
  /**
   * When set (and non-null), the surface opens directly into the per-file diff view for this
   * relative path. Updating it (incl. setting it to a different path while open) routes the
   * surface to that diff. Setting it back to null leaves the user on the current internal route.
   */
  initialDiffPath?: string | null;
  initialDiffStaged?: boolean;
  initialDiffTargetLine?: number | null;
  /** Let an owning modal render the title and close control for a directly opened diff. */
  hideDiffHeader?: boolean;
};

export const MobileChangesSurface: React.FC<MobileChangesSurfaceProps> = ({ onClose, initialDiffPath, initialDiffStaged = false, initialDiffTargetLine = null, hideDiffHeader = false }) => {
  const { t } = useI18n();
  const { git } = useRuntimeAPIs();
  const currentDirectory = normalizePath(useEffectiveDirectory() ?? null);
  const status = useGitStatus(currentDirectory || null);
  const isGitRepo = useIsGitRepo(currentDirectory || null);
  const isLoadingStatus = useGitLoadingStatus(currentDirectory || null);
  const setActiveDirectory = useGitStore((state) => state.setActiveDirectory);
  const ensureAll = useGitStore((state) => state.ensureAll);
  const fetchStatus = useGitStore((state) => state.fetchStatus);
  const fetchBranches = useGitStore((state) => state.fetchBranches);
  const prefetchDiffs = useGitStore((state) => state.prefetchDiffs);
  const getDiff = useGitStore((state) => state.getDiff);
  const setDiff = useGitStore((state) => state.setDiff);

  const [route, setRoute] = React.useState<{ type: 'list' } | { type: 'diff'; path: string; staged: boolean; targetLine: number | null }>(
    () => (initialDiffPath ? { type: 'diff', path: initialDiffPath, staged: initialDiffStaged, targetLine: initialDiffTargetLine } : { type: 'list' }),
  );
  const mobileNavigationSurfaceRef = React.useRef<HTMLDivElement | null>(null);

  // Allow the host (MobileApp) to push us into a specific diff when the surface
  // is reopened or when an external trigger (e.g. PendingChangesBar tap) requests
  // a different file mid-session.
  React.useEffect(() => {
    if (!initialDiffPath) return;
    setRoute((current) => (
      current.type === 'diff' && current.path === initialDiffPath && current.staged === initialDiffStaged && current.targetLine === initialDiffTargetLine
        ? current
        : { type: 'diff', path: initialDiffPath, staged: initialDiffStaged, targetLine: initialDiffTargetLine }
    ));
  }, [initialDiffPath, initialDiffStaged, initialDiffTargetLine]);
  const [syncAction, setSyncAction] = React.useState<SyncAction>(null);
  const [commitAction, setCommitAction] = React.useState<CommitAction>(null);
  const [commitMessage, setCommitMessage] = React.useState('');
  const [revertingPaths, setRevertingPaths] = React.useState<Set<string>>(new Set());
  const [isRevertingAll, setIsRevertingAll] = React.useState(false);
  const [isGeneratingMessage, setIsGeneratingMessage] = React.useState(false);
  const [generatedHighlights, setGeneratedHighlights] = React.useState<string[]>([]);
  const [visibleChangePaths, setVisibleChangePaths] = React.useState<string[]>([]);
  const [remotes, setRemotes] = React.useState<GitRemote[]>([]);
  const [remoteUrl, setRemoteUrl] = React.useState<string | null>(null);
  const [diffLoadState, setDiffLoadState] = React.useState<DiffLoadState>({
    key: null,
    loading: false,
    error: null,
    resolved: false,
  });
  const [diffRetryNonce, setDiffRetryNonce] = React.useState(0);
  const remoteRequest = React.useRef({ key: null as string | null, generation: 0 });

  const changeEntries = React.useMemo(() => {
    const files = status?.files ?? [];
    const unique = new Map<string, (typeof files)[number]>();
    for (const file of files) {
      unique.set(file.path, file);
    }
    return Array.from(unique.values()).sort((a, b) => a.path.localeCompare(b.path));
  }, [status?.files]);

  const stagedChangeEntries = React.useMemo(
    () => changeEntries.filter(isStagedStatusFile),
    [changeEntries],
  );

  const unstagedChangeEntries = React.useMemo(
    () => changeEntries.filter(isUnstagedStatusFile),
    [changeEntries],
  );

  const effectiveRemotes = React.useMemo<GitRemote[]>(() => {
    if (remotes.length > 0) return remotes;
    const trackingRemote = status?.tracking?.includes('/') ? status.tracking.split('/')[0] : null;
    if (trackingRemote || remoteUrl) {
      return [{ name: trackingRemote || 'origin', fetchUrl: remoteUrl ?? '', pushUrl: remoteUrl ?? '' }];
    }
    return [];
  }, [remoteUrl, remotes, status?.tracking]);

  const selectedDiffSelector = React.useMemo(() => (state: ReturnType<typeof useGitStore.getState>) => {
    if (!currentDirectory || route.type !== 'diff') return null;
    return state.directories.get(currentDirectory)?.diffCache.get(diffCacheKey(route.path, route.staged)) ?? null;
  }, [currentDirectory, route]);
  const selectedDiff = useGitStore(selectedDiffSelector);

  const selectedFileEntry = React.useMemo(() => {
    if (route.type !== 'diff') return null;
    return changeEntries.find((entry) => entry.path === route.path) ?? null;
  }, [changeEntries, route]);

  const activeDiffRequestKey = route.type === 'diff' && currentDirectory
    ? `${currentDirectory}\u0000${diffCacheKey(route.path, route.staged)}`
    : null;
  const hasActiveDiffLoadState = diffLoadState.key === activeDiffRequestKey;
  const selectedDiffLoading = Boolean(
    activeDiffRequestKey
    && !selectedDiff
    && (!hasActiveDiffLoadState || diffLoadState.loading),
  );
  const selectedDiffError = hasActiveDiffLoadState ? diffLoadState.error : null;
  const selectedFileExists = Boolean(
    selectedFileEntry
    || (hasActiveDiffLoadState && diffLoadState.resolved),
  );

  const refreshStatusAndBranches = useEvent(async (directory: string, showErrors = true) => {
    try {
      await Promise.all([
        fetchStatus(directory, git),
        fetchBranches(directory, git),
      ]);
    } catch (error) {
      if (showErrors) {
        toast.error(error instanceof Error ? error.message : t('gitView.toast.refreshRepositoryFailed'));
      }
    }
  });

  const refreshRemotes = useEvent(async (directory: string, requestKey: string, requestGeneration: number) => {
    const isCurrentRequest = () => remoteRequest.current.key === requestKey
      && remoteRequest.current.generation === requestGeneration;
    try {
      const [remoteList, url] = await Promise.all([
        git.getRemotes(directory).catch(() => []),
        git.getRemoteUrl ? git.getRemoteUrl(directory).catch(() => null) : Promise.resolve(null),
      ]);
      if (!isCurrentRequest()) return;
      setRemotes(remoteList);
      setRemoteUrl(url);
    } catch {
      if (!isCurrentRequest()) return;
      setRemotes([]);
      setRemoteUrl(null);
    }
  });

  const startRemoteRefresh = useEvent((directory: string) => {
    if (directory !== currentDirectory) {
      return { requestGeneration: null, promise: Promise.resolve() };
    }
    const requestGeneration = remoteRequest.current.generation + 1;
    remoteRequest.current = { key: directory, generation: requestGeneration };
    return {
      requestGeneration,
      promise: refreshRemotes(directory, directory, requestGeneration),
    };
  });

  React.useEffect(() => {
    if (!currentDirectory) return;
    setActiveDirectory(currentDirectory);
    void ensureAll(currentDirectory, git);
  }, [currentDirectory, ensureAll, git, setActiveDirectory]);

  React.useEffect(() => {
    if (!currentDirectory) {
      remoteRequest.current = { key: null, generation: remoteRequest.current.generation + 1 };
      setRemotes([]);
      setRemoteUrl(null);
      return;
    }
    const { requestGeneration, promise } = startRemoteRefresh(currentDirectory);
    void promise;
    return () => {
      if (requestGeneration !== null
        && remoteRequest.current.key === currentDirectory
        && remoteRequest.current.generation === requestGeneration) {
        remoteRequest.current = { key: currentDirectory, generation: requestGeneration + 1 };
      }
    };
  }, [currentDirectory, git, startRemoteRefresh]);

  React.useEffect(() => {
    if (!currentDirectory || changeEntries.length === 0) return;
    const orderedPaths = Array.from(new Set([
      ...stagedChangeEntries.map((entry) => entry.path),
      ...visibleChangePaths,
      ...changeEntries.slice(0, 20).map((entry) => entry.path),
    ])).filter(Boolean);
    if (orderedPaths.length === 0) return;
    const timeoutId = window.setTimeout(() => {
      void prefetchDiffs(currentDirectory, git, orderedPaths, { maxFiles: 40 });
    }, 120);
    return () => window.clearTimeout(timeoutId);
  }, [changeEntries, currentDirectory, git, prefetchDiffs, stagedChangeEntries, visibleChangePaths]);

  React.useEffect(() => {
    if (route.type !== 'diff') {
      setDiffLoadState({ key: null, loading: false, error: null, resolved: false });
      return;
    }
    const cacheKey = diffCacheKey(route.path, route.staged);
    if (!currentDirectory || !activeDiffRequestKey) {
      setDiffLoadState({ key: null, loading: false, error: null, resolved: false });
      return;
    }
    if (getDiff(currentDirectory, cacheKey)) {
      setDiffLoadState((current) => ({
        key: activeDiffRequestKey,
        loading: false,
        error: null,
        resolved: (current.key === activeDiffRequestKey && current.resolved) || Boolean(selectedFileEntry),
      }));
      return;
    }

    let cancelled = false;
    setDiffLoadState({ key: activeDiffRequestKey, loading: true, error: null, resolved: false });
    void git.getGitFileDiff(currentDirectory, { path: route.path, staged: route.staged || undefined })
      .then((response) => {
        if (cancelled) return;
        setDiff(currentDirectory, cacheKey, {
          original: response.original ?? '',
          modified: response.modified ?? '',
          isBinary: response.isBinary,
        });
        setDiffLoadState((current) => current.key === activeDiffRequestKey
          ? { ...current, loading: false, error: null, resolved: true }
          : current);
      })
      .catch((error) => {
        if (cancelled) return;
        setDiffLoadState((current) => current.key === activeDiffRequestKey
          ? { ...current, loading: false, error: error instanceof Error ? error.message : String(error), resolved: false }
          : current);
      });

    return () => {
      cancelled = true;
    };
  }, [activeDiffRequestKey, currentDirectory, diffRetryNonce, getDiff, git, route, selectedFileEntry, setDiff]);

  const handleSyncAction = async (action: Exclude<SyncAction, null>, remote?: GitRemote) => {
    if (!currentDirectory) return;
    const operationDirectory = currentDirectory;
    setSyncAction(action);
    try {
      const getPullOptions = (pullRemote: GitRemote) => {
        const trackingPrefix = `${pullRemote.name}/`;
        const trackedBranch = status?.tracking?.startsWith(trackingPrefix)
          ? status.tracking.slice(trackingPrefix.length)
          : undefined;
        return { remote: pullRemote.name, branch: trackedBranch, rebase: true };
      };

      if (action === 'fetch') {
        if (!remote) throw new Error(t('mobile.changes.noRemote'));
        await git.gitFetch(operationDirectory, { remote: remote.name });
        toast.success(t('gitView.toast.fetchedFromRemote', { name: remote.name }));
      } else if (action === 'sync') {
        if (!remote) throw new Error(t('mobile.changes.noRemote'));
        await git.gitFetch(operationDirectory, { remote: remote.name });
        const afterFetch = await git.getGitStatus(operationDirectory);
        if ((afterFetch.behind ?? 0) > 0) {
          if ((afterFetch.files?.length ?? 0) > 0) {
            toast.error(t('gitView.toast.commitOrStashBeforeSync'));
            return;
          }
          await git.gitPull(operationDirectory, getPullOptions(remote));
        }
        const afterPull = await git.getGitStatus(operationDirectory);
        if ((afterPull.ahead ?? 0) > 0) {
          await git.gitPush(operationDirectory);
        }
        toast.success(t('gitView.toast.alreadyUpToDate'));
      }
      await refreshStatusAndBranches(operationDirectory, false);
      await startRemoteRefresh(operationDirectory).promise;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('gitView.toast.syncActionFailed', { action: t('gitView.sync.syncChanges') }));
    } finally {
      setSyncAction(null);
    }
  };

  const moveChangePaths = useEvent(async (paths: string[], direction: 'stage' | 'unstage') => {
    if (!currentDirectory || paths.length === 0) return;
    const operationDirectory = currentDirectory;
    try {
      if (direction === 'stage') {
        if (paths.length > 1) await stageGitFiles(operationDirectory, paths);
        else await stageGitFile(operationDirectory, paths[0]);
      } else {
        if (paths.length > 1) await unstageGitFiles(operationDirectory, paths);
        else await unstageGitFile(operationDirectory, paths[0]);
      }
      await refreshStatusAndBranches(operationDirectory, false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : direction === 'stage'
        ? t('gitView.toast.stageFileFailed')
        : t('gitView.toast.unstageFileFailed'));
    }
  });

  const handleViewChangeDiff = useEvent((path: string, staged = false) => {
    setRoute({ type: 'diff', path, staged, targetLine: null });
  });

  const closeDiffDetail = useEvent(() => {
    if (route.type !== 'diff') return false;
    setRoute({ type: 'list' });
    return true;
  });

  useMobileBackRoute({
    id: 'mobile-changes-diff',
    active: route.type === 'diff' && !hideDiffHeader,
    layer: 'overlay',
    onBack: closeDiffDetail,
    surfaceRef: mobileNavigationSurfaceRef,
  });

  const handleRevertFile = useEvent(async (filePath: string) => {
    if (!currentDirectory) return;
    const operationDirectory = currentDirectory;
    setRevertingPaths((previous) => new Set(previous).add(filePath));
    try {
      await git.revertGitFile(operationDirectory, filePath);
      toast.success(t('gitView.toast.revertedFile', { path: filePath }));
      await refreshStatusAndBranches(operationDirectory, false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('gitView.toast.revertFailed'));
    } finally {
      setRevertingPaths((previous) => {
        const next = new Set(previous);
        next.delete(filePath);
        return next;
      });
    }
  });

  const handleRevertAll = useEvent(async (paths: string[]) => {
    if (!currentDirectory || paths.length === 0 || isRevertingAll) return;
    const operationDirectory = currentDirectory;
    const uniquePaths = Array.from(new Set(paths));
    setIsRevertingAll(true);
    setRevertingPaths(new Set(uniquePaths));
    try {
      await Promise.all(uniquePaths.map((filePath) => git.revertGitFile(operationDirectory, filePath)));
      await refreshStatusAndBranches(operationDirectory, false);
      toast.success(uniquePaths.length === 1
        ? t('gitView.toast.revertedFilesSingle', { count: uniquePaths.length })
        : t('gitView.toast.revertedFilesPlural', { count: uniquePaths.length }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('gitView.toast.revertFailed'));
    } finally {
      setRevertingPaths(new Set());
      setIsRevertingAll(false);
    }
  });

  const handleInsertHighlights = useEvent((highlights: string[]) => {
    const normalized = highlights.map((text) => text.trim()).filter(Boolean);
    if (normalized.length === 0) {
      setGeneratedHighlights([]);
      return;
    }
    setCommitMessage((current) => `${current.trim()}${current.trim() ? '\n\n' : ''}${normalized.join('\n')}`.trim());
    setGeneratedHighlights([]);
  });

  const handleGenerateCommitMessage = useEvent(async () => {
    if (!currentDirectory) return;
    const operationDirectory = currentDirectory;
    const selectedFilePaths = stagedChangeEntries.map((file) => file.path).sort();
    if (selectedFilePaths.length === 0) {
      toast.error(t('gitView.toast.selectFileToDescribe'));
      return;
    }
    setIsGeneratingMessage(true);
    try {
      const { message } = await generateCommitMessage(operationDirectory, selectedFilePaths);
      setCommitMessage(message.subject?.trim() ?? '');
      setGeneratedHighlights(Array.isArray(message.highlights) ? message.highlights : []);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('gitView.toast.generateCommitMessageFailed'));
    } finally {
      setIsGeneratingMessage(false);
    }
  });

  const handleCommit = async (options: { pushAfter?: boolean } = {}) => {
    if (!currentDirectory) return;
    const operationDirectory = currentDirectory;
    if (!commitMessage.trim()) {
      toast.error(t('gitView.toast.enterCommitMessage'));
      return;
    }
    const filesToCommit = stagedChangeEntries.map((file) => file.path).sort();
    if (filesToCommit.length === 0) {
      toast.error(t('gitView.toast.selectFileToCommit'));
      return;
    }

    setCommitAction(options.pushAfter ? 'commitAndPush' : 'commit');
    try {
      await git.createGitCommit(operationDirectory, commitMessage.trim(), { files: filesToCommit });
      toast.success(t('gitView.toast.commitCreated'));
      setCommitMessage('');
      setGeneratedHighlights([]);

      if (options.pushAfter) {
        const trackingRemoteName = status?.tracking?.split('/')[0];
        const remote = effectiveRemotes.find((entry) => entry.name === trackingRemoteName) ?? effectiveRemotes[0];
        if (!remote) throw new Error(t('mobile.changes.noRemote'));
        setSyncAction('sync');
        const trackingPrefix = `${remote.name}/`;
        const trackedBranch = status?.tracking?.startsWith(trackingPrefix)
          ? status.tracking.slice(trackingPrefix.length)
          : undefined;

        await git.gitFetch(operationDirectory, { remote: remote.name });
        const afterFetch = await git.getGitStatus(operationDirectory);
        if ((afterFetch.behind ?? 0) > 0) {
          await git.gitPull(operationDirectory, { remote: remote.name, branch: trackedBranch, rebase: true });
        }

        const afterPull = await git.getGitStatus(operationDirectory);
        if ((afterPull.ahead ?? 0) > 0) {
          await git.gitPush(operationDirectory);
        }

        await refreshStatusAndBranches(operationDirectory, false);
        await startRemoteRefresh(operationDirectory).promise;
      } else {
        await refreshStatusAndBranches(operationDirectory, false);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('gitView.toast.createCommitFailed'));
    } finally {
      setCommitAction(null);
      if (options.pushAfter) setSyncAction(null);
    }
  };

  const changeGroups = React.useMemo<ChangesGroupConfig[]>(() => {
    const groups: ChangesGroupConfig[] = [];

    if (stagedChangeEntries.length > 0) {
      groups.push({
        id: 'staged',
        title: t('gitView.changes.stagedTitle'),
        entries: stagedChangeEntries,
        actionSymbol: '-',
        actionAllLabel: t('gitView.changes.unstageAllAria'),
        getActionLabel: (path: string) => t('gitView.changes.unstageFileAria', { path }),
        onActionFile: (path: string) => void moveChangePaths([path], 'unstage'),
        onActionAll: (paths: string[]) => void moveChangePaths(paths, 'unstage'),
        onViewDiff: (path: string) => handleViewChangeDiff(path, true),
        onRevertFile: handleRevertFile,
        showRevertActions: false,
        accent: true,
      });
    }

    if (unstagedChangeEntries.length > 0) {
      groups.push({
        id: 'unstaged',
        title: t('gitView.changes.title'),
        entries: unstagedChangeEntries,
        actionSymbol: '+',
        actionAllLabel: t('gitView.changes.stageAllAria'),
        getActionLabel: (path: string) => t('gitView.changes.stageFileAria', { path }),
        onActionFile: (path: string) => void moveChangePaths([path], 'stage'),
        onActionAll: (paths: string[]) => void moveChangePaths(paths, 'stage'),
        onViewDiff: (path: string) => handleViewChangeDiff(path, false),
        onRevertFile: handleRevertFile,
      });
    }

    return groups;
  }, [handleRevertFile, handleViewChangeDiff, moveChangePaths, stagedChangeEntries, t, unstagedChangeEntries]);

  const renderListState = (state: React.ReactNode) => (
    <div className="flex h-full flex-col overflow-hidden bg-background text-foreground">
      {hideDiffHeader ? null : (
        <header className="flex h-[var(--oc-header-height,56px)] shrink-0 items-center gap-2 px-3 text-foreground">
          {onClose ? (
            <button
              type="button"
              className="-ml-1 flex size-10 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              aria-label={t('mobile.surface.closeAria')}
              onClick={onClose}
              style={{ touchAction: 'manipulation' }}
            >
              <Icon name="close" className="size-5" />
            </button>
          ) : null}
          <div className="min-w-0 flex-1 px-1">
            <h2 className="typography-ui-label text-foreground">{t('mobile.nav.changes')}</h2>
            <p className="truncate typography-micro text-muted-foreground">
              {status?.current || currentDirectory || ''}
            </p>
          </div>
        </header>
      )}
      <div className="min-h-0 flex-1">{state}</div>
    </div>
  );

  if (!currentDirectory) {
    return renderListState(<MobileChangesState message={t('gitView.empty.selectSessionOrDirectory')} />);
  }

  if (isLoadingStatus && isGitRepo === null) {
    return renderListState(<MobileChangesState loading message={t('gitView.loading.checkingRepository')} />);
  }

  if (isGitRepo === false) {
    return renderListState(<MobileChangesState icon message={t('gitView.empty.notGitRepository')} description={t('gitView.empty.notGitRepositoryDescription')} />);
  }

  if (route.type === 'diff') {
    return (
      <div ref={mobileNavigationSurfaceRef} className="h-full min-h-0">
        <MobileDiffDetail
          path={route.path}
          diff={selectedDiff}
          fileExists={selectedFileExists}
          error={selectedDiffError}
          loading={selectedDiffLoading}
          targetLine={route.targetLine}
          onBack={closeDiffDetail}
          onRetry={() => setDiffRetryNonce((value) => value + 1)}
          hideHeader={hideDiffHeader}
        />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background text-foreground">
      <header className="flex h-[var(--oc-header-height,56px)] shrink-0 items-center gap-2 px-3 text-foreground">
        {onClose ? (
          <button
            type="button"
            className="-ml-1 flex size-10 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            aria-label={t('mobile.surface.closeAria')}
            onClick={onClose}
            style={{ touchAction: 'manipulation' }}
          >
            <Icon name="close" className="size-5" />
          </button>
        ) : null}
        <div className="min-w-0 flex-1 px-1">
          <h2 className="typography-ui-label text-foreground">{t('mobile.nav.changes')}</h2>
          <p className="truncate typography-micro text-muted-foreground">
            {status?.current || currentDirectory}
          </p>
        </div>
        <SyncActions
          syncAction={syncAction}
          remotes={effectiveRemotes}
          onSync={(remote) => void handleSyncAction('sync', remote)}
          disabled={commitAction !== null || isLoadingStatus}
          aheadCount={status?.ahead ?? 0}
          behindCount={status?.behind ?? 0}
          trackingRemoteName={status?.tracking?.split('/')[0]}
          hasUncommittedChanges={changeEntries.length > 0}
        />
      </header>
      {changeEntries.length > 0 ? (
        <div className="flex min-h-0 flex-1 flex-col">
          {/* File list scrolls inside ChangesPanel; the commit footer stays pinned. */}
          <div className="min-h-0 flex-1 overflow-hidden px-4 pt-4">
            <ChangesPanel
              groups={changeGroups}
              diffStats={status?.diffStats}
              revertingPaths={revertingPaths}
              onRevertAll={handleRevertAll}
              isRevertingAll={isRevertingAll}
              headerBackgroundClassName="bg-transparent"
              onVisiblePathsChange={setVisibleChangePaths}
            />
          </div>
          <div className="shrink-0 border-t border-border/50 px-4 pb-4 pt-3">
            <CommitSection
              stagedCount={stagedChangeEntries.length}
              commitMessage={commitMessage}
              onCommitMessageChange={setCommitMessage}
              generatedHighlights={generatedHighlights}
              onInsertHighlights={handleInsertHighlights}
              onGenerateMessage={handleGenerateCommitMessage}
              isGeneratingMessage={isGeneratingMessage}
              onCommit={() => void handleCommit({ pushAfter: false })}
              onCommitAndPush={() => void handleCommit({ pushAfter: true })}
              commitAction={commitAction}
              gitmojiEnabled={false}
              onOpenGitmojiPicker={() => {}}
            />
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1">
          <MobileChangesState icon message={t('gitView.empty.cleanTitle')} description={t('mobile.changes.cleanDescription')} />
        </div>
      )}
    </div>
  );
};

const MobileChangesState: React.FC<{
  message: string;
  description?: string;
  loading?: boolean;
  icon?: boolean;
}> = ({ message, description, loading = false, icon = false }) => (
  <div className="flex h-full items-center justify-center px-6 text-center">
    <div className="flex max-w-sm flex-col items-center gap-2">
      {loading ? <Icon name="loader-4" className="size-5 animate-spin text-muted-foreground" /> : null}
      {icon ? <Icon name="git-branch" className="size-6 text-muted-foreground" /> : null}
      <p className="typography-ui-label font-semibold text-foreground">{message}</p>
      {description ? <p className="typography-meta text-muted-foreground">{description}</p> : null}
    </div>
  </div>
);

const MobileDiffDetail: React.FC<{
  path: string;
  diff: { original: string; modified: string; isBinary?: boolean } | null;
  fileExists: boolean;
  error: string | null;
  loading: boolean;
  targetLine: number | null;
  onBack: () => void;
  onRetry: () => void;
  hideHeader?: boolean;
}> = ({ path, diff, fileExists, error, loading, targetLine, onBack, onRetry, hideHeader = false }) => {
  const { t } = useI18n();
  const language = React.useMemo(() => getLanguageFromExtension(path) || 'text', [path]);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background text-foreground">
      {hideHeader ? null : (
        <header className="flex h-[var(--oc-header-height,56px)] shrink-0 items-center gap-3 border-b border-border/50 px-3 text-foreground">
          <button
            type="button"
            className="flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            aria-label={t('header.actions.backAria')}
            onClick={onBack}
          >
            <Icon name="arrow-left" className="size-5" />
          </button>
          <div className="min-w-0 flex-1 px-2">
            <h2 className="truncate typography-ui-header text-foreground">{path}</h2>
          </div>
        </header>
      )}
      <div className="min-h-0 flex-1 overflow-hidden">
        {error ? (
          <div className="flex h-full items-center justify-center px-6 text-center">
            <div className="flex max-w-sm flex-col items-center gap-3">
              <p className="typography-ui-label font-semibold text-foreground">{t('mobile.changes.diffDetail.loadFailed')}</p>
              <p className="typography-meta text-muted-foreground">{error}</p>
              <Button type="button" size="sm" variant="outline" onClick={onRetry}>{t('diffView.actions.retry')}</Button>
            </div>
          </div>
        ) : loading ? (
          <MobileChangesState loading message={t('diffView.state.loadingDiff')} />
        ) : !fileExists ? (
          <MobileChangesState icon message={t('mobile.changes.diffDetail.missingTitle')} description={t('mobile.changes.diffDetail.missingDescription')} />
        ) : !diff ? (
          <MobileChangesState loading message={t('diffView.state.loadingDiff')} />
        ) : diff.isBinary ? (
          <MobileChangesState icon message={t('diffView.binary.unavailable')} />
        ) : isImageFile(path) ? (
          <MobileChangesState icon message={t('mobile.changes.diffDetail.imageUnavailable')} />
        ) : (
          <ScrollShadow
            className="h-full overflow-y-auto overflow-x-hidden p-3 pwa-overlay-scroll"
            data-diff-virtual-root
            data-diff-virtual-content
          >
            <PierreDiffViewer
              original={diff.original}
              modified={diff.modified}
              language={language}
              fileName={path}
              renderSideBySide={false}
              wrapLines={true}
              focusLine={targetLine}
              layout="inline"
            />
          </ScrollShadow>
        )}
      </div>
    </div>
  );
};
