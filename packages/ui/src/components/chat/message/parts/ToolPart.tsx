
import React from 'react';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import { PatchDiff } from '@pierre/diffs/react';
import { cn } from '@/lib/utils';
import { SimpleMarkdownRenderer } from '../../MarkdownRenderer';
import { getToolMetadata } from '@/lib/toolHelpers';
import type { ToolPart as ToolPartType, ToolState as ToolStateUnion } from '@opencode-ai/sdk/v2';
import { toolDisplayStyles } from '@/lib/typography';
import { WorkerHighlightedCode } from '@/components/code/WorkerHighlightedCode';
import { useOptionalThemeSystem } from '@/contexts/useThemeSystem';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessionMessageRecords, useEnsureSessionMessages, useSessionStatus, useSessionStatusObservedAt, useSessionStatusSnapshotAt } from '@/sync/sync-context';
import { useUIStore } from '@/stores/useUIStore';
import { sessionEvents } from '@/lib/sessionEvents';
import { ScrollShadow } from '@/components/ui/ScrollShadow';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { Text } from '@/components/ui/text';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { copyTextToClipboard } from '@/lib/clipboard';
import type { ContentChangeReason } from '@/hooks/useChatAutoFollow';
import type { ToolPopupContent } from '../types';
import { ensurePierreThemeRegistered } from '@/lib/shiki/appThemeRegistry';
import { getDefaultTheme } from '@/lib/theme/themes';
import { ensureOutsideFileGrantForDesktop } from '@/lib/outsideFileGrants';
import { getDirectoryForFilePath, isFilePathWithinDirectory, toAbsoluteFilePath } from '@/lib/path-utils';

import { TOOL_ROW_CHIP_CLASS, TOOL_ROW_INTERACTIVE_CHROME_CLASS } from './toolRowChrome';
import {
    formatEditOutput,
    detectLanguageFromOutput,
    formatInputForDisplay,
    renderTodoOutput,
    tryParseJsonOutput,
    coerceToText,
} from '../toolRenderers';
import { JsonTreeViewer } from '@/components/ui/JsonTreeViewer';
import { JsonSummaryView } from './JsonSummaryView';
import { Icon } from "@/components/icon/Icon";
import { AgentAvatar } from '@/components/chat/AgentAvatar';
import { type DiffViewMode } from '../DiffViewToggle';
import { MinDurationShineText } from './MinDurationShineText';
import { ToolRevealOnMount } from './ToolRevealOnMount';
import { getToolIcon } from './toolPresentation';
import { useDurationTickerNow } from './useDurationTicker';
import {
    buildTaskSummaryEntriesFromSession,
    normalizeTaskSummaryEntries,
    parseTaskMetadataBlock,
    readTaskSessionIdFromOutput,
    readTaskSessionIdFromRecord,
    prepareTaskOutputForDisplay,
    type TaskToolSummaryEntry,
} from './taskToolModel';
import { shouldSuppressTaskLoading } from './shouldSuppressTaskLoading';
import { areRenderRelevantPartsEqual } from '../renderCompare';
import { useI18n } from '@/lib/i18n';
import { getDiffPatchEntries, getPatchText, getToolNavigationDiffEntries } from './toolDiffUtils';
import { useDeferredToolHydration } from './deferredToolHydrationContext';
import { scheduleAfterPaintTask } from '@/lib/afterPaintTaskQueue';
import { DualLimitLru } from '@/lib/dualLimitLru';
import { isEmbeddedSessionChat } from '@/components/layout/contextPanelEmbeddedChat';
import { useMobileAppActions } from '@/apps/mobileAppContext';
import { todoToolListClassName, todoToolScrollOptions } from '@/components/chat/statusBarPopover';
import {
    getToolExpandedContentClassName,
    getToolScrollableSectionPaddingClassName,
    MOBILE_SHELL_CODE_LINE_HEIGHT,
    TOOL_EXPANDED_TIMELINE_CLASS_NAME,
} from './toolExpandedLayout';
import { navigateNestedSession, useSessionSurface } from '../../SessionSurfaceContext';

const TOOL_ROW_TEXT_CLASS = '!text-[length:var(--text-meta)] !leading-5 sm:!leading-6 tracking-normal';
const TOOL_ROW_TITLE_CLASS = cn('typography-meta font-medium', TOOL_ROW_TEXT_CLASS);
const TOOL_ROW_DESCRIPTION_CLASS = cn('typography-meta', TOOL_ROW_TEXT_CLASS);
/** Agent Task 内部摘要行：比工具标题小一号，行高与行距保持匀称 */
const TASK_SUMMARY_TEXT_CLASS = 'typography-micro !text-[length:calc(var(--text-meta)-0.0625rem)] !leading-5 tracking-normal';
const TASK_SUMMARY_LIST_CLASS = 'flex w-full min-w-0 flex-col gap-1';

/** 从 task input 解析子 Agent 名（OpenCode 子 Agent 不一定在主选择器里） */
const resolveTaskAgentName = (input: Record<string, unknown> | undefined): string | undefined => {
    if (!input) return undefined;
    // 优先官方 task 字段；兼容偶发的 agent / subagent 别名
    const candidates = [input.subagent_type, input.agent, input.subagent];
    for (const raw of candidates) {
        if (typeof raw !== 'string') continue;
        const trimmed = raw.trim();
        if (trimmed.length > 0) return trimmed;
    }
    return undefined;
};

/** 与 MessageHeader / Agent 选择器一致的昵称首字母大写 */
const formatAgentDisplayName = (name: string): string =>
    name.length > 0 ? name.charAt(0).toUpperCase() + name.slice(1) : name;
const hydratedHistoricalToolIds = new DualLimitLru<string, true>({
    maxEntries: 2000,
    maxBytes: 256 * 1024,
});

type ToolStateWithMetadata = ToolStateUnion & { metadata?: Record<string, unknown>; input?: Record<string, unknown>; output?: string; error?: string; time?: { start: number; end?: number } };

interface ToolPartProps {
    part: ToolPartType;
    messageId?: string;
    isExpanded: boolean;
    onToggle: (toolId: string) => void;
    isMobile: boolean;
    alwaysShowActions?: boolean;
    onContentChange?: (reason?: ContentChangeReason) => void;
    onShowPopup?: (content: ToolPopupContent) => void;
    animateTailText?: boolean;
}

const getMultiFileDescription = (
    metadata: Record<string, unknown> | undefined,
    animate = true,
    showFileIcons = true,
): React.ReactNode => {
    const files = Array.isArray(metadata?.files) ? metadata?.files : [];
    if (files.length <= 1) return null;

    const parseCount = (value: unknown): number | null => {
        if (typeof value === 'number' && Number.isFinite(value)) {
            return Math.max(0, Math.trunc(value));
        }
        if (typeof value === 'string') {
            const parsed = Number.parseInt(value, 10);
            if (Number.isFinite(parsed)) {
                return Math.max(0, parsed);
            }
        }
        return null;
    };

    const combineCounts = (base: number | null, incoming: number | null): number | null => {
        if (base === null) return incoming;
        if (incoming === null) return base;
        return base + incoming;
    };

    const entriesByPath = new Map<string, { path: string; name: string; added: number | null; removed: number | null }>();

    for (const file of files) {
        const fileObj = file as { relativePath?: string; filePath?: string; additions?: unknown; deletions?: unknown };
        const filePath = fileObj.relativePath || fileObj.filePath || '';
        if (!filePath) continue;
        const fileName = filePath.split('/').pop() || filePath;
        const added = parseCount(fileObj.additions);
        const removed = parseCount(fileObj.deletions);

        const existing = entriesByPath.get(filePath);
        if (existing) {
            existing.added = combineCounts(existing.added, added);
            existing.removed = combineCounts(existing.removed, removed);
            continue;
        }

        entriesByPath.set(filePath, { path: filePath, name: fileName, added, removed });
    }

    const entries = Array.from(entriesByPath.values());

    return (
        <>
            {entries.map((entry) => {
                const hasPerFileDiff = entry.added !== null || entry.removed !== null;
                return (
                    <span key={entry.path} className={cn('inline-flex min-w-0 max-w-full items-center gap-1', TOOL_ROW_DESCRIPTION_CLASS)} style={{ color: 'var(--tools-description)' }}>
                        {showFileIcons ? <FileTypeIcon filePath={entry.path} className="h-3.5 w-3.5" /> : null}
                        <Text
                            variant={animate ? 'generate-effect' : 'static'}
                            className={cn('min-w-0 max-w-full truncate', TOOL_ROW_DESCRIPTION_CLASS)}
                            style={{ color: 'var(--tools-description)' }}
                            title={entry.path}
                        >
                            {entry.name}
                        </Text>
                        {hasPerFileDiff ? (
                            <span className="flex-shrink-0 inline-flex items-center gap-0 typography-meta" style={{ fontSize: '0.8rem', lineHeight: '1' }}>
                                <span style={{ color: 'var(--status-success)' }}>+{entry.added ?? 0}</span>
                                <span style={{ color: 'var(--tools-description)' }}>/</span>
                                <span style={{ color: 'var(--status-error)' }}>-{entry.removed ?? 0}</span>
                            </span>
                        ) : null}
                    </span>
                );
            })}
        </>
    );
};

const normalizeToolName = (toolName: string | undefined | null): string => {
    if (typeof toolName !== 'string') {
        return '';
    }

    const trimmed = toolName.trim().toLowerCase();
    if (!trimmed) {
        return '';
    }

    if (trimmed.includes('.')) {
        const dotParts = trimmed.split('.').filter(Boolean);
        const last = dotParts[dotParts.length - 1];
        if (last) return last;
    }

    return trimmed;
};

const MAX_DURATION_MS = 5 * 60 * 1000; // 5 minutes cap
const GIT_REFRESH_MUTATING_TOOLS = new Set([
    'bash',
    'edit',
    'write',
    'apply_patch',
    'patch',
    'task',
]);

/** Edit/write 类：不展开，点击在右侧打开改动行（与 Read 同属导航工具） */
const FILE_NAV_TOOL_NAMES = new Set([
    'edit',
    'multiedit',
    'apply_patch',
    'write',
    'create',
    'file_write',
]);

const isFileNavToolName = (toolName: string): boolean => FILE_NAV_TOOL_NAMES.has(toolName);

const formatDuration = (start: number, end?: number, now: number = Date.now()) => {
    const duration = Math.min(Math.max(0, (end ?? now) - start), MAX_DURATION_MS);
    const seconds = duration / 1000;

    const displaySeconds = seconds < 0.05 && end !== undefined ? 0.1 : seconds;
    return `${displaySeconds.toFixed(1)}s`;
};

const LiveDuration: React.FC<{ start: number; end?: number; active: boolean }> = ({ start, end, active }) => {
    const now = useDurationTickerNow(active, 250);

    return <>{formatDuration(start, end, now)}</>;
};

const deferredToolBodyMounts: Array<{ active: boolean; fn: () => void }> = [];
let deferredToolBodyFrame: number | undefined;

const flushDeferredToolBodyMounts = () => {
    while (deferredToolBodyMounts.length > 0) {
        const item = deferredToolBodyMounts.pop();
        if (!item) {
            break;
        }
        if (item.active) {
            item.fn();
            deferredToolBodyFrame = deferredToolBodyMounts.length > 0
                ? window.requestAnimationFrame(flushDeferredToolBodyMounts)
                : undefined;
            return;
        }
    }

    deferredToolBodyFrame = undefined;
};

const scheduleDeferredToolBodyMount = (fn: () => void) => {
    if (typeof window === 'undefined') {
        fn();
        return () => undefined;
    }

    const item = { active: true, fn };
    deferredToolBodyMounts.push(item);

    if (deferredToolBodyFrame === undefined) {
        deferredToolBodyFrame = window.requestAnimationFrame(() => {
            deferredToolBodyFrame = window.requestAnimationFrame(flushDeferredToolBodyMounts);
        });
    }

    return () => {
        item.active = false;
    };
};

const useDeferredExpandedContent = (isExpanded: boolean) => {
    // If the tool is expanded when the row first mounts (e.g. "show tools open
    // by default", or scrolling a default-open tool back into a virtualized
    // view), render the body SYNCHRONOUSLY so the virtualizer measures the real
    // height immediately. Deferring it would let the row mount short and grow a
    // frame later, which makes the virtualizer compensate scroll and lurch the
    // viewport past several messages on slow scroll. Only defer LATER
    // user-initiated expansions, where instant single-item feedback isn't worth
    // blocking the click on a heavy body render.
    const [shouldRender, setShouldRender] = React.useState(isExpanded);
    const mountedRef = React.useRef(false);

    React.useEffect(() => {
        if (!isExpanded) {
            mountedRef.current = true;
            setShouldRender(false);
            return;
        }

        if (!mountedRef.current) {
            mountedRef.current = true;
            setShouldRender(true);
            return;
        }

        return scheduleDeferredToolBodyMount(() => {
            React.startTransition(() => {
                setShouldRender(true);
            });
        });
    }, [isExpanded]);

    return shouldRender;
};

