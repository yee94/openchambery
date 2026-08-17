import React from 'react';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useGlobalSessionsStore, resolveGlobalSessionDirectory } from '@/stores/useGlobalSessionsStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useGitAllBranches, useGitStore } from '@/stores/useGitStore';
import { useFileSearchStore } from '@/stores/useFileSearchStore';
import { useDeviceInfo } from '@/lib/device';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { getContextFileOpenFailureMessage, validateContextFileOpen } from '@/lib/contextFileOpenGuard';
import { toast } from '@/components/ui';
import type { Session } from '@/lib/opencode/v2-types';
import { createWorktreeSession } from '@/lib/worktreeSessionCreator';
import { formatShortcutForDisplay, getEffectiveShortcutCombo } from '@/lib/shortcuts';
import { canUseElectronDesktopIPC, invokeDesktop, isDesktopShell, isVSCodeRuntime, isWebRuntime } from '@/lib/desktop';
import { SETTINGS_PAGE_METADATA, type SettingsRuntimeContext } from '@/lib/settings/metadata';
import { scoreByFuzzyQuery } from '@/lib/search/fuzzySearch';
import { truncatePathMiddle } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { sessionEvents } from '@/lib/sessionEvents';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { buildCommandPaletteFileSearchKey, scoreCommandPaletteFiles } from './commandPaletteFilesState';
import { openAndCreateTerminalTab } from '@/lib/terminalTabShortcuts';
import { Kbd } from '@/components/ui/kbd';

type CommandEntry = {
  id: string;
  title: string;
  shortcutId?: string;
  searchText: string;
  onSelect: () => void;
};

type FileHit = { path: string; name: string; relativePath: string };

type CommandPaletteResultProps = {
  title: React.ReactNode;
  description?: React.ReactNode;
  trailing?: React.ReactNode;
};

const CommandPaletteResult: React.FC<CommandPaletteResultProps> = ({ title, description, trailing }) => (
  <>
    <div className="flex min-w-0 flex-1 items-center gap-2.5">
      <span
        className={
          description
            ? 'min-w-0 max-w-[58%] shrink-0 truncate typography-meta font-medium leading-4 text-foreground'
            : 'min-w-0 flex-1 truncate typography-meta font-medium leading-4 text-foreground'
        }
      >
        {title}
      </span>
      {description ? (
        <span className="min-w-0 flex-1 truncate typography-micro leading-4 text-muted-foreground/65">
          {description}
        </span>
      ) : null}
    </div>
    {trailing ? (
      <div className="ml-auto flex shrink-0 items-center pl-2 text-muted-foreground/50">
        {trailing}
      </div>
    ) : null}
  </>
);

const ITEM_CLASS = 'h-8 gap-2 rounded-md px-2.5 py-0 typography-meta';
const GROUP_CLASS =
  'py-0 [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pb-0.5 [&_[cmdk-group-heading]]:pt-1.5 [&_[cmdk-group-heading]]:!text-[12px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:leading-4 [&_[cmdk-group-heading]]:text-muted-foreground/65';

const normalizePath = (value: string): string => {
  if (!value) return '';
  const raw = value.replace(/\\/g, '/');
  const hadUncPrefix = raw.startsWith('//');
  let normalized = raw.replace(/\/+/g, '/');
  if (hadUncPrefix && !normalized.startsWith('//')) normalized = `/${normalized}`;
  const isUnixRoot = normalized === '/';
  const isWindowsDriveRoot = /^[A-Za-z]:\/$/.test(normalized);
  if (!isUnixRoot && !isWindowsDriveRoot) normalized = normalized.replace(/\/+$/, '');
  return normalized;
};

