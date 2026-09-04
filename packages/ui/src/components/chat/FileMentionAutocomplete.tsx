import React from 'react';
import { useEvent } from '@reactuses/core';
import { cn, truncatePathMiddle } from '@/lib/utils';
import { useFileSearchStore } from '@/stores/useFileSearchStore';
import { useConfigStore } from '@/stores/useConfigStore';
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
import { useMobileAutocompleteMaxHeight } from './useMobileAutocompleteMaxHeight';
import {
  composerAutocompleteRowClassName,
  composerAutocompleteSurfaceClassName,
} from './composerAutocompleteChrome';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import type { Session } from '@opencode-ai/sdk/v2';
import {
  buildMentionRows,
  emitComposerAutocompleteRows,
  resetComposerAutocompleteRows,
  resolveFileMentionIconName,
  type ComposerAutocompleteVisibleRows,
} from '@/lib/composer-autocomplete';
import {
  getVisibleSessionMentionCandidates,
  mergeAndRankFileMentionPathHits,
  rankAgentMentionCandidates,
  rankRecentFileMentionCandidates,
  resolveFileMentionSearchQuery,
  type FileMentionPathHit,
} from './fileMentionAutocompleteState';
import {
  createMentionTouchSelectionController,
  type MentionTouchSelectionController,
} from './fileMentionTouchSelection';

type FileInfo = FileMentionPathHit;
type AgentInfo = {
  name: string;
  description?: string;
  mode?: string | null;
};

export interface FileMentionHandle {
  handleKeyDown: (key: string) => void;
  acceptIndex: (index: number) => void;
}

interface FileMentionAutocompleteProps {
  searchQuery: string;
  onFileSelect: (file: FileInfo) => void;
  onAgentSelect?: (agentName: string) => void;
  onSessionSelect?: (session: Session) => void;
  onClose: () => void;
  style?: React.CSSProperties;
  onRowsChange?: (rows: ComposerAutocompleteVisibleRows) => void;
}

