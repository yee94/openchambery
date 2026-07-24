import React from 'react';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { Button } from '@/components/ui/button';
import { SettingsSidebarLayout } from '@/components/sections/shared/SettingsSidebarLayout';
import { SettingsSidebarItem } from '@/components/sections/shared/SettingsSidebarItem';
import { SettingsGroup } from '@/components/sections/shared/SettingsGroup';
import { Icon } from "@/components/icon/Icon";
import { cn } from '@/lib/utils';
import { isVSCodeRuntime } from '@/lib/desktop';
import { sessionEvents } from '@/lib/sessionEvents';
import { useI18n } from '@/lib/i18n';
import { PROJECT_COLOR_MAP, PROJECT_ICON_MAP, ProjectIconImage } from '@/lib/projectMeta';

export const ProjectsSidebar: React.FC<{ onItemSelect?: () => void }> = ({ onItemSelect }) => {
  const { t } = useI18n();
  const projects = useProjectsStore((state) => state.projects);
  const activeProjectId = useProjectsStore((state) => state.activeProjectId);
  const selectedId = useUIStore((state) => state.settingsProjectsSelectedId);
  const setSelectedId = useUIStore((state) => state.setSettingsProjectsSelectedId);
  const knownProjectIdsRef = React.useRef<Set<string> | null>(null);
  const pendingAddedProjectIdsRef = React.useRef(new Set<string>());

  const isVSCode = React.useMemo(() => isVSCodeRuntime(), []);

  const handleAddProject = React.useCallback(() => {
    sessionEvents.requestDirectoryDialog();
  }, []);

  React.useEffect(() => {
    const projectIds = new Set(projects.map((project) => project.id));
    const knownProjectIds = knownProjectIdsRef.current;
    if (knownProjectIds) {
      for (const projectId of projectIds) {
        if (!knownProjectIds.has(projectId)) {
          pendingAddedProjectIdsRef.current.add(projectId);
        }
      }
    }
    knownProjectIdsRef.current = projectIds;

    if (activeProjectId && pendingAddedProjectIdsRef.current.delete(activeProjectId)) {
      setSelectedId(activeProjectId);
      return;
    }

    if (projects.length === 0) {
      if (selectedId !== null) {
        setSelectedId(null);
      }
      return;
    }
    if (selectedId && projects.some((p) => p.id === selectedId)) {
      return;
    }
    setSelectedId(projects[0].id);
  }, [activeProjectId, projects, selectedId, setSelectedId]);

  return (
    <SettingsSidebarLayout
      variant="background"
      header={
        <div className="flex min-w-0 items-center justify-between gap-2 px-[var(--oc-settings-row-inset)]">
          <span className="typography-ui-label text-foreground">
            {t('settings.projects.sidebar.total', { count: projects.length })}
          </span>
          {!isVSCode && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7 -my-1 text-muted-foreground"
              onClick={handleAddProject}
              aria-label={t('settings.projects.sidebar.actions.addProject')}
            >
              <Icon name="add" className="size-4" />
            </Button>
          )}
        </div>
      }
    >
      {projects.length > 0 ? <SettingsGroup>
        {projects.map((project) => {
          const selected = project.id === selectedId;
          const iconName = project.icon ? PROJECT_ICON_MAP[project.icon] : null;
          const iconColor = project.color ? PROJECT_COLOR_MAP[project.color] : undefined;
          const fallback = <Icon name={iconName ?? 'folder'} className="h-4 w-4" style={iconColor ? { color: iconColor } : undefined} />;
          const icon = (
            <span
              className={cn('flex size-5 shrink-0 items-center justify-center overflow-hidden', selected ? 'text-foreground' : 'text-muted-foreground')}
            >
              {project.iconImage ? <ProjectIconImage project={project} className="size-full object-contain" fallback={fallback} /> : fallback}
            </span>
          );

          return (
            <SettingsSidebarItem
              key={project.id}
              title={project.path.split(/[\\/]/).filter(Boolean).at(-1) || project.path}
              icon={icon}
              selected={selected}
              onSelect={() => {
                setSelectedId(project.id);
                onItemSelect?.();
              }}
            />
          );
        })}
      </SettingsGroup> : null}
    </SettingsSidebarLayout>
  );
};
