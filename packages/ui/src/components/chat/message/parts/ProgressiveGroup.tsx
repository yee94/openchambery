import React from 'react';
import { useEvent } from '@reactuses/core';
import { cn } from '@/lib/utils';
import type { TurnActivityPresentationKind, TurnActivityRecord as TurnActivityPart, TurnCompletionDisposition } from '../../lib/turns/types';
import type { Part, ToolPart as ToolPartType } from '@opencode-ai/sdk/v2';
import type { StreamPhase } from '../types';
import type { ContentChangeReason } from '@/hooks/useChatAutoFollow';
import type { ToolPopupContent } from '../types';
import ToolPart from './ToolPart';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { Text } from '@/components/ui/text';
import { Icon } from "@/components/icon/Icon";
import { getToolIcon } from './toolPresentation';
import { resolveToolDisplayName } from '@/lib/toolHelpers';
import { ContextToolGroup } from './ContextToolGroup';
import { SkillToolGroup } from './SkillToolGroup';
import { collectConsecutiveProcessTools, hasProcessSuccessor } from './processToolGrouping';
import { collectConsecutiveSkillTools, getSkillNameFromToolPart } from './skillToolGrouping';
import { LatticeOrb } from './LatticeOrb';
import { extractTextContent } from '../partUtils';
import { isContextGroupTool, isExpandableTool, isProcessGroupTool, isSkillGroupTool, isStandaloneTool, isStaticTool, isToolPartActive } from './toolRenderUtils';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useUIStore } from '@/stores/useUIStore';
import { useInstalledSkillsQuery } from '@/queries/installedSkillsQueries';
import { ensureOutsideFileGrantForDesktop } from '@/lib/outsideFileGrants';
import ReasoningPart from './ReasoningPart';
import JustificationBlock from './JustificationBlock';
import { areRenderRelevantPartsEqual } from '../renderCompare';
import { getExternalFaviconUrl } from '@/lib/url';
import { getDirectoryForFilePath, getRelativeFilePath, isFilePathWithinDirectory, normalizeFilePath, toAbsoluteFilePath } from '@/lib/path-utils';
import {
    getToolRowBlockClass,
    TOOL_ROW_CHIP_GEOMETRY_CLASS,
    TOOL_ROW_INTERACTIVE_CHROME_CLASS,
} from './toolRowChrome';
import { useSessionSurface } from '../../SessionSurfaceContext';
import { useMobileAppActions } from '@/apps/mobileAppContext';
import { useI18n } from '@/lib/i18n';
import { AgentAvatar } from '../../AgentAvatar';
import { formatActivityDuration } from './formatActivityDuration';
import { Button } from '@/components/ui/button';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import {
    getTranscriptMessageMaterializationState,
    materializeTranscriptMessage,
} from '@/sync/transcript-repository-runtime';

const TOOL_ROW_TEXT_CLASS = '!text-[length:var(--text-meta)] !leading-5 sm:!leading-6 tracking-normal';
const TOOL_ROW_TITLE_CLASS = cn('typography-meta font-medium', TOOL_ROW_TEXT_CLASS);
const TOOL_ROW_DESCRIPTION_CLASS = cn('typography-meta', TOOL_ROW_TEXT_CLASS);

const EMPTY_ACTIVITY_PARTS: TurnActivityPart[] = [];

interface ProgressiveGroupProps {
    parts: TurnActivityPart[];
    materializationParts?: TurnActivityPart[];
    isExpanded: boolean;
    collapsedPreviewCount?: number;
    completionDisposition?: TurnCompletionDisposition;
    activityPresentationKind?: TurnActivityPresentationKind;
    durationMs?: number;
    startedAt?: number;
    onToggle: () => void;
    isMobile: boolean;
    expandedTools: Set<string>;
    onToggleTool: (toolId: string) => void;
    onShowPopup: (content: ToolPopupContent) => void;
    onContentChange?: (reason?: ContentChangeReason) => void;
    streamPhase: StreamPhase;
    showHeader: boolean;
    renderJustificationActions?: (activity: TurnActivityPart) => React.ReactNode;
}

type MaterializationStatus = 'idle' | 'loading' | 'ready' | 'error';

const isSlimMaterializablePart = (activity: TurnActivityPart): boolean => {
    const part = activity.part as Part & { slim?: unknown };
    return part.slim === true && (part.type === 'tool' || part.type === 'reasoning' || part.type === 'file');
};

const getSlimActivityMessageIds = (parts: TurnActivityPart[]): string[] => {
    const ids = new Set<string>();
    for (const activity of parts) {
        if (isSlimMaterializablePart(activity) && activity.messageId) {
            ids.add(activity.messageId);
        }
    }
    return [...ids];
};

const hasMaterializedActivityOutput = (
    parts: TurnActivityPart[],
    messageIds: ReadonlySet<string>,
): boolean => parts.some((activity) => {
    if (!messageIds.has(activity.messageId)) return false;
    const part = activity.part as Part & {
        slim?: unknown;
        text?: unknown;
        url?: unknown;
        state?: { output?: unknown; error?: unknown };
    };
    if (part.slim === true) return false;
    if (part.type === 'reasoning') return typeof part.text === 'string' && part.text.trim().length > 0;
    if (part.type === 'file') return typeof part.url === 'string' && part.url.trim().length > 0;
    if (part.type === 'tool') {
        const output = part.state?.output;
        const error = part.state?.error;
        return (typeof output === 'string' ? output.trim().length > 0 : output != null)
            || (typeof error === 'string' ? error.trim().length > 0 : error != null);
    }
    return false;
});

const ExternalLinkFavicon: React.FC<{ href: string }> = ({ href }) => {
    const [failed, setFailed] = React.useState(false);
    const faviconUrl = React.useMemo(() => getExternalFaviconUrl(href), [href]);

    if (!faviconUrl || failed) {
        return null;
    }

    return (
        <span className="inline-flex size-[18px] flex-shrink-0 items-center justify-center rounded border border-[var(--border)] bg-[var(--interactive-hover)]">
            <img
                src={faviconUrl}
                alt=""
                aria-hidden="true"
                loading="lazy"
                decoding="async"
                className="size-3.5 rounded-sm"
                onError={() => setFailed(true)}
            />
        </span>
    );
};

/**
 * Parts arrive in correct chronological order:
 * messages in sequence, parts within each message in their natural LLM
 * production order. No re-sorting needed — time-based sorting breaks this
 * because text parts get time.end = message completion time (later than
 * tools), pushing text after tools within the same message.
 */
const sortPartsByTime = (parts: TurnActivityPart[]): TurnActivityPart[] => parts;



/**
 * Extract a short filename from a tool part's input (for aggregation display).
 */
const getToolFileName = (activity: TurnActivityPart): string | null => {
    const part = activity.part as ToolPartType;
    const state = part.state as { input?: Record<string, unknown>; metadata?: Record<string, unknown> } | undefined;
    const input = state?.input;
    const metadata = state?.metadata;

    const filePath =
        (input?.filePath as string) ||
        (input?.file_path as string) ||
        (input?.path as string) ||
        (metadata?.filePath as string) ||
        (metadata?.file_path as string) ||
        (metadata?.path as string);

    if (typeof filePath === 'string' && filePath.trim().length > 0) {
        const lastSlash = filePath.lastIndexOf('/');
        return lastSlash >= 0 ? filePath.slice(lastSlash + 1) : filePath;
    }

    return null;
};