const parseDiffStats = (metadata?: Record<string, unknown>): { added: number; removed: number } | null => {
    const diffText = getPatchText((metadata as { patch?: unknown } | undefined)?.patch)
        ?? getPatchText(metadata?.diff);
    if (!diffText) return null;

    let added = 0;
    let removed = 0;
    let lineStart = 0;

    for (let index = 0; index <= diffText.length; index += 1) {
        if (index < diffText.length && diffText.charCodeAt(index) !== 10) {
            continue;
        }

        const line = diffText.slice(lineStart, index);
        if (line.startsWith('+') && !line.startsWith('+++')) added++;
        if (line.startsWith('-') && !line.startsWith('---')) removed++;
        lineStart = index + 1;
    }

    if (added === 0 && removed === 0) return null;
    return { added, removed };
};

const parseWriteLineCount = (input?: Record<string, unknown>): number | null => {
    if (!input?.content || typeof input.content !== 'string') return null;
    let lines = 1;
    for (let index = 0; index < input.content.length; index += 1) {
        if (input.content.charCodeAt(index) === 10) {
            lines += 1;
        }
    }
    return lines;
};

const extractFirstChangedLineFromDiff = (diffText: string): number | undefined => {
    if (!diffText || typeof diffText !== 'string') {
        return undefined;
    }

    const lines = diffText.split('\n');
    let currentNewLine: number | undefined;
    let firstHunkStart: number | undefined;

    for (const rawLine of lines) {
        const line = rawLine.replace(/\r$/, '');
        const hunkMatch = line.match(/^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
        if (hunkMatch) {
            const parsed = Number.parseInt(hunkMatch[1] ?? '', 10);
            if (Number.isFinite(parsed)) {
                currentNewLine = Math.max(1, parsed);
                if (!Number.isFinite(firstHunkStart)) {
                    firstHunkStart = currentNewLine;
                }
            }
            continue;
        }

        if (currentNewLine === undefined || !Number.isFinite(currentNewLine)) {
            continue;
        }

        if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ')) {
            continue;
        }

        if (line.startsWith('+')) {
            return currentNewLine;
        }

        if (line.startsWith(' ')) {
            currentNewLine += 1;
            continue;
        }

        if (line.startsWith('-') || line.startsWith('\\')) {
            continue;
        }
    }

    return firstHunkStart;
};

const buildWritePreviewPatch = (filePath: string | undefined, content: string): string | undefined => {
    const normalizedContent = content.replace(/\r\n/g, '\n');
    if (!normalizedContent.trim()) {
        return undefined;
    }

    const normalizedPath = (() => {
        const candidate = (filePath ?? '').trim();
        if (!candidate) {
            return 'new-file';
        }
        return candidate.startsWith('/') ? candidate.slice(1) : candidate;
    })();

    const lines = normalizedContent.split('\n');
    const hunkSize = lines.length;
    const body = lines.map((line) => `+${line}`).join('\n');

    return [
        '--- /dev/null',
        `+++ b/${normalizedPath}`,
        `@@ -0,0 +1,${hunkSize} @@`,
        body,
    ].join('\n');
};

const getFirstChangedLineFromMetadata = (
    tool: string,
    metadata?: Record<string, unknown>,
    preferredPath?: string,
): number | undefined => {
    if (!metadata || (tool !== 'edit' && tool !== 'multiedit' && tool !== 'apply_patch')) {
        return undefined;
    }

    const primaryDiff = getPrimaryDiffFromMetadata(tool, metadata, preferredPath);
    if (primaryDiff) {
        const line = extractFirstChangedLineFromDiff(primaryDiff);
        if (Number.isFinite(line)) {
            return line;
        }
    }

    return undefined;
};

const getPrimaryDiffFromMetadata = (
    tool: string,
    metadata?: Record<string, unknown>,
    preferredPath?: string,
): string | undefined => {
    if (!metadata || (tool !== 'edit' && tool !== 'multiedit' && tool !== 'apply_patch')) {
        return undefined;
    }

    const files = Array.isArray(metadata.files) ? metadata.files : [];
    if (files.length > 0) {
        const preferred = typeof preferredPath === 'string' && preferredPath.length > 0
            ? preferredPath
            : undefined;
        const matched = preferred
            ? files.find((file) => {
                if (!file || typeof file !== 'object') {
                    return false;
                }
                const candidate = file as { relativePath?: unknown; filePath?: unknown; movePath?: unknown };
                return candidate.relativePath === preferred || candidate.filePath === preferred || candidate.movePath === preferred;
            })
            : files[0];

        if (matched && typeof matched === 'object') {
            const patch = getPatchText((matched as { patch?: unknown; diff?: unknown }).patch)
                ?? getPatchText((matched as { patch?: unknown; diff?: unknown }).diff);
            if (patch) {
                return patch;
            }
        }
    }

    const fileDiff = metadata.filediff;
    if (fileDiff && typeof fileDiff === 'object') {
        const patch = getPatchText((fileDiff as { patch?: unknown }).patch)
            ?? getPatchText((fileDiff as { diff?: unknown }).diff);
        if (patch) {
            return patch;
        }
    }

    const topLevelPatch = getPatchText((metadata as { patch?: unknown }).patch) ?? getPatchText(metadata.diff);
    if (topLevelPatch) {
        return topLevelPatch;
    }

    return undefined;
};

const normalizeDisplayPath = (value: string): string => {
    const trimmed = value.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/');
    if (!trimmed || trimmed === '/') {
        return trimmed;
    }
    return trimmed.replace(/\/+$/, '');
};

const getRelativePath = (absolutePath: string, currentDirectory: string): string => {
    const normalizedAbsolutePath = normalizeDisplayPath(absolutePath);
    const normalizedCurrentDirectory = normalizeDisplayPath(currentDirectory);

    if (!normalizedAbsolutePath) {
        return '';
    }

    if (!normalizedCurrentDirectory) {
        return normalizedAbsolutePath;
    }

    if (normalizedAbsolutePath === normalizedCurrentDirectory) {
        return '.';
    }

    const prefix = `${normalizedCurrentDirectory}/`;
    if (normalizedAbsolutePath.startsWith(prefix)) {
        return normalizedAbsolutePath.slice(prefix.length);
    }

    return normalizedAbsolutePath;
};

type ToolDiagnostic = {
    message: string;
    line: number;
    character: number;
};

type ToolDiagnosticSection = {
    displayPath: string;
    diagnostics: ToolDiagnostic[];
    remaining: number;
};

const TOOL_DIAGNOSTICS_MAX_PER_FILE = 5;

const isRecord = (value: unknown): value is Record<string, unknown> => {
    return typeof value === 'object' && value !== null;
};

const normalizeToolDiagnostic = (value: unknown): ToolDiagnostic | null => {
    if (!isRecord(value)) {
        return null;
    }

    const message = typeof value.message === 'string' ? value.message.trim() : '';
    if (!message) {
        return null;
    }

    const severity = typeof value.severity === 'number' && Number.isFinite(value.severity) ? Math.trunc(value.severity) : undefined;
    if (severity !== undefined && severity !== 1) {
        return null;
    }

    const range = isRecord(value.range) ? value.range : undefined;
    const start = range && isRecord(range.start) ? range.start : undefined;
    const rawLine = typeof start?.line === 'number' && Number.isFinite(start.line) ? Math.max(0, Math.trunc(start.line)) : 0;
    const rawCharacter = typeof start?.character === 'number' && Number.isFinite(start.character)
        ? Math.max(0, Math.trunc(start.character))
        : 0;

    return {
        message,
        line: rawLine + 1,
        character: rawCharacter + 1,
    };
};

const getPrimaryToolPath = (
    toolName: string,
    input: Record<string, unknown> | undefined,
    metadata: Record<string, unknown> | undefined,
): string | null => {
    const fileDiff = isRecord(metadata?.filediff) ? metadata.filediff : undefined;
    const fileDiffPath = isRecord(fileDiff) && typeof fileDiff.file === 'string' ? fileDiff.file : null;

    if (toolName === 'apply_patch') {
        const files = Array.isArray(metadata?.files) ? metadata.files : [];
        const first = files.find((entry) => {
            if (!isRecord(entry)) {
                return false;
            }
            return typeof entry.movePath === 'string'
                || typeof entry.filePath === 'string'
                || typeof entry.relativePath === 'string';
        });
        if (isRecord(first)) {
            return typeof first.movePath === 'string'
                ? first.movePath
                : typeof first.filePath === 'string'
                    ? first.filePath
                    : typeof first.relativePath === 'string'
                        ? first.relativePath
                        : fileDiffPath;
        }
        const fallbackDiff = getPatchText(metadata?.patch) ?? getPatchText(metadata?.diff);
        const firstPatchEntry = fallbackDiff
            ? getDiffPatchEntries(undefined, fallbackDiff, (path) => path)
                .find((entry) => entry.renderMode === 'diff')
            : undefined;
        if (firstPatchEntry?.title) {
            return firstPatchEntry.title;
        }
        return fileDiffPath;
    }

    if (toolName === 'edit' || toolName === 'multiedit') {
        if (fileDiffPath) {
            return fileDiffPath;
        }
        return typeof input?.filePath === 'string'
            ? input.filePath
            : typeof input?.file_path === 'string'
                ? input.file_path
                : typeof input?.path === 'string'
                    ? input.path
                    : null;
    }

    if (toolName === 'write') {
        return typeof input?.filePath === 'string'
            ? input.filePath
            : typeof input?.file_path === 'string'
                ? input.file_path
                : typeof input?.path === 'string'
                    ? input.path
                    : null;
    }

    return null;
};

const getToolDiagnosticSection = (
    toolName: string,
    input: Record<string, unknown> | undefined,
    metadata: Record<string, unknown> | undefined,
    currentDirectory: string,
): ToolDiagnosticSection | null => {
    if (!['edit', 'multiedit', 'write', 'apply_patch'].includes(toolName)) {
        return null;
    }

    const primaryPath = getPrimaryToolPath(toolName, input, metadata);
    if (!primaryPath || !metadata || !isRecord(metadata.diagnostics)) {
        return null;
    }

    const normalizedPath = normalizeDisplayPath(primaryPath);
    const absolutePath = normalizedPath.startsWith('/')
        ? normalizedPath
        : `${normalizeDisplayPath(currentDirectory)}/${normalizedPath}`.replace(/\/+/g, '/');

    const rawDiagnostics = (metadata.diagnostics as Record<string, unknown>)[normalizedPath]
        ?? (metadata.diagnostics as Record<string, unknown>)[absolutePath];
    if (!Array.isArray(rawDiagnostics)) {
        return null;
    }

    const diagnostics = rawDiagnostics
        .map((entry) => normalizeToolDiagnostic(entry))
        .filter((entry): entry is ToolDiagnostic => !!entry);
    if (diagnostics.length === 0) {
        return null;
    }

    const visible = diagnostics.slice(0, TOOL_DIAGNOSTICS_MAX_PER_FILE);
    return {
        displayPath: normalizedPath.startsWith('/') ? getRelativePath(normalizedPath, currentDirectory) : normalizedPath,
        diagnostics: visible,
        remaining: Math.max(0, diagnostics.length - visible.length),
    };
};

const usePierreThemeConfig = () => {
    const themeSystem = useOptionalThemeSystem();
    const fallbackLightTheme = React.useMemo(() => getDefaultTheme(false), []);
    const fallbackDarkTheme = React.useMemo(() => getDefaultTheme(true), []);

    const availableThemes = React.useMemo(
        () => themeSystem?.availableThemes ?? [fallbackLightTheme, fallbackDarkTheme],
        [fallbackDarkTheme, fallbackLightTheme, themeSystem?.availableThemes],
    );
    const lightThemeId = themeSystem?.lightThemeId ?? fallbackLightTheme.metadata.id;
    const darkThemeId = themeSystem?.darkThemeId ?? fallbackDarkTheme.metadata.id;

    const lightTheme = React.useMemo(
        () => availableThemes.find((theme) => theme.metadata.id === lightThemeId) ?? fallbackLightTheme,
        [availableThemes, fallbackLightTheme, lightThemeId],
    );
    const darkTheme = React.useMemo(
        () => availableThemes.find((theme) => theme.metadata.id === darkThemeId) ?? fallbackDarkTheme,
        [availableThemes, darkThemeId, fallbackDarkTheme],
    );

    React.useEffect(() => {
        ensurePierreThemeRegistered(lightTheme);
        ensurePierreThemeRegistered(darkTheme);
    }, [darkTheme, lightTheme]);

    const currentVariant = themeSystem?.currentTheme.metadata.variant ?? 'light';

    return {
        pierreTheme: { light: lightTheme.metadata.id, dark: darkTheme.metadata.id },
        pierreThemeType: currentVariant === 'dark' ? ('dark' as const) : ('light' as const),
    };
};

// Parse question tool output: "User has answered your questions: "Q1"="A1", "Q2"="A2". You can now..."
const parseQuestionOutput = (output: string): Array<{ question: string; answer: string }> | null => {
    const match = output.match(/^User has answered your questions:\s*(.+?)\.\s*You can now/s);
    if (!match) return null;

    const pairs: Array<{ question: string; answer: string }> = [];
    const content = match[1];

    // Match "question"="answer" pairs, handling multiline answers
    const pairRegex = /"([^"]+)"="([^"]*(?:[^"\\]|\\.)*)"/g;
    let pairMatch;
    while ((pairMatch = pairRegex.exec(content)) !== null) {
        pairs.push({
            question: pairMatch[1],
            answer: pairMatch[2],
        });
    }

    return pairs.length > 0 ? pairs : null;
};

