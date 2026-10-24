import React from 'react';
import { useEvent } from '@reactuses/core';
import { cn, truncatePathMiddle } from '@/lib/utils';
import { useFileSearchStore } from '@/stores/useFileSearchStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { filterVisibleAgents } from '@/stores/useAgentsStore';
import { AgentAvatar } from './AgentAvatar';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useFilesViewTabsStore } from '@/stores/useFilesViewTabsStore';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useChatSearchDirectory } from '@/hooks/useChatSearchDirectory';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { Icon } from "@/components/icon/Icon";
import { useDirectoryShowHidden } from '@/lib/directoryShowHidden';
import { useFilesViewShowGitignored } from '@/lib/filesViewShowGitignored';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { mergeLiveSessionCatalog, useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { ComposerAutocompleteLayer } from './ComposerAutocompleteLayer';
import {
  composerAutocompleteRowClassName,
} from './composerAutocompleteChrome';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useAllLiveSessions } from '@/sync/sync-context';
import type { Session } from '@/lib/opencode/v2-types';
import {
  buildMentionRows,
  emitComposerAutocompleteRows,
  resetComposerAutocompleteRows,
  type ComposerAutocompleteVisibleRows,
} from '@/lib/composer-autocomplete';
import { useInstalledSkillsQuery } from '@/queries/installedSkillsQueries';
import { highlightAutocompleteQuery } from './autocompleteQueryHighlight';
import {
  getVisibleSessionMentionCandidates,
  mergeAndRankFileMentionPathHits,
  rankRecentFileMentionCandidates,
  resolveFileMentionSearchQuery,
  type FileMentionPathHit,
} from './fileMentionAutocompleteState';
import {
  createMentionTouchSelectionController,
  type MentionTouchSelectionController,
} from './fileMentionTouchSelection';

type FileInfo = FileMentionPathHit;

export type MentionSkillInfo = {
  name: string;
  scope: string;
  source?: string;
  description?: string;
};

export interface FileMentionHandle {
  handleKeyDown: (key: string) => void;
  acceptIndex: (index: number) => void;
}

interface FileMentionAutocompleteProps {
  searchQuery: string;
  onFileSelect: (file: FileInfo) => void;
  onAgentSelect?: (agentName: string) => void;
  onSkillSelect?: (skill: MentionSkillInfo) => void;
  onSessionSelect?: (session: Session) => void;
  onClose: () => void;
  style?: React.CSSProperties;
  onRowsChange?: (rows: ComposerAutocompleteVisibleRows) => void;
}

