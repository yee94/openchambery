import React from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Icon } from "@/components/icon/Icon";
import type { GitRemote } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';

interface BranchInfo {
  ahead?: number;
  behind?: number;
}

export type BranchSelectorWorktreeOption = {
  value: string;
  label: string;
  pending?: boolean;
};

interface BranchSelectorProps {
  currentBranch: string | null | undefined;
  localBranches: string[];
  remoteBranches: string[];
  branchInfo: Record<string, BranchInfo> | undefined;
  onCheckout: (branch: string) => void;
  onCreate: (name: string, remote?: GitRemote) => Promise<void>;
  remotes?: GitRemote[];
  disabled?: boolean;
  /** Icon-only trigger; branch name shown in tooltip. */
  iconOnly?: boolean;
  /** Replace the default trigger (e.g. draft composer chip). */
  trigger?: React.ReactElement;
  /** Optional content label override for the default text trigger. */
  triggerLabel?: string | null;
  /** Align the dropdown. Defaults based on iconOnly. */
  contentAlign?: 'start' | 'end' | 'center';
  /** Hide the trigger tooltip (useful for custom composer chips). */
  hideTooltip?: boolean;
  /** Project root directory row shown above linked worktrees. */
  projectRootOption?: BranchSelectorWorktreeOption | null;
  /** Linked worktrees listed under the branch lists. */
  worktreeOptions?: BranchSelectorWorktreeOption[];
  /** Currently selected session/worktree directory. */
  selectedDirectory?: string | null;
  onSelectDirectory?: (directory: string) => void;
  onCreateWorktree?: () => void;
  worktreesLabel?: string;
  worktreeNewLabel?: string;
  projectRootLabel?: string;
  onOpenChange?: (open: boolean) => void;
}

const sanitizeBranchNameInput = (value: string): string => {
  return value
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^A-Za-z0-9._/-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/\/{2,}/g, '/')
    .replace(/\/-+/g, '/')
    .replace(/-+\//g, '/')
    .replace(/^[-/]+/, '')
    .replace(/[-/]+$/, '');
};