const getToolDescriptionPath = (part: ToolPartType, state: ToolStateUnion, currentDirectory: string): string | null => {
    const stateWithData = state as ToolStateWithMetadata;
    const metadata = stateWithData.metadata;
    const input = stateWithData.input;

    if (part.tool === 'apply_patch') {
        const files = Array.isArray(metadata?.files) ? metadata?.files : [];
        const firstFile = files[0] as { relativePath?: string; filePath?: string } | undefined;
        const filePath = firstFile?.relativePath || firstFile?.filePath;
        if (files.length > 1) return null;
        if (typeof filePath === 'string') {
            return getRelativePath(filePath, currentDirectory);
        }
        return null;
    }

    if ((part.tool === 'edit' || part.tool === 'multiedit') && input) {
        const filePath = input?.filePath || input?.file_path || input?.path || metadata?.filePath || metadata?.file_path || metadata?.path;
        if (typeof filePath === 'string') {
            return getRelativePath(filePath, currentDirectory);
        }
    }

    if (part.tool === 'read' && input) {
        const filePath = input?.filePath || input?.file_path || input?.path || metadata?.filePath || metadata?.file_path || metadata?.path;
        if (typeof filePath === 'string') {
            return getRelativePath(filePath, currentDirectory);
        }
    }

    if (['write', 'create', 'file_write'].includes(part.tool) && input) {
        const filePath = input?.filePath || input?.file_path || input?.path;
        if (typeof filePath === 'string') {
            return getRelativePath(filePath, currentDirectory);
        }
    }

    if (part.tool === 'lsp' && input) {
        const filePath = input?.filePath || input?.file_path || input?.path;
        if (typeof filePath === 'string') {
            return getRelativePath(filePath, currentDirectory);
        }
    }

    return null;
};

const getLspToolDescription = (input: Record<string, unknown> | undefined, currentDirectory: string): string => {
    if (!input) {
        return '';
    }

    const operation = typeof input.operation === 'string' ? input.operation : 'lsp';
    if (operation === 'workspaceSymbol') {
        const query = typeof input.query === 'string' && input.query.trim().length > 0
            ? ` "${input.query.trim()}"`
            : '';
        return `${operation}${query}`;
    }

    const filePath = typeof input.filePath === 'string'
        ? input.filePath
        : typeof input.file_path === 'string'
            ? input.file_path
            : typeof input.path === 'string'
                ? input.path
                : '';
    const displayPath = filePath ? getRelativePath(filePath, currentDirectory) : '';

    if (operation === 'documentSymbol') {
        return displayPath ? `${operation} ${displayPath}` : operation;
    }

    const line = typeof input.line === 'number' && Number.isFinite(input.line) ? Math.trunc(input.line) : undefined;
    const character = typeof input.character === 'number' && Number.isFinite(input.character) ? Math.trunc(input.character) : undefined;
    const position = line !== undefined && character !== undefined ? `:${line}:${character}` : '';

    return displayPath ? `${operation} ${displayPath}${position}` : operation;
};

const getToolDescription = (part: ToolPartType, state: ToolStateUnion, currentDirectory: string): string => {
    const stateWithData = state as ToolStateWithMetadata;
    const metadata = stateWithData.metadata;
    const input = stateWithData.input;

    const filePathLabel = getToolDescriptionPath(part, state, currentDirectory);
    if (filePathLabel) {
        return filePathLabel;
    }

    if (part.tool === 'apply_patch') {
        const files = Array.isArray(metadata?.files) ? metadata?.files : [];
        if (files.length > 1) {
            return `${files.length} files`;
        }
        return '';
    }

    // Question tool: show "Asked N question(s)"
    if (part.tool === 'question' && input?.questions && Array.isArray(input.questions)) {
        const count = input.questions.length;
        return `Asked ${count} question${count !== 1 ? 's' : ''}`;
    }

    if (part.tool === 'bash' && input?.command && typeof input.command === 'string') {
        const firstLine = input.command.split('\n')[0];
        return firstLine.substring(0, 100);
    }

    if (part.tool === 'task' && input?.description && typeof input.description === 'string') {
        return input.description.substring(0, 80);
    }

    if (part.tool === 'lsp') {
        return getLspToolDescription(input, currentDirectory);
    }

    const desc = input?.description || metadata?.description || ('title' in state && state.title) || '';
    return typeof desc === 'string' ? desc : '';
};

interface ToolScrollableSectionProps {
    children: React.ReactNode;
    isMobile?: boolean;
    maxHeightClass?: string;
    className?: string;
    outerClassName?: string;
    disableHorizontal?: boolean;
}

const ToolScrollableSection: React.FC<ToolScrollableSectionProps> = ({
    children,
    isMobile = false,
    maxHeightClass = 'max-h-[60vh]',
    className,
    outerClassName,
    disableHorizontal = false,
}) => (
    <div className={cn('w-full min-w-0 flex-none overflow-hidden', outerClassName)}>
        <ScrollShadow
            className={cn(
                'tool-output-surface rounded-xl w-full min-w-0',
                getToolScrollableSectionPaddingClassName(isMobile),
                maxHeightClass,
                disableHorizontal ? 'overflow-y-auto overflow-x-hidden' : 'overflow-auto',
                className,
                isMobile && getToolScrollableSectionPaddingClassName(true),
            )}
        >
            <div className="w-full min-w-0">
                {children}
            </div>
        </ScrollShadow>
    </div>
);

const getToolOutputLanguage = (
    output: string,
    part: ToolPartType,
    metadata: Record<string, unknown> | undefined,
    input: Record<string, unknown> | undefined,
): string => {
    if (part.tool === 'bash') {
        return 'bash';
    }

    return detectLanguageFromOutput(formatEditOutput(output, part.tool, metadata), part.tool, input);
};

const getToolOutputText = (
    output: string,
    part: ToolPartType,
    metadata: Record<string, unknown> | undefined,
): string => {
    if (part.tool === 'bash') {
        return output;
    }

    return formatEditOutput(output, part.tool, metadata);
};

const ToolScrollableTextOutput: React.FC<{
    output: string;
    part: ToolPartType;
    metadata: Record<string, unknown> | undefined;
    input: Record<string, unknown> | undefined;
    isMobile?: boolean;
}> = ({ output, part, metadata, input, isMobile = false }) => {
    const { t } = useI18n();
    const renderedOutput = getToolOutputText(output, part, metadata);
    const outputLanguage = getToolOutputLanguage(output, part, metadata, input);
    const jsonResult = React.useMemo(() => tryParseJsonOutput(renderedOutput), [renderedOutput]);
    const [jsonViewMode, setJsonViewMode] = React.useState<'summary' | 'formatted' | 'raw'>('summary');
    const [copiedJson, setCopiedJson] = React.useState(false);

    React.useEffect(() => {
        setJsonViewMode('summary');
        setCopiedJson(false);
    }, [renderedOutput]);

    const handleJsonViewChange = React.useCallback((view: 'summary' | 'formatted' | 'raw', event: React.MouseEvent<HTMLButtonElement>) => {
        event.stopPropagation();
        setJsonViewMode(view);
    }, []);

    const handleCopyOutput = React.useCallback(async (event: React.MouseEvent<HTMLButtonElement>) => {
        event.stopPropagation();
        const result = await copyTextToClipboard(renderedOutput);
        if (!result.ok) {
            toast.error(t('chat.toolPart.copyOutputFailed'));
            return;
        }
        setCopiedJson(true);
        if (typeof window !== 'undefined') {
            window.setTimeout(() => setCopiedJson(false), 1200);
        }
    }, [renderedOutput, t]);

    if (jsonResult.isJson) {
        return (
            <div className="tool-output-surface relative p-2 rounded-xl w-full min-w-0">
                <div className="absolute right-2 top-2 z-10 flex items-center gap-1">
                    <Button
                        variant="ghost"
                        size="icon"
                        className={cn('h-6 w-6 rounded-md text-muted-foreground hover:text-foreground', jsonViewMode === 'summary' && 'bg-[var(--interactive-selection)] text-[var(--interactive-selection-foreground)]')}
                        onClick={(event) => handleJsonViewChange('summary', event)}
                        onPointerDown={(event) => event.stopPropagation()}
                        aria-label={t('chat.toolPart.showNavigableJson')}
                        title={t('chat.toolPart.showNavigableJson')}
                    >
                        <Icon name="list-unordered" className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                        variant="ghost"
                        size="icon"
                        className={cn('h-6 w-6 rounded-md text-muted-foreground hover:text-foreground', jsonViewMode === 'formatted' && 'bg-[var(--interactive-selection)] text-[var(--interactive-selection-foreground)]')}
                        onClick={(event) => handleJsonViewChange('formatted', event)}
                        onPointerDown={(event) => event.stopPropagation()}
                        aria-label={t('chat.toolPart.showFormattedJson')}
                        title={t('chat.toolPart.showFormattedJson')}
                    >
                        <Icon name="node-tree" className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                        variant="ghost"
                        size="icon"
                        className={cn('h-6 w-6 rounded-md text-muted-foreground hover:text-foreground', jsonViewMode === 'raw' && 'bg-[var(--interactive-selection)] text-[var(--interactive-selection-foreground)]')}
                        onClick={(event) => handleJsonViewChange('raw', event)}
                        onPointerDown={(event) => event.stopPropagation()}
                        aria-label={t('chat.toolPart.showRawJson')}
                        title={t('chat.toolPart.showRawJson')}
                    >
                        <Icon name="code-box" className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 rounded-md bg-[var(--surface-elevated)]/80 text-muted-foreground hover:text-foreground"
                        onClick={handleCopyOutput}
                        onPointerDown={(event) => event.stopPropagation()}
                        aria-label={copiedJson ? t('chat.toolPart.copiedOutput') : t('chat.toolPart.copyOutput')}
                        title={copiedJson ? t('chat.toolPart.copiedOutput') : t('chat.toolPart.copyOutput')}
                    >
                        <Icon name={copiedJson ? 'check' : 'file-copy'} className="h-3.5 w-3.5" />
                    </Button>
                </div>
                {jsonViewMode === 'summary' ? (
                    <JsonSummaryView data={jsonResult.data} />
                ) : jsonViewMode === 'formatted' ? (
                    <JsonTreeViewer
                        data={jsonResult.data}
                        initiallyExpandedDepth={1}
                        maxHeight="400px"
                    />
                ) : (
                    <div className="typography-code pr-12 text-muted-foreground/90">
                        <WorkerHighlightedCode
                            language="json"
                            code={renderedOutput}
                            style={TOOL_COLLAPSED_CUSTOM_STYLE}
                            codeStyle={CODE_TAG_PROPS.style}
                            wrap
                        />
                    </div>
                )}
            </div>
        );
    }

    return (
        <div className={part.tool === 'bash' ? 'typography-code text-muted-foreground/90' : undefined}>
            <WorkerHighlightedCode
                language={outputLanguage}
                code={renderedOutput}
                style={{
                    ...TOOL_COLLAPSED_CUSTOM_STYLE,
                    ...(isMobile && part.tool === 'bash' ? { lineHeight: MOBILE_SHELL_CODE_LINE_HEIGHT } : {}),
                }}
                codeStyle={CODE_TAG_PROPS.style}
                wrap
            />
        </div>
    );
};

ToolScrollableTextOutput.displayName = 'ToolScrollableTextOutput';


const getTaskSummaryLabel = (entry: TaskToolSummaryEntry): string => {
    const title = entry.state?.title;
    if (typeof title === 'string' && title.trim().length > 0) {
        return title;
    }

    const input = entry.state?.input;
    if (input && typeof input === 'object') {
        const pathCandidate = input.filePath ?? input.file_path ?? input.path;
        if (typeof pathCandidate === 'string' && pathCandidate.trim().length > 0) {
            return pathCandidate.trim();
        }

        const urlCandidate = input.url;
        if (typeof urlCandidate === 'string' && urlCandidate.trim().length > 0) {
            return urlCandidate.trim();
        }
    }

    return '';
};

const FILE_PATH_LABEL_TOOLS = new Set([
    'read',
    'view',
    'file_read',
    'cat',
    'write',
    'create',
    'file_write',
    'edit',
    'multiedit',
    'apply_patch',
]);

const shouldRenderGitPathLabel = (toolName: string, label: string): boolean => {
    if (!FILE_PATH_LABEL_TOOLS.has(toolName.toLowerCase())) {
        return false;
    }

    const trimmed = label.trim();
    if (!trimmed || trimmed === 'Patch' || /^\d+\s+files$/.test(trimmed)) {
        return false;
    }

    if (trimmed.includes('/') || trimmed.includes('\\')) {
        return true;
    }

    const baseName = trimmed.split(/[\\/]/).pop() || trimmed;
    if (baseName.startsWith('.') || baseName.includes('.')) {
        return true;
    }

    return /^[A-Za-z0-9_-]+$/.test(baseName);
};

const getTaskSummaryEntryRenderSignature = (entry: TaskToolSummaryEntry): string => {
    const toolName = normalizeToolName(entry.tool);
    const status = entry.state?.status ?? '';
    const label = getTaskSummaryLabel(entry);
    return `${entry.id ?? ''}\u0001${toolName}\u0001${status}\u0001${label}`;
};