export const FileMentionAutocomplete = React.forwardRef<FileMentionHandle, FileMentionAutocompleteProps>(({
  searchQuery,
  onFileSelect,
  onAgentSelect,
  onSkillSelect,
  onSessionSelect,
  onClose,
  style,
  onRowsChange,
}, ref) => {
  const { t } = useI18n();
  const currentDirectory = useChatSearchDirectory() ?? '';
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const activeSessions = useGlobalSessionsStore((state) => state.activeSessions);
  const liveSessions = useAllLiveSessions({ enabled: Boolean(onSessionSelect) });
  const activeProjectId = useProjectsStore((state) => state.activeProjectId);
  const projects = useProjectsStore((state) => state.projects);
  const activeProjectPath = React.useMemo(
    () => projects.find((project) => project.id === activeProjectId)?.path ?? null,
    [activeProjectId, projects],
  );
  const projectRoot = React.useMemo(() => {
    const candidate = activeProjectPath || currentDirectory;
    return candidate ? candidate.replace(/\\/g, '/').replace(/\/+$/, '') : null;
  }, [activeProjectPath, currentDirectory]);
  const projectTabs = useFilesViewTabsStore((state) => projectRoot ? state.byRoot[projectRoot] : undefined);
  const agentCatalog = useConfigStore((state) => state.agents);
  const searchFiles = useFileSearchStore((state) => state.searchFiles);
  const debouncedQuery = useDebouncedValue(searchQuery, 180);
  const showHidden = useDirectoryShowHidden();
  const showGitignored = useFilesViewShowGitignored();
  const [pathHits, setPathHits] = React.useState<FileInfo[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [selectedIndex, setSelectedIndex] = React.useState(0);
  const selectedIndexRef = React.useRef(0);
  const previousResultsRef = React.useRef({ query: searchQuery, directory: currentDirectory, ids: [] as string[] });
  const [marqueeWidth, setMarqueeWidth] = React.useState(360);
  const [overflowMap, setOverflowMap] = React.useState<Record<number, boolean>>({});
  const [marqueeDurations, setMarqueeDurations] = React.useState<Record<number, number>>({});
  const itemRefs = React.useRef<(HTMLDivElement | null)[]>([]);
  const labelRefs = React.useRef<(HTMLSpanElement | null)[]>([]);
  const measureRefs = React.useRef<(HTMLSpanElement | null)[]>([]);
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const lastVisibleRowsRef = React.useRef<ComposerAutocompleteVisibleRows | null>(null);
  const touchSelectionControllerRef = React.useRef<MentionTouchSelectionController | null>(null);
  if (!touchSelectionControllerRef.current) {
    touchSelectionControllerRef.current = createMentionTouchSelectionController();
  }
  const isMobile = useUIStore((state) => state.isMobile);
  const normalizedSearchQuery = (searchQuery ?? '').trim();
  const skillsQuery = useInstalledSkillsQuery({ directory: currentDirectory || null });
  const visibleSkills = React.useMemo(
    () => onSkillSelect ? skillsQuery.data ?? [] : [],
    [onSkillSelect, skillsQuery.data],
  );
  const recentFiles = React.useMemo(() => {
    if (!projectRoot || !projectTabs) {
      return [] as FileInfo[];
    }

    const ordered = [
      projectTabs.selectedPath,
      ...projectTabs.openPaths.slice().reverse(),
    ].filter((value): value is string => typeof value === 'string' && value.length > 0);

    const seen = new Set<string>();
    const mapped: FileInfo[] = [];
    for (const filePath of ordered) {
      if (seen.has(filePath)) continue;
      seen.add(filePath);
      const normalizedPath = filePath.replace(/\\/g, '/');
      const name = normalizedPath.split('/').filter(Boolean).pop() || normalizedPath;
      const relativePath = normalizedPath.startsWith(`${projectRoot}/`)
        ? normalizedPath.slice(projectRoot.length + 1)
        : normalizedPath;
      mapped.push({
        name,
        path: normalizedPath,
        relativePath,
        extension: name.includes('.') ? name.split('.').pop()?.toLowerCase() : undefined,
      });
    }

    return rankRecentFileMentionCandidates(mapped, normalizedSearchQuery, { limit: 6 });
  }, [normalizedSearchQuery, projectRoot, projectTabs]);
  const visibleAgents = React.useMemo(
    () => onAgentSelect ? filterVisibleAgents(agentCatalog).filter((agent) => agent.mode !== 'primary') : [],
    [agentCatalog, onAgentSelect],
  );
  const visibleSessions = React.useMemo(() => {
    if (!onSessionSelect) return [];

    // Sidebar rows overlay live directory titles onto the index/global catalog.
    // Mentions must use the same catalog or @search shows a stale title.
    return getVisibleSessionMentionCandidates({
      sessions: mergeLiveSessionCatalog(activeSessions, liveSessions),
      currentSessionId,
      searchQuery: normalizedSearchQuery,
    });
  }, [activeSessions, currentSessionId, liveSessions, normalizedSearchQuery, onSessionSelect]);
  const visibleRecentFiles = recentFiles;
  const visiblePathHits = pathHits;
  const rows = React.useMemo(() => buildMentionRows({
    skills: visibleSkills,
    agents: visibleAgents,
    sessions: visibleSessions,
    recentFiles: visibleRecentFiles,
    pathHits: visiblePathHits,
    searchQuery: normalizedSearchQuery,
    untitledSession: t('chat.fileMentionAutocomplete.untitledSession'),
    sessionBadge: t('chat.fileMentionAutocomplete.sessionType'),
    skillBadge: t('chat.commandAutocomplete.badge.skill'),
  }), [visibleSkills, visibleAgents, visibleSessions, visibleRecentFiles, visiblePathHits, normalizedSearchQuery, t]);

  React.useEffect(() => {
    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node | null;
      if (!target || !containerRef.current) {
        return;
      }
      if (containerRef.current.contains(target)) {
        return;
      }
      onClose();
    };

    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
    };
  }, [onClose]);

  React.useEffect(() => {
    if (!currentDirectory) {
      setPathHits([]);
      return;
    }

    const normalizedQuery = (debouncedQuery ?? '').trim();
    const normalizedQueryLower = resolveFileMentionSearchQuery(normalizedQuery);

    if (!normalizedQueryLower) {
      setPathHits([]);
      return;
    }

    let cancelled = false;
    setLoading(true);

    const searchOptions = {
      includeHidden: showHidden,
      respectGitignore: !showGitignored,
    } as const;

    // Fetch files and directories separately (API is type-scoped), then merge
    // into one similarity-ranked list — no file/folder group-by.
    Promise.all([
      searchFiles(currentDirectory, normalizedQueryLower, 80, {
        ...searchOptions,
        type: 'file',
      }),
      searchFiles(currentDirectory, normalizedQueryLower, 40, {
        ...searchOptions,
        type: 'directory',
      }),
    ])
      .then(([fileHits, directoryHits]) => {
        if (cancelled) {
          return;
        }

        const recentSet = new Set(recentFiles.map((file) => file.path));
        setPathHits(mergeAndRankFileMentionPathHits({
          files: fileHits,
          directories: directoryHits,
          query: normalizedQuery,
          excludePaths: recentSet,
          limit: 20,
        }));
      })
      .catch(() => {
        if (!cancelled) {
          setPathHits([]);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [currentDirectory, debouncedQuery, recentFiles, searchFiles, showHidden, showGitignored]);

  React.useLayoutEffect(() => {
    const previous = previousResultsRef.current;
    const selectedId = previous.ids[selectedIndexRef.current];
    const nextIndex = previous.query === searchQuery && previous.directory === currentDirectory
      ? Math.max(0, rows.findIndex((row) => row.id === selectedId))
      : 0;
    previousResultsRef.current = { query: searchQuery, directory: currentDirectory, ids: rows.map((row) => row.id) };
    selectedIndexRef.current = nextIndex;
    setSelectedIndex(nextIndex);
  }, [rows, searchQuery, currentDirectory]);

  React.useEffect(() => {
    setOverflowMap({});
    setMarqueeDurations({});
  }, [rows]);

  React.useEffect(() => {
    itemRefs.current[selectedIndex]?.scrollIntoView({
      block: 'nearest'
    });
  }, [selectedIndex]);

  React.useEffect(() => {
    let frameId: number | null = null;

    const updateOverflow = () => {
      if (frameId !== null) {
        cancelAnimationFrame(frameId);
      }
      frameId = requestAnimationFrame(() => {
        const next: Record<number, boolean> = {};
        const durations: Record<number, number> = {};
        labelRefs.current.forEach((node, index) => {
          if (!node) {
            return;
          }
          const measureNode = measureRefs.current[index];
          const fullWidth = measureNode?.offsetWidth ?? node.scrollWidth;
          const overflowPx = Math.max(0, fullWidth - node.clientWidth);
          const isOverflowing = overflowPx > 8;
          next[index] = isOverflowing;
          if (isOverflowing) {
            const duration = Math.max(0.6, overflowPx / 110);
            durations[index] = duration;
          }
        });
        setOverflowMap(next);
        setMarqueeDurations(durations);
      });
    };

    updateOverflow();
    window.addEventListener('resize', updateOverflow);

    return () => {
      if (frameId !== null) {
        cancelAnimationFrame(frameId);
      }
      window.removeEventListener('resize', updateOverflow);
    };
  }, [rows]);

  React.useEffect(() => {
    const labelNode = labelRefs.current[selectedIndex];
    if (!labelNode) {
      return;
    }

    const updateWidth = () => {
      const width = labelNode.clientWidth;
      if (width > 0) {
        setMarqueeWidth(width);
      }
    };

    updateWidth();

    if (typeof ResizeObserver === 'undefined') {
      return;
    }

    const observer = new ResizeObserver(updateWidth);
    observer.observe(labelNode);

    return () => {
      observer.disconnect();
    };
  }, [selectedIndex]);

  const handleFileSelect = useEvent((file: FileInfo) => {
    onFileSelect(file);
  });

  const handleAgentPick = useEvent((agentName: string) => {
    onAgentSelect?.(agentName);
  });

  const handleSessionPick = useEvent((session: Session) => {
    onSessionSelect?.(session);
  });

  const handleSkillPick = useEvent((skill: MentionSkillInfo) => {
    onSkillSelect?.(skill);
  });

  const getItemInteractionHandlers = (index: number, select: () => void) => ({
    onMouseDown: (event: React.MouseEvent<HTMLDivElement>) => event.preventDefault(),
    onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.pointerType === 'touch') {
        touchSelectionControllerRef.current?.pointerDown(event.clientX, event.clientY);
      }
    },
    onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.pointerType === 'touch') {
        touchSelectionControllerRef.current?.pointerMove(event.clientX, event.clientY);
      }
    },
    onPointerUp: (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.pointerType !== 'touch') return;
      const selected = touchSelectionControllerRef.current?.pointerUp(select) ?? false;
      if (selected) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
    onPointerCancel: () => touchSelectionControllerRef.current?.pointerCancel(),
    onClick: () => {
      touchSelectionControllerRef.current?.click(select);
    },
    onMouseMove: () => {
      selectedIndexRef.current = index;
      setSelectedIndex(index);
    },
  });

  const acceptMentionIndex = (index: number) => {
    const total = rows.length;
    if (total === 0) return;
    const safeIndex = ((index % total) + total) % total;
    const row = rows[safeIndex];
    if (row.agentName !== undefined) {
      handleAgentPick(row.agentName);
      return;
    }
    if (row.id.startsWith('skill:')) {
      const skill = visibleSkills.find((skill) => row.id === `skill:${skill.name}-${skill.scope}`);
      if (skill) handleSkillPick(skill);
      return;
    }
    if (row.id.startsWith('session:')) {
      const session = visibleSessions.find((session) => row.id === `session:${session.id}`);
      if (session) handleSessionPick(session);
      return;
    }
    const selectedPath = row.id.startsWith('recent:')
      ? visibleRecentFiles.find((file) => row.id === `recent:${file.path}`)
      : visiblePathHits.find((file) => row.id === `file:${file.path}`);
    if (selectedPath) handleFileSelect(selectedPath);
  };

  React.useEffect(() => {
    emitComposerAutocompleteRows(onRowsChange, lastVisibleRowsRef, {
      rows,
      highlightedIndex: selectedIndex,
    });
  }, [
    onRowsChange,
    selectedIndex,
    rows,
  ]);

  const onRowsChangeRef = React.useRef(onRowsChange);
  onRowsChangeRef.current = onRowsChange;
  React.useEffect(() => () => {
    resetComposerAutocompleteRows(onRowsChangeRef.current, lastVisibleRowsRef);
  }, []);

  React.useImperativeHandle(ref, () => ({
    acceptIndex: (index: number) => {
      acceptMentionIndex(index);
    },
    handleKeyDown: (key: string) => {
      if (key === 'Escape') {
        onClose();
        return;
      }

      const total = rows.length;
      if (total === 0) {
        return;
      }

      if (key === 'ArrowDown') {
        selectedIndexRef.current = (selectedIndexRef.current + 1) % total;
        setSelectedIndex(selectedIndexRef.current);
        return;
      }

      if (key === 'ArrowUp') {
        selectedIndexRef.current = (selectedIndexRef.current - 1 + total) % total;
        setSelectedIndex(selectedIndexRef.current);
        return;
      }

      if (key === 'Enter' || key === 'Tab') {
        acceptMentionIndex(selectedIndexRef.current);
      }
    }
  }));

  return (
      <ComposerAutocompleteLayer
        ref={containerRef}
        isMobile={isMobile}
        className="max-w-[640px] max-h-64"
        style={style}
      >
        <ScrollableOverlay preventOverscroll outerClassName="flex-1 min-h-0" className="px-0">
          <div className="py-1">
            {rows.map((row, rowIndex) => {
              const isPath = row.id.startsWith('file:') || row.id.startsWith('recent:');
              const displayTitle = isPath ? truncatePathMiddle(row.title, { maxLength: 60 }) : row.title;
              const isSelected = selectedIndex === rowIndex;
              const isOverflowing = overflowMap[rowIndex] ?? false;
              const marqueeDuration = marqueeDurations[rowIndex] ?? 2.6;

              return (
                <div
                  key={row.id}
                  data-mention-id={row.id}
                  ref={(el) => { itemRefs.current[rowIndex] = el; }}
                  className={cn(
                    "flex items-center gap-2 px-3 py-1.5 cursor-pointer typography-ui-label rounded-lg",
                    isMobile && 'min-h-11',
                    composerAutocompleteRowClassName(isMobile, isSelected),
                    !isMobile && isSelected && 'text-interactive-selection-foreground',
                  )}
                  {...getItemInteractionHandlers(rowIndex, () => acceptMentionIndex(rowIndex))}
                >
                  <span className="flex size-5 shrink-0 items-center justify-center">
                    {row.agentName !== undefined ? (
                      <AgentAvatar name={row.agentName} size={20} />
                    ) : (
                      <Icon name={row.iconName} className="size-3.5 text-current" />
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <span
                      ref={(el) => { labelRefs.current[rowIndex] = el; }}
                      className="relative block min-w-0 overflow-hidden file-mention-marquee-container"
                      style={isSelected ? {
                        ['--file-mention-marquee-width' as string]: `${marqueeWidth}px`,
                        ['--file-mention-marquee-duration' as string]: `${marqueeDuration}s`
                      } : undefined}
                      title={row.title}
                    >
                      <span
                        ref={(el) => { measureRefs.current[rowIndex] = el; }}
                        className="absolute invisible whitespace-nowrap pointer-events-none"
                        aria-hidden
                      >
                        {row.title}
                      </span>
                      {isPath && isOverflowing && isSelected ? (
                        <span className="inline-block whitespace-nowrap file-mention-marquee">
                          {highlightAutocompleteQuery(row.title, normalizedSearchQuery)}
                        </span>
                      ) : (
                        <span className="block truncate">
                          {highlightAutocompleteQuery(displayTitle, normalizedSearchQuery)}
                        </span>
                      )}
                    </span>
                    {row.subtitle ? (
                      <div className={cn('truncate text-muted-foreground', isMobile ? 'typography-micro' : 'typography-meta')}>
                        {highlightAutocompleteQuery(row.subtitle, normalizedSearchQuery)}
                      </div>
                    ) : null}
                  </div>
                </div>
              );
            })}
            {loading && visiblePathHits.length === 0 ? (
              <div className="flex items-center justify-center py-3">
                <Icon name="refresh" className="h-4 w-4 animate-spin text-muted-foreground" />
              </div>
            ) : null}
            {!loading && rows.length === 0 && (
              <div className="px-3 py-2 typography-ui-label text-muted-foreground">
                {t('chat.fileMentionAutocomplete.empty')}
              </div>
            )}
          </div>
        </ScrollableOverlay>
        {!isMobile && (
          <div className="px-3 pt-1 pb-1.5 border-t typography-meta text-muted-foreground">
            {t('chat.autocomplete.keyboardHint')}
          </div>
        )}
    </ComposerAutocompleteLayer>
  );
});