const getToolFilePath = (activity: TurnActivityPart): string | null => {
    const part = activity.part as ToolPartType;
    const state = part.state as { input?: Record<string, unknown>; metadata?: Record<string, unknown> } | undefined;
    const input = state?.input;
    const metadata = state?.metadata;

    const filePath =
        (input?.filePath as string) ||
        (input?.file_path as string) ||
        (input?.path as string) ||
        (metadata?.filePath as string) ||
        (metadata?.file_path as string) ||
        (metadata?.path as string);

    return typeof filePath === 'string' && filePath.trim().length > 0 ? filePath : null;
};

const getToolSkillDirectory = (activity: TurnActivityPart): string | null => {
    const part = activity.part as ToolPartType;
    const state = part.state as { metadata?: Record<string, unknown> } | undefined;
    const dir = state?.metadata?.dir;

    return typeof dir === 'string' && dir.trim().length > 0 ? dir : null;
};

const toTodoStatusKey = (value: unknown): 'pending' | 'in_progress' | 'completed' | 'cancelled' | null => {
    if (typeof value !== 'string') {
        return null;
    }
    const normalized = value.trim().toLowerCase();
    if (normalized === 'pending') return 'pending';
    if (normalized === 'in_progress' || normalized === 'in progress' || normalized === 'inprogress') return 'in_progress';
    if (normalized === 'completed' || normalized === 'done') return 'completed';
    if (normalized === 'cancelled' || normalized === 'canceled') return 'cancelled';
    return null;
};

const formatTodoSummary = (todos: unknown[]): string | null => {
    if (todos.length === 0) {
        return '0 tasks';
    }

    let pending = 0;
    let inProgress = 0;
    for (const todo of todos) {
        if (!todo || typeof todo !== 'object') {
            continue;
        }
        const status = toTodoStatusKey((todo as { status?: unknown }).status);
        if (!status) {
            continue;
        }
        if (status === 'pending') pending += 1;
        if (status === 'in_progress') inProgress += 1;
    }

    const activeCount = pending + inProgress;
    if (activeCount === 0) {
        return '0 tasks';
    }

    return `${activeCount} ${activeCount === 1 ? 'task' : 'tasks'}`;
};

const getTodoSummaryFromActivity = (activity: TurnActivityPart): string | null => {
    const part = activity.part as ToolPartType;
    const state = part.state as { input?: Record<string, unknown>; output?: unknown } | undefined;
    const input = state?.input;
    const output = state?.output;

    if (Array.isArray(input?.todos)) {
        const summary = formatTodoSummary(input.todos);
        if (summary) return summary;
    }

    if (Array.isArray(output)) {
        const summary = formatTodoSummary(output);
        if (summary) return summary;
    }

    if (output && typeof output === 'object' && Array.isArray((output as { todos?: unknown }).todos)) {
        const summary = formatTodoSummary((output as { todos: unknown[] }).todos);
        if (summary) return summary;
    }

    if (typeof output === 'string' && output.trim().length > 0) {
        try {
            const parsed = JSON.parse(output) as unknown;
            if (Array.isArray(parsed)) {
                const summary = formatTodoSummary(parsed);
                if (summary) return summary;
            }
            if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { todos?: unknown }).todos)) {
                const summary = formatTodoSummary((parsed as { todos: unknown[] }).todos);
                if (summary) return summary;
            }
        } catch {
            // Ignore non-JSON output.
        }
    }

    return null;
};

const getToolReadOffset = (activity: TurnActivityPart): number | undefined => {
    const part = activity.part as ToolPartType;
    const state = part.state as { input?: Record<string, unknown>; metadata?: Record<string, unknown> } | undefined;
    const input = state?.input;
    const metadata = state?.metadata;

    const rawOffset =
        (typeof input?.offset === 'number' && Number.isFinite(input.offset) ? input.offset : undefined)
        ?? (typeof input?.line === 'number' && Number.isFinite(input.line) ? input.line : undefined)
        ?? (typeof metadata?.offset === 'number' && Number.isFinite(metadata.offset) ? metadata.offset : undefined)
        ?? (typeof metadata?.line === 'number' && Number.isFinite(metadata.line) ? metadata.line : undefined);

    if (typeof rawOffset !== 'number' || rawOffset <= 0) {
        return undefined;
    }

    return Math.floor(rawOffset);
};

const renderReadFilePath = (displayPath: string, animate = true) => {
    const lastSlash = displayPath.lastIndexOf('/');

    if (lastSlash === -1) {
        return (
            <Text
                variant={animate ? 'generate-effect' : 'static'}
                className={cn('min-w-0 flex-1 truncate whitespace-nowrap', TOOL_ROW_DESCRIPTION_CLASS)}
                style={{ color: 'var(--tools-description)' }}
                title={displayPath}
            >
                {displayPath}
            </Text>
        );
    }

    const dir = displayPath.slice(0, lastSlash);
    const name = displayPath.slice(lastSlash + 1);
    const hasAbsoluteRoot = dir.startsWith('/');
    const displayDir = hasAbsoluteRoot ? dir.slice(1) : dir;

    return (
        <span className={cn('min-w-0 inline-flex max-w-full flex-1 items-baseline overflow-hidden', TOOL_ROW_DESCRIPTION_CLASS)} title={displayPath}>
            {hasAbsoluteRoot ? <span className="flex-shrink-0" style={{ color: 'var(--tools-description)' }}>/</span> : null}
            <span
                className="min-w-0 shrink truncate whitespace-nowrap"
                style={{
                    color: 'var(--tools-description)',
                    direction: 'rtl',
                    textAlign: 'left',
                    unicodeBidi: 'plaintext',
                }}
            >
                {displayDir}
            </span>
            <span className="flex-shrink-0" style={{ color: 'var(--tools-description)' }}>/</span>
            <Text
                variant={animate ? 'generate-effect' : 'static'}
                className="flex-shrink-0"
                style={{ color: 'var(--tools-description)' }}
            >
                {name}
            </Text>
        </span>
    );
};

const resolveSkillFilePath = (skillPathOrDir: string): string => {
    const normalizedPath = normalizeFilePath(skillPathOrDir);
    if (!normalizedPath) {
        return '';
    }

    return normalizedPath.toLowerCase().endsWith('/skill.md') ? normalizedPath : `${normalizedPath}/SKILL.md`;
};

/**
 * Get a short description for a static tool (for aggregation display).
 */