const areTaskSummaryEntriesRenderEqual = (
    prevEntries: TaskToolSummaryEntry[],
    nextEntries: TaskToolSummaryEntry[],
): boolean => {
    if (prevEntries === nextEntries) return true;
    if (prevEntries.length !== nextEntries.length) return false;
    for (let index = 0; index < prevEntries.length; index += 1) {
        if (getTaskSummaryEntryRenderSignature(prevEntries[index]) !== getTaskSummaryEntryRenderSignature(nextEntries[index])) {
            return false;
        }
    }
    return true;
};

const TaskSummaryEntryRow = React.memo(({
    entry,
    isMobile,
    animateTailText,
    showToolFileIcons,
}: {
    entry: TaskToolSummaryEntry;
    isMobile: boolean;
    animateTailText: boolean;
    showToolFileIcons: boolean;
}) => {
    const normalizedToolName = normalizeToolName(entry.tool);
    const toolName = normalizedToolName.length > 0 ? normalizedToolName : 'tool';
    const label = getTaskSummaryLabel(entry);
    const hasLabel = label.trim().length > 0;
    const status = entry.state?.status;
    const displayName = getToolMetadata(toolName).displayName;

    return (
        <ToolRevealOnMount animate={animateTailText} wipe>
            <div className={cn('flex gap-1.5 min-w-0 w-full py-px', isMobile ? 'items-start' : 'items-center')}>
                <span className="flex-shrink-0 scale-90 text-foreground/80">{getToolIcon(toolName)}</span>
                <span
                    className={cn(TASK_SUMMARY_TEXT_CLASS, 'text-foreground/80 flex-shrink-0')}
                    style={{ color: 'var(--tools-title)' }}
                    title={displayName}
                >
                    {displayName}
                </span>
                {hasLabel ? (
                    status !== 'error' && shouldRenderGitPathLabel(toolName, label) ? (
                        renderAnimatedPathWithIcon(label, animateTailText, true, showToolFileIcons, TASK_SUMMARY_TEXT_CLASS)
                    ) : (
                        status === 'error' ? (
                            <span className={cn(
                                TASK_SUMMARY_TEXT_CLASS,
                                'flex-1 min-w-0 text-[var(--status-error)]',
                                isMobile ? 'whitespace-normal break-words' : 'truncate',
                            )}>
                                {label}
                            </span>
                        ) : (
                            <Text
                                variant={animateTailText ? 'generate-effect' : 'static'}
                                className={cn(
                                    TASK_SUMMARY_TEXT_CLASS,
                                    'flex-1 min-w-0 text-muted-foreground/70',
                                    isMobile ? 'whitespace-normal break-words' : 'truncate',
                                )}
                                style={{ color: 'var(--tools-description)' }}
                                title={label}
                            >
                                {label}
                            </Text>
                        )
                    )
                ) : null}
            </div>
        </ToolRevealOnMount>
    );
}, (prev, next) => {
    return prev.isMobile === next.isMobile
        && prev.animateTailText === next.animateTailText
        && prev.showToolFileIcons === next.showToolFileIcons
        && getTaskSummaryEntryRenderSignature(prev.entry) === getTaskSummaryEntryRenderSignature(next.entry);
});

TaskSummaryEntryRow.displayName = 'TaskSummaryEntryRow';

const TaskSummaryEntriesList = React.memo(({
    entries,
    isExpanded,
    isMobile,
    animateTailText,
    showToolFileIcons,
}: {
    entries: TaskToolSummaryEntry[];
    isExpanded: boolean;
    isMobile: boolean;
    animateTailText: boolean;
    showToolFileIcons: boolean;
}) => {
    const visibleEntries = isExpanded ? entries : entries.slice(-6);
    const hiddenCount = Math.max(0, entries.length - visibleEntries.length);
    const visibleStartIndex = entries.length - visibleEntries.length;

    return (
        <ToolScrollableSection maxHeightClass={isExpanded ? 'max-h-[40vh]' : 'max-h-56'} disableHorizontal>
            <div className={TASK_SUMMARY_LIST_CLASS}>
                {hiddenCount > 0 ? (
                    <div className={cn(TASK_SUMMARY_TEXT_CLASS, 'text-muted-foreground/70')}>+{hiddenCount} more…</div>
                ) : null}

                {visibleEntries.map((entry, idx) => {
                    const absoluteIndex = isExpanded ? idx : visibleStartIndex + idx;
                    const rowKey = entry.id ?? `${getTaskSummaryEntryRenderSignature(entry)}:${absoluteIndex}`;
                    return (
                        <TaskSummaryEntryRow
                            key={rowKey}
                            entry={entry}
                            isMobile={isMobile}
                            animateTailText={animateTailText}
                            showToolFileIcons={showToolFileIcons}
                        />
                    );
                })}
            </div>
        </ToolScrollableSection>
    );
}, (prev, next) => {
    return prev.isExpanded === next.isExpanded
        && prev.isMobile === next.isMobile
        && prev.animateTailText === next.animateTailText
        && prev.showToolFileIcons === next.showToolFileIcons
        && areTaskSummaryEntriesRenderEqual(prev.entries, next.entries);
});

TaskSummaryEntriesList.displayName = 'TaskSummaryEntriesList';

const TaskToolSummary: React.FC<{
    entries: TaskToolSummaryEntry[];
    isExpanded: boolean;
    isMobile: boolean;
    output?: string;
    sessionId?: string;
    onShowPopup?: (content: ToolPopupContent) => void;
    input?: Record<string, unknown>;
    animateTailText?: boolean;
    isActive?: boolean;
}> = ({ entries, isExpanded, isMobile, output, sessionId, onShowPopup, input, animateTailText = true, isActive = false }) => {
    const { t } = useI18n();
    const currentDirectory = useEffectiveDirectory();
    const setCurrentSession = useSessionUIStore((state) => state.setCurrentSession);
    const openContextPanelTab = useUIStore((state) => state.openContextPanelTab);
    const showToolFileIcons = useUIStore((state) => state.showToolFileIcons);
    const runtime = React.useContext(RuntimeAPIContext);
    const sessionSurface = useSessionSurface();

    const trimmedOutput = typeof output === 'string'
        ? prepareTaskOutputForDisplay(output)
        : '';
    const hasOutput = trimmedOutput.length > 0;
    const [isOutputExpanded, setIsOutputExpanded] = React.useState(false);
    const agentType = resolveTaskAgentName(input) ?? 'subagent';
    const agentDisplayName = formatAgentDisplayName(agentType);

    const handleOpenSession = (event: React.MouseEvent) => {
        event.stopPropagation();
        if (sessionId && currentDirectory) {
            navigateNestedSession(sessionSurface, sessionId, currentDirectory, () => {
                // In contexts with no ContextPanel (embedded session-chat iframe)
                // or single-surface layouts (mobile, VS Code), navigate in place.
                // Otherwise open a new side-panel tab.
                if (isEmbeddedSessionChat() || isMobile || runtime?.runtime.isVSCode) {
                    setCurrentSession(sessionId, currentDirectory);
                    return;
                }

                openContextPanelTab(currentDirectory, {
                    mode: 'chat',
                    dedupeKey: `session:${sessionId}`,
                    label: agentDisplayName,
                    readOnly: true,
                });
            });
        }
    };

    if (entries.length === 0 && !hasOutput && !sessionId) {
        return (
            <div className="relative flex flex-col gap-1 pr-2 pb-1.5 pt-0.5 pl-[1.4375rem]">
                <div className={cn(TASK_SUMMARY_TEXT_CLASS, 'text-muted-foreground/70')}>
                    {isActive ? 'Waiting for subagent activity...' : 'No subagent session id on task metadata.'}
                </div>
            </div>
        );
    }

    return (
        <div
            className={cn(
                'relative flex flex-col gap-1 pr-2 pb-1.5 pt-0.5 pl-[1.4375rem]',
                'before:absolute before:left-[0.4375rem] before:w-px before:bg-border/80 before:content-[""]',
                'before:top-0 before:bottom-0'
            )}
        >
            {entries.length > 0 ? (
                <TaskSummaryEntriesList
                    entries={entries}
                    isExpanded={isExpanded}
                    isMobile={isMobile}
                    animateTailText={animateTailText}
                    showToolFileIcons={showToolFileIcons}
                />
            ) : null}

            {sessionId && sessionSurface.capabilities.navigateNestedSession && (
                <button
                    type="button"
                    className={cn('flex items-center gap-1.5 text-primary hover:text-primary/80 w-full', TASK_SUMMARY_TEXT_CLASS)}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={handleOpenSession}
                >
                    <Icon name="external-link" className="h-3 w-3 flex-shrink-0" />
                    <span className={cn(TASK_SUMMARY_TEXT_CLASS, 'text-primary font-medium')}>{t('chat.toolPart.openSubtask', { type: agentDisplayName })}</span>
                </button>
            )}

            {hasOutput ? (
                <div className={cn('flex flex-col gap-1', (entries.length > 0 || sessionId) && 'pt-1')}
                >
                    <button
                        type="button"
                        className={cn('flex items-center gap-1.5 text-foreground/80 hover:text-foreground w-full', TASK_SUMMARY_TEXT_CLASS)}
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={(event) => {
                            event.stopPropagation();
                            setIsOutputExpanded((prev) => !prev);
                        }}
                    >
                        {isOutputExpanded ? (
                            <Icon name="arrow-down-s" className="h-3 w-3 flex-shrink-0" />
                        ) : (
                            <Icon name="arrow-right-s" className="h-3 w-3 flex-shrink-0" />
                        )}
                        <span className={cn(TASK_SUMMARY_TEXT_CLASS, 'text-foreground/80 font-medium')}>{t('chat.toolPart.output')}</span>
                    </button>
                    {isOutputExpanded ? (
                        <ToolScrollableSection maxHeightClass="max-h-[50vh]">
                            <div className="w-full min-w-0">
                                <SimpleMarkdownRenderer content={trimmedOutput} variant="tool" onShowPopup={onShowPopup} />
                            </div>
                        </ToolScrollableSection>
                    ) : null}
                </div>
            ) : null}
        </div>
    );
};

interface DiffPreviewProps {
    diff: string;
    pierreTheme: { light: string; dark: string };
    pierreThemeType: 'light' | 'dark';
    diffViewMode: DiffViewMode;
}

const TOOL_DIFF_UNSAFE_CSS = `
  [data-diff-header],
  [data-diff] {
    [data-separator] {
      height: 24px !important;
    }
  }
`;

const TOOL_DIFF_METRICS = {
    hunkLineCount: 50,
    lineHeight: 24,
    diffHeaderHeight: 44,
    hunkSeparatorHeight: 24,
    spacing: 0,
};

const TOOL_COLLAPSED_CUSTOM_STYLE: React.CSSProperties = {
    ...toolDisplayStyles.getCollapsedStyles(),
    padding: 0,
    overflow: 'visible',
};

const CODE_TAG_PROPS = { style: { background: 'transparent', backgroundColor: 'transparent' } };

const TOOL_ERROR_ICON_STYLE: React.CSSProperties = { color: 'var(--status-error)' };
const TOOL_NORMAL_ICON_STYLE: React.CSSProperties = { color: 'var(--tools-icon)' };
const TOOL_ERROR_TITLE_STYLE: React.CSSProperties = { color: 'var(--status-error)' };
const TOOL_NORMAL_TITLE_STYLE: React.CSSProperties = { color: 'var(--tools-title)' };

const renderPathLikeGitChanges = (path: string, grow = true) => {
    const lastSlash = path.lastIndexOf('/');
    if (lastSlash === -1) {
        return (
            <span
                className={cn('min-w-0 truncate typography-ui-label text-foreground', grow && 'flex-1')}
                style={{ direction: 'rtl', textAlign: 'left', unicodeBidi: 'plaintext' }}
                title={path}
            >
                {path}
            </span>
        );
    }

    const dir = path.slice(0, lastSlash);
    const name = path.slice(lastSlash + 1);
    const hasAbsoluteRoot = dir.startsWith('/');
    const displayDir = hasAbsoluteRoot ? dir.slice(1) : dir;

    return (
        <span className={cn('min-w-0 flex items-baseline overflow-hidden typography-ui-label', grow && 'flex-1')} title={path}>
            {hasAbsoluteRoot ? <span className="flex-shrink-0 text-muted-foreground">/</span> : null}
            <span className="min-w-0 truncate text-muted-foreground" style={{ direction: 'rtl', textAlign: 'left', unicodeBidi: 'plaintext' }}>
                {displayDir}
            </span>
            <span className="flex-shrink-0">
                <span className="text-muted-foreground">/</span>
                <span className="text-muted-foreground">{name}</span>
            </span>
        </span>
    );
};