export const BranchSelector: React.FC<BranchSelectorProps> = ({
  currentBranch,
  localBranches,
  remoteBranches,
  branchInfo,
  onCheckout,
  onCreate,
  remotes = [],
  disabled = false,
  iconOnly = false,
  trigger,
  triggerLabel,
  contentAlign,
  hideTooltip = false,
  projectRootOption = null,
  worktreeOptions = [],
  selectedDirectory = null,
  onSelectDirectory,
  onCreateWorktree,
  worktreesLabel,
  worktreeNewLabel,
  projectRootLabel,
  onOpenChange,
}) => {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = React.useState(false);
  const [search, setSearch] = React.useState('');
  const [showCreate, setShowCreate] = React.useState(false);
  const [showRemoteSelect, setShowRemoteSelect] = React.useState(false);
  const [newBranchName, setNewBranchName] = React.useState('');
  const [isCreating, setIsCreating] = React.useState(false);
  const createInputRef = React.useRef<HTMLInputElement>(null);

  const stopDropdownTypeahead = React.useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation();
  }, []);

  const hasMultipleRemotes = remotes.length > 1;
  const showWorktreeSection = Boolean(onSelectDirectory || onCreateWorktree);

  const sanitizedNewBranch = React.useMemo(
    () => sanitizeBranchNameInput(newBranchName),
    [newBranchName]
  );

  const filteredLocal = React.useMemo(() => {
    const term = search.toLowerCase();
    if (!term) return localBranches;
    return localBranches.filter((b) => b.toLowerCase().includes(term));
  }, [search, localBranches]);

  const filteredRemote = React.useMemo(() => {
    const term = search.toLowerCase();
    if (!term) return remoteBranches;
    return remoteBranches.filter((b) => b.toLowerCase().includes(term));
  }, [search, remoteBranches]);

  const filteredWorktrees = React.useMemo(() => {
    const term = search.toLowerCase();
    if (!term) return worktreeOptions;
    return worktreeOptions.filter((option) => option.label.toLowerCase().includes(term));
  }, [search, worktreeOptions]);

  const projectRootMatches = React.useMemo(() => {
    if (!projectRootOption) return false;
    const term = search.toLowerCase();
    if (!term) return true;
    return projectRootOption.label.toLowerCase().includes(term)
      || (projectRootLabel ?? '').toLowerCase().includes(term);
  }, [projectRootLabel, projectRootOption, search]);

  const handleCheckout = (branch: string) => {
    if (branch === currentBranch) {
      setIsOpen(false);
      return;
    }
    onCheckout(branch);
    setIsOpen(false);
    setSearch('');
  };

  const handleSelectDirectory = (directory: string) => {
    onSelectDirectory?.(directory);
    setIsOpen(false);
    setSearch('');
  };

  const handleShowCreate = () => {
    setShowCreate(true);
    setTimeout(() => createInputRef.current?.focus(), 50);
  };

  const handleCreate = async () => {
    if (!sanitizedNewBranch || isCreating) return;

    // If multiple remotes, show remote selection first
    if (hasMultipleRemotes) {
      setShowRemoteSelect(true);
      return;
    }

    // Single or no remote - proceed directly
    setIsCreating(true);
    try {
      await onCreate(sanitizedNewBranch, remotes[0]);
      setNewBranchName('');
      setShowCreate(false);
      setIsOpen(false);
    } finally {
      setIsCreating(false);
    }
  };

  const handleSelectRemote = async (remote: GitRemote) => {
    if (!sanitizedNewBranch || isCreating) return;
    setIsCreating(true);
    try {
      await onCreate(sanitizedNewBranch, remote);
      setNewBranchName('');
      setShowCreate(false);
      setShowRemoteSelect(false);
      setIsOpen(false);
    } finally {
      setIsCreating(false);
    }
  };

  const handleBackFromRemoteSelect = () => {
    setShowRemoteSelect(false);
  };

  const handleCancelCreate = () => {
    setNewBranchName('');
    setShowCreate(false);
    setShowRemoteSelect(false);
  };

  React.useEffect(() => {
    if (!isOpen) {
      setSearch('');
      setShowCreate(false);
      setShowRemoteSelect(false);
      setNewBranchName('');
    }
  }, [isOpen]);

  const branchLabel = triggerLabel || currentBranch || t('gitView.branch.detachedHead');
  const resolvedContentAlign = contentAlign ?? (iconOnly ? 'end' : 'start');
  const resolvedWorktreesLabel = worktreesLabel ?? t('chat.chatInput.worktrees');
  const resolvedWorktreeNewLabel = worktreeNewLabel ?? t('chat.chatInput.worktreeNew');
  const resolvedProjectRootLabel = projectRootLabel ?? t('chat.chatInput.projectRoot');

  const defaultTrigger = iconOnly ? (
    <button
      type="button"
      className="flex size-6 items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)] disabled:cursor-not-allowed disabled:opacity-50"
      disabled={disabled}
      aria-label={branchLabel}
    >
      <Icon name="git-branch" className="size-3.5" />
    </button>
  ) : (
    <Button
      variant="ghost"
      size="xs"
      className="h-6 min-w-0 max-w-full justify-start gap-1 px-0 hover:bg-transparent"
      disabled={disabled}
      aria-label={branchLabel}
    >
      <Icon name="git-branch" className="size-3.5 text-primary" />
      <span className="min-w-0 truncate typography-ui-label font-semibold text-left text-foreground">
        {branchLabel}
      </span>
      <Icon name="arrow-down-s" className="size-3 shrink-0 text-muted-foreground" />
    </Button>
  );

  const menuTrigger = (
    <DropdownMenuTrigger asChild disabled={disabled}>
      {trigger ?? defaultTrigger}
    </DropdownMenuTrigger>
  );

  return (
    <DropdownMenu open={isOpen} onOpenChange={(open) => {
      setIsOpen(open);
      onOpenChange?.(open);
    }}>
      {hideTooltip || trigger ? (
        menuTrigger
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            {menuTrigger}
          </TooltipTrigger>
          <TooltipContent sideOffset={8}>
            {iconOnly ? branchLabel : t('gitView.branch.currentBranchTooltip')}
          </TooltipContent>
        </Tooltip>
      )}

      <DropdownMenuContent align={resolvedContentAlign} className="w-72 p-0 max-h-[60vh] flex flex-col">
        <Command className="h-full min-h-0">
          <CommandInput
            placeholder={t('gitView.branch.searchPlaceholder')}
            value={search}
            onValueChange={setSearch}
            onKeyDown={stopDropdownTypeahead}
          />
          <CommandList
            scrollbarClassName="overlay-scrollbar--flush overlay-scrollbar--dense overlay-scrollbar--zero"
            disableHorizontal
          >
            <CommandEmpty>{t('gitView.branch.empty')}</CommandEmpty>

            <CommandGroup>
              {showRemoteSelect ? (
                // Remote selection step
                <div className="px-2 py-1.5">
                  <div className="flex items-center gap-2 mb-2">
                    <button
                      type="button"
                      onClick={handleBackFromRemoteSelect}
                      disabled={isCreating}
                      className="shrink-0 text-muted-foreground hover:text-foreground disabled:opacity-50"
                    >
                      <Icon name="arrow-left" className="size-4" />
                    </button>
                    <span className="typography-meta text-muted-foreground">
                      {t('gitView.branch.pushToPrefix')} <span className="text-foreground font-medium">{sanitizedNewBranch}</span> {t('gitView.branch.pushToSuffix')}
                    </span>
                  </div>
                  <div className="flex flex-col gap-1">
                    {remotes.map((remote) => (
                      <button
                        key={remote.name}
                        type="button"
                        onClick={() => handleSelectRemote(remote)}
                        disabled={isCreating}
                        className="flex flex-col items-start gap-0.5 px-2 py-1.5 rounded-md text-left hover:bg-accent disabled:opacity-50"
                      >
                        <span className="typography-ui-label text-foreground">
                          {isCreating ? (
                            <Icon name="loader-4" className="inline size-3 mr-1.5 animate-spin" />
                          ) : null}
                          {remote.name}
                        </span>
                        <span className="typography-micro text-muted-foreground truncate max-w-full">
                          {remote.pushUrl}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : !showCreate ? (
                <CommandItem onSelect={handleShowCreate}>
                  <Icon name="add" className="size-4" />
                  <span>{t('gitView.branch.create')}</span>
                </CommandItem>
              ) : (
                <div className="flex items-center gap-2 px-2 py-1.5 rounded-lg">
                  <input
                    ref={createInputRef}
                    placeholder={t('gitView.branch.newBranchPlaceholder')}
                    value={newBranchName}
                    onChange={(e) => setNewBranchName(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      stopDropdownTypeahead(e);
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        handleCreate();
                      } else if (e.key === 'Escape') {
                        e.preventDefault();
                        handleCancelCreate();
                      }
                    }}
                    className="flex-1 min-w-0 bg-transparent typography-meta outline-none placeholder:text-muted-foreground"
                  />
                  <button
                    type="button"
                    onClick={handleCreate}
                    disabled={!sanitizedNewBranch || isCreating}
                    className="shrink-0 text-muted-foreground hover:text-foreground disabled:opacity-50"
                  >
                    {isCreating ? (
                      <Icon name="loader-4" className="size-4 animate-spin" />
                    ) : (
                      <Icon name="add" className="size-4" />
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={handleCancelCreate}
                    disabled={isCreating}
                    className="shrink-0 text-muted-foreground hover:text-foreground disabled:opacity-50"
                  >
                    <Icon name="close" className="size-4" />
                  </button>
                </div>
              )}
            </CommandGroup>

            <CommandSeparator />

            <CommandGroup heading={t('gitView.branch.localBranches')}>
              {filteredLocal.map((branch) => (
                <CommandItem
                  key={`local-${branch}`}
                  onSelect={() => handleCheckout(branch)}
                >
                  <span className="flex flex-1 flex-col">
                    <span className="typography-ui-label text-foreground">
                      {branch}
                    </span>
                    {(branchInfo?.[branch]?.ahead || branchInfo?.[branch]?.behind) && (
                      <span className="typography-micro text-muted-foreground">
                        {branchInfo[branch].ahead || 0} ahead ·{' '}
                        {branchInfo[branch].behind || 0} behind
                      </span>
                    )}
                  </span>
                  {currentBranch === branch && (
                    <span className="typography-micro text-primary">{t('gitView.branch.currentBadge')}</span>
                  )}
                </CommandItem>
              ))}
              {filteredLocal.length === 0 && (
                <CommandItem disabled className="justify-center">
                  <span className="typography-meta text-muted-foreground">
                    {t('gitView.branch.noLocalBranches')}
                  </span>
                </CommandItem>
              )}
            </CommandGroup>

            <CommandSeparator />

            <CommandGroup heading={t('gitView.branch.remoteBranches')}>
              {filteredRemote.map((branch) => (
                <CommandItem
                  key={`remote-${branch}`}
                  onSelect={() => handleCheckout(branch)}
                >
                  <span className="typography-ui-label text-foreground">{branch}</span>
                </CommandItem>
              ))}
              {filteredRemote.length === 0 && (
                <CommandItem disabled className="justify-center">
                  <span className="typography-meta text-muted-foreground">
                    {t('gitView.branch.noRemoteBranches')}
                  </span>
                </CommandItem>
              )}
            </CommandGroup>

            {showWorktreeSection ? (
              <>
                <CommandSeparator />
                <CommandGroup>
                  <div className="flex items-center justify-between px-2 py-1.5">
                    <span className="text-muted-foreground typography-meta">{resolvedWorktreesLabel}</span>
                    {onCreateWorktree ? (
                      <button
                        type="button"
                        className="cursor-pointer text-muted-foreground typography-meta hover:text-foreground"
                        onPointerDown={(event) => { event.stopPropagation(); }}
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          setIsOpen(false);
                          onCreateWorktree();
                        }}
                      >
                        {resolvedWorktreeNewLabel}
                      </button>
                    ) : null}
                  </div>
                  {projectRootOption && projectRootMatches ? (
                    <CommandItem onSelect={() => handleSelectDirectory(projectRootOption.value)}>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="typography-micro text-muted-foreground">{resolvedProjectRootLabel}</span>
                        <span className="truncate typography-ui-label text-foreground">{projectRootOption.label}</span>
                      </span>
                      {selectedDirectory === projectRootOption.value ? (
                        <span className="typography-micro text-primary">{t('gitView.branch.currentBadge')}</span>
                      ) : null}
                    </CommandItem>
                  ) : null}
                  {filteredWorktrees.map((option) => (
                    <CommandItem
                      key={`worktree-${option.value}`}
                      onSelect={() => handleSelectDirectory(option.value)}
                    >
                      <span className="truncate typography-ui-label text-foreground">
                        {option.pending ? '⏳ ' : ''}{option.label}
                      </span>
                      {selectedDirectory === option.value ? (
                        <span className="typography-micro text-primary">{t('gitView.branch.currentBadge')}</span>
                      ) : null}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            ) : null}

          </CommandList>
        </Command>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