const getToolShortDescription = (activity: TurnActivityPart): string | null => {
    const part = activity.part as ToolPartType;
    const toolName = part.tool?.toLowerCase() ?? '';
    const state = part.state as { input?: Record<string, unknown>; metadata?: Record<string, unknown> } | undefined;
    const input = state?.input;
    const metadata = state?.metadata;

    // For search tools, show pattern
    if (toolName === 'grep' || toolName === 'search' || toolName === 'find' || toolName === 'ripgrep') {
        const pattern = input?.pattern;
        if (typeof pattern === 'string' && pattern.trim().length > 0) {
            return pattern.length > 40 ? pattern.slice(0, 40) + '...' : pattern;
        }
    }

    // For glob, show pattern
    if (toolName === 'glob') {
        const pattern = input?.pattern;
        if (typeof pattern === 'string' && pattern.trim().length > 0) {
            return pattern.length > 40 ? pattern.slice(0, 40) + '...' : pattern;
        }
    }

    // For web search tools, show query
    if (toolName === 'websearch' || toolName === 'web-search' || toolName === 'search_web' || toolName === 'codesearch' || toolName === 'perplexity') {
        const query = input?.query;
        if (typeof query === 'string' && query.trim().length > 0) {
            return query.length > 50 ? query.slice(0, 50) + '...' : query;
        }
    }

    // For skill, show name
    if (toolName === 'skill') {
        return getSkillNameFromToolPart(part);
    }

    // For fetch-url tools, show URL
    if (toolName === 'webfetch' || toolName === 'fetch' || toolName === 'curl' || toolName === 'wget') {
        const url =
            (typeof input?.url === 'string' && input.url) ||
            (typeof input?.URL === 'string' && input.URL) ||
            (typeof metadata?.url === 'string' && metadata.url) ||
            (typeof metadata?.URL === 'string' && metadata.URL) ||
            '';

        if (typeof url === 'string' && url.trim().length > 0) {
            return url.trim();
        }
    }

    // For todo tools, show status summary without task names
    if (toolName === 'todowrite' || toolName === 'todoread') {
        return getTodoSummaryFromActivity(activity);
    }

    // Fallback: try filename
    return getToolFileName(activity);
};

type AggregatedRow =
    | { type: 'tool-expandable'; activity: TurnActivityPart }
    | { type: 'tool-static-group'; toolName: string; activities: TurnActivityPart[] }
    | { type: 'tool-context-group'; activities: TurnActivityPart[]; hasFollowingOtherType: boolean }
    | { type: 'tool-skill-group'; activities: TurnActivityPart[] }
    | { type: 'reasoning'; activity: TurnActivityPart }
    | { type: 'justification'; activity: TurnActivityPart }
    | { type: 'tool-fallback'; activity: TurnActivityPart };

/** Collect task-tool part ids for header avatars (seed by task id, not agent name). */
const getTaskAvatarSeeds = (parts: TurnActivityPart[]): { active: string[]; all: string[] } => {
    const active: string[] = [];
    const all: string[] = [];

    for (const activity of parts) {
        if (activity.kind !== 'tool') continue;
        const part = activity.part as ToolPartType;
        if (part.tool?.trim().toLowerCase() !== 'task') continue;

        const taskId = typeof part.id === 'string' ? part.id.trim() : '';
        if (!taskId) continue;

        const state = part.state as unknown;
        if (!state || typeof state !== 'object') continue;
        const stateRecord = state as Record<string, unknown>;

        all.push(taskId);
        if (stateRecord.status === 'pending' || stateRecord.status === 'running') {
            active.push(taskId);
        }
    }

    return { active, all };
};

interface ExpandableToolRowProps {
    activity: TurnActivityPart;
    isExpanded: boolean;
    isMobile: boolean;
    onToggleTool: (toolId: string) => void;
    onShowPopup: (content: ToolPopupContent) => void;
    onContentChange?: (reason?: ContentChangeReason) => void;
}

const ExpandableToolRow: React.FC<ExpandableToolRowProps> = ({
    activity,
    isExpanded,
    isMobile,
    onToggleTool,
    onShowPopup,
    onContentChange,
}) => {
    const handleToggle = useEvent(() => {
        onToggleTool(activity.id);
    });

    return (
        <div className={getToolRowBlockClass(isMobile)}>
            <ToolPart
                part={activity.part as ToolPartType}
                messageId={activity.messageId}
                isExpanded={isExpanded}
                onToggle={handleToggle}
                isMobile={isMobile}
                onContentChange={onContentChange}
                onShowPopup={onShowPopup}
                animateTailText={false}
            />
        </div>
    );
};

const MemoExpandableToolRow = React.memo(ExpandableToolRow, (prev, next) => {
    return prev.isExpanded === next.isExpanded
        && prev.isMobile === next.isMobile
        && prev.onToggleTool === next.onToggleTool
        && prev.onShowPopup === next.onShowPopup
        && prev.onContentChange === next.onContentChange
        && prev.activity.id === next.activity.id
        && prev.activity.messageId === next.activity.messageId
        && prev.activity.kind === next.activity.kind
        && prev.activity.endedAt === next.activity.endedAt
        && areRenderRelevantPartsEqual([prev.activity.part], [next.activity.part]);
});

interface StaticGroupedToolRowProps {
    toolName: string;
    activities: TurnActivityPart[];
    isMobile: boolean;
}

const StaticGroupedToolRow: React.FC<StaticGroupedToolRowProps> = ({
    toolName,
    activities,
    isMobile,
}) => {
    return (
        <div className={getToolRowBlockClass(isMobile)}>
            <StaticToolRow
                toolName={toolName}
                activities={activities}
                isMobile={isMobile}
                animateTailText={false}
            />
        </div>
    );
};

const MemoStaticGroupedToolRow = React.memo(StaticGroupedToolRow, (prev, next) => {
    return prev.toolName === next.toolName
        && prev.isMobile === next.isMobile
        && areActivityListsEqual(prev.activities, next.activities);
});

/**
 * Aggregate sorted activity parts into display rows.
 * Consecutive skill calls collapse into one SkillToolGroup.
 * Consecutive process tools (explore + edit/write/bash/custom, not skill/task/question)
 * collapse into one ContextToolGroup. Body text splits the run; reasoning does not
 * settle the live label.
 * Other static tools render one row per call (no consecutive merge).
 * Reasoning/justification become inline text.
 * Task and question stay as individual expandable rows.
 * Unknown tools stay as individual expandable rows (fallback).
 */
const aggregateRows = (parts: TurnActivityPart[]): AggregatedRow[] => {
    const rows: AggregatedRow[] = [];

    let i = 0;
    while (i < parts.length) {
        const activity = parts[i];

        if (activity.kind === 'reasoning') {
            if (!extractTextContent(activity.part).trim()) {
                i++;
                continue;
            }
            rows.push({ type: 'reasoning', activity });
            i++;
            continue;
        }

        if (activity.kind === 'justification') {
            rows.push({ type: 'justification', activity });
            i++;
            continue;
        }

        // Tool part
        const toolPart = activity.part as ToolPartType;
        const toolName = toolPart.tool?.toLowerCase() ?? '';

        if (isProcessGroupTool(toolName)) {
            const grouped = collectConsecutiveProcessTools(parts, i, (item) => {
                const tool = item.part as ToolPartType;
                return tool.tool;
            });
            rows.push({
                type: 'tool-context-group',
                activities: grouped.items,
                hasFollowingOtherType: hasProcessSuccessor(parts, grouped.end, (item) => ({
                    kind: item.kind,
                    toolName: (item.part as ToolPartType).tool,
                })),
            });
            i = grouped.end;
            continue;
        }

        if (isSkillGroupTool(toolName)) {
            const grouped = collectConsecutiveSkillTools(parts, i, (item) => {
                const tool = item.part as ToolPartType;
                return tool.tool;
            });
            if (grouped.items.length > 0) {
                rows.push({
                    type: 'tool-skill-group',
                    activities: grouped.items,
                });
                i = grouped.end;
                continue;
            }
        }

        if (isStandaloneTool(toolName)) {
            rows.push({ type: 'tool-expandable', activity });
            i++;
            continue;
        }

        if (isExpandableTool(toolName)) {
            rows.push({ type: 'tool-expandable', activity });
            i++;
            continue;
        }

        if (isStaticTool(toolName)) {
            // One static call per row — flat list, no multi-target chip merge.
            rows.push({ type: 'tool-static-group', toolName, activities: [activity] });
            i++;
            continue;
        }

        // Unknown/fallback tool — keep as expandable
        rows.push({ type: 'tool-fallback', activity });
        i++;
    }

    return rows;
};