const renderAnimatedPathWithIcon = (
    path: string,
    animate = true,
    grow = true,
    showFileIcons = true,
    textClassName: string = TOOL_ROW_DESCRIPTION_CLASS,
) => {
    const lastSlash = path.lastIndexOf('/');
    const iconClass = textClassName === TASK_SUMMARY_TEXT_CLASS ? 'h-3 w-3 flex-shrink-0' : 'h-3.5 w-3.5 flex-shrink-0';

    if (lastSlash === -1) {
        return (
            <span className={cn('min-w-0 inline-flex items-center gap-1 overflow-hidden', grow && 'flex-1')} title={path}>
                {showFileIcons ? <FileTypeIcon filePath={path} className={iconClass} /> : null}
                <Text
                    variant={animate ? 'generate-effect' : 'static'}
                    className={cn('min-w-0 truncate whitespace-nowrap', textClassName, grow && 'flex-1')}
                    style={{ color: 'var(--tools-description)' }}
                >
                    {path}
                </Text>
            </span>
        );
    }

    const dir = path.slice(0, lastSlash);
    const name = path.slice(lastSlash + 1);
    const hasAbsoluteRoot = dir.startsWith('/');
    const displayDir = hasAbsoluteRoot ? dir.slice(1) : dir;

    return (
        <span className={cn('min-w-0 inline-flex items-center gap-1 overflow-hidden', grow && 'flex-1')} title={path}>
            {showFileIcons ? <FileTypeIcon filePath={path} className={iconClass} /> : null}
            <span className={cn('min-w-0 inline-flex max-w-full items-baseline overflow-hidden', textClassName, grow && 'flex-1')}>
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
        </span>
    );
};

const PlainDiffFallback: React.FC<{ diff: string }> = ({ diff }) => (
    <pre
        className="m-0 overflow-auto whitespace-pre-wrap break-words rounded-lg p-2 typography-code"
        style={{
            backgroundColor: 'var(--syntax-base-background)',
            color: 'var(--syntax-base-foreground)',
        }}
    >
        {diff}
    </pre>
);

class DiffPreviewErrorBoundary extends React.Component<{
    resetKey: string;
    fallback: React.ReactNode;
    children: React.ReactNode;
}, { hasError: boolean }> {
    state = { hasError: false };

    static getDerivedStateFromError(): { hasError: boolean } {
        return { hasError: true };
    }

    componentDidUpdate(prevProps: { resetKey: string }) {
        if (prevProps.resetKey !== this.props.resetKey && this.state.hasError) {
            this.setState({ hasError: false });
        }
    }

    componentDidCatch(error: Error) {
        if (process.env.NODE_ENV === 'development') {
            console.warn('Tool diff preview failed; rendering raw patch instead.', error);
        }
    }

    render() {
        if (this.state.hasError) {
            return this.props.fallback;
        }
        return this.props.children;
    }
}

const DiffPreview: React.FC<DiffPreviewProps> = React.memo(({ diff, pierreTheme, pierreThemeType, diffViewMode }) => {
    const options = React.useMemo(
        () => ({
            diffStyle: diffViewMode === 'side-by-side' ? 'split' as const : 'unified' as const,
            diffIndicators: 'none' as const,
            hunkSeparators: 'line-info-basic' as const,
            lineDiffType: 'none' as const,
            disableFileHeader: true,
            maxLineDiffLength: 1000,
            expansionLineCount: 20,
            overflow: 'wrap' as const,
            theme: pierreTheme,
            themeType: pierreThemeType,
            unsafeCSS: TOOL_DIFF_UNSAFE_CSS,
        }),
        [diffViewMode, pierreTheme, pierreThemeType]
    );

    const fallback = <PlainDiffFallback diff={diff} />;

    return (
        <div className="typography-code px-1 pb-1 pt-0">
            <DiffPreviewErrorBoundary resetKey={diff} fallback={fallback}>
                <PatchDiff
                    patch={diff}
                    metrics={TOOL_DIFF_METRICS}
                    options={options}
                    className="block w-full"
                />
            </DiffPreviewErrorBoundary>
        </div>
    );
});

DiffPreview.displayName = 'DiffPreview';

interface ToolExpandedContentProps {
    part: ToolPartType;
    state: ToolStateUnion;
    currentDirectory: string;
    isExpanded: boolean;
    isMobile: boolean;
    onShowPopup?: (content: ToolPopupContent) => void;
}

const ToolExpandedContent: React.FC<ToolExpandedContentProps> = React.memo(({
    part,
    state,
    currentDirectory,
    isExpanded,
    isMobile,
    onShowPopup,
}) => {
    const { t } = useI18n();
    const { pierreTheme, pierreThemeType } = usePierreThemeConfig();
    const [diffViewMode, setDiffViewMode] = React.useState<DiffViewMode>('unified');
    const stateWithData = state as ToolStateWithMetadata;
    const metadata = stateWithData.metadata;
    const input = stateWithData.input;
    const rawOutput = stateWithData.output;
    const hasStringOutput = typeof rawOutput === 'string' && rawOutput.length > 0;
    const outputString = typeof rawOutput === 'string' ? rawOutput : '';

    const fileDiff = isRecord(metadata?.filediff) ? metadata.filediff : undefined;
    const diffContent = getPatchText((metadata as { patch?: unknown } | undefined)?.patch)
        ?? getPatchText(metadata?.diff)
        ?? getPatchText(fileDiff?.patch)
        ?? getPatchText(fileDiff?.diff)
        ?? null;
    const diffEntries = React.useMemo(
        () => getDiffPatchEntries(metadata, diffContent ?? undefined, (path) => getRelativePath(path, currentDirectory)),
        [currentDirectory, diffContent, metadata]
    );
    const hideToolInputPreview = part.tool === 'apply_patch'
        || part.tool === 'edit'
        || part.tool === 'multiedit';
    const diagnosticSection = React.useMemo(
        () => getToolDiagnosticSection(part.tool, input, metadata, currentDirectory),
        [currentDirectory, input, metadata, part.tool],
    );

    const inputTextContent = React.useMemo(() => {
        if (!input || typeof input !== 'object' || Object.keys(input).length === 0) {
            return '';
        }

        if ('command' in input && typeof input.command === 'string' && part.tool === 'bash') {
            return formatInputForDisplay(input, part.tool);
        }

        if (typeof (input as { content?: unknown }).content === 'string') {
            return (input as { content?: string }).content ?? '';
        }

        return formatInputForDisplay(input, part.tool);
    }, [input, part.tool]);
    const hasInputText = !hideToolInputPreview && inputTextContent.trim().length > 0;
    const isWriteLikeTool = part.tool === 'write' || part.tool === 'create' || part.tool === 'file_write';
    const isTodoTool = part.tool === 'todowrite' || part.tool === 'todoread';
    const todoContent = React.useMemo(() => {
        if (Array.isArray(input?.todos)) {
            return JSON.stringify(input.todos);
        }
        return outputString;
    }, [input?.todos, outputString]);
    const writeLikeInputPatch = React.useMemo(() => {
        if (!isWriteLikeTool || !hasInputText) {
            return undefined;
        }
        const filePath = typeof input?.filePath === 'string'
            ? input.filePath
            : typeof input?.file_path === 'string'
                ? input.file_path
                : typeof input?.path === 'string'
                    ? input.path
                    : undefined;
        return buildWritePreviewPatch(filePath, inputTextContent);
    }, [hasInputText, input?.filePath, input?.file_path, input?.path, inputTextContent, isWriteLikeTool]);

    React.useEffect(() => {
        setDiffViewMode('unified');
    }, [part.id]);

    const renderScrollableBlock = (
        content: React.ReactNode,
        options?: { maxHeightClass?: string; className?: string; disableHorizontal?: boolean; outerClassName?: string }
    ) => (
        <ToolScrollableSection
            isMobile={isMobile}
            maxHeightClass={options?.maxHeightClass}
            className={options?.className}
            disableHorizontal={options?.disableHorizontal}
            outerClassName={options?.outerClassName}
        >
            {content}
        </ToolScrollableSection>
    );

    const renderResultContent = () => {
        const renderDiagnosticsSection = () => {
            if (!diagnosticSection) {
                return null;
            }

            return (
                <div
                    className="tool-output-surface flex flex-col gap-2 rounded-xl border p-2"
                    style={{
                        borderColor: 'var(--status-error-border)',
                        backgroundColor: 'var(--status-error-background)',
                    }}
                >
                    <div className="typography-meta font-medium" style={{ color: 'var(--status-error)' }}>
                        {t('chat.toolPart.lspErrors')}
                    </div>
                    <div className="flex flex-col gap-1">
                        <div className="flex items-center gap-1 min-w-0">
                            {renderPathLikeGitChanges(diagnosticSection.displayPath, false)}
                        </div>
                        <div className="flex flex-col gap-1">
                            {diagnosticSection.diagnostics.map((diagnostic, index) => (
                                <div key={`${diagnosticSection.displayPath}:${diagnostic.line}:${diagnostic.character}:${index}`} className="rounded-md border px-2 py-1" style={{ borderColor: 'var(--status-error-border)', backgroundColor: 'var(--surface-elevated)' }}>
                                    <div className="flex items-start gap-2 min-w-0">
                                        <span className="typography-micro shrink-0" style={{ color: 'var(--status-error)' }}>
                                            [{diagnostic.line}:{diagnostic.character}]
                                        </span>
                                        <span className="typography-meta text-foreground whitespace-pre-wrap break-words">
                                            {diagnostic.message}
                                        </span>
                                    </div>
                                </div>
                            ))}
                        </div>
                        {diagnosticSection.remaining > 0 ? (
                            <div className="typography-micro text-muted-foreground">
                                {t('chat.toolPart.moreErrors', { count: diagnosticSection.remaining })}
                            </div>
                        ) : null}
                    </div>
                </div>
            );
        };

        // Question tool: show parsed Q&A summary or question content from input
        if (part.tool === 'question') {
            if (state.status === 'completed' && hasStringOutput) {
                const parsedQA = parseQuestionOutput(outputString);
                if (parsedQA && parsedQA.length > 0) {
                    return renderScrollableBlock(
                        <div className="flex flex-col gap-2">
                            {parsedQA.map((qa, index) => (
                                <div key={index} className="flex flex-col gap-0.5">
                                    <div className="typography-micro text-muted-foreground">{qa.question}</div>
                                    <div className="typography-meta text-foreground whitespace-pre-wrap">{qa.answer}</div>
                                </div>
                            ))}
                        </div>,
                        { maxHeightClass: 'max-h-[40vh]' }
                    );
                }
            }

            if (state.status === 'error' && 'error' in state) {
                return (
                    <div className="flex flex-col gap-1">
                        <div className="typography-meta font-medium text-muted-foreground">{t('chat.toolPart.error')}</div>
                        <div className="typography-meta p-2 rounded-xl border" style={{
                            backgroundColor: 'var(--status-error-background)',
                            color: 'var(--status-error)',
                            borderColor: 'var(--status-error-border)',
                        }}>
                            {coerceToText(state.error)}
                        </div>
                    </div>
                );
            }

            // Show question content from input whenever available, whether the tool is
            // pending/running or completed without parseable output. This ensures question
            // text persists across refreshes even if the QuestionCard store data is lost.
            const questionInput = input as { questions?: Array<{ question?: string; header?: string; options?: Array<{ label: string; description: string }>; multiple?: boolean }> } | undefined;
            if (questionInput?.questions && Array.isArray(questionInput.questions) && questionInput.questions.length > 0) {
                return renderScrollableBlock(
                    <div className="flex flex-col gap-2">
                        {questionInput.questions.map((q, index) => (
                            <div key={index} className="flex flex-col gap-0.5">
                                {q.header ? (
                                    <div className="typography-micro text-muted-foreground">{coerceToText(q.header)}</div>
                                ) : null}
                                <div className="typography-meta text-foreground">{coerceToText(q.question)}</div>
                                {Array.isArray(q.options) && q.options.length > 0 ? (
                                    <div className="flex flex-wrap gap-1 mt-0.5">
                                        {q.options.map((opt) => (
                                            <span key={coerceToText(opt.label)} className="typography-micro px-1.5 py-0.5 rounded bg-muted/30 border border-border/30 text-muted-foreground">
                                                {coerceToText(opt.label)}
                                            </span>
                                        ))}
                                    </div>
                                ) : null}
                            </div>
                        ))}
                    </div>,
                    { maxHeightClass: 'max-h-[40vh]' }
                );
            }

            return <div className="typography-meta text-muted-foreground">{t('chat.toolPart.awaitingResponse')}</div>;
        }

        if (part.tool === 'task' && hasStringOutput) {
            return renderScrollableBlock(
                <div className="w-full min-w-0">
                    <SimpleMarkdownRenderer content={coerceToText(outputString)} variant="tool" onShowPopup={onShowPopup} />
                </div>
            );
        }

        if ((part.tool === 'edit' || part.tool === 'multiedit' || part.tool === 'apply_patch' || part.tool === 'write') && (diffEntries.length > 0 || !!diagnosticSection)) {
            return renderScrollableBlock(
                <div className="flex flex-col gap-3">
                    {diffEntries.map((entry) => (
                        <div key={entry.id} className="w-full min-w-0">
                            {entry.renderMode === 'diff' ? (
                                <DiffPreview
                                    diff={entry.patch}
                                    pierreTheme={pierreTheme}
                                    pierreThemeType={pierreThemeType}
                                    diffViewMode={diffViewMode}
                                />
                            ) : (
                                <PlainDiffFallback diff={entry.patch} />
                            )}
                        </div>
                    ))}
                    {renderDiagnosticsSection()}
                </div>,
                { className: 'p-1' }
            );
        }

        if (part.tool === 'write' && diagnosticSection) {
            return renderScrollableBlock(
                <div className="flex flex-col gap-3">
                    {renderDiagnosticsSection()}
                </div>,
                { className: 'p-1' },
            );
        }

        if (isWriteLikeTool) {
            return null;
        }

        if (hasStringOutput && outputString.trim()) {
            return renderScrollableBlock(
                <ToolScrollableTextOutput
                    output={coerceToText(outputString)}
                    part={part}
                    metadata={metadata}
                    input={input}
                    isMobile={isMobile}
                />,
                {
                    className: part.tool === 'bash' ? 'p-1 rounded-none' : 'p-1',
                    maxHeightClass: part.tool === 'bash' ? 'max-h-[46vh]' : undefined,
                }
            );
        }

        return renderScrollableBlock(
            <div className="typography-meta text-muted-foreground/70">{t('chat.toolPart.noOutputProduced')}</div>,
            { maxHeightClass: 'max-h-60' }
        );
    };

    if (isTodoTool) {
        if (state.status === 'error' && 'error' in state) {
            return (
                <div className={getToolExpandedContentClassName(isMobile, 'todo-error')}>
                    <div className="typography-meta font-medium text-muted-foreground/80">{t('chat.toolPart.error')}</div>
                    <div className="typography-meta p-2 rounded-xl border" style={{
                        backgroundColor: 'var(--status-error-background)',
                        color: 'var(--status-error)',
                        borderColor: 'var(--status-error-border)',
                    }}>
                        {state.error}
                    </div>
                </div>
            );
        }

        const todoOutput = renderTodoOutput(todoContent, undefined, { listClassName: todoToolListClassName });

        return (
            <div className={getToolExpandedContentClassName(isMobile, 'todo')}>
                {renderScrollableBlock(
                    todoOutput ?? (
                        <ToolScrollableTextOutput
                            output={todoContent}
                            part={part}
                            metadata={metadata}
                            input={input}
                            isMobile={isMobile}
                        />
                    ),
                    todoToolScrollOptions,
                )}
            </div>
        );
    }

    return (
        <div
            className={getToolExpandedContentClassName(isMobile, 'default', part.tool === 'bash')}
        >
            {part.tool === 'question' ? (
                renderResultContent()
            ) : (
                <>
                    {hasInputText ? (
                        <div>
                            {renderScrollableBlock(
                                part.tool === 'bash' ? (
                                    <pre
                                        className="tool-input-text whitespace-pre-wrap break-words typography-code text-muted-foreground/90 m-0 p-0"
                                        style={isMobile ? { lineHeight: MOBILE_SHELL_CODE_LINE_HEIGHT } : undefined}
                                    >
                                        {inputTextContent}
                                    </pre>
                                ) : isWriteLikeTool && writeLikeInputPatch ? (
                                    <DiffPreview
                                        diff={writeLikeInputPatch}
                                        pierreTheme={pierreTheme}
                                        pierreThemeType={pierreThemeType}
                                        diffViewMode={diffViewMode}
                                    />
                                ) : (
                                    <blockquote className="tool-input-text m-0 whitespace-pre-wrap break-words typography-meta italic text-muted-foreground/70">
                                        {inputTextContent}
                                    </blockquote>
                                ),
                                {
                                    maxHeightClass: isWriteLikeTool && writeLikeInputPatch && isExpanded ? 'max-h-[50vh]' : 'max-h-60',
                                    className: part.tool === 'bash' ? 'tool-input-surface p-0 rounded-none' : 'tool-input-surface',
                                }
                            )}
                        </div>
                    ) : null}

                    {state.status === 'completed' && 'output' in state && (
                        <div>
                            {renderResultContent()}
                        </div>
                    )}

                    {state.status === 'error' && 'error' in state && (
                        <div className="flex flex-col gap-1">
                            <div className="typography-meta font-medium text-muted-foreground/80">{t('chat.toolPart.error')}</div>
                            <div className="typography-meta p-2 rounded-xl border" style={{
                                backgroundColor: 'var(--status-error-background)',
                                color: 'var(--status-error)',
                                borderColor: 'var(--status-error-border)',
                            }}>
                                {coerceToText(state.error)}
                            </div>
                        </div>
                    )}
                </>
            )}
        </div>
    );
});

