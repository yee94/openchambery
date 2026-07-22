import React from 'react';
import { cn, fuzzyMatch } from '@/lib/utils';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessionMessages } from '@/sync/sync-context';
import { useCommandsQuery } from '@/queries/commandQueries';
import { useInstalledSkillsQuery } from '@/queries/installedSkillsQueries';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { Icon } from "@/components/icon/Icon";
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { isVSCodeRuntime } from '@/lib/desktop';
import { useMobileAutocompleteMaxHeight } from './useMobileAutocompleteMaxHeight';
import { shouldSubmitCommandOnSelection } from './commandSelection';

type CommandSource = 'openchamber' | 'opencode' | 'skill';

export interface CommandInfo {
  id: string;
  name: string;
  source: CommandSource;
  description?: string;
  agent?: string;
  model?: string;
  isBuiltIn?: boolean;
  isOpenChamber?: boolean;
  isSkill?: boolean;
  scope?: string;
  reference?: string;
}

export interface CommandAutocompleteHandle {
  handleKeyDown: (key: string) => void;
}

const BASE_BADGE_CLASS = "text-[10px] leading-none uppercase font-bold tracking-tight px-1.5 py-1 rounded border flex-shrink-0";
const TYPE_BADGE_CLASS = cn(
  BASE_BADGE_CLASS,
  "bg-[color-mix(in_srgb,var(--primary-base)_12%,transparent)] text-[color-mix(in_srgb,var(--primary-base)_70%,transparent)] border-[color-mix(in_srgb,var(--primary-base)_24%,transparent)]"
);
const USER_BADGE_CLASS = cn(
  BASE_BADGE_CLASS,
  "bg-[color-mix(in_srgb,var(--status-success)_12%,transparent)] text-[color-mix(in_srgb,var(--status-success)_70%,transparent)] border-[color-mix(in_srgb,var(--status-success)_24%,transparent)]"
);
const PROJECT_BADGE_CLASS = cn(
  BASE_BADGE_CLASS,
  "bg-[color-mix(in_srgb,var(--status-info)_12%,transparent)] text-[color-mix(in_srgb,var(--status-info)_70%,transparent)] border-[color-mix(in_srgb,var(--status-info)_24%,transparent)]"
);
const NEUTRAL_BADGE_CLASS = cn(
  BASE_BADGE_CLASS,
  "bg-[var(--surface-muted)] text-muted-foreground border-[var(--interactive-border)]/60"
);

const sortCommands = (searchQuery: string) => (a: CommandInfo, b: CommandInfo) => {
  if (a.isBuiltIn !== b.isBuiltIn) {
    return a.isBuiltIn ? -1 : 1;
  }

  const normalizedQuery = searchQuery.toLowerCase();
  const aStartsWith = a.name.toLowerCase().startsWith(normalizedQuery);
  const bStartsWith = b.name.toLowerCase().startsWith(normalizedQuery);
  if (aStartsWith && !bStartsWith) return -1;
  if (!aStartsWith && bStartsWith) return 1;
  return a.name.localeCompare(b.name);
};

interface CommandAutocompleteProps {
  searchQuery: string;
  onCommandSelect: (command: CommandInfo, submit?: boolean) => void;
  onClose: () => void;
  directory?: string | null;
  style?: React.CSSProperties;
}