/**
 * Render a static tool row (one call).
 * Shows: [icon] DisplayName target
 */
const areActivityListsEqual = (left: TurnActivityPart[], right: TurnActivityPart[]): boolean => {
    if (left === right) {
        return true;
    }

    if (left.length !== right.length) {
        return false;
    }

    for (let index = 0; index < left.length; index += 1) {
        const leftActivity = left[index];
        const rightActivity = right[index];

        if (leftActivity.id !== rightActivity.id) {
            return false;
        }

        if (leftActivity.kind !== rightActivity.kind || leftActivity.endedAt !== rightActivity.endedAt) {
            return false;
        }

        if (!areRenderRelevantPartsEqual([leftActivity.part], [rightActivity.part])) {
            return false;
        }
    }

    return true;
};

const StaticToolRowInner: React.FC<{
    toolName: string;
    activities: TurnActivityPart[];
    isMobile: boolean;
    animateTailText: boolean;
}> = ({ toolName, activities, isMobile, animateTailText }) => {
    const { t } = useI18n();
    const showToolFileIcons = useUIStore((state) => state.showToolFileIcons);
    const displayName = resolveToolDisplayName(toolName, t);
    const icon = getToolIcon(toolName);
    const isReadGroup = toolName.toLowerCase() === 'read';
    const runtime = React.useContext(RuntimeAPIContext);
    const mobileActions = useMobileAppActions();
    const fallbackDirectory = useDirectoryStore((state) => state.currentDirectory);
    const sessionSurface = useSessionSurface();
    const currentDirectory = sessionSurface.kind === 'embedded'
        ? sessionSurface.directory
        : fallbackDirectory;
    const skillsQuery = useInstalledSkillsQuery({ enabled: toolName.toLowerCase() === 'skill' });
    const skills = React.useMemo(() => skillsQuery.data ?? [], [skillsQuery.data]);
    const skillByName = React.useMemo(() => new Map(skills.map((skill) => [skill.name, skill])), [skills]);

    // Rows are one call each; still accept a list so callers can pass a single activity.
    const primaryActivity = activities[0] ?? null;
    const isActive = primaryActivity ? isToolPartActive(primaryActivity.part) : true;
    const description = primaryActivity ? getToolShortDescription(primaryActivity) : null;

    const skillEntry = React.useMemo(() => {
        if (toolName.toLowerCase() !== 'skill' || !primaryActivity || !description) {
            return null as { name: string; path: string } | null;
        }

        const skill = skillByName.get(description);
        const rawPath = skill?.path || getToolSkillDirectory(primaryActivity);
        // Built-in skills are not backed by a real file path.
        if (!rawPath || rawPath === '<built-in>') return null;
        const path = resolveSkillFilePath(rawPath);
        if (!path) return null;
        return { name: description, path };
    }, [description, primaryActivity, skillByName, toolName]);

    const readFileEntry = React.useMemo(() => {
        if (!isReadGroup || !primaryActivity) {
            return null as { path: string; displayPath: string; offset?: number } | null;
        }

        const filePath = getToolFilePath(primaryActivity);
        if (!filePath) return null;
        const displayPath = getRelativeFilePath(filePath, currentDirectory);
        if (!displayPath) return null;
        return {
            path: filePath,
            displayPath,
            offset: getToolReadOffset(primaryActivity),
        };
    }, [currentDirectory, isReadGroup, primaryActivity]);

    const handleReadFileClick = useEvent((filePath: string, offset?: number) => {
        if (!currentDirectory) {
            return;
        }
        const absolutePath = toAbsoluteFilePath(currentDirectory, filePath);
        if (!absolutePath) {
            return;
        }

        // Dedicated mobile: same gesture resizable sheet as Edit/Write diffs.
        if (mobileActions) {
            mobileActions.openFile({
                path: absolutePath,
                targetLine: offset && Number.isFinite(offset) ? Math.max(1, Math.trunc(offset)) : undefined,
            });
            return;
        }

        if (runtime?.editor) {
            void runtime.editor.openFile(absolutePath, offset);
            return;
        }

        if (!isFilePathWithinDirectory(absolutePath, currentDirectory)) {
            void ensureOutsideFileGrantForDesktop(absolutePath, currentDirectory).then(() => {
                const uiStore = useUIStore.getState();
                const contextDirectory = currentDirectory || getDirectoryForFilePath(currentDirectory, absolutePath);
                if (offset && Number.isFinite(offset)) {
                    uiStore.openContextFileAtLine(contextDirectory, absolutePath, Math.max(1, Math.trunc(offset)), 1);
                    return;
                }
                uiStore.openContextFile(contextDirectory, absolutePath);
            });
            return;
        }

        const uiStore = useUIStore.getState();
        const contextDirectory = getDirectoryForFilePath(currentDirectory, absolutePath);
        if (offset && Number.isFinite(offset)) {
            uiStore.openContextFileAtLine(contextDirectory, absolutePath, Math.max(1, Math.trunc(offset)), 1);
            return;
        }
        uiStore.openContextFile(contextDirectory, absolutePath);
    });

    const handleSkillClick = useEvent((skillPath: string) => {
        const absolutePath = normalizeFilePath(skillPath);
        if (!absolutePath) {
            return;
        }

        const openInContext = () => {
            // Dedicated mobile: gesture sheet; desktop keeps context panel.
            if (mobileActions) {
                mobileActions.openFile({ path: absolutePath });
                return;
            }
            const uiStore = useUIStore.getState();
            const contextDirectory = currentDirectory || getDirectoryForFilePath('', absolutePath);
            uiStore.openContextFile(contextDirectory, absolutePath);
        };

        // Skill files are commonly outside the active workspace; mint a grant
        // first so the right-hand FilesView can read them without a 403.
        if (currentDirectory && !isFilePathWithinDirectory(absolutePath, currentDirectory)) {
            void ensureOutsideFileGrantForDesktop(absolutePath, currentDirectory).then(openInContext);
            return;
        }
        openInContext();
    });

    const normalizedToolName = toolName.toLowerCase();
    const isSearchGroup = normalizedToolName === 'grep'
        || normalizedToolName === 'search'
        || normalizedToolName === 'find'
        || normalizedToolName === 'ripgrep'
        || normalizedToolName === 'glob';
    const isFetchGroup = normalizedToolName === 'webfetch' || normalizedToolName === 'fetch' || normalizedToolName === 'curl' || normalizedToolName === 'wget';
    const isSkillGroup = normalizedToolName === 'skill';
    // Read/Skill 与 Edit/Write 一致：整行导航热区
    const isWholeRowNav = Boolean(readFileEntry || skillEntry);
    const canActivateWholeRowNav = Boolean(
        (readFileEntry && currentDirectory)
        || skillEntry
    );

    const handleWholeRowNavClick = useEvent(() => {
        if (!isWholeRowNav || !canActivateWholeRowNav) {
            return;
        }
        if (readFileEntry) {
            handleReadFileClick(readFileEntry.path, readFileEntry.offset);
            return;
        }
        if (skillEntry) {
            handleSkillClick(skillEntry.path);
        }
    });

    const handleWholeRowNavKeyDown = useEvent((event: React.KeyboardEvent<HTMLDivElement>) => {
        if (event.key !== 'Enter' && event.key !== ' ') {
            return;
        }
        event.preventDefault();
        handleWholeRowNavClick();
    });

    return (
        <div
            className={cn(
                'flex w-full items-center gap-x-1.5 min-w-0',
                TOOL_ROW_INTERACTIVE_CHROME_CLASS,
                isWholeRowNav && canActivateWholeRowNav && 'cursor-pointer',
                isWholeRowNav && !canActivateWholeRowNav && 'cursor-default opacity-70',
            )}
            // Full-width nav rows match ToolPart soft press (never compact).
            data-mobile-press-feedback={isWholeRowNav ? 'soft' : undefined}
            onClick={isWholeRowNav ? handleWholeRowNavClick : undefined}
            onKeyDown={isWholeRowNav ? handleWholeRowNavKeyDown : undefined}
            role={isWholeRowNav ? 'button' : undefined}
            tabIndex={isWholeRowNav && canActivateWholeRowNav ? 0 : undefined}
            aria-disabled={isWholeRowNav && !canActivateWholeRowNav ? true : undefined}
        >
            <div className={cn('inline-flex items-center justify-center flex-shrink-0', isMobile ? 'size-4' : 'size-3.5')} style={{ color: 'var(--tools-icon)' }}>
                {isActive ? (
                    <LatticeOrb
                        isMobile={isMobile}
                        label={t('chat.assistantStatus.usingTool', { tool: displayName })}
                    />
                ) : icon}
            </div>
            <span
                className={cn(TOOL_ROW_TITLE_CLASS, 'inline-flex items-center flex-shrink-0 opacity-85')}
                style={{ color: 'var(--tools-title)' }}
                title={displayName}
            >
                {displayName}
            </span>
            {isReadGroup && readFileEntry ? (
                <span
                    className={cn('inline-flex !min-h-0 items-center justify-start gap-1 min-w-0 flex-1 text-left', TOOL_ROW_DESCRIPTION_CLASS)}
                    style={{ color: 'var(--tools-description)' }}
                    title={readFileEntry.offset ? `${readFileEntry.displayPath}:${readFileEntry.offset}` : readFileEntry.displayPath}
                >
                    {showToolFileIcons ? <FileTypeIcon filePath={readFileEntry.path} className="h-3.5 w-3.5" /> : null}
                    {renderReadFilePath(readFileEntry.displayPath, animateTailText)}
                </span>
            ) : null}
            {isSearchGroup && description ? (
                <span className="inline-flex min-w-0 flex-1">
                    <Text
                        variant={animateTailText ? 'generate-effect' : 'static'}
                        className={cn('min-w-0 flex-1 truncate whitespace-nowrap', TOOL_ROW_DESCRIPTION_CLASS)}
                        style={{ color: 'var(--tools-description)' }}
                        title={description}
                    >
                        "{description}"
                    </Text>
                </span>
            ) : null}
            {isFetchGroup && description ? (
                <a
                    href={description}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(event) => {
                        // 避免被整行导航（若未来扩展）吞掉外链
                        event.stopPropagation();
                    }}
                    className={cn(
                        'min-w-0 flex-1 inline-flex items-center gap-1.5 underline decoration-[color:var(--status-info)] underline-offset-2 hover:opacity-90',
                        'truncate whitespace-nowrap', TOOL_ROW_DESCRIPTION_CLASS
                    )}
                    style={{ color: 'var(--status-info)' }}
                    title={description}
                >
                    <ExternalLinkFavicon href={description} />
                    <span className="min-w-0 truncate">{description}</span>
                </a>
            ) : null}
            {isSkillGroup && skillEntry ? (
                <span
                    className={cn('!min-h-0 min-w-0 flex-1 truncate whitespace-nowrap text-left', TOOL_ROW_DESCRIPTION_CLASS)}
                    style={{ color: 'var(--tools-description)' }}
                    title={skillEntry.path}
                >
                    {skillEntry.name}
                </span>
            ) : null}
            {isSkillGroup && !skillEntry && description ? (
                <span
                    className={cn('!min-h-0 min-w-0 flex-1 truncate whitespace-nowrap text-left', TOOL_ROW_DESCRIPTION_CLASS)}
                    style={{ color: 'var(--tools-description)' }}
                    title={description}
                >
                    {description}
                </span>
            ) : null}
            {!isReadGroup && !isSearchGroup && !isFetchGroup && !isSkillGroup && description ? (
                <Text
                    variant={animateTailText ? 'generate-effect' : 'static'}
                    className={cn('min-w-0 flex-1 truncate whitespace-nowrap', TOOL_ROW_DESCRIPTION_CLASS)}
                    style={{ color: 'var(--tools-description)' }}
                >
                    {description}
                </Text>
            ) : null}
        </div>
    );
};