export const CommandPalette: React.FC = () => {
  const { t } = useI18n();

  const isCommandPaletteOpen = useUIStore((s) => s.isCommandPaletteOpen);
  const setCommandPaletteOpen = useUIStore((s) => s.setCommandPaletteOpen);
  const setActiveMainTab = useUIStore((s) => s.setActiveMainTab);
  const setSettingsDialogOpen = useUIStore((s) => s.setSettingsDialogOpen);
  const setSettingsPage = useUIStore((s) => s.setSettingsPage);
  const setSessionSwitcherOpen = useUIStore((s) => s.setSessionSwitcherOpen);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const toggleRightSidebar = useUIStore((s) => s.toggleRightSidebar);
  const toggleBottomTerminal = useUIStore((s) => s.toggleBottomTerminal);
  const openContextOverview = useUIStore((s) => s.openContextOverview);
  const openContextFile = useUIStore((s) => s.openContextFile);
  const shortcutOverrides = useUIStore((s) => s.shortcutOverrides);

  const openNewSessionDraft = useSessionUIStore((s) => s.openNewSessionDraft);
  const setCurrentSession = useSessionUIStore((s) => s.setCurrentSession);

  const activeSessions = useGlobalSessionsStore((s) => s.activeSessions);
  const currentDirectory = useDirectoryStore((s) => s.currentDirectory);
  const activeProject = useProjectsStore((s) => s.getActiveProject());
  const projects = useProjectsStore((s) => s.projects);
  const effectiveDirectory = useEffectiveDirectory();
  const searchFiles = useFileSearchStore((s) => s.searchFiles);
  const { files: filesApi, git: gitApi } = useRuntimeAPIs();
  const ensureGitStatus = useGitStore((s) => s.ensureStatus);
  const { isMobile } = useDeviceInfo();

  const currentRoot = React.useMemo(
    () => (effectiveDirectory ? normalizePath(effectiveDirectory) : null),
    [effectiveDirectory],
  );

  const [query, setQuery] = React.useState('');
  const debouncedQuery = useDebouncedValue(query, 200);
  const trimmedQuery = debouncedQuery.trim();
  const liveTrimmed = query.trim();

  // Clear query on open (not close) so content stays visible through the
  // close animation instead of emptying mid-flight.
  React.useEffect(() => {
    if (isCommandPaletteOpen) setQuery('');
  }, [isCommandPaletteOpen]);

  // Lazy-load git status for every session directory we plan to display so that
  // branch labels become available across all projects, not only the active one.
  // Deferred to idle to keep the first render (and the file-search effect) free
  // from a flood of git store updates.
  React.useEffect(() => {
    if (!isCommandPaletteOpen || !gitApi) return;
    const handle = setTimeout(() => {
      const seen = new Set<string>();
      for (const session of activeSessions) {
        const dir = resolveGlobalSessionDirectory(session);
        if (!dir || seen.has(dir)) continue;
        seen.add(dir);
        void ensureGitStatus(dir, gitApi);
      }
    }, 0);
    return () => clearTimeout(handle);
  }, [isCommandPaletteOpen, activeSessions, gitApi, ensureGitStatus]);

  const close = React.useCallback(() => setCommandPaletteOpen(false), [setCommandPaletteOpen]);
  const run = React.useCallback(
    (fn: () => void | Promise<void>) => () => {
      close();
      void fn();
    },
    [close],
  );

  // ---------------------------------------------------------------------------
  // Commands
  // ---------------------------------------------------------------------------
  const commands = React.useMemo<CommandEntry[]>(() => {
    const list: CommandEntry[] = [
      {
        id: 'new-session',
        title: t('commandPalette.item.newSession'),
        shortcutId: 'new_chat',
        searchText: t('commandPalette.item.newSession'),
        onSelect: run(() => {
          setActiveMainTab('chat');
          setSessionSwitcherOpen(false);
          openNewSessionDraft();
        }),
      },
      {
        id: 'new-worktree',
        title: t('commandPalette.item.newWorktreeDraft'),
        shortcutId: 'new_chat_worktree',
        searchText: t('commandPalette.item.newWorktreeDraft'),
        onSelect: run(() => {
          void createWorktreeSession();
        }),
      },
      {
        id: 'add-project',
        title: t('commandPalette.item.addProject'),
        searchText: t('commandPalette.item.addProject'),
        onSelect: run(() => {
          sessionEvents.requestDirectoryDialog();
        }),
      },
      {
        id: 'toggle-sidebar',
        title: isMobile
          ? t('commandPalette.item.showSessionSwitcher')
          : t('commandPalette.item.toggleSidebar'),
        shortcutId: 'toggle_sidebar',
        searchText: isMobile
          ? t('commandPalette.item.showSessionSwitcher')
          : t('commandPalette.item.toggleSidebar'),
        onSelect: run(() => {
          if (isMobile) {
            const { isSessionSwitcherOpen } = useUIStore.getState();
            setSessionSwitcherOpen(!isSessionSwitcherOpen);
          } else {
            toggleSidebar();
          }
        }),
      },
      {
        id: 'toggle-right-sidebar',
        title: t('commandPalette.item.toggleRightSidebar'),
        shortcutId: 'toggle_right_sidebar',
        searchText: t('commandPalette.item.toggleRightSidebar'),
        onSelect: run(() => toggleRightSidebar()),
      },
      {
        id: 'toggle-terminal',
        title: t('commandPalette.item.toggleTerminal'),
        shortcutId: 'toggle_terminal',
        searchText: t('commandPalette.item.toggleTerminal'),
        onSelect: run(() => toggleBottomTerminal()),
      },
      {
        id: 'new-terminal-tab',
        title: t('commandPalette.item.newTerminalTab'),
        shortcutId: 'open_new_terminal',
        searchText: t('commandPalette.item.newTerminalTab'),
        onSelect: run(() => {
          if (!effectiveDirectory) {
            return;
          }
          openAndCreateTerminalTab(effectiveDirectory);
        }),
      },
      {
        id: 'context-usage',
        title: t('commandPalette.item.showContextUsage'),
        searchText: t('commandPalette.item.showContextUsage'),
        onSelect: run(() => {
          if (currentDirectory) openContextOverview(currentDirectory);
        }),
      },
      {
        id: 'open-settings',
        title: t('commandPalette.item.openSettings'),
        shortcutId: 'open_settings',
        searchText: t('commandPalette.item.openSettings'),
        onSelect: run(() => setSettingsDialogOpen(true)),
      },
    ];
    if (canUseElectronDesktopIPC()) {
      list.splice(1, 0, {
        id: 'new-mini-chat',
        title: t('commandPalette.item.newMiniChat'),
        shortcutId: 'new_mini_chat',
        searchText: t('commandPalette.item.newMiniChat'),
        onSelect: run(() => {
          void invokeDesktop('desktop_open_draft_mini_chat_window', {
            directory: normalizePath(currentDirectory || activeProject?.path || ''),
            projectId: activeProject?.id ?? null,
          }).catch((error) => {
            console.warn('[command-palette] failed to open draft mini chat window', error);
          });
        }),
      });
    }

    return list;
  }, [
    t,
    run,
    isMobile,
    setActiveMainTab,
    setSessionSwitcherOpen,
    openNewSessionDraft,
    toggleSidebar,
    toggleRightSidebar,
    toggleBottomTerminal,
    currentDirectory,
    effectiveDirectory,
    openContextOverview,
    setSettingsDialogOpen,
    activeProject?.id,
    activeProject?.path,
  ]);

  // ---------------------------------------------------------------------------
  // Settings sub-pages (only show when there's a query)
  // ---------------------------------------------------------------------------
  const settingsRuntimeCtx = React.useMemo<SettingsRuntimeContext>(() => {
    const isDesktop = isDesktopShell();
    return { isVSCode: isVSCodeRuntime(), isWeb: !isDesktop && isWebRuntime(), isDesktop, isMobile };
  }, [isMobile]);

  const settingsEntries = React.useMemo<CommandEntry[]>(() => {
    return SETTINGS_PAGE_METADATA
      .filter((p) => p.slug !== 'home')
      .filter((p) => (p.isAvailable ? p.isAvailable(settingsRuntimeCtx) : true))
      .map((page) => {
        const keywords = (page.keywords ?? []).join(' ');
        return {
          id: `settings:${page.slug}`,
          title: page.title,
          searchText: `${page.title} ${page.group} ${keywords}`,
          onSelect: run(() => {
            setSettingsPage(page.slug);
            setSettingsDialogOpen(true);
          }),
        } satisfies CommandEntry;
      });
  }, [settingsRuntimeCtx, run, setSettingsPage, setSettingsDialogOpen]);

  // ---------------------------------------------------------------------------
  // Sessions
  // ---------------------------------------------------------------------------
  const sortedActiveSessions = React.useMemo(() => {
    const getUpdated = (s: Session) =>
      (typeof s.time?.updated === 'number' ? s.time.updated : 0) ||
      (typeof s.time?.created === 'number' ? s.time.created : 0);
    return [...activeSessions].sort((a, b) => getUpdated(b) - getUpdated(a));
  }, [activeSessions]);

  const allBranches = useGitAllBranches();
  const worktreeMetadata = useSessionUIStore((s) => s.worktreeMetadata);

  const branchForSession = React.useCallback(
    (sessionId: string, dir: string | null): string | null => {
      const meta = worktreeMetadata.get(sessionId);
      if (meta?.branch) return meta.branch.trim() || null;
      if (dir) return allBranches.get(dir)?.trim() || null;
      return null;
    },
    [worktreeMetadata, allBranches],
  );

  // ---------------------------------------------------------------------------
  // File search
  // ---------------------------------------------------------------------------
  const [fileResults, setFileResults] = React.useState<FileHit[]>([]);
  const [fileResultsKey, setFileResultsKey] = React.useState('');

  const fileSearchKey = buildCommandPaletteFileSearchKey(currentRoot, trimmedQuery);

  React.useEffect(() => {
    if (!isCommandPaletteOpen) {
      setFileResults([]);
      setFileResultsKey('');
      return;
    }
    if (!fileSearchKey) {
      setFileResults([]);
      setFileResultsKey('');
      return;
    }
    if (!currentRoot) {
      setFileResults([]);
      setFileResultsKey('');
      return;
    }
    let cancelled = false;
    void searchFiles(currentRoot, trimmedQuery, 10, { type: 'file' })
      .then((results) => {
        if (cancelled) return;
        setFileResults(
          results.map((file) => ({
            path: normalizePath(file.path),
            name: file.name,
            relativePath: file.relativePath,
          })),
        );
        setFileResultsKey(fileSearchKey);
      })
      .catch(() => {
        if (!cancelled) {
          setFileResults([]);
          setFileResultsKey(fileSearchKey);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [isCommandPaletteOpen, currentRoot, trimmedQuery, fileSearchKey, searchFiles]);

  // ---------------------------------------------------------------------------
  // Filter visible items
  // ---------------------------------------------------------------------------
  const hasQuery = liveTrimmed.length > 0;

  const scoredCommands = React.useMemo(() => {
    if (!hasQuery) return commands.map((item) => ({ item, score: 0 }));
    return scoreByFuzzyQuery(commands, liveTrimmed, (c) => c.searchText, {
      limit: 7,
      noFuzzy: true,
    });
  }, [commands, liveTrimmed, hasQuery]);

  const scoredSettings = React.useMemo(() => {
    if (!hasQuery) return [];
    return scoreByFuzzyQuery(settingsEntries, liveTrimmed, (c) => c.searchText, {
      limit: 7,
      noFuzzy: true,
    });
  }, [settingsEntries, liveTrimmed, hasQuery]);

  const scoredSessions = React.useMemo(() => {
    if (!hasQuery) return sortedActiveSessions.slice(0, 5).map((item) => ({ item, score: 0 }));
    return scoreByFuzzyQuery(sortedActiveSessions, liveTrimmed, (s) => s.title || '', {
      limit: 7,
      threshold: 0.2,
    });
  }, [sortedActiveSessions, liveTrimmed, hasQuery]);

  const scoredFiles = React.useMemo(() => {
    if (!isCommandPaletteOpen) return [];
    return scoreCommandPaletteFiles(fileResults, trimmedQuery, fileSearchKey, fileResultsKey);
  }, [isCommandPaletteOpen, fileResults, fileResultsKey, fileSearchKey, trimmedQuery]);

  const isFileSearchStale = isCommandPaletteOpen && fileSearchKey.length > 0 && fileResultsKey !== fileSearchKey;

  // ---------------------------------------------------------------------------
  // Projects
  // ---------------------------------------------------------------------------
  const scoredProjects = React.useMemo(() => {
    if (!hasQuery) return [];
    const projectEntries = projects.map((project) => ({
      ...project,
      displayName: project.label || project.path.split('/').pop() || project.path,
      searchText: `${project.label || ''} ${project.path}`,
    }));
    return scoreByFuzzyQuery(projectEntries, liveTrimmed, (p) => p.searchText, {
      limit: 7,
      threshold: 0.4,
    });
  }, [projects, liveTrimmed, hasQuery]);

  const visibleCommands = scoredCommands.map((x) => x.item);
  const visibleSettings = scoredSettings.map((x) => x.item);
  const visibleSessions = scoredSessions.map((x) => x.item);
  const visibleFiles = hasQuery ? scoredFiles.map((x) => x.item) : [];
  const visibleProjects = hasQuery ? scoredProjects.map((x) => x.item) : [];

  const groupOrder = React.useMemo<('commands' | 'settings' | 'sessions' | 'files' | 'projects')[]>(() => {
    if (!hasQuery) return ['commands', 'sessions'];
    const best = (arr: { score: number }[]): number => (arr.length ? arr[0].score : Infinity);
    const groups: { key: 'commands' | 'settings' | 'sessions' | 'files' | 'projects'; score: number }[] = [
      { key: 'commands', score: best(scoredCommands) },
      { key: 'settings', score: best(scoredSettings) },
      { key: 'sessions', score: best(scoredSessions) },
      { key: 'files', score: best(scoredFiles) },
      { key: 'projects', score: best(scoredProjects) },
    ];
    groups.sort((a, b) => a.score - b.score);
    return groups.map((g) => g.key);
  }, [hasQuery, scoredCommands, scoredSettings, scoredSessions, scoredFiles, scoredProjects]);

  const handleOpenSession = React.useCallback(
    (session: Session) => {
      close();
      setCurrentSession(session.id, resolveGlobalSessionDirectory(session));
    },
    [close, setCurrentSession],
  );

  const handleOpenFile = React.useCallback(
    async (filePath: string) => {
      if (!currentRoot) return;
      const validation = await validateContextFileOpen(filesApi, filePath);
      if (!validation.ok) {
        toast.error(getContextFileOpenFailureMessage(validation.reason));
        return;
      }
      openContextFile(currentRoot, filePath);
      close();
    },
    [currentRoot, filesApi, openContextFile, close],
  );

  const handleOpenProject = React.useCallback(
    (projectId: string, projectPath: string) => {
      close();
      openNewSessionDraft({ selectedProjectId: projectId, directoryOverride: projectPath });
    },
    [close, openNewSessionDraft],
  );

  const shortcut = React.useCallback(
    (actionId: string) =>
      formatShortcutForDisplay(getEffectiveShortcutCombo(actionId, shortcutOverrides)),
    [shortcutOverrides],
  );

  return (
    <Dialog open={isCommandPaletteOpen} onOpenChange={setCommandPaletteOpen}>
      <DialogHeader className="sr-only">
        <DialogTitle>{t('commandPalette.title')}</DialogTitle>
        <DialogDescription>{t('commandPalette.description')}</DialogDescription>
      </DialogHeader>
      <DialogContent
        className="fixed left-1/2 top-[12vh] z-50 max-h-[min(32rem,calc(100vh-2rem))] w-[min(40rem,calc(100vw-1.5rem))] max-w-none -translate-x-1/2 translate-y-0 gap-0 overflow-hidden rounded-2xl border border-[var(--interactive-border)]/55 bg-[color:color-mix(in_srgb,var(--surface-elevated)_80%,transparent)] p-0 shadow-2xl backdrop-blur-2xl supports-[backdrop-filter]:bg-[color:color-mix(in_srgb,var(--surface-elevated)_72%,transparent)] sm:top-[14vh] sm:max-h-[min(32rem,calc(100vh-4rem))] sm:w-[min(40rem,calc(100vw-3rem))]"
        containerClassName="block p-0"
        showCloseButton={false}
      >
        <Command
          shouldFilter={false}
          className="max-h-full min-h-0 rounded-[inherit] bg-transparent [&_[cmdk-group]]:px-0 [&_[data-slot=command-input-wrapper]]:px-2.5 [&_[data-slot=command-input-wrapper]]:pt-2.5 [&_[data-slot=command-input-wrapper]]:pb-1.5 [&_[data-slot=command-input-field]]:!bg-transparent"
        >
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder={t('commandPalette.input.placeholder')}
          />
          <CommandList className="px-1.5 pb-2">
            <CommandEmpty className="py-10 text-muted-foreground">
              {t('commandPalette.empty.noResults')}
            </CommandEmpty>

            {groupOrder.map((groupKey) => {
              if (groupKey === 'commands' && visibleCommands.length > 0) {
                return (
                  <CommandGroup key="commands" heading={t('settings.page.commands.title')} className={GROUP_CLASS}>
                    {visibleCommands.map((cmd) => (
                      <CommandItem
                        key={cmd.id}
                        value={cmd.id}
                        onSelect={cmd.onSelect}
                        className={ITEM_CLASS}
                      >
                        <CommandPaletteResult
                          title={cmd.title}
                          trailing={cmd.shortcutId ? (
                            <Kbd className="h-3.5 min-w-0 shrink-0 rounded-full border-0 bg-[color-mix(in_srgb,var(--surface-foreground)_6%,transparent)] px-1.5 font-sans text-[10px] font-medium tracking-tight text-muted-foreground/65 shadow-none">
                              {shortcut(cmd.shortcutId)}
                            </Kbd>
                          ) : undefined}
                        />
                      </CommandItem>
                    ))}
                  </CommandGroup>
                );
              }
              if (groupKey === 'settings' && visibleSettings.length > 0) {
                return (
                  <CommandGroup key="settings" heading={t('settings.view.home.title')} className={GROUP_CLASS}>
                    {visibleSettings.map((cmd) => (
                      <CommandItem
                        key={cmd.id}
                        value={cmd.id}
                        onSelect={cmd.onSelect}
                        className={ITEM_CLASS}
                      >
                        <CommandPaletteResult title={cmd.title} />
                      </CommandItem>
                    ))}
                  </CommandGroup>
                );
              }
              if (groupKey === 'sessions' && visibleSessions.length > 0) {
                return (
                  <CommandGroup key="sessions" heading={t('header.sessions.title')} className={GROUP_CLASS}>
                    {visibleSessions.map((session) => {
                      const title = session.title || t('commandPalette.session.untitled');
                      const dir = resolveGlobalSessionDirectory(session);
                      const branch = branchForSession(session.id, dir);
                      return (
                        <CommandItem
                          key={session.id}
                          value={`session:${session.id}`}
                          onSelect={() => handleOpenSession(session)}
                          className={ITEM_CLASS}
                        >
                          <CommandPaletteResult
                            title={title}
                            trailing={
                              branch ? (
                                <span className="max-w-40 truncate typography-micro leading-none opacity-70">
                                  {branch}
                                </span>
                              ) : undefined
                            }
                          />
                        </CommandItem>
                      );
                    })}
                  </CommandGroup>
                );
              }
              if (groupKey === 'files' && visibleFiles.length > 0) {
                return (
                  <CommandGroup key="files" heading={t('layout.mainTab.files')} className={GROUP_CLASS}>
                    {visibleFiles.map((file) => {
                      const display = truncatePathMiddle(file.relativePath || file.name, {
                        maxLength: 80,
                      });
                      return (
                        <CommandItem
                          key={`file:${file.path}`}
                          value={`file:${file.path}`}
                          onSelect={() => {
                            void handleOpenFile(file.path);
                          }}
                          className={ITEM_CLASS}
                        >
                          <CommandPaletteResult
                            title={file.name}
                            description={display !== file.name ? display : undefined}
                          />
                        </CommandItem>
                      );
                    })}
                  </CommandGroup>
                );
              }
              if (groupKey === 'projects' && visibleProjects.length > 0) {
                return (
                  <CommandGroup key="projects" heading={t('sessions.sidebar.projectsTitle')} className={GROUP_CLASS}>
                    {visibleProjects.map((project) => {
                      const displayName = project.displayName;
                      return (
                        <CommandItem
                          key={`project:${project.id}`}
                          value={`project:${project.id}`}
                          onSelect={() => handleOpenProject(project.id, project.path)}
                          className={ITEM_CLASS}
                        >
                          <CommandPaletteResult title={displayName} />
                        </CommandItem>
                      );
                    })}
                  </CommandGroup>
                );
              }
              return null;
            })}

            {isFileSearchStale ? (
              <div className="px-3 py-2 typography-micro text-muted-foreground/70">
                {t('commandPalette.empty.searchingFiles')}
              </div>
            ) : null}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
};