ToolExpandedContent.displayName = 'ToolExpandedContent';

const ToolPartContent: React.FC<ToolPartProps> = ({
    part,
    messageId,
    isExpanded,
    onToggle,
    isMobile,
    onContentChange,
    onShowPopup,
    animateTailText = true,
}) => {
    const state = part.state;
    const showToolFileIcons = useUIStore((s) => s.showToolFileIcons);
    // Settings → Visual：「显示子智能体工作详情」；默认关闭，保持紧凑单行
    const showSubagentTaskDetails = useUIStore((s) => s.showSubagentTaskDetails);
    const openContextPanelTab = useUIStore((s) => s.openContextPanelTab);
    const openContextDiff = useUIStore((s) => s.openContextDiff);
    const openContextToolDiff = useUIStore((s) => s.openContextToolDiff);
    const navigateToDiff = useUIStore((s) => s.navigateToDiff);
    const currentDirectory = useEffectiveDirectory() ?? '';
    const setCurrentSession = useSessionUIStore((s) => s.setCurrentSession);
    const mobileActions = useMobileAppActions();
    const sessionSurface = useSessionSurface();

    const normalizedPartTool = normalizeToolName(part.tool);
    const isTaskTool = normalizedPartTool === 'task';
    // Edit/Write：单行导航，不展开详情
    const isFileNavTool = isFileNavToolName(normalizedPartTool);

    const status = state?.status as string | undefined;
    const isFinalized = status === 'completed' || status === 'error' || status === 'aborted' || status === 'failed' || status === 'timeout' || status === 'cancelled';
    const isError = status === 'error' || status === 'failed';

    const [activeLatched, setActiveLatched] = React.useState<boolean>(!isFinalized);
    const previousPartIdRef = React.useRef<string | undefined>(part.id);
    const lastGitRefreshSignatureRef = React.useRef<string>('');

    React.useEffect(() => {
        if (previousPartIdRef.current === part.id) {
            return;
        }
        previousPartIdRef.current = part.id;
        lastGitRefreshSignatureRef.current = '';
        // Reset latch only when tool identity changes.
        setActiveLatched(!isFinalized);
    }, [isFinalized, part.id]);

    React.useEffect(() => {
        if (!isFinalized) {
            setActiveLatched(true);
        }
    }, [isFinalized]);

    React.useEffect(() => {
        if (!isFinalized || isError || !currentDirectory) {
            return;
        }
        if (!GIT_REFRESH_MUTATING_TOOLS.has(normalizedPartTool)) {
            return;
        }

        const signature = `${part.id}:${status ?? 'unknown'}`;
        if (lastGitRefreshSignatureRef.current === signature) {
            return;
        }
        lastGitRefreshSignatureRef.current = signature;
        sessionEvents.requestGitRefresh({ directory: currentDirectory });
    }, [currentDirectory, isError, isFinalized, normalizedPartTool, part.id, status]);

    const shouldNotifyStructuralChange = isFinalized || isTaskTool;

    const onContentChangeRef = React.useRef(onContentChange);
    onContentChangeRef.current = onContentChange;
    const expandedContentRef = React.useRef<HTMLDivElement>(null);

    React.useLayoutEffect(() => {
        if (isTaskTool || isFileNavTool) {
            return;
        }

        const element = expandedContentRef.current;
        if (!element) {
            if (shouldNotifyStructuralChange) {
                onContentChangeRef.current?.('structural');
            }
            return;
        }

        element.style.height = isExpanded ? 'auto' : '0px';
        element.style.overflow = isExpanded ? 'visible' : 'hidden';

        if (shouldNotifyStructuralChange) {
            onContentChangeRef.current?.('structural');
        }
    }, [isExpanded, isFileNavTool, isTaskTool, shouldNotifyStructuralChange]);

    const stateWithData = state as ToolStateWithMetadata;
    const metadata = stateWithData.metadata;
    const partMetadata = (part as unknown as { metadata?: unknown }).metadata;
    const input = stateWithData.input;
    const time = stateWithData.time;

    const [pinnedTime, setPinnedTime] = React.useState<{ start?: number; end?: number }>(() => ({
        start: typeof time?.start === 'number' ? time.start : undefined,
        end: typeof time?.end === 'number' ? time.end : undefined,
    }));
    const [localStartAt, setLocalStartAt] = React.useState<number | undefined>(undefined);
    const [localFinalizedAt, setLocalFinalizedAt] = React.useState<number | undefined>(undefined);

    React.useEffect(() => {
        setPinnedTime({});
        setLocalStartAt(undefined);
        setLocalFinalizedAt(undefined);
    }, [part.id]);

    React.useEffect(() => {
        if (isFinalized) {
            return;
        }
        if (typeof time?.start === 'number') {
            return;
        }
        setLocalStartAt((prev) => prev ?? Date.now());
    }, [isFinalized, time?.start]);

    React.useEffect(() => {
        setPinnedTime((prev) => {
            const next = { ...prev };
            let changed = false;

            if (typeof time?.start === 'number' && (typeof prev.start !== 'number' || time.start < prev.start)) {
                next.start = time.start;
                changed = true;
            }

            if (typeof time?.end === 'number' && (typeof prev.end !== 'number' || time.end > prev.end)) {
                next.end = time.end;
                changed = true;
            }

            return changed ? next : prev;
        });
    }, [time?.end, time?.start]);

    const effectiveTimeStart = React.useMemo(() => {
        // Once we captured a local start (during pending, before server sends time.start),
        // always prefer it so the timer never jumps when server start arrives later.
        if (typeof localStartAt === 'number') {
            return localStartAt;
        }
        const candidates = [pinnedTime.start, time?.start].filter(
            (value): value is number => typeof value === 'number'
        );
        if (candidates.length === 0) {
            return undefined;
        }
        return Math.min(...candidates);
    }, [localStartAt, pinnedTime.start, time?.start]);

    const taskOutputString = React.useMemo(() => {
        return typeof stateWithData.output === 'string' ? stateWithData.output : undefined;
    }, [stateWithData.output]);

    const parsedTaskMetadata = React.useMemo(() => {
        return parseTaskMetadataBlock(taskOutputString);
    }, [taskOutputString]);

    const metadataTaskSummaryEntries = React.useMemo<TaskToolSummaryEntry[]>(() => {
        if (!isTaskTool) {
            return [];
        }
        const candidateSummary = (metadata as { summary?: unknown; entries?: unknown; tools?: unknown; calls?: unknown } | undefined);
        const normalized = normalizeTaskSummaryEntries(
            candidateSummary?.summary ?? candidateSummary?.entries ?? candidateSummary?.tools ?? candidateSummary?.calls
        );

        if (normalized.length > 0) {
            return normalized;
        }

        return parsedTaskMetadata.summaryEntries;
    }, [isTaskTool, metadata, parsedTaskMetadata.summaryEntries]);

    const hasFinalMetadataTaskSummary = isFinalized && metadataTaskSummaryEntries.length > 0;

    const explicitTaskSessionId = React.useMemo<string | undefined>(() => {
        if (!isTaskTool) {
            return undefined;
        }

        // Current OpenCode publishes this authoritative join while the Task is
        // running. The remaining sources only support older persisted parts.
        const metadataSessionId = readTaskSessionIdFromRecord(metadata);
        if (metadataSessionId) {
            return metadataSessionId;
        }

        const partLevelSessionId = readTaskSessionIdFromRecord(partMetadata);
        if (partLevelSessionId) {
            return partLevelSessionId;
        }

        if (parsedTaskMetadata.sessionId) {
            return parsedTaskMetadata.sessionId;
        }
        return readTaskSessionIdFromOutput(taskOutputString);
    }, [isTaskTool, metadata, parsedTaskMetadata.sessionId, partMetadata, taskOutputString]);

    const taskSessionId = explicitTaskSessionId;
    const shouldObserveTaskStatus = isTaskTool && !isFinalized && activeLatched;
    const activeTaskStatusSessionId = shouldObserveTaskStatus ? taskSessionId : undefined;
    const activeTaskParentSessionId = shouldObserveTaskStatus && !taskSessionId ? part.sessionID : undefined;
    const observedTaskSessionId = activeTaskStatusSessionId ?? activeTaskParentSessionId;
    const childSessionStatus = useSessionStatus(activeTaskStatusSessionId ?? '', currentDirectory);
    const parentSessionStatus = useSessionStatus(activeTaskParentSessionId ?? '', currentDirectory);
    const statusObservedAt = useSessionStatusObservedAt(observedTaskSessionId ?? '', currentDirectory);
    const statusSnapshotAt = useSessionStatusSnapshotAt(currentDirectory, shouldObserveTaskStatus);
    // 关闭详情时不必为竖线摘要拉取子会话消息
    const childSessionLookupId = (!showSubagentTaskDetails || hasFinalMetadataTaskSummary) ? '' : (taskSessionId ?? '');

    const childSessionMessages = useSessionMessageRecords(childSessionLookupId, currentDirectory);
    useEnsureSessionMessages(childSessionLookupId, currentDirectory);

    const childSessionTaskSummaryEntries = React.useMemo<TaskToolSummaryEntry[]>(() => {
        if (!isTaskTool || !taskSessionId) {
            return [];
        }
        if (!Array.isArray(childSessionMessages) || childSessionMessages.length === 0) {
            return [];
        }
        return buildTaskSummaryEntriesFromSession(childSessionMessages);
    }, [childSessionMessages, isTaskTool, taskSessionId]);

    React.useEffect(() => {
        if (typeof time?.end === 'number' || typeof pinnedTime.end === 'number') {
            setLocalFinalizedAt(undefined);
            return;
        }

        if (typeof effectiveTimeStart !== 'number') {
            return;
        }

        if (!isFinalized) {
            return;
        }

        setLocalFinalizedAt((prev) => prev ?? Date.now());
    }, [
        effectiveTimeStart,
        isFinalized,
        pinnedTime.end,
        time?.end,
    ]);

    const effectiveTimeEnd = isFinalized ? (pinnedTime.end ?? time?.end ?? localFinalizedAt) : undefined;
    const isActive = !isFinalized && activeLatched;
    const suppressTaskLoading = shouldSuppressTaskLoading({
        isTaskTool,
        isFinalized,
        taskSessionId,
        childSessionStatus,
        parentSessionStatus,
        statusObservedAt,
        taskStartedAt: effectiveTimeStart,
        statusSnapshotAt,
    });
    const effectiveActive = isActive && !suppressTaskLoading;
    React.useEffect(() => {
        if (suppressTaskLoading) setActiveLatched(false);
    }, [suppressTaskLoading]);
    const shouldTreatAsFinalized = isFinalized;

    const taskSummaryEntries = React.useMemo<TaskToolSummaryEntry[]>(() => {
        if (childSessionTaskSummaryEntries.length > 0) {
            return childSessionTaskSummaryEntries;
        }
        return metadataTaskSummaryEntries;
    }, [childSessionTaskSummaryEntries, metadataTaskSummaryEntries]);
    const taskSummaryRenderSignature = React.useMemo(() => {
        return taskSummaryEntries.map(getTaskSummaryEntryRenderSignature).join('\u0000');
    }, [taskSummaryEntries]);
    const lastTaskSummaryRenderSignatureRef = React.useRef<string | null>(null);

    React.useEffect(() => {
        if (!isTaskTool) {
            lastTaskSummaryRenderSignatureRef.current = null;
            return;
        }

        const previous = lastTaskSummaryRenderSignatureRef.current;
        lastTaskSummaryRenderSignatureRef.current = taskSummaryRenderSignature;
        if (previous === null || previous === taskSummaryRenderSignature || taskSummaryEntries.length === 0) {
            return;
        }

        onContentChangeRef.current?.('structural');
    }, [isTaskTool, taskSummaryEntries.length, taskSummaryRenderSignature]);

    const diffStats = React.useMemo(() => {
        return (normalizedPartTool === 'edit' || normalizedPartTool === 'multiedit' || normalizedPartTool === 'apply_patch')
            ? parseDiffStats(metadata)
            : null;
    }, [metadata, normalizedPartTool]);
    const writeLineCount = React.useMemo(() => {
        return normalizedPartTool === 'write' ? parseWriteLineCount(input) : null;
    }, [input, normalizedPartTool]);
    const isMultiFileApplyPatch = normalizedPartTool === 'apply_patch' && Array.isArray(metadata?.files) && (metadata?.files as []).length > 1;
    const normalizedPart = normalizedPartTool !== part.tool ? ({ ...part, tool: normalizedPartTool } as ToolPartType) : part;
    const descriptionPath = getToolDescriptionPath(normalizedPart, state, currentDirectory);
    const description = getToolDescription(normalizedPart, state, currentDirectory);
    const displayName = getToolMetadata(normalizedPartTool || part.tool).displayName;
    // Task 工具：用子 Agent 昵称替换通用 “Agent Task” 文案
    const taskAgentName = isTaskTool ? resolveTaskAgentName(input) : undefined;
    const taskTitle = taskAgentName ? formatAgentDisplayName(taskAgentName) : displayName;
    
    // Tool title/description — shown inline as context
    const justificationText = React.useMemo(() => {
        if (normalizedPartTool === 'bash') {
            return null;
        }
        if (normalizedPartTool === 'apply_patch') {
            return null;
        }
        if (normalizedPartTool === 'lsp') {
            return null;
        }
        if (
            descriptionPath
            && (normalizedPartTool === 'apply_patch' || normalizedPartTool === 'edit' || normalizedPartTool === 'multiedit' || normalizedPartTool === 'write')
        ) {
            return null;
        }
        const title = (stateWithData as { title?: string }).title;
        if (typeof title === 'string' && title.trim().length > 0) {
            return title;
        }
        const inputDesc = input?.description;
        if (typeof inputDesc === 'string' && inputDesc.trim().length > 0) {
            return inputDesc;
        }
        return null;
    }, [descriptionPath, normalizedPartTool, stateWithData, input]);
    const runtime = React.useContext(RuntimeAPIContext);
    const pendingOpenTaskSessionRef = React.useRef(false);

    /** 打开子 Agent 会话（context panel / 移动端切会话）；成功返回 true */
    const openTaskSession = React.useCallback((sessionIdOverride?: string): boolean => {
        const sessionId = sessionIdOverride ?? taskSessionId;
        if (!sessionId || !currentDirectory) {
            return false;
        }
        pendingOpenTaskSessionRef.current = false;
        return navigateNestedSession(sessionSurface, sessionId, currentDirectory, () => {
            if (isMobile || runtime?.runtime.isVSCode) {
                setCurrentSession(sessionId, currentDirectory);
                return;
            }
            openContextPanelTab(currentDirectory, {
                mode: 'chat',
                dedupeKey: `session:${sessionId}`,
                label: taskTitle,
                readOnly: true,
            });
        });
    }, [
        currentDirectory,
        isMobile,
        openContextPanelTab,
        runtime?.runtime.isVSCode,
        setCurrentSession,
        sessionSurface,
        taskSessionId,
        taskTitle,
    ]);

    // loading 时点了但 id 尚未到位：等 sessionId 一到就打开
    React.useEffect(() => {
        if (!pendingOpenTaskSessionRef.current || !taskSessionId) {
            return;
        }
        openTaskSession(taskSessionId);
    }, [openTaskSession, taskSessionId]);

    const handleMainClick = (e: { stopPropagation: () => void }) => {
        // Task：整行始终打开子会话（含 loading）；详情展开只走图标位箭头
        if (isTaskTool) {
            e.stopPropagation();
            if (sessionSurface.capabilities.navigateNestedSession && !openTaskSession()) {
                // 子会话 id 还在路上：记下意图，id 到达后自动打开
                pendingOpenTaskSessionRef.current = true;
            }
            return;
        }

        let filePath: unknown;
        let targetLine: number | undefined;
        let toolDiff: string | undefined;
        if (normalizedPartTool === 'edit' || normalizedPartTool === 'multiedit' || normalizedPartTool === 'apply_patch') {
            filePath = getPrimaryToolPath(normalizedPartTool, input, metadata);
            targetLine = getFirstChangedLineFromMetadata(
                normalizedPartTool,
                metadata,
                typeof filePath === 'string' ? filePath : undefined,
            );
            if (typeof filePath === 'string') {
                toolDiff = getPrimaryDiffFromMetadata(normalizedPartTool, metadata, filePath);
            }
        } else if (['write', 'create', 'file_write'].includes(normalizedPartTool)) {
            filePath = input?.filePath || input?.file_path || input?.path || metadata?.filePath || metadata?.file_path || metadata?.path;
            targetLine = 1;
            if (typeof filePath === 'string' && typeof input?.content === 'string') {
                toolDiff = buildWritePreviewPatch(filePath, input.content);
            }
        } else if (normalizedPartTool === 'lsp') {
            filePath = input?.filePath || input?.file_path || input?.path;
            const line = input?.line;
            targetLine = typeof line === 'number' && Number.isFinite(line) ? Math.trunc(line) : undefined;
        }

        if (typeof filePath === 'string') {
            e.stopPropagation();
            const absolutePath = toAbsoluteFilePath(currentDirectory, filePath) || (
                filePath.startsWith('/')
                    ? filePath
                    : (currentDirectory.endsWith('/') ? currentDirectory + filePath : `${currentDirectory}/${filePath}`)
            );

            if (isFileNavTool) {
                const relativePath = getRelativePath(absolutePath, currentDirectory);
                const supportsExactToolDiff = normalizedPartTool === 'edit'
                    || normalizedPartTool === 'multiedit'
                    || normalizedPartTool === 'apply_patch';
                const selectedToolDiffs = toolDiff && supportsExactToolDiff
                    ? getToolNavigationDiffEntries(
                        normalizedPartTool,
                        metadata,
                        toolDiff,
                        relativePath,
                        (path) => getRelativePath(path, currentDirectory),
                    )
                    : [];
                const toolPatches = selectedToolDiffs.map((entry) => ({
                    path: entry.title,
                    patch: entry.patch,
                }));

                if (runtime?.runtime.isVSCode && runtime.editor && toolDiff) {
                    const label = `${relativePath} (changes)`;
                    void runtime.editor.openDiff('', absolutePath, label, { line: targetLine, patch: toolDiff });
                    return;
                }

                if (isFilePathWithinDirectory(absolutePath, currentDirectory)) {
                    if (mobileActions) {
                        if (toolPatches.length > 0) {
                            mobileActions.openToolDiff({
                                diffPath: relativePath,
                                patches: toolPatches,
                                targetLine,
                            });
                        } else if (normalizedPartTool === 'apply_patch') {
                            mobileActions.openTurnDiff(messageId);
                        } else {
                            mobileActions.openChanges({ diffPath: relativePath, staged: false, targetLine });
                        }
                    } else if (isMobile) {
                        navigateToDiff(relativePath, false, 'turn', targetLine);
                    } else {
                        if (toolPatches.length > 0) {
                            openContextToolDiff(
                                currentDirectory,
                                relativePath,
                                toolPatches,
                                targetLine,
                                messageId,
                            );
                        } else {
                            openContextDiff(currentDirectory, relativePath, false, 'turn', targetLine, messageId);
                        }
                    }
                    return;
                }

                if (runtime?.editor) {
                    void runtime.editor.openFile(absolutePath, targetLine);
                    return;
                }

                const openInContext = () => {
                    const uiStore = useUIStore.getState();
                    const contextDirectory = getDirectoryForFilePath(currentDirectory, absolutePath);
                    if (typeof targetLine === 'number' && Number.isFinite(targetLine)) {
                        uiStore.openContextFileAtLine(contextDirectory, absolutePath, Math.max(1, Math.trunc(targetLine)), 1);
                        return;
                    }
                    uiStore.openContextFile(contextDirectory, absolutePath);
                };

                void ensureOutsideFileGrantForDesktop(absolutePath, currentDirectory).then(openInContext);
                return;
            }

            if (normalizedPartTool === 'lsp') {
                if (runtime?.editor) {
                    void runtime.editor.openFile(absolutePath, targetLine);
                    return;
                }

                const openInContext = () => {
                    const uiStore = useUIStore.getState();
                    const contextDirectory = getDirectoryForFilePath(currentDirectory, absolutePath);
                    if (typeof targetLine === 'number' && Number.isFinite(targetLine)) {
                        uiStore.openContextFileAtLine(contextDirectory, absolutePath, Math.max(1, Math.trunc(targetLine)), 1);
                        return;
                    }
                    uiStore.openContextFile(contextDirectory, absolutePath);
                };

                if (!isFilePathWithinDirectory(absolutePath, currentDirectory)) {
                    void ensureOutsideFileGrantForDesktop(absolutePath, currentDirectory).then(openInContext);
                    return;
                }
                openInContext();
                return;
            }

            if (runtime?.editor) {
                if (runtime.runtime.isVSCode && toolDiff && (part.tool === 'edit' || part.tool === 'multiedit' || part.tool === 'apply_patch')) {
                    const label = `${getRelativePath(absolutePath, currentDirectory)} (changes)`;
                    void runtime.editor.openDiff('', absolutePath, label, { line: targetLine, patch: toolDiff });
                    return;
                }
                runtime.editor.openFile(absolutePath, targetLine);
                return;
            }
        }

        if (normalizedPartTool === 'apply_patch' && mobileActions) {
            e.stopPropagation();
            mobileActions.openTurnDiff(messageId);
            return;
        }

        if (normalizedPartTool === 'apply_patch' && currentDirectory && !mobileActions && !isMobile && !runtime?.runtime.isVSCode) {
            e.stopPropagation();
            openContextPanelTab(currentDirectory, { mode: 'diff', diffScope: 'turn', diffTurnMessageId: messageId });
            return;
        }

        if (!isFileNavTool) {
            onToggle(part.id);
        }
    };

    const handleMainKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
        if (event.key !== 'Enter' && event.key !== ' ') {
            return;
        }
        event.preventDefault();
        handleMainClick(event);
    };

    const iconStyle = !isTaskTool && isError ? TOOL_ERROR_ICON_STYLE : TOOL_NORMAL_ICON_STYLE;
    const titleStyle = !isTaskTool && isError ? TOOL_ERROR_TITLE_STYLE : TOOL_NORMAL_TITLE_STYLE;
    const taskBusy = Boolean(isTaskTool && effectiveActive && !isError);
    const shouldRenderTaskSummary = useDeferredExpandedContent(
        isTaskTool
        && showSubagentTaskDetails
        && (taskSummaryEntries.length > 0 || effectiveActive || shouldTreatAsFinalized || !!taskSessionId)
    );
    const shouldRenderExpandedContent = useDeferredExpandedContent(!isTaskTool && !isFileNavTool && isExpanded);

    if (!shouldTreatAsFinalized && !isActive && !isTaskTool) {
        return null;
    }

    return (
        <div>
            {}
            <div
                className={cn(
                'group/tool flex gap-1.5 cursor-pointer',
                TOOL_ROW_INTERACTIVE_CHROME_CLASS,
                // Task 干活中也要有明确 hover 洗底（与其它工具行一致）
                isTaskTool && 'hover:!bg-[color-mix(in_srgb,var(--surface-foreground)_6%,transparent)]',
                isMultiFileApplyPatch ? 'flex-wrap items-start' : 'items-center'
            )}
                onClick={handleMainClick}
                onKeyDown={handleMainKeyDown}
                role="button"
                tabIndex={0}
            >
                <div className={cn('flex gap-1.5', isMultiFileApplyPatch ? 'w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5' : 'items-center flex-shrink-0')}>
                    {}
                    <div
                        className={cn(
                            'relative h-3.5 w-3.5 flex-shrink-0',
                            !isFileNavTool && 'group/taskicon cursor-pointer'
                        )}
                        onClick={(event) => {
                            event.stopPropagation();
                            if (isFileNavTool) {
                                handleMainClick(event);
                                return;
                            }
                            if (isTaskTool) {
                                // 图标位：开启详情时箭头负责展开；否则与整行一样打开子会话
                                if (showSubagentTaskDetails) {
                                    onToggle(part.id);
                                    return;
                                }
                                if (sessionSurface.capabilities.navigateNestedSession && !openTaskSession()) {
                                    pendingOpenTaskSessionRef.current = true;
                                }
                                return;
                            }
                            onToggle(part.id);
                        }}
                    >
                        {}
                        <div
                            className={cn(
                                'absolute inset-0 flex items-center justify-center transition-opacity',
                                // Task：头像常显；仅悬停图标位且开启详情时才换成箭头（勿用整行 group-hover）
                                // Edit/Write：固定工具图标，不换箭头
                                // 其它工具：展开或 hover 整行时让位给箭头
                                isFileNavTool
                                    ? undefined
                                    : isTaskTool
                                        ? (showSubagentTaskDetails ? 'group-hover/taskicon:opacity-0' : undefined)
                                        : cn(isExpanded && 'opacity-0', !isExpanded && 'group-hover/tool:opacity-0')
                            )}
                            style={isTaskTool ? undefined : iconStyle}
                        >
                            {isTaskTool ? (
                                <AgentAvatar
                                    // 子 Agent（如 Explorer）不一定出现在主 Agent 选择器里；identicon 只吃名字种子
                                    name={taskAgentName ?? 'subagent'}
                                    size={14}
                                    label={taskTitle}
                                />
                            ) : (
                                getToolIcon(normalizedPartTool || part.tool)
                            )}
                        </div>
                        {}
                        {!isFileNavTool ? (
                            <div
                                className={cn(
                                    'absolute inset-0 transition-opacity flex items-center justify-center pointer-events-none',
                                    isTaskTool
                                        ? (showSubagentTaskDetails
                                            ? 'opacity-0 group-hover/taskicon:opacity-100'
                                            : 'opacity-0')
                                        : cn(isExpanded && 'opacity-100', !isExpanded && 'opacity-0 group-hover/tool:opacity-100')
                                )}
                            >
                                {isExpanded ? <Icon name="arrow-down-s" className="h-3.5 w-3.5" /> : <Icon name="arrow-right-s" className="h-3.5 w-3.5" />}
                            </div>
                        ) : null}
                    </div>
                    {isMultiFileApplyPatch ? (
                        <>
                            <MinDurationShineText
                                active={Boolean(effectiveActive && !isError)}
                                minDurationMs={300}
                                className={cn(TOOL_ROW_TITLE_CLASS, 'flex-shrink-0')}
                                style={titleStyle}
                                title={displayName}
                            >
                                {displayName}
                            </MinDurationShineText>
                            {getMultiFileDescription(metadata, animateTailText, showToolFileIcons)}
                        </>
                    ) : (
                        <>
                            <div className="flex items-center gap-2 min-w-0 flex-1">
                                {taskBusy ? (
                                    <span
                                        className={cn(TOOL_ROW_TITLE_CLASS, 'flex-shrink-0 animate-text-shimmer')}
                                        style={{
                                            color: 'var(--tools-title)',
                                            ['--oc-text-shimmer-base' as string]: 'var(--tools-title)',
                                        }}
                                        title={taskTitle}
                                    >
                                        {taskTitle}
                                    </span>
                                ) : (
                                    <MinDurationShineText
                                        active={Boolean(effectiveActive && !isError)}
                                        minDurationMs={300}
                                        className={cn(TOOL_ROW_TITLE_CLASS, 'flex-shrink-0')}
                                        style={titleStyle}
                                        title={taskTitle}
                                    >
                                        {taskTitle}
                                    </MinDurationShineText>
                                )}
                            </div>
                            {normalizedPartTool === 'bash' && typeof effectiveTimeStart === 'number' ? (
                                <span className={cn('flex-shrink-0 tabular-nums text-muted-foreground/80', TOOL_ROW_DESCRIPTION_CLASS)}>
                                    <LiveDuration
                                        start={effectiveTimeStart}
                                        end={typeof effectiveTimeEnd === 'number' ? effectiveTimeEnd : undefined}
                                        active={Boolean(effectiveActive && typeof effectiveTimeEnd !== 'number')}
                                    />
                                </span>
                            ) : null}
                        </>
                    )}
                </div>

                {!isMultiFileApplyPatch && (
                    <div className={cn('flex items-center gap-1 flex-1 min-w-0', TOOL_ROW_DESCRIPTION_CLASS)} style={{ color: 'var(--tools-description)' }}>
                        <div className="flex items-center gap-1 flex-1 min-w-0">
                            {justificationText && (
                                <span
                                    className={cn(
                                        'min-w-0 truncate',
                                        TOOL_ROW_DESCRIPTION_CLASS,
                                        taskBusy && 'animate-text-shimmer',
                                    )}
                                    style={{
                                        color: 'var(--tools-description)',
                                        ...(taskBusy
                                            ? { ['--oc-text-shimmer-base' as string]: 'var(--tools-description)' }
                                            : { opacity: 0.8 }),
                                    }}
                                    title={justificationText}
                                >
                                    {justificationText}
                                </span>
                            )}
                            {!justificationText && normalizedPartTool === 'lsp' && descriptionPath ? (
                                renderAnimatedPathWithIcon(descriptionPath, animateTailText, false, showToolFileIcons)
                            ) : null}
                            {!justificationText && normalizedPartTool !== 'lsp' && description && (
                                descriptionPath && description === descriptionPath ? (
                                    renderAnimatedPathWithIcon(descriptionPath, animateTailText, false, showToolFileIcons)
                                ) : (
                                    <Text
                                        variant={animateTailText ? 'generate-effect' : 'static'}
                                        className={cn('min-w-0 truncate', TOOL_ROW_DESCRIPTION_CLASS)}
                                        style={{ color: 'var(--tools-description)' }}
                                        title={description}
                                    >
                                        {description}
                                    </Text>
                                )
                            )}
                            {diffStats && (
                                <span className="flex-shrink-0 inline-flex items-center gap-0 typography-meta" style={{ fontSize: '0.8rem', lineHeight: '1' }}>
                                    <span style={{ color: 'var(--status-success)' }}>+{diffStats.added}</span>
                                    <span style={{ color: 'var(--tools-description)' }}>/</span>
                                    <span style={{ color: 'var(--status-error)' }}>-{diffStats.removed}</span>
                                </span>
                            )}
                            {writeLineCount && (
                                <span className="flex-shrink-0 inline-flex items-center gap-0 typography-meta" style={{ fontSize: '0.8rem', lineHeight: '1' }}>
                                    <span style={{ color: 'var(--status-success)' }}>+{writeLineCount}</span>
                                </span>
                            )}
                        </div>
                    </div>
                )}
            </div>

            {}
            {shouldRenderTaskSummary ? (
                <TaskToolSummary
                    entries={taskSummaryEntries}
                    isExpanded={isExpanded}
                    isMobile={isMobile}
                    output={taskOutputString}
                    sessionId={taskSessionId}
                    onShowPopup={onShowPopup}
                    input={input}
                    animateTailText={animateTailText}
                    isActive={effectiveActive}
                />
            ) : null}

            {!isTaskTool && !isFileNavTool && isExpanded ? (
                <div
                    ref={expandedContentRef}
                    aria-hidden={false}
                    style={{
                        height: 'auto',
                        overflow: 'visible',
                        overflowAnchor: 'none',
                    }}
                >
                    {shouldRenderExpandedContent ? (
                        <div
                            className={TOOL_EXPANDED_TIMELINE_CLASS_NAME}
                        >
                            <span
                                aria-hidden="true"
                                className="pointer-events-none absolute left-0 top-px bottom-0 w-px"
                                style={{ backgroundColor: 'var(--tools-border)' }}
                            />
                            <ToolExpandedContent
                                part={part}
                                state={state}
                                currentDirectory={currentDirectory}
                                isExpanded={isExpanded}
                                isMobile={isMobile}
                                onShowPopup={onShowPopup}
                            />
                        </div>
                    ) : null}
                </div>
            ) : null}
        </div>
    );
};