export const StaticToolRow = React.memo(StaticToolRowInner, (prev, next) => {
    return prev.toolName === next.toolName
        && prev.isMobile === next.isMobile
        && prev.animateTailText === next.animateTailText
        && areActivityListsEqual(prev.activities, next.activities);
});

/**
 * Inline reasoning text block — rendered as dimmed italic markdown.
 */
const InlineReasoningBlock = React.memo(({ activity, onContentChange, streamPhase }: {
    activity: TurnActivityPart;
    onContentChange?: (reason?: ContentChangeReason) => void;
    streamPhase: StreamPhase;
}) => {
    return (
        <ReasoningPart
            part={activity.part}
            messageId={activity.messageId}
            streamPhase={streamPhase}
            onContentChange={onContentChange}
        />
    );
});

/**
 * Inline justification text block — rendered as normal assistant text between tools.
 */
const InlineJustificationBlock = React.memo(({ activity, onContentChange, onShowPopup, actions, streamPhase }: {
    activity: TurnActivityPart;
    onContentChange?: (reason?: ContentChangeReason) => void;
    onShowPopup?: (content: ToolPopupContent) => void;
    actions?: React.ReactNode;
    streamPhase: StreamPhase;
}) => {
    return (
        <JustificationBlock
            part={activity.part}
            messageId={activity.messageId}
            onContentChange={onContentChange}
            onShowPopup={onShowPopup}
            actions={actions}
            streamPhase={streamPhase}
        />
    );
});

