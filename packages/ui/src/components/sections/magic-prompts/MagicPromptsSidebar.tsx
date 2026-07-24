import React from 'react';
import { useMagicPromptsStore } from '@/stores/useMagicPromptsStore';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { SettingsGroup } from '@/components/sections/shared/SettingsGroup';

interface MagicPromptsSidebarProps {
  onItemSelect?: () => void;
}

export const MagicPromptsSidebar: React.FC<MagicPromptsSidebarProps> = ({ onItemSelect }) => {
  const { t } = useI18n();
  const selectedPromptId = useMagicPromptsStore((state) => state.selectedPromptId);
  const setSelectedPromptId = useMagicPromptsStore((state) => state.setSelectedPromptId);

  const grouped = React.useMemo(() => {
    return [
      {
        groupKey: 'settings.magicPrompts.sidebar.group.git',
        items: [
          { id: 'git.commit.generate', titleKey: 'settings.magicPrompts.sidebar.item.gitCommitGenerate' },
          { id: 'git.pr.generate', titleKey: 'settings.magicPrompts.sidebar.item.gitPrGenerate' },
          { id: 'git.conflict.resolve', titleKey: 'settings.magicPrompts.sidebar.item.gitConflictResolve' },
          { id: 'git.integrate.cherrypick.resolve', titleKey: 'settings.magicPrompts.sidebar.item.gitCherrypickConflictResolve' },
        ],
      },
      {
        groupKey: 'settings.magicPrompts.sidebar.group.github',
        items: [
          { id: 'github.pr.review', titleKey: 'settings.magicPrompts.sidebar.item.githubPrReview' },
          { id: 'github.issue.review', titleKey: 'settings.magicPrompts.sidebar.item.githubIssueReview' },
          { id: 'github.pr.checks.review', titleKey: 'settings.magicPrompts.sidebar.item.githubPrFailedChecksReview' },
          { id: 'github.pr.comments.review', titleKey: 'settings.magicPrompts.sidebar.item.githubPrCommentsReview' },
          { id: 'github.pr.comment.single', titleKey: 'settings.magicPrompts.sidebar.item.githubSinglePrCommentReview' },
        ],
      },
      {
        groupKey: 'settings.magicPrompts.sidebar.group.planning',
        items: [
          { id: 'plan.todo', titleKey: 'settings.magicPrompts.sidebar.item.planTodo' },
          { id: 'plan.improve', titleKey: 'settings.magicPrompts.sidebar.item.planImprove' },
          { id: 'plan.implement', titleKey: 'settings.magicPrompts.sidebar.item.planImplement' },
        ],
      },
      {
        groupKey: 'settings.magicPrompts.sidebar.group.session',
        items: [
          { id: 'session.explore', titleKey: 'settings.magicPrompts.sidebar.item.sessionExplore' },
          { id: 'session.summary', titleKey: 'settings.magicPrompts.sidebar.item.sessionSummary' },
          { id: 'session.review', titleKey: 'settings.magicPrompts.sidebar.item.sessionWorkspaceReview' },
          { id: 'session.plan', titleKey: 'settings.magicPrompts.sidebar.item.sessionFeaturePlan' },
          { id: 'session.craftGoal', titleKey: 'settings.magicPrompts.sidebar.item.sessionCraftGoal' },
          { id: 'session.catchup', titleKey: 'settings.magicPrompts.sidebar.item.sessionCatchUp' },
          { id: 'session.debug', titleKey: 'settings.magicPrompts.sidebar.item.sessionDebug' },
          { id: 'session.weigh', titleKey: 'settings.magicPrompts.sidebar.item.sessionWeigh' },
          { id: 'session.fusion', titleKey: 'settings.magicPrompts.sidebar.item.sessionFusion' },
        ],
      },
    ] as const;
  }, []);

  return (
    <div className="oc-settings-page-content h-full overflow-y-auto bg-background p-3">
      <div className="flex flex-col justify-center gap-1 px-2">
        <span className="typography-ui-label text-foreground">
          {t('settings.magicPrompts.sidebar.title')}
        </span>
        <span className="typography-meta text-muted-foreground">
          {t('settings.magicPrompts.sidebar.description')}
        </span>
      </div>

      {grouped.map((group) => (
          <SettingsGroup key={group.groupKey} label={t(group.groupKey)}>
            {group.items.map((item) => {
              const selected = selectedPromptId === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    setSelectedPromptId(item.id);
                    onItemSelect?.();
                  }}
                  className={cn(
                    'oc-settings-group-row flex w-full items-center text-left transition-colors',
                    selected ? 'bg-interactive-selection text-foreground' : 'text-foreground hover:bg-interactive-hover'
                  )}
                >
                  <span className="typography-ui-label truncate font-normal">{t(item.titleKey)}</span>
                </button>
              );
            })}
          </SettingsGroup>
        ))}
    </div>
  );
};