class ToolPartErrorBoundary extends React.Component<{
    children: React.ReactNode;
    displayName: string;
    errorLabel: string;
    resetKey: unknown;
    toolName: string;
}, { hasError: boolean; error?: Error }> {
    state: { hasError: boolean; error?: Error } = { hasError: false };

    static getDerivedStateFromError(error: Error): { hasError: boolean; error: Error } {
        return { hasError: true, error };
    }

    componentDidUpdate(prevProps: { resetKey: unknown }) {
        if (prevProps.resetKey !== this.props.resetKey && this.state.hasError) {
            this.setState({ hasError: false, error: undefined });
        }
    }

    componentDidCatch(error: Error) {
        if (process.env.NODE_ENV === 'development') {
            console.warn('Tool part failed to render; showing safe fallback.', error);
        }
    }

    render() {
        if (!this.state.hasError) {
            return this.props.children;
        }

        const message = this.state.error?.message;
        return (
            <div className={cn('flex items-center gap-1.5 min-w-0', TOOL_ROW_CHIP_CLASS)}>
                <div className="h-3.5 w-3.5 flex-shrink-0" style={TOOL_ERROR_ICON_STYLE}>
                    {getToolIcon(this.props.toolName)}
                </div>
                <span className={cn(TOOL_ROW_TITLE_CLASS, 'flex-shrink-0')} style={TOOL_ERROR_TITLE_STYLE}>
                    {this.props.displayName}
                </span>
                {message ? (
                    <span className={cn(TOOL_ROW_DESCRIPTION_CLASS, 'min-w-0 truncate')} style={{ color: 'var(--tools-description)' }} title={message}>
                        {this.props.errorLabel}: {message}
                    </span>
                ) : null}
            </div>
        );
    }
}