export const FileMentionAutocomplete = React.forwardRef<FileMentionHandle, FileMentionAutocompleteProps>(({
  searchQuery,
  onFileSelect,
  onAgentSelect,
  onSessionSelect,
  onClose,
  style,
  onRowsChange,
}, ref) => {
  const { t } = useI18n();
  const currentDirectory = useChatSearchDirectory() ?? '';
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const activeSessions = useGlobalSessionsStore((state) => state.activeSessions);
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
  const getVisibleAgents = useConfigStore((state) => state.getVisibleAgents);
  const searchFiles = useFileSearchStore((state) => state.searchFiles);
  const debouncedQuery = useDebouncedValue(searchQuery, 180);
  const showHidden = useDirectoryShowHidden();
  const showGitignored = useFilesViewShowGitignored();
  const [pathHits, setPathHits] = React.useState<FileInfo[]>([]);
  const [agents, setAgents] = React.useState<AgentInfo[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [selectedIndex, setSelectedIndex] = React.useState(0);
  const selectedIndexRef = React.useRef(0);
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
  const mobileMaxHeight = useMobileAutocompleteMaxHeight(containerRef, isMobile);
  const normalizedSearchQuery = (searchQuery ?? '').trim();
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
    () => normalizedSearchQuery.length > 0 ? agents : agents.slice(0, 2),
    [agents, normalizedSearchQuery.length],
  );
  const visibleSessions = React.useMemo(() => {
    if (!onSessionSelect) return [];

    return getVisibleSessionMentionCandidates({
      sessions: activeSessions,
      currentSessionId,
      searchQuery: normalizedSearchQuery,
    });
  }, [activeSessions, currentSessionId, normalizedSearchQuery, onSessionSelect]);
  const visibleRecentFiles = recentFiles;
  const visiblePathHits = pathHits;

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

  React.useEffect(() => {
    const visibleAgents = getVisibleAgents();
    const filtered = visibleAgents
      .filter((agent) => agent.mode && agent.mode !== 'primary')
      .map((agent) => ({
        name: agent.name,
        description: agent.description,
        mode: agent.mode,
      }));
    setAgents(rankAgentMentionCandidates(filtered, searchQuery ?? ''));
  }, [getVisibleAgents, searchQuery]);

  React.useEffect(() => {
    setSelectedIndex(0);
    setOverflowMap({});
    setMarqueeDurations({});
  }, [visiblePathHits, visibleRecentFiles.length, visibleAgents.length, visibleSessions.length]);

  React.useEffect(() => {
    selectedIndexRef.current = selectedIndex;
  }, [selectedIndex]);

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
  }, [visiblePathHits, visibleRecentFiles]);

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
    onMouseMove: () => setSelectedIndex(index),
  });

  const acceptMentionIndex = (index: number) => {
    const total = visibleAgents.length + visibleSessions.length + visibleRecentFiles.length + visiblePathHits.length;
    if (total === 0) return;
    const safeIndex = ((index % total) + total) % total;
    if (safeIndex < visibleAgents.length) {
      const agent = visibleAgents[safeIndex];
      if (agent) handleAgentPick(agent.name);
      return;
    }
    const sessionIndex = safeIndex - visibleAgents.length;
    if (sessionIndex < visibleSessions.length) {
      const session = visibleSessions[sessionIndex];
      if (session) handleSessionPick(session);
      return;
    }
    const pathIndex = sessionIndex - visibleSessions.length;
    const selectedPath = pathIndex < visibleRecentFiles.length
      ? visibleRecentFiles[pathIndex]
      : visiblePathHits[pathIndex - visibleRecentFiles.length];
    if (selectedPath) handleFileSelect(selectedPath);
  };

  React.useEffect(() => {
    emitComposerAutocompleteRows(onRowsChange, lastVisibleRowsRef, {
      rows: buildMentionRows({
        agents: visibleAgents,
        sessions: visibleSessions,
        recentFiles: visibleRecentFiles,
        pathHits: visiblePathHits,
        untitledSession: t('chat.fileMentionAutocomplete.untitledSession'),
        sessionBadge: t('chat.fileMentionAutocomplete.sessionType'),
      }),
      highlightedIndex: selectedIndex,
    });
  }, [
    onRowsChange,
    selectedIndex,
    t,
    visibleAgents,
    visiblePathHits,
    visibleRecentFiles,
    visibleSessions,
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

      const total = visibleAgents.length + visibleSessions.length + visibleRecentFiles.length + visiblePathHits.length;
      if (total === 0) {
        return;
      }

      if (key === 'ArrowDown') {
        setSelectedIndex((prev) => (prev + 1) % total);
        return;
      }

      if (key === 'ArrowUp') {
        setSelectedIndex((prev) => (prev - 1 + total) % total);
        return;
      }

      if (key === 'Enter' || key === 'Tab') {
        acceptMentionIndex(selectedIndexRef.current);
      }
    }
  }), [visiblePathHits, visibleRecentFiles, visibleAgents, visibleSessions, onClose, handleFileSelect, handleAgentPick, handleSessionPick]);

  const getPathIcon = (file: FileInfo) => (
    <Icon name={resolveFileMentionIconName(file)} className="h-3.5 w-3.5 text-current" />
  );

  return (
      <div
        ref={containerRef}
        className={composerAutocompleteSurfaceClassName(isMobile, 'max-w-[640px] max-h-64')}
        style={mobileMaxHeight !== undefined ? { ...style, maxHeight: mobileMaxHeight } : style}
      >
        <ScrollableOverlay preventOverscroll outerClassName="flex-1 min-h-0" className="px-0">
          <div className="pb-2">
            {visibleAgents.length > 0 && (
              <div className="px-3 pb-1 pt-2 typography-meta font-medium text-muted-foreground">
                {t('chat.fileMentionAutocomplete.groups.agents')}
              </div>
            )}
            {visibleAgents.map((agent, index) => {
              const isSelected = selectedIndex === index;
              return (
                <div
                  key={`agent-${agent.name}`}
                  ref={(el) => { itemRefs.current[index] = el; }}
                  className={cn(
                    'flex items-start gap-2 px-3 py-1.5 cursor-pointer typography-ui-label rounded-lg',
                    isMobile && 'min-h-11',
                    composerAutocompleteRowClassName(isMobile, isSelected),
                    !isMobile && isSelected && 'text-interactive-selection-foreground',
                  )}
                  {...getItemInteractionHandlers(index, () => handleAgentPick(agent.name))}
                >
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold truncate">@{agent.name}</div>
                    {agent.description && !isMobile ? (
                      <div className="typography-meta text-muted-foreground truncate">{agent.description}</div>
                    ) : null}
                  </div>
                </div>
              );
            })}
            {visibleAgents.length === 2 && normalizedSearchQuery.length === 0 && agents.length > 2 && (
              <div className="px-3 py-1 typography-meta text-muted-foreground">
                {t('chat.fileMentionAutocomplete.searchMoreAgents')}
              </div>
            )}
            {visibleSessions.length > 0 && (
              <div className="px-3 pb-1 pt-2 typography-meta font-medium text-muted-foreground">
                {t('chat.fileMentionAutocomplete.groups.sessions')}
              </div>
            )}
            {visibleSessions.map((session, index) => {
              const rowIndex = visibleAgents.length + index;
              const isSelected = selectedIndex === rowIndex;
              return (
                <div
                  key={`session-${session.id}`}
                  ref={(el) => { itemRefs.current[rowIndex] = el; }}
                  className={cn(
                    'flex items-center gap-2 px-3 py-1.5 cursor-pointer typography-ui-label rounded-lg',
                    isMobile && 'min-h-11',
                    composerAutocompleteRowClassName(isMobile, isSelected),
                    !isMobile && isSelected && 'text-interactive-selection-foreground',
                  )}
                  {...getItemInteractionHandlers(rowIndex, () => handleSessionPick(session))}
                >
                  <Icon name="chat-thread" className="h-4 w-4 flex-shrink-0 text-[var(--primary-base)]" />
                  <span
                    className="min-w-0 flex-1 truncate"
                    title={session.title || t('chat.fileMentionAutocomplete.untitledSession')}
                  >
                    {session.title || t('chat.fileMentionAutocomplete.untitledSession')}
                  </span>
                  {!isMobile ? (
                    <span className="flex-shrink-0 typography-meta text-muted-foreground">
                      {t('chat.fileMentionAutocomplete.sessionType')}
                    </span>
                  ) : null}
                </div>
              );
            })}
            {visibleRecentFiles.length > 0 && (
              <div className="px-3 pb-1 pt-2 typography-meta font-medium text-muted-foreground">
                {t('chat.fileMentionAutocomplete.groups.recentFiles')}
              </div>
            )}
            {visibleRecentFiles.map((file, index) => {
              const rowIndex = visibleAgents.length + visibleSessions.length + index;
              const relativePath = file.relativePath || file.name;
              const displayPath = truncatePathMiddle(relativePath, { maxLength: 60 });
              const isSelected = selectedIndex === rowIndex;
              const isOverflowing = overflowMap[rowIndex] ?? false;
              const marqueeDuration = marqueeDurations[rowIndex] ?? 2.6;

              return (
                <div
                  key={`recent-${file.path}`}
                  ref={(el) => { itemRefs.current[rowIndex] = el; }}
                  className={cn(
                    "flex items-center gap-2 px-3 py-1.5 cursor-pointer typography-ui-label rounded-lg",
                    isMobile && 'min-h-11',
                    composerAutocompleteRowClassName(isMobile, isSelected),
                    !isMobile && isSelected && 'text-interactive-selection-foreground',
                  )}
                  {...getItemInteractionHandlers(rowIndex, () => handleFileSelect(file))}
                >
                  {getPathIcon(file)}
                  <span
                    ref={(el) => { labelRefs.current[rowIndex] = el; }}
                    className="relative flex-1 min-w-0 overflow-hidden file-mention-marquee-container"
                    style={isSelected ? {
                      ['--file-mention-marquee-width' as string]: `${marqueeWidth}px`,
                      ['--file-mention-marquee-duration' as string]: `${marqueeDuration}s`
                    } : undefined}
                    aria-label={relativePath}
                  >
                    <span
                      ref={(el) => { measureRefs.current[rowIndex] = el; }}
                      className="absolute invisible whitespace-nowrap pointer-events-none"
                      aria-hidden
                    >
                      {relativePath}
                    </span>
                    {isOverflowing && isSelected ? (
                      <span className="inline-block whitespace-nowrap file-mention-marquee">
                        {relativePath}
                      </span>
                    ) : (
                      <span className="block truncate">
                        {displayPath}
                      </span>
                    )}
                  </span>
                </div>
              );
            })}
            {visiblePathHits.length > 0 && (
              <div className="px-3 pb-1 pt-2 typography-meta font-medium text-muted-foreground">
                {t('chat.fileMentionAutocomplete.groups.files')}
              </div>
            )}
            {visiblePathHits.map((file, index) => {
              const rowIndex = visibleAgents.length + visibleSessions.length + visibleRecentFiles.length + index;
              const relativePath = file.relativePath || file.name;
              const displayPath = truncatePathMiddle(relativePath, { maxLength: 60 });
              const isSelected = selectedIndex === rowIndex;
              const isOverflowing = overflowMap[rowIndex] ?? false;
              const marqueeDuration = marqueeDurations[rowIndex] ?? 2.6;

              return (
                <div
                  key={file.path}
                  ref={(el) => { itemRefs.current[rowIndex] = el; }}
                  className={cn(
                    "flex items-center gap-2 px-3 py-1.5 cursor-pointer typography-ui-label rounded-lg",
                    isMobile && 'min-h-11',
                    composerAutocompleteRowClassName(isMobile, isSelected),
                    !isMobile && isSelected && 'text-interactive-selection-foreground',
                  )}
                  {...getItemInteractionHandlers(rowIndex, () => handleFileSelect(file))}
                >
                  {getPathIcon(file)}
                  <span
                    ref={(el) => { labelRefs.current[rowIndex] = el; }}
                    className="relative flex-1 min-w-0 overflow-hidden file-mention-marquee-container"
                    style={isSelected ? {
                      ['--file-mention-marquee-width' as string]: `${marqueeWidth}px`,
                      ['--file-mention-marquee-duration' as string]: `${marqueeDuration}s`
                    } : undefined}
                    aria-label={relativePath}
                  >
                    <span
                      ref={(el) => { measureRefs.current[rowIndex] = el; }}
                      className="absolute invisible whitespace-nowrap pointer-events-none"
                      aria-hidden
                    >
                      {relativePath}
                    </span>
                    {isOverflowing && isSelected ? (
                      <span className="inline-block whitespace-nowrap file-mention-marquee">
                        {relativePath}
                      </span>
                    ) : (
                      <span className="block truncate">
                        {displayPath}
                      </span>
                    )}
                  </span>
                </div>
              );
            })}
            {loading && visiblePathHits.length === 0 ? (
              <div className="flex items-center justify-center py-3">
                <Icon name="refresh" className="h-4 w-4 animate-spin text-muted-foreground" />
              </div>
            ) : null}
            {!loading && visiblePathHits.length === 0 && visibleRecentFiles.length === 0 && visibleAgents.length === 0 && visibleSessions.length === 0 && (
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
    </div>
  );
});
