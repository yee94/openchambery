import React from 'react';
import { useEvent } from '@reactuses/core';
import { BranchSelector, type BranchSelectorWorktreeOption } from '@/components/views/git/BranchSelector';
import { Icon } from '@/components/icon/Icon';
import { SELECTOR_CHIP_HOVER_CLASS } from '@/components/chat/message/parts/toolRowChrome';
import { toast } from '@/components/ui';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { NewWorktreeDialog } from '@/components/session/NewWorktreeDialog';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useI18n } from '@/lib/i18n';
import type { GitRemote } from '@/lib/api/types';
import { normalizePath } from '@/lib/pathNormalization';
import { cn } from '@/lib/utils';
import { createWorktreeDraftForBranch } from '@/lib/worktreeSessionCreator';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useGitStore, useIsGitRepo } from '@/stores/useGitStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { refreshGitBranchesQuery, useGitBranchesQuery, useGitRemotesQuery } from '@/queries/gitBranchQueries';
import { isDirectoryBasenameLabel } from './draftSessionBranchLabel';
import {
  canQueryDraftGitBranches,
  resolveDraftBranchListDirectory,
  splitGitBranchList,
} from './draftSessionBranchQueries';

export type DraftSessionBranchSelectorProps = {
  directory: string | null;
  projectDirectory: string | null;
  label: string | null;
  projectRootOption: BranchSelectorWorktreeOption | null;
  worktreeOptions: BranchSelectorWorktreeOption[];
  onSelectDirectory: (directory: string) => void;
  className?: string;
  maxWidthClassName?: string;
  presentation?: 'dropdown' | 'mobile-sheet';
};

