import React from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Icon } from "@/components/icon/Icon";
import type { IconName } from "@/components/icon/icons";
import { BranchSelector } from './BranchSelector';
import { WorktreeBranchDisplay } from './WorktreeBranchDisplay';
import { SyncActions } from './SyncActions';
import type {
  GitStatus,
  GitIdentityProfile,
  GitRemote,
} from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';

type SyncAction = 'fetch' | 'pull' | 'push' | 'sync' | null;

const IDENTITY_ICON_MAP: Record<string, IconName> = {
  branch: 'git-branch',
  briefcase: 'briefcase',
  house: 'home',
  graduation: 'graduation-cap',
  code: 'code',
  heart: 'heart',
  user: 'user-3',
};

const IDENTITY_COLOR_MAP: Record<string, string> = {
  keyword: 'var(--syntax-keyword)',
  error: 'var(--status-error)',
  string: 'var(--syntax-string)',
  function: 'var(--syntax-function)',
  type: 'var(--syntax-type)',
  success: 'var(--status-success)',
  info: 'var(--status-info)',
  warning: 'var(--status-warning)',
};

function getIdentityColor(token?: string | null) {
  return token ? IDENTITY_COLOR_MAP[token] || 'var(--primary)' : 'var(--primary)';
}

interface IdentityDropdownProps {
  activeProfile: GitIdentityProfile | null;
  identities: GitIdentityProfile[];
  onSelect: (profile: GitIdentityProfile) => void;
  isApplying: boolean;
  iconOnly?: boolean;
}

export const IdentityDropdown: React.FC<IdentityDropdownProps> = ({
  activeProfile,
  identities,
  onSelect,
  isApplying,
  iconOnly = false,
}) => {
  const { t } = useI18n();
  const iconName = IDENTITY_ICON_MAP[activeProfile?.icon ?? 'branch'] ?? 'user-3';

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 min-w-0 max-w-[15rem] justify-start gap-1.5 px-2 py-1 typography-ui-label"
              style={{ color: getIdentityColor(activeProfile?.color) }}
              disabled={isApplying || identities.length === 0}
            >
              <Icon name={isApplying ? 'loader-4' : iconName} className={isApplying ? 'size-4 animate-spin' : 'size-4'} />
              {!iconOnly ? (
                <span className="git-identity-label min-w-0 flex-1 truncate text-left">
                  {activeProfile?.name || t('gitView.header.noIdentity')}
                </span>
              ) : null}
              <Icon name="arrow-down-s" className="size-4 opacity-60" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent sideOffset={8}>{t('gitView.header.identityTooltip')}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-64">
        {identities.map((profile) => (
          <DropdownMenuItem key={profile.id} onSelect={() => onSelect(profile)}>
            <span className="flex min-w-0 flex-col">
              <span className="typography-ui-label text-foreground">{profile.name}</span>
              <span className="typography-meta text-muted-foreground">{profile.userEmail}</span>
            </span>
            {activeProfile?.id === profile.id ? <Icon name="check" className="ml-auto size-4 text-foreground" /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

interface GitHeaderProps {
  status: GitStatus | null;
  localBranches: string[];
  remoteBranches: string[];
  branchInfo: Record<string, { ahead?: number; behind?: number }> | undefined;
  syncAction: SyncAction;
  remotes: GitRemote[];
  onSync: (remote: GitRemote) => void;
  onCheckoutBranch: (branch: string) => void;
  onCreateBranch: (name: string, remote?: GitRemote) => Promise<void>;
  onRenameBranch?: (oldName: string, newName: string) => Promise<void>;
  isWorktreeMode: boolean;
  onOpenHistory?: () => void;
  onOpenGraph?: () => void;
  onOpenStashes?: () => void;
}

export const GitHeader: React.FC<GitHeaderProps> = ({
  status,
  localBranches,
  remoteBranches,
  branchInfo,
  syncAction,
  remotes,
  onSync,
  onCheckoutBranch,
  onCreateBranch,
  onRenameBranch,
  isWorktreeMode,
  onOpenHistory,
  onOpenGraph,
  onOpenStashes,
}) => {
  const { t } = useI18n();
  if (!status) {
    return null;
  }

  return (
    <header className="@container/git-header px-4 bg-transparent">
      <div className="flex h-8 min-w-0 items-center gap-1">
        <div className="min-w-0 flex-1">
          {isWorktreeMode ? (
            <WorktreeBranchDisplay
              currentBranch={status.current}
              onRename={onRenameBranch}
            />
          ) : (
            <BranchSelector
              currentBranch={status.current}
              localBranches={localBranches}
              remoteBranches={remoteBranches}
              branchInfo={branchInfo}
              onCheckout={onCheckoutBranch}
              onCreate={onCreateBranch}
              remotes={remotes}
            />
          )}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <SyncActions
            syncAction={syncAction}
            remotes={remotes}
            onSync={onSync}
            disabled={!status}
            aheadCount={status.ahead}
            behindCount={status.behind}
            trackingRemoteName={status.tracking?.split('/')[0]}
            hasUncommittedChanges={(status.files?.length ?? 0) > 0}
          />
          {onOpenHistory || onOpenGraph || onOpenStashes ? (
            <DropdownMenu>
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="xs"
                      className="h-6 w-fit shrink-0 px-1 text-muted-foreground hover:text-foreground"
                      aria-label={t('gitView.header.repositoryViews')}
                    >
                      <Icon name="git-repository" className="size-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent sideOffset={8}>{t('gitView.header.repositoryViews')}</TooltipContent>
              </Tooltip>
              <DropdownMenuContent align="end">
                {onOpenHistory ? (
                  <DropdownMenuItem onSelect={onOpenHistory}>
                    <Icon name="history" className="size-4" />
                    {t('gitView.history.title')}
                  </DropdownMenuItem>
                ) : null}
                {onOpenGraph ? (
                  <DropdownMenuItem onSelect={onOpenGraph}>
                    <Icon name="git-merge" className="size-4" />
                    {t('gitView.graph.title')}
                  </DropdownMenuItem>
                ) : null}
                {onOpenStashes ? (
                  <DropdownMenuItem onSelect={onOpenStashes}>
                    <Icon name="archive-stack" className="size-4" />
                    {t('gitView.stashes.title')}
                  </DropdownMenuItem>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      </div>
    </header>
  );
};
