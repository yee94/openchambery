import React from 'react';
import { useEvent, useTimeoutFn } from '@reactuses/core';
import { toast } from 'sonner';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { AgentAvatar } from '@/components/chat/AgentAvatar';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { useGitStore, useGitStatus } from '@/stores/useGitStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { normalizePath } from '@/lib/pathNormalization';
import { resolveProjectForSessionDirectory } from '@/lib/projectResolution';
import { copyTextToClipboard } from '@/lib/clipboard';
import { useWorkStatusSubagents } from './useWorkStatusSubagents';

type Props = {
  sessionId: string | null;
  directory: string | null;
};

const rowClassName = 'flex w-full min-w-0 items-center justify-start gap-2 text-left text-[13px] font-normal leading-5 tracking-normal text-muted-foreground';
const iconClassName = 'size-3.5 shrink-0';
const revealCopyClassName = 'oc-work-status-action pointer-events-none shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/copy:pointer-events-auto group-hover/copy:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100';
const basename = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() || path;

export const WorkStatusCompact: React.FC<Props> = ({ sessionId, directory }) => {
  const { t } = useI18n();
  const { git } = useRuntimeAPIs();
  const ensureStatus = useGitStore((state) => state.ensureStatus);
  const gitStatus = useGitStatus(directory);
  const projects = useProjectsStore((state) => state.projects);
  const availableWorktrees = useSessionUIStore((state) => state.availableWorktreesByProject);
  const sessionWorktree = useSessionUIStore((state) => sessionId ? state.worktreeMetadata.get(sessionId) : undefined);
  const { project, worktree } = React.useMemo(() => {
    const path = normalizePath(directory);
    const belongsToDirectory = (root: string) => {
      const normalized = normalizePath(root);
      return Boolean(path && normalized && (path === normalized || path.startsWith(`${normalized}/`)));
    };
    const attached = sessionWorktree && belongsToDirectory(sessionWorktree.path) ? sessionWorktree : undefined;
    const project = resolveProjectForSessionDirectory(projects, availableWorktrees, attached?.projectDirectory || directory);
    const candidates = project ? availableWorktrees.get(project.path) : undefined;
    const worktree = attached ?? candidates?.filter((entry) => belongsToDirectory(entry.path))
      .sort((a, b) => b.path.length - a.path.length)[0];
    return { project, worktree };
  }, [availableWorktrees, directory, projects, sessionWorktree]);
  const projectPath = project?.path || worktree?.projectDirectory || directory;
  const projectLabel = project?.label?.trim() || (projectPath ? basename(projectPath) : null);
  const worktreeLabel = worktree && normalizePath(worktree.path) !== normalizePath(projectPath)
    ? worktree.name?.trim() || basename(worktree.path)
    : null;
  const subagents = useWorkStatusSubagents(sessionId, directory);
  const subagentGroups = [
    { phase: 'working', labelKey: 'chat.workStatus.subagent.workingCount', items: subagents.filter((agent) => agent.phase === 'working') },
    { phase: 'done', labelKey: 'chat.workStatus.subagent.doneCount', items: subagents.filter((agent) => agent.phase === 'done') },
  ] as const;
  const visibleSubagents = subagents.slice(0, 3);
  const [subagentsExpanded, setSubagentsExpanded] = React.useState(false);
  const subagentsListId = React.useId();
  const setRightSidebarOpen = useUIStore((state) => state.setRightSidebarOpen);
  const openContextPanelTab = useUIStore((state) => state.openContextPanelTab);
  const setRightSidebarTab = useUIStore((state) => state.setRightSidebarTab);
  const [copiedKey, setCopiedKey] = React.useState<string | null>(null);
  const [, resetCopyFeedback] = useTimeoutFn(() => setCopiedKey(null), 1500, { immediate: false });
  const copyText = useEvent(async (key: string, text: string) => {
    try {
      const result = await copyTextToClipboard(text);
      if (!result.ok) throw new Error(result.error);
      setCopiedKey(key);
      resetCopyFeedback();
    } catch {
      toast.error(t('gitView.toast.copyFailed'));
    }
  });

  React.useEffect(() => {
    if (!directory || !git) return undefined;
    void ensureStatus(directory, git);
    return undefined;
  }, [directory, ensureStatus, git]);

  const branch = gitStatus?.current || null;
  const changed = worktree?.worktreeStatus === 'pending' ? 0 : gitStatus?.files.length ?? 0;
  let additions = 0;
  let deletions = 0;
  if (gitStatus?.diffStats) {
    for (const entry of Object.values(gitStatus.diffStats)) {
      additions += entry?.insertions ?? 0;
      deletions += entry?.deletions ?? 0;
    }
  }

  const branchCopyKey = branch ? `branch:${branch}` : '';
  const worktreeCopyKey = worktree?.path ? `worktree:${worktree.path}` : '';
  const isBranchCopied = Boolean(branchCopyKey && copiedKey === branchCopyKey);
  const isPathCopied = Boolean(worktreeCopyKey && copiedKey === worktreeCopyKey);
  const copyBranch = useEvent(() => {
    if (!branch) return;
    void copyText(branchCopyKey, branch);
  });
  const copyWorktreePath = useEvent(() => {
    const path = worktree?.path;
    if (!path) return;
    void copyText(worktreeCopyKey, path);
  });
  const openGit = useEvent(() => {
    setRightSidebarTab('git');
    setRightSidebarOpen(true);
  });

  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      {projectLabel ? (
        <div className={`${rowClassName} h-8 px-2`} title={`${t('chat.workStatus.section.project')}: ${projectPath}`}>
          <Icon name="folder" weight="medium" className={iconClassName} />
          <span className="min-w-0 truncate">{projectLabel}</span>
        </div>
      ) : null}
      {branch ? (
        <div className={`${rowClassName} group/copy h-8 px-2`} title={`${t('gitView.branch.currentBranchTooltip')}: ${branch}`}>
          <Icon name="git-branch" weight="medium" className={iconClassName} />
          <span className="min-w-0 truncate">{branch}</span>
          <Button
            variant="ghost"
            size="xs"
            className={revealCopyClassName}
            aria-label={t('chat.workStatus.action.copyBranch')}
            title={t(isBranchCopied ? 'contextSidebar.actions.copied' : 'chat.workStatus.action.copyBranch')}
            onClick={copyBranch}
          >
            <Icon name={isBranchCopied ? 'check' : 'file-copy'} className={iconClassName} />
          </Button>
        </div>
      ) : null}

      {worktreeLabel ? (
        <div className={`${rowClassName} group/copy h-8 px-2`} title={`${t('sessions.sidebar.sessionDialogs.worktree.label')}: ${worktree?.path}`}>
          <Icon name="node-tree" weight="medium" className={iconClassName} />
          <span className="min-w-0 truncate">{worktreeLabel}</span>
          <Button
            variant="ghost"
            size="xs"
            className={revealCopyClassName}
            aria-label={t('agentManager.detail.actions.copyWorktreePath')}
            title={t(isPathCopied ? 'contextSidebar.actions.copied' : 'agentManager.detail.actions.copyWorktreePath')}
            onClick={copyWorktreePath}
          >
            <Icon name={isPathCopied ? 'check' : 'file-copy'} className={iconClassName} />
          </Button>
        </div>
      ) : null}

      {changed > 0 ? (
        <Button
          variant="ghost"
          size="sm"
          className={`oc-work-status-action ${rowClassName}`}
          title={t(changed === 1 ? 'chat.workStatus.git.changedFileSingle' : 'chat.workStatus.git.changedFilePlural', { count: changed })}
          aria-label={t('chat.workStatus.action.openGit')}
          onClick={openGit}
        >
          <Icon name="changes" weight="medium" className={iconClassName} />
          <span className="min-w-0 truncate">{t('chat.workStatus.compact.changes')}</span>
          {additions > 0 || deletions > 0 ? (
            <span className="ml-auto flex shrink-0 gap-1.5 text-[12px] tabular-nums">
              <span className="text-[var(--status-success)]">{`+${additions}`}</span>
              <span className="text-[var(--status-error)]">{`−${deletions}`}</span>
            </span>
          ) : <span className="ml-auto tabular-nums">{changed}</span>}
        </Button>
      ) : null}

      {subagents.length > 0 ? (
        <div role="group" aria-label={t('chat.workStatus.section.subagents')} className="flex min-w-0 flex-col">
          <Button
            type="button"
            variant="ghost"
            size="sm"
             className={`oc-work-status-action ${rowClassName} gap-1.5`}
            aria-expanded={subagentsExpanded}
            aria-controls={subagentsListId}
            onClick={() => setSubagentsExpanded((expanded) => !expanded)}
          >
            <span aria-hidden="true" className="inline-flex shrink-0 items-center">
              {visibleSubagents.map((subagent, index) => {
                const label = subagent.label.trim() || t('chat.workStatus.subagent.untitled');
                return (
                  <AgentAvatar
                    key={subagent.key}
                    name={subagent.seed}
                    label={label}
                    size={14}
                    className={`relative bg-background ring-2 ring-background ${index > 0 ? '-ml-1' : ''}`}
                  />
                );
              })}
            </span>
            <span className="flex min-w-0 flex-1 items-center gap-x-1 whitespace-nowrap text-left text-[11px] leading-5 tabular-nums">
              <span>{t(subagentGroups[0].labelKey, { count: subagentGroups[0].items.length })}</span>
              <span aria-hidden="true">·</span>
              <span>{t(subagentGroups[1].labelKey, { count: subagentGroups[1].items.length })}</span>
            </span>
            <Icon
              name={subagentsExpanded ? 'arrow-down-s' : 'arrow-right-s'}
              className="size-3.5 shrink-0 text-muted-foreground opacity-70"
            />
          </Button>
          <div id={subagentsListId} hidden={!subagentsExpanded} className={subagentsExpanded ? 'mt-1 mb-1 flex min-w-0 flex-col gap-1' : 'hidden'}>
            {subagentsExpanded ? subagentGroups.filter((group) => group.items.length > 0).map((group) => (
              <section key={group.phase} aria-label={t(group.labelKey, { count: group.items.length })} className="flex min-w-0 flex-col gap-1 [&+section]:mt-2">
                <div className="px-2 py-1 text-[11px] leading-4 text-muted-foreground/70">
                  {t(group.labelKey, { count: group.items.length })}
                </div>
                {group.items.map((subagent) => {
                const label = subagent.label.trim() || t('chat.workStatus.subagent.untitled');
                return (
                  <Button
                    key={subagent.key}
                    variant="ghost"
                    size="sm"
                    disabled={!subagent.sessionID || !directory}
                    className="oc-work-status-action flex w-full min-w-0 items-center justify-start gap-2 text-left text-[12px] font-normal leading-5 text-muted-foreground"
                    onClick={() => {
                      if (!subagent.sessionID || !directory) return;
                      openContextPanelTab(directory, {
                        mode: 'chat',
                        dedupeKey: `session:${subagent.sessionID}`,
                        label,
                        readOnly: true,
                      });
                    }}
                  >
                    <AgentAvatar name={subagent.seed} label={label} size={14} />
                    <span className="min-w-0 flex-1 truncate" title={label}>{label}</span>
                  </Button>
                );
                })}
              </section>
            )) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
};
