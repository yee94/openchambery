import React from 'react';
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
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useI18n } from '@/lib/i18n';
import type { GitRemote } from '@/lib/api/types';
import { cn } from '@/lib/utils';
import { createWorktreeDraft, createWorktreeDraftForBranch } from '@/lib/worktreeSessionCreator';
import { useGitStore, useIsGitRepo } from '@/stores/useGitStore';
import { refreshGitBranchesQuery, useGitBranchesQuery, useGitRemotesQuery } from '@/queries/gitBranchQueries';

export type DraftSessionBranchSelectorProps = {
  directory: string | null;
  projectDirectory: string | null;
  label: string | null;
  projectRootOption: BranchSelectorWorktreeOption | null;
  worktreeOptions: BranchSelectorWorktreeOption[];
  onSelectDirectory: (directory: string) => void;
  className?: string;
  maxWidthClassName?: string;
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
}) => {
  const { t } = useI18n();
  const { git } = useRuntimeAPIs();
  const isGitRepo = useIsGitRepo(directory);
  const branchesQuery = useGitBranchesQuery(directory, git, isGitRepo === true);
  const branches = branchesQuery.data;
  const fetchStatus = useGitStore((state) => state.fetchStatus);
  const [branchSelectorOpen, setBranchSelectorOpen] = React.useState(false);
  const remotesQuery = useGitRemotesQuery(directory, git, isGitRepo === true && branchSelectorOpen);
  const remotes = remotesQuery.data ?? [];
  const [pendingBranch, setPendingBranch] = React.useState<string | null>(null);
  const [isActing, setIsActing] = React.useState(false);

  const localBranches = React.useMemo(() => {
    if (!branches?.all) return [];
    return branches.all
      .filter((branchName: string) => !branchName.startsWith('remotes/'))
      .sort();
  }, [branches]);

  const remoteBranches = React.useMemo(() => {
    if (!branches?.all) return [];
    return branches.all
      .filter((branchName: string) => branchName.startsWith('remotes/'))
      .map((branchName: string) => branchName.replace(/^remotes\//, ''))
      .sort();
  }, [branches]);

  const currentBranch = branches?.current?.trim() || null;
  const chipLabel = label || currentBranch || t('chat.chatInput.branch');

  const refreshGit = React.useCallback(async () => {
    if (!directory || !git) return;
    await refreshGitBranchesQuery(directory, git);
    await fetchStatus(directory, git, { silent: true });
  }, [directory, fetchStatus, git]);

  const findExistingWorktree = React.useCallback((branch: string) => {
    const normalized = normalizeBranchRef(branch);
    const shortName = branchShortName(normalized);
    return worktreeOptions.find((option) => {
      const labelValue = option.label.trim();
      return labelValue === normalized || labelValue === shortName;
    }) ?? null;
  }, [worktreeOptions]);

  const checkoutBranch = React.useCallback(async (branch: string) => {
    if (!directory || !git) return;
    const normalized = normalizeBranchRef(branch);
    if (currentBranch === normalized || currentBranch === branchShortName(normalized)) return;
    try {
      await git.checkoutBranch(directory, normalized);
      toast.success(t('gitView.toast.checkedOut', { name: normalized }));
      await refreshGit();
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : t('gitView.toast.checkoutFailed', { name: normalized });
      toast.error(message);
    }
  }, [currentBranch, directory, git, refreshGit, t]);

  const handleBranchSelected = React.useCallback((branch: string) => {
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
  }, [currentBranch, findExistingWorktree, onSelectDirectory]);

  const handleCheckoutHere = React.useCallback(async () => {
    if (!pendingBranch || isActing) return;
    setIsActing(true);
    try {
      await checkoutBranch(pendingBranch);
      setPendingBranch(null);
    } finally {
      setIsActing(false);
    }
  }, [checkoutBranch, isActing, pendingBranch]);

  const handleCreateWorktree = React.useCallback(async () => {
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
  }, [isActing, pendingBranch, projectDirectory]);

  const handleCreate = React.useCallback(async (branchName: string, remote?: GitRemote) => {
    if (!directory || !git) return;
    const remoteName = remote?.name ?? 'origin';
    try {
      await git.createBranch(directory, branchName, currentBranch ?? 'HEAD');
      toast.success(t('gitView.toast.createdBranch', { name: branchName }));
      // After creating a brand-new branch, ask the same draft-only chooser.
      setPendingBranch(branchName);

      // Keep upstream setup opportunistic; do not block the chooser.
      void git.gitPush(directory, {
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
  }, [currentBranch, directory, git, refreshGit, t]);

  const chipTrigger = (
    <button
      type="button"
      className={cn(
        'group relative inline-flex h-6 min-w-0 w-fit items-center rounded-lg !border-0 px-1.5 py-1 pr-1.5 typography-micro font-medium text-foreground/80 transition-[padding] hover:pr-5 focus-visible:pr-5 data-[popup-open]:pr-5',
        maxWidthClassName,
        SELECTOR_CHIP_HOVER_CLASS,
        className,
      )}
      aria-label={chipLabel}
    >
      <Icon name="git-branch" className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="truncate">{chipLabel}</span>
      <Icon
        name="arrow-down-s"
        className="pointer-events-none absolute right-1 size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 group-data-[popup-open]:opacity-100"
        aria-hidden="true"
      />
    </button>
  );

  return (
    <>
      <BranchSelector
        currentBranch={currentBranch}
        localBranches={localBranches}
        remoteBranches={remoteBranches}
        branchInfo={branches?.branches}
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
        onCreateWorktree={() => { void createWorktreeDraft(); }}
        onOpenChange={setBranchSelectorOpen}
      />

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