const ProgressiveGroup: React.FC<ProgressiveGroupProps> = ({
    parts,
    materializationParts = parts,
    isExpanded,
    collapsedPreviewCount = 0,
    completionDisposition,
    activityPresentationKind = 'default',
    durationMs,
    onToggle,
    isMobile,
    expandedTools,
    onToggleTool,
    onShowPopup,
    onContentChange,
    streamPhase,
    showHeader,
    renderJustificationActions,
}) => {
    const { t } = useI18n();
    const effectiveDirectory = useEffectiveDirectory() ?? '';
    const materializationMessageIds = React.useMemo(
        () => getSlimActivityMessageIds(materializationParts),
        [materializationParts],
    );
    const requestedMaterializationIdsRef = React.useRef(new Set<string>());
    const materializationFlightsRef = React.useRef(new Map<string, Promise<void>>());
    const materializationErrorsRef = React.useRef(new Set<string>());
    const [, setMaterializationRevision] = React.useState(0);
    const activityHeaderRef = React.useRef<HTMLButtonElement | null>(null);
    const pendingToggleAnchorRef = React.useRef<{
        top: number;
        scrollContainer: HTMLElement | null;
    } | null>(null);
    const isActive = completionDisposition === 'active';
    // Live elapsed lives only on WorkingPlaceholder (status row). The foldable
    // activity header shows duration only after the turn settles — avoids two
    // counters racing with different tick/round rules while work is in flight.
    const activityDuration = !isActive
        && (completionDisposition === 'normal' || completionDisposition === 'abnormal')
        && typeof durationMs === 'number'
        && Number.isFinite(durationMs)
        && durationMs >= 0
        ? formatActivityDuration(durationMs)
        : null;
    const isCompleted = completionDisposition === 'normal' || completionDisposition === 'abnormal';
    const isCompaction = activityPresentationKind === 'compaction';
    const activityIconName = isCompaction ? 'fold-vertical' : 'stack';
    const activityStatusLabel = completionDisposition === undefined
        ? t('chat.activity.title')
        : isActive
            ? t(isCompaction ? 'chat.activity.compacting' : 'chat.activity.active')
            : isCompleted
                ? t(isCompaction ? 'chat.activity.compactionCompleted' : 'chat.activity.completedStatus')
                : t('chat.activity.title');
    const taskAvatarSeeds = React.useMemo(() => getTaskAvatarSeeds(parts), [parts]);
    const displayedTaskAvatarSeeds = isActive ? taskAvatarSeeds.active : taskAvatarSeeds.all;
    // Cap avatars so the collapsed header stays one line (text is already short).
    const visibleTaskAvatarSeeds = displayedTaskAvatarSeeds.slice(0, isMobile ? 2 : 3);
    const requestMaterialization = useEvent((retryErrorsOnly = false, autoSkipFailed = false) => {
        if (!effectiveDirectory || !materializationMessageIds.length) return;
        for (const targetMessageId of materializationMessageIds) {
            const targetSessionId = materializationParts.find((activity) => activity.messageId === targetMessageId)?.part.sessionID;
            if (!targetSessionId) continue;
            const current = getTranscriptMessageMaterializationState(
                effectiveDirectory,
                targetSessionId,
                targetMessageId,
            );
            if (current.status === 'ready') continue;
            // Background auto-fill must not retry failed messages. A host that
            // keeps answering exact fetches with slim parts keeps the message in
            // `error` forever; auto-retrying re-fires one exact fetch per
            // virtualizer remount (diagnostics: 104 materialize diffs in ~10s
            // with slim/full counts unchanged). Manual expand and the retry
            // button remain the retry paths.
            if (autoSkipFailed && current.status === 'error') continue;
            if (retryErrorsOnly && current.status !== 'error' && !materializationErrorsRef.current.has(targetMessageId)) continue;
            requestedMaterializationIdsRef.current.add(targetMessageId);
            materializationErrorsRef.current.delete(targetMessageId);
            if (materializationFlightsRef.current.has(targetMessageId)) continue;

            // Expand / retry jump the shared exact-fill queue; mount auto-fill
            // (autoSkipFailed) stays background so deep-history remounts cannot
            // starve a user-driven disclosure.
            const flight = materializeTranscriptMessage(
                effectiveDirectory,
                targetSessionId,
                targetMessageId,
                { priority: autoSkipFailed ? 'background' : 'user' },
            )
                .catch(() => {
                    materializationErrorsRef.current.add(targetMessageId);
                })
                .finally(() => {
                    materializationFlightsRef.current.delete(targetMessageId);
                    setMaterializationRevision((revision) => revision + 1);
                });
            materializationFlightsRef.current.set(targetMessageId, flight);
        }
        setMaterializationRevision((revision) => revision + 1);
    });
    const handleRetryMaterialization = useEvent((event: React.MouseEvent<HTMLButtonElement>) => {
        event.stopPropagation();
        requestMaterialization(true);
    });
    // Live processing stays force-expanded: no user collapse, and no indent rail
    // so in-flight tool rows do not jump left/right as the disclosure settles.
    const disclosureLockedOpen = isActive;
    const effectivelyExpanded = disclosureLockedOpen || isExpanded;
    const handleToggle = useEvent(() => {
        if (disclosureLockedOpen) {
            return;
        }
        const header = activityHeaderRef.current;
        pendingToggleAnchorRef.current = header
            ? {
                top: header.getBoundingClientRect().top,
                scrollContainer: header.closest<HTMLElement>('[data-scrollbar="chat"]'),
            }
            : null;
        if (!effectivelyExpanded) {
            requestMaterialization();
        }
        onToggle();
    });
    // Expanded completed groups hydrate slim reasoning/tool bodies after mount.
    // Collapsed groups stay on slim summaries — virtualizer jump-to-top remounts
    // hundreds of folded rows and must not fan out exact session.message fills.
    // Active groups are excluded — their slim parts keep updating via SSE.
    // Failed messages are skipped here (autoSkipFailed) so a permanently slim
    // host record cannot turn every remount into another exact fetch.
    React.useEffect(() => {
        if (isActive || !effectivelyExpanded) {
            return;
        }
        requestMaterialization(false, true);
    }, [isActive, effectivelyExpanded]);
    React.useLayoutEffect(() => {
        const anchor = pendingToggleAnchorRef.current;
        const header = activityHeaderRef.current;
        if (!anchor || !header) {
            return;
        }

        const restoreHeaderPosition = () => {
            if (!header.isConnected) {
                return;
            }
            const delta = header.getBoundingClientRect().top - anchor.top;
            if (Math.abs(delta) < 0.5) {
                return;
            }
            if (anchor.scrollContainer?.isConnected) {
                anchor.scrollContainer.scrollTop += delta;
                return;
            }
            window.scrollBy(0, delta);
        };

        restoreHeaderPosition();
        if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
            pendingToggleAnchorRef.current = null;
            return;
        }
        const frame = window.requestAnimationFrame(() => {
            restoreHeaderPosition();
            pendingToggleAnchorRef.current = null;
        });
        return () => window.cancelAnimationFrame(frame);
    }, [effectivelyExpanded]);
    const previewCount = showHeader && !effectivelyExpanded
        ? Math.max(0, Math.floor(collapsedPreviewCount))
        : 0;
    const shouldRenderRows = !showHeader || effectivelyExpanded || previewCount > 0;
    const requestedMessageIds = requestedMaterializationIdsRef.current;
    const requestedStatuses = [...requestedMessageIds]
        .map((targetMessageId): MaterializationStatus => {
            if (materializationFlightsRef.current.has(targetMessageId)) return 'loading';
            if (materializationErrorsRef.current.has(targetMessageId)) return 'error';
            const targetSessionId = materializationParts.find((activity) => activity.messageId === targetMessageId)?.part.sessionID ?? '';
            return getTranscriptMessageMaterializationState(effectiveDirectory, targetSessionId, targetMessageId).status;
        });
    const isMaterializationLoading = requestedStatuses.includes('loading');
    const hasMaterializationError = requestedStatuses.includes('error');
    const materializationReady = requestedStatuses.length > 0 && requestedStatuses.every((status) => status === 'ready');
    const requestedPartsStillSlim = materializationParts.some((activity) => (
        requestedMessageIds.has(activity.messageId) && isSlimMaterializablePart(activity)
    ));
    const showEmptyMaterialization = materializationReady
        && !requestedPartsStillSlim
        && !hasMaterializedActivityOutput(materializationParts, requestedMessageIds);

    const sortedParts = React.useMemo(() => {
        if (!shouldRenderRows) {
            return EMPTY_ACTIVITY_PARTS;
        }
        return sortPartsByTime(parts);
    }, [parts, shouldRenderRows]);

    const rows = React.useMemo(() => {
        if (!shouldRenderRows) {
            return [] as AggregatedRow[];
        }
        return aggregateRows(sortedParts);
    }, [shouldRenderRows, sortedParts]);

    const previewHiddenCount = React.useMemo(() => {
        if (effectivelyExpanded || previewCount === 0) {
            return 0;
        }
        return Math.max(0, rows.length - previewCount);
    }, [effectivelyExpanded, previewCount, rows.length]);

    const visibleRows = React.useMemo(() => {
        if (effectivelyExpanded || previewCount === 0) {
            return rows;
        }
        return rows.slice(-previewCount);
    }, [effectivelyExpanded, previewCount, rows]);

    // Header-only turns (e.g. completed compaction with foldable body text outside
    // activity rows) must still paint the disclosure chrome when showHeader is set.
    // Live non-compaction with zero rows stays hidden — the Working header alone
    // above WorkingPlaceholder is empty chrome; show it once the first row exists.
    if ((!showHeader || (disclosureLockedOpen && !isCompaction)) && rows.length === 0) {
        return null;
    }

    const wrapRow = (key: string, content: React.ReactNode) => {
        const row = <div className={getToolRowBlockClass(isMobile)}>{content}</div>;
        return <React.Fragment key={key}>{row}</React.Fragment>;
    };

    const renderedRows = shouldRenderRows
        ? visibleRows.map((row, index) => {
        switch (row.type) {
            case 'reasoning':
                return wrapRow(
                    row.activity.id,
                    <>
                        <InlineReasoningBlock
                            activity={row.activity}
                            streamPhase={streamPhase}
                            onContentChange={onContentChange}
                        />
                    </>
                );

            case 'justification':
                return wrapRow(
                    row.activity.id,
                    <>
                        <InlineJustificationBlock
                            activity={row.activity}
                            onContentChange={onContentChange}
                            onShowPopup={onShowPopup}
                            actions={renderJustificationActions?.(row.activity)}
                            streamPhase={streamPhase}
                        />
                    </>
                );

            case 'tool-expandable':
                return (
                    <MemoExpandableToolRow
                        key={row.activity.id}
                        activity={row.activity}
                        isExpanded={expandedTools.has(row.activity.id)}
                        isMobile={isMobile}
                        onToggleTool={onToggleTool}
                        onShowPopup={onShowPopup}
                        onContentChange={onContentChange}
                    />
                );

            case 'tool-static-group':
                return (
                    <MemoStaticGroupedToolRow
                        key={row.activities[0]?.id ?? `static-${row.toolName}-${index}`}
                        toolName={row.toolName}
                        activities={row.activities}
                        isMobile={isMobile}
                    />
                );

            case 'tool-context-group':
                return (
                    <ContextToolGroup
                        key={row.activities[0]?.id ?? `context-${index}`}
                        activities={row.activities}
                        isMobile={isMobile}
                        isTurnLive={isActive}
                        hasFollowingOtherType={row.hasFollowingOtherType}
                    >
                        {row.activities.map((activity) => {
                            const groupedTool = activity.part as ToolPartType;
                            const groupedToolName = groupedTool.tool?.toLowerCase() ?? '';
                            if (isContextGroupTool(groupedToolName)) {
                                return (
                                    <StaticToolRow
                                        key={activity.id}
                                        toolName={groupedToolName}
                                        activities={[activity]}
                                        isMobile={isMobile}
                                        animateTailText={false}
                                    />
                                );
                            }
                            return (
                                <ToolPart
                                    key={activity.id}
                                    part={groupedTool}
                                    messageId={activity.messageId}
                                    isExpanded={expandedTools.has(activity.id)}
                                    onToggle={onToggleTool}
                                    isMobile={isMobile}
                                    onContentChange={onContentChange}
                                    onShowPopup={onShowPopup}
                                    animateTailText={false}
                                />
                            );
                        })}
                    </ContextToolGroup>
                );

            case 'tool-skill-group':
                return (
                    <SkillToolGroup
                        key={row.activities[0]?.id ?? `skill-${index}`}
                        activities={row.activities}
                        isMobile={isMobile}
                    >
                        {row.activities.map((activity) => {
                            const groupedTool = activity.part as ToolPartType;
                            return (
                                <StaticToolRow
                                    key={activity.id}
                                    toolName={groupedTool.tool?.toLowerCase() ?? ''}
                                    activities={[activity]}
                                    isMobile={isMobile}
                                    animateTailText={false}
                                />
                            );
                        })}
                    </SkillToolGroup>
                );

            case 'tool-fallback':
                return (
                    <MemoExpandableToolRow
                        key={row.activity.id}
                        activity={row.activity}
                        isExpanded={expandedTools.has(row.activity.id)}
                        isMobile={isMobile}
                        onToggleTool={onToggleTool}
                        onShowPopup={onShowPopup}
                        onContentChange={onContentChange}
                    />
                );

            default:
                return null;
        }
    })
        : null;

    // Empty expanded disclosures (e.g. compaction with only foldable body text
    // outside activity rows) keep the header and skip the empty rail.
    const shouldShowRowsContainer = visibleRows.length > 0;
    if (!showHeader) {
        return (
            <div className={getToolRowBlockClass(isMobile)}>{renderedRows}</div>
        );
    }

    return (
        <div className={getToolRowBlockClass(isMobile)}>
                    <button
                        ref={activityHeaderRef}
                        type="button"
                        className={cn(
                            // Full-width row: left grows (flex-1), right trailer stays at the trailing edge.
                            'group/tool flex w-full min-w-0 flex-nowrap items-center text-left',
                            isMobile ? 'gap-x-1' : 'gap-x-2',
                            // Locked-open live headers are not a disclosure control — drop chip hover/cursor.
                            !disclosureLockedOpen && TOOL_ROW_INTERACTIVE_CHROME_CLASS,
                            disclosureLockedOpen && `oc-tool-row -mx-2 ${TOOL_ROW_CHIP_GEOMETRY_CLASS} cursor-default`,
                            // Mobile only: drop chip pr so the chevron has no dead trailing slot.
                            // Desktop keeps px-2 so hover wash padding matches left (symmetric rounded chip).
                            isMobile && 'pr-0',
                        )}
                        data-mobile-press-feedback={disclosureLockedOpen ? undefined : 'soft'}
                        onClick={disclosureLockedOpen ? undefined : handleToggle}
                        aria-expanded={effectivelyExpanded}
                        aria-disabled={disclosureLockedOpen || undefined}
                        aria-label={disclosureLockedOpen
                            ? activityStatusLabel
                            : effectivelyExpanded
                                ? t('chat.activity.collapseAria')
                                : t('chat.activity.expandAria')}
                    >
                    <span className={cn(
                        // flex-1 absorbs free space so the trailer is pushed to the row end.
                        // overflow-clip (not overflow-hidden): mobile.css rewrites
                        // .overflow-hidden → overflow-y:auto and shows an Android scrollbar.
                        'inline-flex min-w-0 flex-1 items-center overflow-clip',
                        isMobile ? 'gap-x-1' : 'gap-x-1.5',
                    )}>
                        <span
                            className={cn(
                                'inline-flex flex-none items-center justify-center',
                                isMobile ? 'h-5 w-4' : 'h-6 w-3.5',
                            )}
                            style={{ color: 'var(--tools-icon)' }}
                        >
                            {isActive && !isCompaction ? (
                                <LatticeOrb
                                    isMobile={isMobile}
                                    label={activityStatusLabel}
                                    className="block"
                                />
                            ) : (
                                <Icon name={activityIconName} className="h-3.5 w-3.5" />
                            )}
                        </span>
                        <span className={cn(
                            'inline-flex flex-shrink-0 items-center',
                            // Mobile matches tool-row body (meta); desktop keeps label emphasis.
                            isMobile ? 'typography-meta h-5' : 'typography-ui-label h-5 font-semibold',
                            isActive
                                ? 'animate-text-shimmer text-[var(--status-info)] [--oc-text-shimmer-base:var(--status-info)]'
                                : 'text-foreground/85',
                        )}>
                            {activityStatusLabel}
                        </span>
                        {activityDuration ? (
                            <span className="typography-meta shrink-0 tabular-nums text-muted-foreground">{activityDuration}</span>
                        ) : null}
                    </span>
                    {/* Trailer: agents (optional) + chevron — always the rightmost content. */}
                    <span className={cn(
                        'ml-auto inline-flex max-w-[min(14rem,55%)] shrink-0 items-center justify-end',
                        isMobile ? 'gap-0.5' : 'gap-1',
                    )}>
                        {displayedTaskAvatarSeeds.length > 0 ? (
                            <span className={cn(
                                'inline-flex min-w-0 items-center text-muted-foreground',
                                isMobile ? 'gap-1' : 'gap-1.5',
                            )}>
                                <span className="inline-flex shrink-0 items-center gap-0.5" aria-hidden="true">
                                    {visibleTaskAvatarSeeds.map((seed, index) => (
                                        <AgentAvatar
                                            key={`${seed}-${index}`}
                                            name={seed}
                                            size={isMobile ? 12 : 14}
                                            className={cn(
                                                'flex-none',
                                                isMobile
                                                    ? 'size-3 min-h-3 min-w-3 max-h-3 max-w-3'
                                                    : 'size-3.5 min-h-3.5 min-w-3.5 max-h-3.5 max-w-3.5',
                                            )}
                                        />
                                    ))}
                                </span>
                                <span className="typography-meta min-w-0 truncate">
                                    {isActive
                                        ? t('chat.activity.agentsWorking', { count: displayedTaskAvatarSeeds.length })
                                        : t('chat.activity.agentsInvolved', { count: displayedTaskAvatarSeeds.length })}
                                </span>
                            </span>
                        ) : null}
                        {!disclosureLockedOpen ? (
                            <Icon
                                name={effectivelyExpanded ? 'arrow-down-s' : 'arrow-right-s'}
                                className={cn(
                                    'flex-shrink-0 text-muted-foreground opacity-70',
                                    // Mobile optical pull after pr-0; desktop keeps chip padding intact for hover wash.
                                    isMobile && '-mr-0.5',
                                    isMobile ? 'size-3' : 'size-3.5',
                                )}
                            />
                        ) : null}
                    </span>
                    </button>
                {shouldShowRowsContainer ? (
                    <div className={disclosureLockedOpen ? undefined : 'relative ml-2 pl-3'}>
                        {!disclosureLockedOpen ? (
                            <span
                                aria-hidden="true"
                                className="pointer-events-none absolute left-0 top-px bottom-0 w-px opacity-40"
                                style={{ backgroundColor: 'var(--tools-border)' }}
                            />
                        ) : null}
                        {previewHiddenCount > 0 ? (
                            <button
                                type="button"
                                onClick={handleToggle}
                                className="typography-meta leading-4 px-2 py-1 text-muted-foreground/45 hover:text-muted-foreground/65 text-left"
                            >
                                +{previewHiddenCount} more...
                            </button>
                        ) : null}
                        <div className="flow-root">{renderedRows}</div>
                    </div>
                ) : null}
                {effectivelyExpanded && (isMaterializationLoading || hasMaterializationError || showEmptyMaterialization) ? (
                    <div
                        className={cn(
                            'typography-meta flex min-h-9 items-center gap-2 px-2 text-muted-foreground',
                            disclosureLockedOpen ? undefined : 'ml-5',
                            hasMaterializationError && 'text-[var(--status-error)]',
                        )}
                        role={hasMaterializationError ? 'alert' : 'status'}
                    >
                        {isMaterializationLoading ? (
                            <>
                                <Icon name="loader-4" className="size-3.5 shrink-0 animate-spin" />
                                <span>{t('chat.activity.outputLoading')}</span>
                            </>
                        ) : hasMaterializationError ? (
                            <>
                                <Icon name="error-warning" className="size-3.5 shrink-0" />
                                <span className="min-w-0 flex-1">{t('chat.activity.outputLoadFailed')}</span>
                                <Button type="button" variant="ghost" size="xs" onClick={handleRetryMaterialization}>
                                    {t('chat.activity.outputRetry')}
                                </Button>
                            </>
                        ) : (
                            <span>{t('chat.toolOutputDialog.noOutputProduced')}</span>
                        )}
                    </div>
                ) : null}
        </div>
    );
};

export default React.memo(ProgressiveGroup);