const ToolPart: React.FC<ToolPartProps> = (props) => {
    const { t } = useI18n();
    const deferHydration = useDeferredToolHydration();
    const toolName = normalizeToolName(props.part.tool) || 'tool';
    const displayName = getToolMetadata(toolName).displayName;
    const [isHydrated, setIsHydrated] = React.useState(() => (
        !deferHydration || hydratedHistoricalToolIds.get(props.part.id) === true
    ));

    React.useEffect(() => {
        if (!deferHydration || isHydrated) {
            return;
        }
        return scheduleAfterPaintTask(() => {
            hydratedHistoricalToolIds.set(props.part.id, true, props.part.id.length * 2 + 8);
            React.startTransition(() => {
                setIsHydrated(true);
            });
        });
    }, [deferHydration, isHydrated, props.part.id]);

    if (!isHydrated) {
        return (
            <div className={cn('flex min-w-0 items-center gap-2', TOOL_ROW_CHIP_CLASS)}>
                <span className="h-3.5 w-3.5 shrink-0 rounded bg-muted/50" aria-hidden="true" />
                <span className={cn(TOOL_ROW_TITLE_CLASS, 'shrink-0 text-muted-foreground')}>
                    {displayName}
                </span>
                <span className="h-3 w-24 min-w-0 rounded bg-muted/40" aria-hidden="true" />
            </div>
        );
    }

    return (
        <ToolPartErrorBoundary
            displayName={displayName}
            errorLabel={t('chat.toolPart.error')}
            resetKey={props.part}
            toolName={toolName}
        >
            <ToolPartContent {...props} />
        </ToolPartErrorBoundary>
    );
};

export default React.memo(ToolPart, (prev, next) => {
    return areRenderRelevantPartsEqual([prev.part], [next.part])
        && prev.messageId === next.messageId
        && prev.isExpanded === next.isExpanded
        && prev.isMobile === next.isMobile
        && prev.alwaysShowActions === next.alwaysShowActions
        && prev.onContentChange === next.onContentChange
        && prev.onShowPopup === next.onShowPopup
        && prev.animateTailText === next.animateTailText;
});