export const CommandAutocomplete = React.forwardRef<CommandAutocompleteHandle, CommandAutocompleteProps>(({
  searchQuery,
  onCommandSelect,
  onClose,
  directory,
  style,
}, ref) => {
  const { t } = useI18n();
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const sessionMessages = useSessionMessages(currentSessionId ?? '');
  const hasMessagesInCurrentSession = sessionMessages.length > 0;
  const hasSession = Boolean(currentSessionId);
  const hasNewSessionDraft = useSessionUIStore((state) => Boolean(state.newSessionDraft?.open));
  const canStartSessionCommand = hasSession || hasNewSessionDraft;
  const isMobile = useUIStore((state) => state.isMobile);
  const canUseReviewHandoffFlow = hasSession && !isMobile && !isVSCodeRuntime();

  const [commands, setCommands] = React.useState<CommandInfo[]>([]);
  const [loading, setLoading] = React.useState(false);
  const commandsQuery = useCommandsQuery({ directory });
  const commandsWithMetadata = React.useMemo(() => commandsQuery.data ?? [], [commandsQuery.data]);
  const isCommandsFetching = commandsQuery.isFetching;
  const skillsQuery = useInstalledSkillsQuery({ directory });
  const skills = React.useMemo(() => skillsQuery.data ?? [], [skillsQuery.data]);
  const [selectedIndex, setSelectedIndex] = React.useState(0);
  const selectedIndexRef = React.useRef(0);
  const keyboardNavigationRef = React.useRef(false);
  const itemRefs = React.useRef<(HTMLDivElement | null)[]>([]);
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const mobileMaxHeight = useMobileAutocompleteMaxHeight(containerRef, isMobile);
  const ignoreClickRef = React.useRef(false);
  const pointerStartRef = React.useRef<{ x: number; y: number } | null>(null);
  const pointerMovedRef = React.useRef(false);

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
    const loadCommands = async () => {
      setLoading(isCommandsFetching);
      try {
        const customCommands: CommandInfo[] = commandsWithMetadata.map((cmd, index) => ({
          id: `opencode:${cmd.scope ?? 'global'}:${cmd.name}:${cmd.agent ?? ''}:${cmd.model ?? ''}:${index}`,
          name: cmd.name,
          source: 'opencode',
          description: cmd.description,
          agent: cmd.agent ?? undefined,
          model: cmd.model ?? undefined,
          isBuiltIn: cmd.isBuiltIn,
          isSkill: cmd.source === 'skill',
          scope: cmd.scope,
          reference: cmd.reference,
        }));
        const skillCommands: CommandInfo[] = skills.map((skill, index) => ({
          id: `skill:${skill.scope}:${skill.source ?? 'opencode'}:${skill.name}:${index}`,
          name: skill.name,
          source: 'skill',
          description: skill.description,
          isSkill: true,
          scope: skill.scope,
        }));

        const builtInCommands: CommandInfo[] = [
          { id: 'openchamber:new', name: 'new', source: 'openchamber' as const, description: t('chat.commandAutocomplete.command.newDescription'), isBuiltIn: true },
          ...(hasSession && !hasMessagesInCurrentSession
            ? [{ id: 'openchamber:init', name: 'init', source: 'openchamber' as const, description: t('chat.commandAutocomplete.command.initDescription'), isBuiltIn: true }]
            : []
          ),
          ...(hasSession  // Show when session exists, not when hasMessages
            ? [
                { id: 'openchamber:undo', name: 'undo', source: 'openchamber' as const, description: t('chat.commandAutocomplete.command.undoDescription'), isBuiltIn: true },
                { id: 'openchamber:redo', name: 'redo', source: 'openchamber' as const, description: t('chat.commandAutocomplete.command.redoDescription'), isBuiltIn: true },
                { id: 'openchamber:fork', name: 'fork', source: 'openchamber' as const, description: t('chat.commandAutocomplete.command.forkDescription'), isBuiltIn: true },
                { id: 'openchamber:timeline', name: 'timeline', source: 'openchamber' as const, description: t('chat.commandAutocomplete.command.timelineDescription'), isBuiltIn: true },
              ]
            : []
          ),
          { id: 'openchamber:model', name: 'model', source: 'openchamber' as const, description: t('chat.commandAutocomplete.command.modelDescription'), isBuiltIn: true },
          { id: 'openchamber:compact', name: 'compact', source: 'openchamber' as const, description: t('chat.commandAutocomplete.command.compactDescription'), isBuiltIn: true },
          ...(hasSession
            ? [{ id: 'openchamber:summary', name: 'summary', source: 'openchamber' as const, description: t('chat.commandAutocomplete.command.summaryDescription'), isOpenChamber: true }]
            : []
          ),
          ...(canStartSessionCommand
            ? [{ id: 'openchamber:workspace-review', name: 'workspace-review', source: 'openchamber' as const, description: t('chat.commandAutocomplete.command.workspaceReviewDescription'), isOpenChamber: true }]
            : []
          ),
          ...(canUseReviewHandoffFlow
            ? [{ id: 'openchamber:handoff-review', name: 'handoff-review', source: 'openchamber' as const, description: t('chat.commandAutocomplete.command.handoffReviewDescription'), isOpenChamber: true }]
            : []
          ),
          ...(canStartSessionCommand
            ? [{ id: 'openchamber:plan-feature', name: 'plan-feature', source: 'openchamber' as const, description: t('chat.commandAutocomplete.command.featurePlanDescription'), isOpenChamber: true }]
            : []
          ),
          ...(canStartSessionCommand
            ? [{ id: 'openchamber:craft-goal', name: 'craft-goal', source: 'openchamber' as const, description: t('chat.commandAutocomplete.command.craftGoalDescription'), isOpenChamber: true }]
            : []
          ),
          ...(canStartSessionCommand
            ? [{ id: 'openchamber:goal', name: 'goal', source: 'openchamber' as const, description: t('chat.goal.button.armAria'), isBuiltIn: true }]
            : []
          ),
          ...(canStartSessionCommand
            ? [{ id: 'openchamber:catch-up', name: 'catch-up', source: 'openchamber' as const, description: t('chat.commandAutocomplete.command.catchUpDescription'), isOpenChamber: true }]
            : []
          ),
          ...(canStartSessionCommand
            ? [{ id: 'openchamber:debug', name: 'debug', source: 'openchamber' as const, description: t('chat.commandAutocomplete.command.debugDescription'), isOpenChamber: true }]
            : []
          ),
          ...(canStartSessionCommand
            ? [{ id: 'openchamber:weigh', name: 'weigh', source: 'openchamber' as const, description: t('chat.commandAutocomplete.command.weighDescription'), isOpenChamber: true }]
            : []
          ),
          ...(canStartSessionCommand
            ? [{ id: 'openchamber:explore', name: 'explore', source: 'openchamber' as const, description: t('chat.commandAutocomplete.command.exploreDescription'), isOpenChamber: true }]
            : []
          ),
        ];
        const allCommands = [...builtInCommands, ...customCommands, ...skillCommands];

        const allowInitCommand = !hasMessagesInCurrentSession;
        const filtered = (searchQuery
          ? allCommands.filter(cmd =>
              fuzzyMatch(cmd.name, searchQuery) ||
              (cmd.description && fuzzyMatch(cmd.description, searchQuery))
            )
          : allCommands).filter(cmd => allowInitCommand || cmd.name !== 'init');

        filtered.sort(sortCommands(searchQuery));

        filtered.sort(sortCommands(searchQuery));
        setCommands(filtered);
      } catch {

        const allowInitCommand = !hasMessagesInCurrentSession;
        const builtInCommands: CommandInfo[] = [
          { id: 'openchamber:new', name: 'new', source: 'openchamber' as const, description: t('chat.commandAutocomplete.command.newDescription'), isBuiltIn: true },
          ...(hasSession && !hasMessagesInCurrentSession
            ? [{ id: 'openchamber:init', name: 'init', source: 'openchamber' as const, description: t('chat.commandAutocomplete.command.initDescription'), isBuiltIn: true }]
            : []
          ),
          ...(hasSession  // Show when session exists, not when hasMessages
            ? [
                { id: 'openchamber:undo', name: 'undo', source: 'openchamber' as const, description: t('chat.commandAutocomplete.command.undoDescription'), isBuiltIn: true },
                { id: 'openchamber:redo', name: 'redo', source: 'openchamber' as const, description: t('chat.commandAutocomplete.command.redoDescription'), isBuiltIn: true },
                { id: 'openchamber:fork', name: 'fork', source: 'openchamber' as const, description: t('chat.commandAutocomplete.command.forkDescription'), isBuiltIn: true },
                { id: 'openchamber:timeline', name: 'timeline', source: 'openchamber' as const, description: t('chat.commandAutocomplete.command.timelineDescription'), isBuiltIn: true },
              ]
            : []
          ),
          { id: 'openchamber:model', name: 'model', source: 'openchamber' as const, description: t('chat.commandAutocomplete.command.modelDescription'), isBuiltIn: true },
          { id: 'openchamber:compact', name: 'compact', source: 'openchamber' as const, description: t('chat.commandAutocomplete.command.compactDescription'), isBuiltIn: true },
          ...(hasSession
            ? [{ id: 'openchamber:summary', name: 'summary', source: 'openchamber' as const, description: t('chat.commandAutocomplete.command.summaryDescription'), isOpenChamber: true }]
            : []
          ),
          ...(canStartSessionCommand
            ? [{ id: 'openchamber:workspace-review', name: 'workspace-review', source: 'openchamber' as const, description: t('chat.commandAutocomplete.command.workspaceReviewDescription'), isOpenChamber: true }]
            : []
          ),
          ...(canUseReviewHandoffFlow
            ? [{ id: 'openchamber:handoff-review', name: 'handoff-review', source: 'openchamber' as const, description: t('chat.commandAutocomplete.command.handoffReviewDescription'), isOpenChamber: true }]
            : []
          ),
          ...(canStartSessionCommand
            ? [{ id: 'openchamber:plan-feature', name: 'plan-feature', source: 'openchamber' as const, description: t('chat.commandAutocomplete.command.featurePlanDescription'), isOpenChamber: true }]
            : []
          ),
          ...(canStartSessionCommand
            ? [{ id: 'openchamber:craft-goal', name: 'craft-goal', source: 'openchamber' as const, description: t('chat.commandAutocomplete.command.craftGoalDescription'), isOpenChamber: true }]
            : []
          ),
          ...(canStartSessionCommand
            ? [{ id: 'openchamber:goal', name: 'goal', source: 'openchamber' as const, description: t('chat.goal.button.armAria'), isBuiltIn: true }]
            : []
          ),
          ...(canStartSessionCommand
            ? [{ id: 'openchamber:catch-up', name: 'catch-up', source: 'openchamber' as const, description: t('chat.commandAutocomplete.command.catchUpDescription'), isOpenChamber: true }]
            : []
          ),
          ...(canStartSessionCommand
            ? [{ id: 'openchamber:debug', name: 'debug', source: 'openchamber' as const, description: t('chat.commandAutocomplete.command.debugDescription'), isOpenChamber: true }]
            : []
          ),
          ...(canStartSessionCommand
            ? [{ id: 'openchamber:weigh', name: 'weigh', source: 'openchamber' as const, description: t('chat.commandAutocomplete.command.weighDescription'), isOpenChamber: true }]
            : []
          ),
          ...(canStartSessionCommand
            ? [{ id: 'openchamber:explore', name: 'explore', source: 'openchamber' as const, description: t('chat.commandAutocomplete.command.exploreDescription'), isOpenChamber: true }]
            : []
          ),
        ];

        const filtered = (searchQuery
          ? builtInCommands.filter(cmd =>
              fuzzyMatch(cmd.name, searchQuery) ||
              (cmd.description && fuzzyMatch(cmd.description, searchQuery))
            )
          : builtInCommands).filter(cmd => allowInitCommand || cmd.name !== 'init');

        setCommands(filtered);
      } finally {
        setLoading(false);
      }
    };

    loadCommands();
  }, [searchQuery, hasMessagesInCurrentSession, hasSession, canStartSessionCommand, canUseReviewHandoffFlow, commandsWithMetadata, isCommandsFetching, skills, t]);

  React.useEffect(() => {
    setSelectedIndex(0);
  }, [commands]);

  React.useEffect(() => {
    selectedIndexRef.current = selectedIndex;
  }, [selectedIndex]);

  React.useEffect(() => {
    itemRefs.current[selectedIndex]?.scrollIntoView({
      block: 'nearest'
    });
  }, [selectedIndex]);

  React.useImperativeHandle(ref, () => ({
    handleKeyDown: (key: string) => {
      const total = commands.length;
      if (key === 'Escape') {
        onClose();
        return;
      }

      if (total === 0) {
        return;
      }

      if (key === 'ArrowDown') {
        keyboardNavigationRef.current = true;
        setSelectedIndex((prev) => (prev + 1) % total);
        return;
      }

      if (key === 'ArrowUp') {
        keyboardNavigationRef.current = true;
        setSelectedIndex((prev) => (prev - 1 + total) % total);
        return;
      }

      if (key === 'Enter' || key === 'Tab') {
        const safeIndex = ((selectedIndexRef.current % total) + total) % total;
        const command = commands[safeIndex];
        if (command) {
          // Enter immediately runs system/opencode commands (e.g. /new, /fork,
          // /model). Skills only get inserted — they usually need arguments or
          // surrounding context before the user actually sends.
          const shouldSubmit = shouldSubmitCommandOnSelection(command, key === 'Enter');
          onCommandSelect(command, shouldSubmit);
        }
      }
    }
  }), [commands, onClose, onCommandSelect]);

  const getCommandIcon = (command: CommandInfo) => {

    switch (command.name) {
      case 'new':
        return <Icon name="add" className="h-3.5 w-3.5" />;
      case 'init':
        return <Icon name="file" className="h-3.5 w-3.5 text-green-500" />;
      case 'undo':
        return <Icon name="arrow-go-back" className="h-3.5 w-3.5 text-orange-500" />;
      case 'redo':
        return <Icon name="arrow-go-forward" className="h-3.5 w-3.5 text-orange-500" />;
      case 'timeline':
        return <Icon name="time" className="h-3.5 w-3.5" />;
      case 'compact':
        return <Icon name="scissors" className="h-3.5 w-3.5 text-purple-500" />;
      case 'goal':
        return <Icon name="target" className="h-3.5 w-3.5" />;
      case 'review':
        return <Icon name="search-eye" className="h-3.5 w-3.5 text-blue-500" />;
      case 'test':
      case 'build':
      case 'run':
        return <Icon name="terminal-box" className="h-3.5 w-3.5 text-cyan-500" />;
      default:
        if (command.isBuiltIn) {
          return <Icon name="flashlight" className="h-3.5 w-3.5 text-yellow-500" />;
        }
        return <Icon name="command" className="h-3.5 w-3.5 text-muted-foreground" />;
    }
  };

  return (
    <div
      ref={containerRef}
      className="absolute z-[100] min-w-0 w-full max-w-[450px] max-h-64 bg-background border-2 border-border/60 rounded-xl shadow-none bottom-full mb-2 left-0 flex flex-col"
      style={mobileMaxHeight !== undefined ? { ...style, maxHeight: mobileMaxHeight } : style}
    >
      <ScrollableOverlay preventOverscroll outerClassName="flex-1 min-h-0" className="px-0 pb-2">
        {loading ? (
          <div className="flex items-center justify-center py-4">
            <Icon name="refresh" className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div>
            {commands.map((command, index) => {
              const isSystem = command.isBuiltIn;
              const isOpenChamberBadge = command.isOpenChamber;
              return (
                <div
                  key={command.id}
                  ref={(el) => { itemRefs.current[index] = el; }}
                  className={cn(
                    "flex gap-2 px-3 py-2 cursor-pointer rounded-lg",
                    isMobile ? "items-center" : "items-start",
                    index === selectedIndex && "bg-interactive-selection"
                  )}
                  // Block the focus transfer the tap would perform: the textarea
                  // must stay focused so selecting a command doesn't dismiss the
                  // soft keyboard (the blur raced the keyboard-hide trigger and
                  // won against the deferred refocus).
                  onMouseDown={(event) => event.preventDefault()}
                  onPointerDown={(event) => {
                    if (event.pointerType !== 'touch') {
                      return;
                    }
                    pointerStartRef.current = { x: event.clientX, y: event.clientY };
                    pointerMovedRef.current = false;
                  }}
                  onPointerMove={(event) => {
                    if (event.pointerType !== 'touch' || !pointerStartRef.current) {
                      return;
                    }
                    const dx = event.clientX - pointerStartRef.current.x;
                    const dy = event.clientY - pointerStartRef.current.y;
                    if (Math.hypot(dx, dy) > 6) {
                      pointerMovedRef.current = true;
                    }
                  }}
                  onPointerUp={(event) => {
                    if (event.pointerType !== 'touch') {
                      return;
                    }
                    const didMove = pointerMovedRef.current;
                    pointerStartRef.current = null;
                    pointerMovedRef.current = false;
                    if (didMove) {
                      return;
                    }
                    event.preventDefault();
                    event.stopPropagation();
                    ignoreClickRef.current = true;
                    onCommandSelect(command, shouldSubmitCommandOnSelection(command, isMobile));
                  }}
                  onPointerCancel={() => {
                    pointerStartRef.current = null;
                    pointerMovedRef.current = false;
                  }}
                  onClick={() => {
                    if (ignoreClickRef.current) {
                      ignoreClickRef.current = false;
                      return;
                    }
                    onCommandSelect(command, shouldSubmitCommandOnSelection(command, isMobile));
                  }}
                  onMouseMove={() => {
                    keyboardNavigationRef.current = false;
                    setSelectedIndex(index);
                  }}
                >
                  <div className={cn(!isMobile && "mt-0.5")}>
                    {getCommandIcon(command)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="typography-ui-label font-medium">/{command.name}</span>
                      {command.isSkill ? (
                        <span className={TYPE_BADGE_CLASS}>
                          {t('chat.commandAutocomplete.badge.skill')}
                        </span>
                      ) : (
                        <span className={TYPE_BADGE_CLASS}>
                          {t('chat.commandAutocomplete.badge.command')}
                        </span>
                      )}
                      {isOpenChamberBadge ? (
                        <span className={NEUTRAL_BADGE_CLASS}>
                          OpenChamber
                        </span>
                      ) : isSystem ? (
                        <span className={NEUTRAL_BADGE_CLASS}>
                          {t('chat.commandAutocomplete.badge.system')}
                        </span>
                      ) : command.scope ? (
                        <span className={command.scope === 'project' ? PROJECT_BADGE_CLASS : USER_BADGE_CLASS}>
                          {command.scope}
                        </span>
                      ) : null}
                      {command.agent && (
                        <span className={NEUTRAL_BADGE_CLASS}>
                          {command.agent}
                        </span>
                      )}
                    </div>
                    {command.description && !isMobile && (
                      <div className="typography-meta text-muted-foreground mt-0.5 truncate">
                        {command.description}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
            {commands.length === 0 && (
              <div className="px-3 py-2 typography-ui-label text-muted-foreground">
                {t('chat.commandAutocomplete.empty')}
              </div>
            )}
          </div>
        )}
      </ScrollableOverlay>
      {!isMobile && (
        <div className="px-3 pt-1 pb-1.5 border-t typography-meta text-muted-foreground">
          {t('chat.autocomplete.keyboardHint')}
        </div>
      )}
    </div>
  );
});

CommandAutocomplete.displayName = 'CommandAutocomplete';