const normalizeBranchRef = (branch: string): string => branch.replace(/^remotes\//, '').trim();

const branchShortName = (branch: string): string => {
  const normalized = normalizeBranchRef(branch);
  const slash = normalized.lastIndexOf('/');
  return slash >= 0 ? normalized.slice(slash + 1) : normalized;
};

export const DraftSessionBranchSelector: React.FC<DraftSessionBranchSelectorProps> = ({
  directory,
  projectDirectory,
  label,
  projectRootOption,
  worktreeOptions,
  onSelectDirectory,
  className,
  maxWidthClassName = 'max-w-[48vw] sm:max-w-[20rem]',
  presentation = 'dropdown',
}) => {
  const { t } = useI18n();
  const { git } = useRuntimeAPIs();
  // Branch *lists* are repo-wide and already warmed for the project root by ChatInput.
  // Checkout / current branch still target the selected draft directory (root or worktree).
  const listDirectory = resolveDraftBranchListDirectory(projectDirectory, directory);
  const selectedDirectory = directory;
  const isListDirectoryGitRepo = useIsGitRepo(listDirectory);
  const isSelectedDirectoryGitRepo = useIsGitRepo(selectedDirectory);
  // Do not wait for `isGitRepo === true`: after switching to a worktree the store
  // entry is often still `null`, which previously disabled the query and cleared lists.
  const canQueryListBranches = canQueryDraftGitBranches(listDirectory, isListDirectoryGitRepo);
  const canQuerySelectedBranches = selectedDirectory !== listDirectory
    && canQueryDraftGitBranches(selectedDirectory, isSelectedDirectoryGitRepo);
  const listBranchesQuery = useGitBranchesQuery(listDirectory, git, canQueryListBranches);
  const selectedBranchesQuery = useGitBranchesQuery(selectedDirectory, git, canQuerySelectedBranches);
  const listBranches = listBranchesQuery.data;
  const selectedBranches = selectedDirectory === listDirectory
    ? listBranches
    : selectedBranchesQuery.data;
  const fetchStatus = useGitStore((state) => state.fetchStatus);
  const selectedStatusBranch = useGitStore((state) => (
    selectedDirectory
      ? state.directories.get(selectedDirectory)?.status?.current?.trim() || null
      : null
  ));
  const [branchSelectorOpen, setBranchSelectorOpen] = React.useState(false);
  const remotesQuery = useGitRemotesQuery(
    listDirectory,
    git,
    canQueryListBranches && branchSelectorOpen,
  );
  const remotes = remotesQuery.data ?? [];
  const [pendingBranch, setPendingBranch] = React.useState<string | null>(null);
  const [isActing, setIsActing] = React.useState(false);
  const [newWorktreeDialogOpen, setNewWorktreeDialogOpen] = React.useState(false);
  const projects = useProjectsStore((state) => state.projects);
  const activeProjectId = useProjectsStore((state) => state.activeProjectId);

  React.useEffect(() => {
    if (!git) return;
    // Resolve unknown repo probes so later gates and status.current stay accurate.
    if (listDirectory && isListDirectoryGitRepo === null) {
      void fetchStatus(listDirectory, git, { silent: true });
    }
    if (
      selectedDirectory
      && selectedDirectory !== listDirectory
      && isSelectedDirectoryGitRepo === null
    ) {
      void fetchStatus(selectedDirectory, git, { silent: true });
    }
  }, [
    fetchStatus,
    git,
    isListDirectoryGitRepo,
    isSelectedDirectoryGitRepo,
    listDirectory,
    selectedDirectory,
  ]);

  const worktreeDialogProjectId = React.useMemo(() => {
    const normalizedProjectDirectory = normalizePath(projectDirectory);
    if (normalizedProjectDirectory) {
      const matched = projects.find(
        (project) => normalizePath(project.path) === normalizedProjectDirectory,
      );
      if (matched) return matched.id;
    }
    return activeProjectId;
  }, [activeProjectId, projectDirectory, projects]);

  const { localBranches, remoteBranches } = React.useMemo(
    () => splitGitBranchList(listBranches?.all),
    [listBranches],
  );

  const currentBranch = selectedBranches?.current?.trim() || selectedStatusBranch || null;
  // Parent may still pass a directory basename while branches load (or after a
  // missing-option fallback). Prefer the live git current branch over that.
  const chipLabel = (
    (!isDirectoryBasenameLabel(label, directory) && label)
    || currentBranch
    || label
    || t('chat.chatInput.branch')
  );

  const refreshGit = useEvent(async () => {
    if (!git) return;
    const targets = new Set<string>();
    if (listDirectory) targets.add(listDirectory);
    if (selectedDirectory) targets.add(selectedDirectory);
    await Promise.all([...targets].map(async (target) => {
      await refreshGitBranchesQuery(target, git);
      await fetchStatus(target, git, { silent: true });
    }));
  });

  const findExistingWorktree = useEvent((branch: string) => {
    const normalized = normalizeBranchRef(branch);
    const shortName = branchShortName(normalized);
    return worktreeOptions.find((option) => {
      const labelValue = option.label.trim();
      return labelValue === normalized || labelValue === shortName;
    }) ?? null;
  });

  const checkoutBranch = useEvent(async (branch: string) => {
    if (!selectedDirectory || !git) return;
    const normalized = normalizeBranchRef(branch);
    if (currentBranch === normalized || currentBranch === branchShortName(normalized)) return;
    try {
      await git.checkoutBranch(selectedDirectory, normalized);
      toast.success(t('gitView.toast.checkedOut', { name: normalized }));
      await refreshGit();
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : t('gitView.toast.checkoutFailed', { name: normalized });
      toast.error(message);
    }
  });

  const handleBranchSelected = useEvent((branch: string) => {
    const normalized = normalizeBranchRef(branch);
    if (!normalized) return;
    if (
      currentBranch === normalized
      || currentBranch === branchShortName(normalized)
    ) {
      return;
    }

    const existing = findExistingWorktree(normalized);
    if (existing) {
      onSelectDirectory(existing.value);
      return;
    }

    // Draft conversations get a chooser: isolate via worktree, or checkout here.
    setPendingBranch(normalized);
  });

  const handleCheckoutHere = useEvent(async () => {
    if (!pendingBranch || isActing) return;
    setIsActing(true);
    try {
      await checkoutBranch(pendingBranch);
      setPendingBranch(null);
    } finally {
      setIsActing(false);
    }
  });

  const handleCreateWorktree = useEvent(async () => {
    if (!pendingBranch || isActing) return;
    setIsActing(true);
    try {
      const path = await createWorktreeDraftForBranch({
        branch: pendingBranch,
        projectDirectory: projectDirectory ?? undefined,
      });
      if (path) {
        setPendingBranch(null);
      }
    } finally {
      setIsActing(false);
    }
  });

  const handleCreate = useEvent(async (branchName: string, remote?: GitRemote) => {
    if (!selectedDirectory || !git) return;
    const remoteName = remote?.name ?? 'origin';
    try {
      await git.createBranch(selectedDirectory, branchName, currentBranch ?? 'HEAD');
      toast.success(t('gitView.toast.createdBranch', { name: branchName }));
      // After creating a brand-new branch, ask the same draft-only chooser.
      setPendingBranch(branchName);

      // Keep upstream setup opportunistic; do not block the chooser.
      void git.gitPush(selectedDirectory, {
        remote: remoteName,
        branch: branchName,
        options: ['--set-upstream'],
      }).then(async () => {
        await refreshGit();
        toast.success(t('gitView.toast.upstreamSet', { branch: branchName, remote: remoteName }));
      }).catch(async (pushError) => {
        const message = pushError instanceof Error
          ? pushError.message
          : t('gitView.toast.branchCreatedLocally');
        toast.warning(t('gitView.toast.branchCreatedLocally'), {
          description: (
            <span className="text-foreground/80 dark:text-foreground/70">
              {message}
            </span>
          ),
        });
        await refreshGit();
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : t('gitView.toast.createBranchFailed');
      toast.error(message);
      throw error;
    }
  });

  // Match the sidebar worktree entry: open the full configure dialog (branch
  // name, worktree directory, source branch) instead of silent instant create.
  const handleOpenCreateWorktreeDialog = useEvent(() => {
    const projectsState = useProjectsStore.getState();
    const normalizedProjectDirectory = normalizePath(projectDirectory);
    const matchedProject = normalizedProjectDirectory
      ? projectsState.projects.find(
        (project) => normalizePath(project.path) === normalizedProjectDirectory,
      ) ?? null
      : null;
    if (matchedProject && projectsState.activeProjectId !== matchedProject.id) {
      projectsState.setActiveProjectIdOnly(matchedProject.id);
    }
    setNewWorktreeDialogOpen(true);
  });

  const handleWorktreeCreated = useEvent(
    (worktreePath: string, options?: { sessionId?: string }) => {
      setNewWorktreeDialogOpen(false);
      if (options?.sessionId) {
        useSessionUIStore.getState().setCurrentSession(options.sessionId, worktreePath);
        return;
      }

      const projectsState = useProjectsStore.getState();
      const normalizedProjectDirectory = normalizePath(projectDirectory);
      const matchedProject = normalizedProjectDirectory
        ? projectsState.projects.find(
          (project) => normalizePath(project.path) === normalizedProjectDirectory,
        ) ?? null
        : null;
      const projectId = matchedProject?.id ?? projectsState.activeProjectId ?? null;
      const sessionStore = useSessionUIStore.getState();

      // Keep the open draft and only retarget its directory so composer text is preserved.
      if (sessionStore.newSessionDraft?.open) {
        sessionStore.overrideNewSessionDraftTarget({
          ...(projectId ? { selectedProjectId: projectId } : {}),
          directoryOverride: worktreePath,
          bootstrapPendingDirectory: worktreePath,
          preserveDirectoryOverride: true,
        });
        useDirectoryStore.getState().setDirectory(worktreePath, { showOverlay: false });
        return;
      }

      sessionStore.openNewSessionDraft({
        ...(projectId ? { selectedProjectId: projectId } : {}),
        directoryOverride: worktreePath,
        preserveDirectoryOverride: true,
      });
    },
  );

  const chipTrigger = (
    <button
      type="button"
      className={cn(
        'group relative inline-flex min-w-0 w-fit items-center gap-1.5 rounded-lg !border-0 px-1.5 font-medium text-foreground/80',
        presentation === 'mobile-sheet'
          ? 'h-[26px] text-[11px] leading-none'
          : 'h-6 py-1 pr-1.5 typography-micro transition-[padding] hover:pr-5 focus-visible:pr-5 data-[popup-open]:pr-5',
        maxWidthClassName,
        SELECTOR_CHIP_HOVER_CLASS,
        className,
      )}
      aria-label={chipLabel}
    >
      <Icon name="git-branch" className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="min-w-0 truncate">{chipLabel}</span>
      {presentation === 'dropdown' ? (
        <Icon
          name="arrow-down-s"
          className="pointer-events-none absolute right-1 size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 group-data-[popup-open]:opacity-100"
          aria-hidden="true"
        />
      ) : null}
    </button>
  );

  return (
    <>
      <BranchSelector
        currentBranch={currentBranch}
        localBranches={localBranches}
        remoteBranches={remoteBranches}
        branchInfo={listBranches?.branches}
        onCheckout={handleBranchSelected}
        onCreate={handleCreate}
        remotes={remotes}
        trigger={chipTrigger}
        triggerLabel={chipLabel}
        hideTooltip
        projectRootOption={projectRootOption}
        worktreeOptions={worktreeOptions}
        selectedDirectory={directory}
        onSelectDirectory={onSelectDirectory}
        onCreateWorktree={handleOpenCreateWorktreeDialog}
        open={branchSelectorOpen}
        presentation={presentation}
        onOpenChange={setBranchSelectorOpen}
      />

      {newWorktreeDialogOpen ? (
        <NewWorktreeDialog
          open={true}
          projectId={worktreeDialogProjectId}
          onOpenChange={setNewWorktreeDialogOpen}
          onWorktreeCreated={handleWorktreeCreated}
        />
      ) : null}

      <Dialog
        open={Boolean(pendingBranch)}
        onOpenChange={(open) => {
          if (!open && !isActing) setPendingBranch(null);
        }}
      >
        <DialogContent showCloseButton={false} className="max-w-sm gap-4">
          <DialogHeader>
            <DialogTitle>
              {t('chat.chatInput.branchSwitch.title', { branch: pendingBranch ?? '' })}
            </DialogTitle>
            <DialogDescription>
              {t('chat.chatInput.branchSwitch.description')}
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-2">
            <button
              type="button"
              disabled={isActing}
              onClick={() => { void handleCheckoutHere(); }}
              className="flex w-full flex-col items-start gap-0.5 rounded-lg border border-border px-3 py-2.5 text-left hover:bg-interactive-hover disabled:opacity-50"
            >
              <span className="inline-flex items-center gap-1.5 typography-ui-label font-medium text-foreground">
                {isActing ? <Icon name="loader-4" className="size-3.5 animate-spin" /> : <Icon name="arrow-left-right" className="size-3.5 text-muted-foreground" />}
                {t('chat.chatInput.branchSwitch.checkoutHere')}
              </span>
              <span className="typography-micro text-muted-foreground">
                {t('chat.chatInput.branchSwitch.checkoutHereDescription')}
              </span>
            </button>

            <button
              type="button"
              disabled={isActing}
              onClick={() => { void handleCreateWorktree(); }}
              className="flex w-full flex-col items-start gap-0.5 rounded-lg border border-border px-3 py-2.5 text-left hover:bg-interactive-hover disabled:opacity-50"
            >
              <span className="inline-flex items-center gap-1.5 typography-ui-label font-medium text-foreground">
                {isActing ? <Icon name="loader-4" className="size-3.5 animate-spin" /> : <Icon name="git-branch" className="size-3.5 text-muted-foreground" />}
                {t('chat.chatInput.branchSwitch.createWorktree')}
              </span>
              <span className="typography-micro text-muted-foreground">
                {t('chat.chatInput.branchSwitch.createWorktreeDescription')}
              </span>
            </button>
          </div>

          <DialogFooter>
            <button
              type="button"
              disabled={isActing}
              onClick={() => setPendingBranch(null)}
              className="inline-flex h-8 items-center justify-center rounded-md border border-border px-3 typography-ui-label text-foreground hover:bg-interactive-hover/50 disabled:opacity-50"
            >
              {t('chat.chatInput.branchSwitch.cancel')}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};
