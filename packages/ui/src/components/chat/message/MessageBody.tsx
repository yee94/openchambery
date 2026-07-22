import React from 'react';
import type { Part } from '@opencode-ai/sdk/v2';

import UserTextPart from './parts/UserTextPart';
import ToolPart from './parts/ToolPart';
import AssistantTextPart from './parts/AssistantTextPart';
import ReasoningPart from './parts/ReasoningPart';
import { MessageFilesDisplay } from '../FileAttachment';
import { TurnChangedFilesDropdown } from '../TurnChangedFilesDropdown';
import type { ToolPart as ToolPartType } from '@opencode-ai/sdk/v2';
import type { StreamPhase, ToolPopupContent, AgentMentionInfo } from './types';
import type { TurnChangedFile, TurnGroupingContext } from '../lib/turns/types';
import { cn } from '@/lib/utils';
import { WorkerHighlightedCode } from '@/components/code/WorkerHighlightedCode';
import { isEmptyTextPart, extractTextContent } from './partUtils';
import { FadeInOnReveal } from './FadeInOnReveal';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { ContentChangeReason } from '@/hooks/useChatAutoFollow';
import {
    emitStreamingHapticEvent,
    hasStreamingHapticSubscribers,
    shouldEmitToolAppearanceHaptic,
} from '@/sync/streaming-haptic-events';

import { SimpleMarkdownRenderer } from '../MarkdownRenderer';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useUIStore } from '@/stores/useUIStore';
import { flattenAssistantTextParts } from '@/lib/messages/messageText';
import { useMessageTTS } from '@/hooks/useMessageTTS';
import { useConfigStore } from '@/stores/useConfigStore';
import { TextSelectionMenu } from './TextSelectionMenu';
import { copyTextToClipboard } from '@/lib/clipboard';
import { useChatSurfaceMode } from '@/components/chat/useChatSurfaceMode';
import { isVSCodeRuntime } from '@/lib/desktop';
import { Icon } from "@/components/icon/Icon";
import { formatTimestampForDisplay } from './timeFormat';
import { ToolRevealOnMount } from './parts/ToolRevealOnMount';
import { StaticToolRow } from './parts/ProgressiveGroup';
import { getToolRowBlockClass, TOOL_ROW_CHIP_GEOMETRY_CLASS } from './parts/toolRowChrome';
import { isExpandableTool, isStandaloneTool } from './parts/toolRenderUtils';
import TurnActivity from '../components/TurnActivity';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useI18n } from '@/lib/i18n';
import { extractLoopbackUrls } from '@/lib/url';
import { useDeviceInfo } from '@/lib/device';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import {
    type ReviewTransferDirection,
    sendImplementationResponseToReviewer,
    sendReviewFeedbackToOriginal,
} from '@/lib/reviewFlow';
import { isEmbeddedSessionChat } from '@/components/layout/contextPanelEmbeddedChat';
import { getSessionSurfaceActionAvailability, navigateNestedSession, useSessionSurface } from '../SessionSurfaceContext';


const CONTAIN_LAYOUT_STYLE = { contain: 'layout' as const };
const MESSAGE_FOOTER_CONTAINER_STYLE = { containerType: 'inline-size' as const, containerName: 'message-footer' };
const INLINE_MESSAGE_ACTIONS_CLASS_NAME = 'mt-1.5 mb-0.5 flex items-center justify-start gap-1.5';
/** 移动端：正文与底栏再拉开一点，避免贴死. */
const INLINE_MESSAGE_ACTIONS_MOBILE_CLASS_NAME = 'mt-3 mb-0.5 flex items-center justify-start gap-1.5';
/** Icon-only message-footer actions — ~14px glyphs in 24px hit; medium stroke. */
const MESSAGE_ACTION_ICON_BUTTON_CLASS =
  'size-6! p-0 text-muted-foreground bg-transparent hover:text-foreground hover:!bg-transparent active:!bg-transparent focus-visible:!bg-transparent focus-visible:ring-2 focus-visible:ring-primary/50';
const MESSAGE_ACTION_ICON_CLASS = 'size-3.5!';
/**
 * 底栏整行：操作组 | 耗时组 — 组内 gap-2，组间 gap-3，颜色同一档.
 * 移动端 -ml 抵消 size-6 按钮图标居中内缩，与正文左对齐.
 */
const MESSAGE_FOOTER_ROW_CLASS = 'mt-1.5 mb-0.5 flex flex-wrap items-center gap-3';
const MESSAGE_FOOTER_ROW_MOBILE_CLASS = 'mt-3 mb-0.5 flex flex-wrap items-center gap-3 -ml-[5px]';
const MESSAGE_ACTION_GROUP_CLASS = 'flex items-center gap-2';
/** Duration / timestamp — 与操作图标同色；字略小，行高贴齐图标高度保持垂直对齐. */
const MESSAGE_FOOTER_META_GROUP_CLASS = 'flex items-center gap-2 text-muted-foreground';
const MESSAGE_FOOTER_META_CLASS =
  'inline-flex h-3.5 items-center gap-1 text-[11px] leading-none tabular-nums text-muted-foreground';
const MESSAGE_FOOTER_META_ICON_CLASS = 'size-3.5!';
/** Message-action icons: medium stroke — PC + mobile 同一套. */
const MESSAGE_ACTION_ICON_WEIGHT = 'medium' as const;

const getDisplayFileName = (file: string): string => {
    const normalized = file.replace(/\\/g, '/');
    const segments = normalized.split('/').filter(Boolean);
    return segments.at(-1) ?? file;
};

const TurnChangedFileChipContent = React.memo(({ file, interactive = false }: { file: TurnChangedFile; interactive?: boolean }) => (
    <span
        className={cn(
            'inline-flex max-w-full items-center gap-1.5 rounded-lg border border-border/30 bg-muted/30 px-2 py-1 text-xs leading-[1.35] text-muted-foreground',
            interactive && 'transition-colors hover:border-border/60 hover:bg-interactive-hover'
        )}
    >
        <FileTypeIcon filePath={file.file} className="h-3.5 w-3.5 flex-shrink-0" />
        <span className="max-w-52 truncate text-foreground/80" title={file.file}>{getDisplayFileName(file.file)}</span>
        <span className="flex-shrink-0 inline-flex items-center gap-0 typography-meta" style={{ fontSize: '0.8rem', lineHeight: '1' }}>
            <span style={{ color: 'var(--status-success)' }}>+{file.additions}</span>
            <span className="text-muted-foreground/70">/</span>
            <span style={{ color: 'var(--status-error)' }}>-{file.deletions}</span>
        </span>
    </span>
));

const TurnChangedFilePillButton = React.memo(({
    file,
    onOpen,
}: {
    file: TurnChangedFile;
    onOpen: (file: string) => void;
}) => {
    const { t } = useI18n();
    return (
        <button
            type="button"
            className="inline-flex h-8 max-w-full cursor-pointer items-center rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]"
            aria-label={t('chat.changedFiles.actions.openFileTitle', { path: file.file })}
            title={file.file}
            onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onOpen(file.file);
            }}
        >
            <TurnChangedFileChipContent file={file} interactive />
        </button>
    );
});

const StaticTurnChangedFilePills = React.memo(({ files }: { files: TurnChangedFile[] }) => (
    <>
        {files.map((file) => (
            <span key={file.file} className="inline-flex h-8 max-w-full items-center" title={file.file}>
                <TurnChangedFileChipContent file={file} />
            </span>
        ))}
    </>
));

const InteractiveTurnChangedFilePills = React.memo(({ files }: { files: TurnChangedFile[] }) => {
    const effectiveDirectory = useEffectiveDirectory();
    const isMobile = useUIStore((state) => state.isMobile);
    const navigateToDiff = useUIStore((state) => state.navigateToDiff);
    const openContextDiff = useUIStore((state) => state.openContextDiff);

    const openLastTurnDiff = React.useCallback((file: string) => {
        if (!isMobile && effectiveDirectory) {
            openContextDiff(effectiveDirectory, file, false, 'turn');
            return;
        }

        navigateToDiff(file, false, 'turn');
    }, [effectiveDirectory, isMobile, navigateToDiff, openContextDiff]);

    return (
        <>
            {files.map((file) => (
                <TurnChangedFilePillButton key={file.file} file={file} onOpen={openLastTurnDiff} />
            ))}
        </>
    );
});

const TurnChangedFilePills = React.memo(({ files, isInteractive }: { files?: TurnChangedFile[]; isInteractive: boolean }) => {
    if (!files || files.length === 0) return null;

    return isInteractive ? <InteractiveTurnChangedFilePills files={files} /> : <StaticTurnChangedFilePills files={files} />;
});

type SubtaskPartLike = Part & {
    type: 'subtask';
    description?: unknown;
    command?: unknown;
    agent?: unknown;
    prompt?: unknown;
    taskSessionID?: unknown;
    model?: {
        providerID?: unknown;
        modelID?: unknown;
    };
};

type ShellActionPartLike = Part & {
    type: 'text';
    shellAction?: {
        command?: unknown;
        output?: unknown;
        status?: unknown;
    };
};

const isSubtaskPart = (part: Part): part is SubtaskPartLike => {
    return part.type === 'subtask';
};

const isShellActionPart = (part: Part): part is ShellActionPartLike => {
    const textPart = part as unknown as { type?: unknown; shellAction?: unknown };
    return textPart.type === 'text' && typeof textPart.shellAction === 'object' && textPart.shellAction !== null;
};

const normalizeSubtaskModel = (model: SubtaskPartLike['model']): string | null => {
    if (!model || typeof model !== 'object') return null;
    const providerID = typeof model.providerID === 'string' ? model.providerID.trim() : '';
    const modelID = typeof model.modelID === 'string' ? model.modelID.trim() : '';
    if (!providerID || !modelID) return null;
    return `${providerID}/${modelID}`;
};

const UserSubtaskPart: React.FC<{ part: SubtaskPartLike }> = ({ part }) => {
    const [expanded, setExpanded] = React.useState(false);
    const effectiveDirectory = useEffectiveDirectory();
    const { isMobile } = useDeviceInfo();
    const setCurrentSession = useSessionUIStore((state) => state.setCurrentSession);
    const openContextPanelTab = useUIStore((state) => state.openContextPanelTab);
    const sessionSurface = useSessionSurface();
    const { t } = useI18n();

    const description = typeof part.description === 'string' ? part.description.trim() : '';
    const command = typeof part.command === 'string' ? part.command.trim() : '';
    const agent = typeof part.agent === 'string' ? part.agent.trim() : '';
    const prompt = typeof part.prompt === 'string' ? part.prompt.trim() : '';
    const taskSessionID = typeof part.taskSessionID === 'string' ? part.taskSessionID.trim() : '';
    const model = normalizeSubtaskModel(part.model);

    return (
        <div className="mt-2">
            <div className="flex items-center gap-2 flex-wrap">
                <span className="typography-meta font-semibold text-foreground">{t('chat.messageBody.subtask.title')}</span>
                {command ? (
                    <span className="inline-flex h-5 items-center rounded px-1.5 text-[11px] leading-none bg-foreground/5 text-muted-foreground">
                        /{command}
                    </span>
                ) : null}
                {agent ? (
                    <span className="inline-flex h-5 items-center rounded px-1.5 text-[11px] leading-none bg-foreground/5 text-muted-foreground">
                        @{agent}
                    </span>
                ) : null}
                {model ? (
                    <span className="inline-flex h-5 items-center rounded px-1.5 text-[11px] leading-none bg-foreground/5 text-muted-foreground">
                        {model}
                    </span>
                ) : null}
            </div>

            {description ? (
                <div className="typography-ui-label text-foreground/90 mt-1.5">
                    {description}
                </div>
            ) : null}

            {prompt ? (
                <div className="mt-2 border-t border-border/60 pt-1.5">
                    <button
                        type="button"
                        className="typography-meta text-muted-foreground hover:text-foreground transition-colors underline underline-offset-2"
                        onClick={() => setExpanded((value) => !value)}
                    >
                        {expanded ? t('chat.messageBody.subtask.hidePrompt') : t('chat.messageBody.subtask.showPrompt')}
                    </button>
                    {expanded ? (
                        <pre className="typography-meta mt-1.5 overflow-x-auto whitespace-pre-wrap break-words text-foreground/85">
                            {prompt}
                        </pre>
                    ) : null}
                </div>
            ) : null}

            {taskSessionID && sessionSurface.capabilities.navigateNestedSession ? (
                <div className="mt-1.5">
                    <button
                        type="button"
                        className="typography-meta text-muted-foreground hover:text-foreground transition-colors underline underline-offset-2"
                        onClick={() => {
                            if (!effectiveDirectory) return;
                            navigateNestedSession(sessionSurface, taskSessionID, effectiveDirectory, () => {
                                // In contexts with no ContextPanel (embedded
                                // session-chat iframe) or single-surface layouts
                                // (mobile, VS Code), navigate in place. Otherwise
                                // open a new side-panel tab.
                                if (isEmbeddedSessionChat() || isMobile || isVSCodeRuntime()) {
                                    setCurrentSession(taskSessionID, effectiveDirectory);
                                    return;
                                }

                                openContextPanelTab(effectiveDirectory, {
                                    mode: 'chat',
                                    dedupeKey: `session:${taskSessionID}`,
                                    label: description || agent || t('contextPanel.mode.chat'),
                                    readOnly: true,
                                });
                            });
                        }}
                    >
                        {t('chat.messageBody.subtask.openSession')}
                    </button>
                </div>
            ) : null}
        </div>
    );
};

const SHELL_CODE_TAG_STYLE: React.CSSProperties = { background: 'transparent', backgroundColor: 'transparent' };

const UserShellActionPart: React.FC<{ part: ShellActionPartLike }> = ({ part }) => {
    const [expanded, setExpanded] = React.useState(false);
    const [copiedOutput, setCopiedOutput] = React.useState(false);
    const copiedResetTimeoutRef = React.useRef<number | null>(null);
    const { t } = useI18n();

    const command = typeof part.shellAction?.command === 'string' ? part.shellAction.command.trim() : '';
    const output = typeof part.shellAction?.output === 'string' ? part.shellAction.output : '';
    const status = typeof part.shellAction?.status === 'string' ? part.shellAction.status.trim().toLowerCase() : '';
    const hasOutput = output.trim().length > 0;

    const clearCopiedResetTimeout = React.useCallback(() => {
        if (copiedResetTimeoutRef.current !== null && typeof window !== 'undefined') {
            window.clearTimeout(copiedResetTimeoutRef.current);
            copiedResetTimeoutRef.current = null;
        }
    }, []);

    React.useEffect(() => {
        return () => {
            clearCopiedResetTimeout();
        };
    }, [clearCopiedResetTimeout]);

    const copyOutputToClipboard = React.useCallback(async () => {
        if (!hasOutput) return;

        const result = await copyTextToClipboard(output);
        if (!result.ok) return;

        clearCopiedResetTimeout();
        setCopiedOutput(true);
        if (typeof window !== 'undefined') {
            copiedResetTimeoutRef.current = window.setTimeout(() => {
                setCopiedOutput(false);
                copiedResetTimeoutRef.current = null;
            }, 2000);
        }
    }, [clearCopiedResetTimeout, hasOutput, output]);

    return (
        <div className="mt-2">
            <div className="flex items-center gap-2 flex-wrap">
                <span className="typography-meta font-semibold text-foreground">{t('chat.messageBody.shellCommand.title')}</span>
                {status ? (
                    <span className={cn(
                        'inline-flex h-5 items-center rounded px-1.5 text-[11px] leading-none',
                        status === 'error'
                            ? 'bg-[var(--status-error-background)] text-[var(--status-error)]'
                            : 'bg-foreground/5 text-muted-foreground'
                    )}>
                        {status}
                    </span>
                ) : null}
            </div>

            {command ? (
                <div className="typography-meta mt-1.5 overflow-x-auto font-mono">
                    <WorkerHighlightedCode
                        language="bash"
                        code={command}
                        codeStyle={SHELL_CODE_TAG_STYLE}
                        wrap
                    />
                </div>
            ) : null}

            {hasOutput ? (
                <div className="mt-2 border-t border-border/60 pt-1.5">
                    <div className="flex items-center gap-3 flex-wrap">
                        <button
                            type="button"
                            className="typography-meta text-muted-foreground hover:text-foreground transition-colors underline underline-offset-2"
                            onClick={() => setExpanded((value) => !value)}
                        >
                            {expanded ? t('chat.messageBody.shellCommand.hideOutput') : t('chat.messageBody.shellCommand.showOutput')}
                        </button>
                        <button
                            type="button"
                            className="inline-flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
                            onClick={() => {
                                void copyOutputToClipboard();
                            }}
                            aria-label={copiedOutput ? t('chat.messageBody.shellCommand.copied') : t('chat.messageBody.shellCommand.copyOutput')}
                            title={copiedOutput ? t('chat.messageBody.shellCommand.copied') : t('chat.messageBody.shellCommand.copyOutput')}
                        >
                            {copiedOutput ? <Icon name="check" className="h-3.5 w-3.5" /> : <Icon name="file-copy" className="h-3.5 w-3.5" />}
                        </button>
                    </div>
                    {expanded ? (
                        <div className="typography-meta mt-1.5 max-h-56 overflow-auto font-mono text-foreground/85">
                            <WorkerHighlightedCode
                                language="bash"
                                code={output}
                                codeStyle={SHELL_CODE_TAG_STYLE}
                                wrap
                            />
                        </div>
                    ) : null}
                </div>
            ) : null}
        </div>
    );
};

const formatTurnDuration = (durationMs: number): string => {
    const totalSeconds = durationMs / 1000;
    if (totalSeconds < 60) {
        return `${totalSeconds.toFixed(1)}s`;
    }
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = Math.round(totalSeconds % 60);
    return `${minutes}m ${seconds}s`;
};

interface MessageBodyProps {
    sessionId?: string;
    messageId: string;
    parts: Part[];
    sourceParts?: Part[];
    isUser: boolean;
    isMessageCompleted: boolean;
    messageFinish?: string;
    messageCompletedAt?: number;
    messageCreatedAt?: number;


    isMobile: boolean;
    alwaysShowActions?: boolean;
    hasTouchInput?: boolean;
    copiedCode: string | null;
    onCopyCode: (code: string) => void;
    expandedTools: Set<string>;
    onToggleTool: (toolId: string) => void;
    onShowPopup: (content: ToolPopupContent) => void;
    streamPhase: StreamPhase;
    allowAnimation: boolean;
    onContentChange?: (reason?: ContentChangeReason, messageId?: string) => void;

    shouldShowHeader?: boolean;
    hasTextContent?: boolean;
    onCopyMessage?: () => void | boolean | Promise<void | boolean>;
    copiedMessage?: boolean;
    onAuxiliaryContentComplete?: () => void;
    showReasoningTraces?: boolean;
    agentMention?: AgentMentionInfo;
    turnGroupingContext?: TurnGroupingContext;
    onEdit?: () => void;
    onRevert?: () => Promise<void>;
    onFork?: () => Promise<void>;
    pendingMessageAction?: 'revert' | 'fork' | null;
    errorMessage?: string;
    errorVariant?: 'error' | 'info';
    userActionsMode?: 'inline' | 'external-content' | 'external-actions';
    stickyUserHeaderEnabled?: boolean;
    reviewTransferDirection?: ReviewTransferDirection | null;
}

const TOOL_REVEAL_CACHE_MAX = 200;
const revealedToolIdsByMessage = new Map<string, Set<string>>();

const readRevealedToolIds = (messageId: string): Set<string> => {
    const cached = revealedToolIdsByMessage.get(messageId);
    return cached ? new Set(cached) : new Set<string>();
};

const writeRevealedToolIds = (messageId: string, value: Set<string>): void => {
    if (revealedToolIdsByMessage.size >= TOOL_REVEAL_CACHE_MAX && !revealedToolIdsByMessage.has(messageId)) {
        const oldest = revealedToolIdsByMessage.keys().next().value;
        if (oldest) {
            revealedToolIdsByMessage.delete(oldest);
        }
    }
    revealedToolIdsByMessage.set(messageId, new Set(value));
};

const UserMessageBody = React.memo(({ messageId, parts, sourceParts, messageCreatedAt, isMobile, alwaysShowActions = isMobile, hasTouchInput, hasTextContent, onCopyMessage, copiedMessage, onShowPopup, agentMention, onEdit, onRevert, onFork, pendingMessageAction, userActionsMode = 'inline', stickyUserHeaderEnabled = true }: {
    messageId: string;
    parts: Part[];
    sourceParts?: Part[];
    messageCreatedAt?: number | null;
    isMobile: boolean;
    alwaysShowActions?: boolean;
    hasTouchInput?: boolean;
    hasTextContent?: boolean;
    onCopyMessage?: () => void;
    copiedMessage?: boolean;
    onShowPopup: (content: ToolPopupContent) => void;
    agentMention?: AgentMentionInfo;
    onEdit?: () => void;
    onRevert?: () => Promise<void>;
    onFork?: () => Promise<void>;
    pendingMessageAction?: 'revert' | 'fork' | null;
    userActionsMode?: 'inline' | 'external-content' | 'external-actions';
    stickyUserHeaderEnabled?: boolean;
}) => {
    const { locale, t } = useI18n();
    const chatSurfaceMode = useChatSurfaceMode();
    const sessionSurface = useSessionSurface();
    const sessionSurfaceActions = getSessionSurfaceActionAvailability(sessionSurface);
    const timeFormatPreference = useUIStore((state) => state.timeFormatPreference);
    const [copyHintVisible, setCopyHintVisible] = React.useState(false);
    const copyHintTimeoutRef = React.useRef<number | null>(null);

    const userContentParts = React.useMemo(() => {
        return parts.filter((part) => {
            if (part.type === 'text') {
                return !isEmptyTextPart(part);
            }
            if (isSubtaskPart(part)) {
                return true;
            }
            if (isShellActionPart(part)) {
                return true;
            }
            return false;
        });
    }, [parts]);

    const mentionToken = agentMention?.token;
    let mentionInjected = false;

    const canCopyMessage = Boolean(onCopyMessage);
    const isMessageCopied = Boolean(copiedMessage);
    const isTouchContext = Boolean(hasTouchInput ?? isMobile);
    const hasCopyableText = Boolean(hasTextContent);
    const showUserContent = userActionsMode !== 'external-actions';
    const showUserActions = userActionsMode !== 'external-content';
    const useStickyScrollableUserContent = stickyUserHeaderEnabled && userActionsMode === 'inline';

    const clearCopyHintTimeout = React.useCallback(() => {
        if (copyHintTimeoutRef.current !== null && typeof window !== 'undefined') {
            window.clearTimeout(copyHintTimeoutRef.current);
            copyHintTimeoutRef.current = null;
        }
    }, []);

    const revealCopyHint = React.useCallback(() => {
        if (!isTouchContext || !canCopyMessage || !hasCopyableText || typeof window === 'undefined') {
            return;
        }

        clearCopyHintTimeout();
        setCopyHintVisible(true);
        copyHintTimeoutRef.current = window.setTimeout(() => {
            setCopyHintVisible(false);
            copyHintTimeoutRef.current = null;
        }, 1800);
    }, [canCopyMessage, clearCopyHintTimeout, hasCopyableText, isTouchContext]);

    React.useEffect(() => {
        if (!hasCopyableText) {
            setCopyHintVisible(false);
            clearCopyHintTimeout();
        }
    }, [clearCopyHintTimeout, hasCopyableText]);

    const handleCopyButtonClick = React.useCallback(
        (event: React.MouseEvent<HTMLButtonElement>) => {
            if (!onCopyMessage || !hasCopyableText) {
                return;
            }

            event.stopPropagation();
            event.preventDefault();
            onCopyMessage();

            if (isTouchContext) {
                revealCopyHint();
            }
        },
        [hasCopyableText, isTouchContext, onCopyMessage, revealCopyHint]
    );

    const effectiveOnFork = chatSurfaceMode === 'mini-chat' || !sessionSurfaceActions.fork ? undefined : onFork;
    // 移动端：尺寸/间距与桌面一致；左对齐由底栏 -ml 处理
    const timestamp = React.useMemo(() => {
        void locale;
        if (typeof messageCreatedAt !== 'number' || messageCreatedAt <= 0) return null;
        const formatted = formatTimestampForDisplay(messageCreatedAt, timeFormatPreference);
        return formatted.length > 0 ? formatted : null;
    }, [locale, messageCreatedAt, timeFormatPreference]);
    const actionsBlock = ((canCopyMessage && hasCopyableText) || onEdit || onRevert || effectiveOnFork) && showUserActions ? (
        <div className={cn(
            'group/user-actions',
            isMobile
                ? userActionsMode === 'inline'
                    ? 'flex items-center justify-end pt-2 pb-3'
                    : stickyUserHeaderEnabled
                        ? 'flex h-9 items-start justify-end pt-0'
                        : 'flex h-11 items-start justify-end pt-0'
                : userActionsMode === 'inline'
                    ? 'absolute top-full left-0 right-0 z-10 pt-5'
                    : 'flex h-8 items-start justify-end pt-2'
        )}>
            <div
                className={cn(
                    MESSAGE_ACTION_GROUP_CLASS,
                    'justify-end',
                    // 移动端去掉 translate-x，保持与气泡右缘对齐且间距均匀
                    !isMobile && userActionsMode === 'inline' && 'translate-x-5',
                    alwaysShowActions
                        ? 'pointer-events-auto opacity-100'
                        : 'pointer-events-none opacity-0 transition-opacity duration-150 group-hover/message:pointer-events-auto group-hover/message:opacity-100 group-hover/user-actions:pointer-events-auto group-hover/user-actions:opacity-100 group-hover/user-shell:pointer-events-auto group-hover/user-shell:opacity-100'
                )}
                data-message-action-group="true"
            >
                {timestamp ? (
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <span
                                className={cn(MESSAGE_FOOTER_META_CLASS, 'mr-1')}
                                aria-label={`Message time: ${timestamp}`}
                            >
                                <Icon weight={MESSAGE_ACTION_ICON_WEIGHT} name="time" className={MESSAGE_FOOTER_META_ICON_CLASS} />
                                <span className="message-footer__label">{timestamp}</span>
                            </span>
                        </TooltipTrigger>
                        <TooltipContent>{timestamp}</TooltipContent>
                    </Tooltip>
                ) : null}
                {onRevert && (
                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className={MESSAGE_ACTION_ICON_BUTTON_CLASS}
                                aria-label={t('chat.messageBody.actions.revertAria')}
                                aria-busy={pendingMessageAction === 'revert'}
                                disabled={Boolean(pendingMessageAction)}
                                onPointerDown={(event) => event.stopPropagation()}
                                onClick={(event) => {
                                    event.stopPropagation();
                                    void onRevert();
                                }}
                            >
                                <Icon
                                    weight={MESSAGE_ACTION_ICON_WEIGHT}
                                    name={pendingMessageAction === 'revert' ? 'loader-4' : 'arrow-go-back'}
                                    className={cn(MESSAGE_ACTION_ICON_CLASS, pendingMessageAction === 'revert' && 'animate-spin')}
                                />
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent sideOffset={6}>{t('chat.messageBody.actions.revert')}</TooltipContent>
                    </Tooltip>
                )}
                {onEdit && (
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className={MESSAGE_ACTION_ICON_BUTTON_CLASS}
                                aria-label={t('chat.messageBody.actions.editAria')}
                                disabled={Boolean(pendingMessageAction)}
                                onPointerDown={(event) => event.stopPropagation()}
                                onClick={(event) => {
                                    event.stopPropagation();
                                    onEdit();
                                }}
                            >
                                <Icon weight={MESSAGE_ACTION_ICON_WEIGHT} name="edit" className={MESSAGE_ACTION_ICON_CLASS} />
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent sideOffset={6}>{t('chat.messageBody.actions.edit')}</TooltipContent>
                    </Tooltip>
                )}
                {effectiveOnFork && (
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className={MESSAGE_ACTION_ICON_BUTTON_CLASS}
                                aria-label={t('chat.messageBody.actions.forkAria')}
                                aria-busy={pendingMessageAction === 'fork'}
                                disabled={Boolean(pendingMessageAction)}
                                onPointerDown={(event) => event.stopPropagation()}
                                onClick={(event) => {
                                    event.stopPropagation();
                                    void effectiveOnFork();
                                }}
                            >
                                <Icon
                                    weight={MESSAGE_ACTION_ICON_WEIGHT}
                                    name={pendingMessageAction === 'fork' ? 'loader-4' : 'git-branch'}
                                    className={cn(MESSAGE_ACTION_ICON_CLASS, pendingMessageAction === 'fork' && 'animate-spin')}
                                />
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent sideOffset={6}>{t('chat.messageBody.actions.fork')}</TooltipContent>
                    </Tooltip>
                )}
                {canCopyMessage && hasCopyableText && (
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                data-visible={copyHintVisible || isMessageCopied ? 'true' : undefined}
                                className={MESSAGE_ACTION_ICON_BUTTON_CLASS}
                                aria-label={t('chat.messageBody.actions.copyMessageAria')}
                                onPointerDown={(event) => event.stopPropagation()}
                                onClick={handleCopyButtonClick}
                                onFocus={() => setCopyHintVisible(true)}
                                onBlur={() => {
                                    if (!isMessageCopied) {
                                        setCopyHintVisible(false);
                                    }
                                }}
                            >
                                {isMessageCopied ? (
                                    <Icon weight={MESSAGE_ACTION_ICON_WEIGHT} name="check" className={cn(MESSAGE_ACTION_ICON_CLASS, 'text-[color:var(--status-success)]')} />
                                ) : (
                                    <Icon weight={MESSAGE_ACTION_ICON_WEIGHT} name="file-copy" className={MESSAGE_ACTION_ICON_CLASS} />
                                )}
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent sideOffset={6}>{t('chat.messageBody.actions.copyMessage')}</TooltipContent>
                    </Tooltip>
                )}
            </div>
        </div>
    ) : null;

    if (!showUserContent) {
        return <>{actionsBlock}</>;
    }

    return (
        <div
            className="relative w-full group/message"
            style={CONTAIN_LAYOUT_STYLE}
            onTouchStart={isTouchContext && canCopyMessage && hasCopyableText ? revealCopyHint : undefined}
        >
            <div
                className={cn(
                    'leading-relaxed text-foreground/90 text-base overflow-x-hidden',
                    useStickyScrollableUserContent
                        ? 'overflow-y-auto overscroll-contain scrollbar-none'
                        : 'overflow-y-hidden'
                )}
                style={useStickyScrollableUserContent ? { maxHeight: 'calc(var(--chat-scroll-height, 100dvh) * 0.4)' } : undefined}
            >
                {userContentParts.map((part, index) => {
                    if (isSubtaskPart(part)) {
                        return (
                            <React.Fragment key={part.id ?? `user-subtask-${index}`}>
                                <UserSubtaskPart part={part} />
                            </React.Fragment>
                        );
                    }

                    if (isShellActionPart(part)) {
                        return (
                            <React.Fragment key={part.id ?? `user-shell-${index}`}>
                                <UserShellActionPart part={part} />
                            </React.Fragment>
                        );
                    }

                    let mentionForPart: AgentMentionInfo | undefined;
                    if (agentMention && mentionToken && !mentionInjected) {
                        const candidateText = extractTextContent(part);
                        if (candidateText.includes(mentionToken)) {
                            mentionForPart = agentMention;
                            mentionInjected = true;
                        }
                    }
                    return (
                        <React.Fragment key={part.id ?? `user-text-${index}`}>
                            <UserTextPart
                                part={part}
                                messageId={messageId}
                                isMobile={isMobile}
                                agentMention={mentionForPart}
                                messageParts={sourceParts ?? parts}
                            />
                        </React.Fragment>
                    );
                })}
            </div>
            <MessageFilesDisplay files={parts} onShowPopup={onShowPopup} compact />
            {actionsBlock}
        </div>
    );
});

interface AssistantMessageActionButtonsProps {
    hasCopyableText: boolean;
    isTouchContext: boolean;
    onCopyMessage?: () => void | boolean | Promise<void | boolean>;
    reviewTransferAction?: {
        ariaLabel: string;
        tooltip: string;
        onClick: () => void | Promise<void>;
    };
    ttsText: string;
}

const AssistantMessageActionButtons = React.memo(({
    hasCopyableText,
    isTouchContext,
    onCopyMessage,
    reviewTransferAction,
    ttsText,
}: AssistantMessageActionButtonsProps) => {
    const { t } = useI18n();
    const chatSurfaceMode = useChatSurfaceMode();
    const sessionSurface = useSessionSurface();
    const sessionSurfaceActions = getSessionSurfaceActionAvailability(sessionSurface);
    const { isPlaying: isTTSPlaying, play: playTTS, stop: stopTTS } = useMessageTTS();
    const showMessageTTSButtons = useConfigStore((state) => state.showMessageTTSButtons);
    const voiceProvider = useConfigStore((state) => state.voiceProvider);
    const [copyHintVisible, setCopyHintVisible] = React.useState(false);
    const [isMessageCopied, setIsMessageCopied] = React.useState(false);
    const [isTransferringReview, setIsTransferringReview] = React.useState(false);
    const copyHintTimeoutRef = React.useRef<number | null>(null);
    const copiedResetTimeoutRef = React.useRef<number | null>(null);
    const canCopyMessage = Boolean(onCopyMessage);

    const clearCopyHintTimeout = React.useCallback(() => {
        if (copyHintTimeoutRef.current !== null && typeof window !== 'undefined') {
            window.clearTimeout(copyHintTimeoutRef.current);
            copyHintTimeoutRef.current = null;
        }
    }, []);

    const clearCopiedResetTimeout = React.useCallback(() => {
        if (copiedResetTimeoutRef.current !== null && typeof window !== 'undefined') {
            window.clearTimeout(copiedResetTimeoutRef.current);
            copiedResetTimeoutRef.current = null;
        }
    }, []);

    React.useEffect(() => {
        return () => {
            clearCopyHintTimeout();
            clearCopiedResetTimeout();
        };
    }, [clearCopiedResetTimeout, clearCopyHintTimeout]);

    React.useEffect(() => {
        if (!hasCopyableText || !canCopyMessage) {
            setCopyHintVisible(false);
            setIsMessageCopied(false);
            clearCopyHintTimeout();
            clearCopiedResetTimeout();
        }
    }, [canCopyMessage, clearCopiedResetTimeout, clearCopyHintTimeout, hasCopyableText]);

    const revealCopyHint = React.useCallback(() => {
        if (!isTouchContext || !canCopyMessage || !hasCopyableText || typeof window === 'undefined') {
            return;
        }

        clearCopyHintTimeout();
        setCopyHintVisible(true);
        copyHintTimeoutRef.current = window.setTimeout(() => {
            setCopyHintVisible(false);
            copyHintTimeoutRef.current = null;
        }, 1800);
    }, [canCopyMessage, clearCopyHintTimeout, hasCopyableText, isTouchContext]);

    const handleCopyButtonClick = React.useCallback(
        async (event: React.MouseEvent<HTMLButtonElement>) => {
            if (!onCopyMessage || !hasCopyableText) {
                return;
            }

            event.stopPropagation();
            event.preventDefault();

            const copied = await onCopyMessage();
            if (copied === false) {
                return;
            }

            clearCopiedResetTimeout();
            setIsMessageCopied(true);
            if (typeof window !== 'undefined') {
                copiedResetTimeoutRef.current = window.setTimeout(() => {
                    setIsMessageCopied(false);
                    copiedResetTimeoutRef.current = null;
                }, 2000);
            }

            if (isTouchContext) {
                revealCopyHint();
            }
        },
        [clearCopiedResetTimeout, hasCopyableText, isTouchContext, onCopyMessage, revealCopyHint]
    );

    const handleReviewTransferClick = React.useCallback(
        async (event: React.MouseEvent<HTMLButtonElement>) => {
            event.stopPropagation();
            event.preventDefault();
            if (!reviewTransferAction || isTransferringReview || !hasCopyableText) return;
            setIsTransferringReview(true);
            try {
                await reviewTransferAction.onClick();
            } finally {
                setIsTransferringReview(false);
            }
        },
        [hasCopyableText, isTransferringReview, reviewTransferAction]
    );

    const readAloudTooltip = React.useMemo(() => {
        if (isTTSPlaying) {
            return t('chat.messageBody.tts.stopSpeaking');
        }
        const providerLabel = voiceProvider === 'browser'
            ? 'Browser'
            : voiceProvider === 'openai'
                ? 'OpenAI'
                : voiceProvider === 'openai-compatible'
                    ? 'Custom'
                    : 'Say';
        return t('chat.messageBody.tts.readAloudWithProvider', { provider: providerLabel });
    }, [isTTSPlaying, t, voiceProvider]);

    const handleTTSClick = React.useCallback(
        (event: React.MouseEvent<HTMLButtonElement>) => {
            event.stopPropagation();
            event.preventDefault();

            if (isTTSPlaying) {
                stopTTS();
                return;
            }

            if (ttsText.trim()) {
                void playTTS(ttsText);
            }
        },
        [isTTSPlaying, playTTS, stopTTS, ttsText]
    );

    return (
        <>
            {onCopyMessage && (
                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            data-visible={copyHintVisible || isMessageCopied ? 'true' : undefined}
                            className={cn(
                                MESSAGE_ACTION_ICON_BUTTON_CLASS,
                                !hasCopyableText && 'opacity-50'
                            )}
                            disabled={!hasCopyableText}
                            aria-label={t('chat.messageBody.actions.copyMessageAria')}
                            aria-hidden={!hasCopyableText}
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={(event) => {
                                void handleCopyButtonClick(event);
                            }}
                            onFocus={() => {
                                if (hasCopyableText) {
                                    setCopyHintVisible(true);
                                }
                            }}
                            onBlur={() => {
                                if (!isMessageCopied) {
                                    setCopyHintVisible(false);
                                }
                            }}
                        >
                            {isMessageCopied ? (
                                <Icon weight={MESSAGE_ACTION_ICON_WEIGHT} name="check" className={cn(MESSAGE_ACTION_ICON_CLASS, 'text-[color:var(--status-success)]')} />
                            ) : (
                                <Icon weight={MESSAGE_ACTION_ICON_WEIGHT} name="file-copy" className={MESSAGE_ACTION_ICON_CLASS} />
                            )}
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent sideOffset={6}>{t('chat.messageBody.actions.copyAnswer')}</TooltipContent>
                </Tooltip>
            )}
            {reviewTransferAction && chatSurfaceMode !== 'mini-chat' && sessionSurfaceActions.reviewTransfer ? (
                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            disabled={isTransferringReview || !hasCopyableText}
                            className={cn(
                                MESSAGE_ACTION_ICON_BUTTON_CLASS,
                                (!hasCopyableText || isTransferringReview) && 'opacity-50'
                            )}
                            aria-label={reviewTransferAction.ariaLabel}
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={(event) => {
                                void handleReviewTransferClick(event);
                            }}
                        >
                            {isTransferringReview ? (
                                <Icon weight={MESSAGE_ACTION_ICON_WEIGHT} name="loader-4" className={cn(MESSAGE_ACTION_ICON_CLASS, 'animate-spin')} />
                            ) : (
                                <Icon weight={MESSAGE_ACTION_ICON_WEIGHT} name="arrow-left-right" className={MESSAGE_ACTION_ICON_CLASS} />
                            )}
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent sideOffset={6}>{reviewTransferAction.tooltip}</TooltipContent>
                </Tooltip>
            ) : null}
            {chatSurfaceMode !== 'mini-chat' && showMessageTTSButtons && hasCopyableText && (
                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className={cn(
                                MESSAGE_ACTION_ICON_BUTTON_CLASS,
                                isTTSPlaying ? 'text-green-500' : 'hover:text-foreground/80'
                            )}
                            aria-label={isTTSPlaying ? t('chat.messageBody.tts.stopSpeaking') : t('chat.messageBody.tts.readAloud')}
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={handleTTSClick}
                        >
                            {isTTSPlaying ? (
                                <Icon weight={MESSAGE_ACTION_ICON_WEIGHT} name="stop" className={MESSAGE_ACTION_ICON_CLASS} />
                            ) : (
                                <Icon weight={MESSAGE_ACTION_ICON_WEIGHT} name="volume-up" className={MESSAGE_ACTION_ICON_CLASS} />
                            )}
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent sideOffset={6}>{readAloudTooltip}</TooltipContent>
                </Tooltip>
            )}
        </>
    );
});

const AssistantMessageBody = React.memo(({
    sessionId,
    messageId,
    parts,
    isMessageCompleted,
    messageFinish,
    messageCompletedAt,
    messageCreatedAt,

    isMobile,
    alwaysShowActions,
    hasTouchInput,
    expandedTools,
    onToggleTool,
    onShowPopup,
    streamPhase: _streamPhase,
    allowAnimation: _allowAnimation,
    onContentChange,
    hasTextContent = false,
    onCopyMessage,
    onAuxiliaryContentComplete,
    showReasoningTraces = false,
    turnGroupingContext,
    errorMessage,
    errorVariant = 'error',
    reviewTransferDirection = null,
}: Omit<MessageBodyProps, 'isUser'>) => {
    const { t, locale } = useI18n();
    const chatSurfaceMode = useChatSurfaceMode();
    const sessionSurface = useSessionSurface();
    const sessionSurfaceActions = getSessionSurfaceActionAvailability(sessionSurface);
    const streamPhase = _streamPhase;
    void _allowAnimation;
    const messageContentRef = React.useRef<HTMLDivElement>(null);
    const messageTextContentRef = React.useRef<HTMLDivElement>(null);
    const toolRevealReadyRef = React.useRef(false);
    const isActiveHapticPhase = _streamPhase === 'streaming' || _streamPhase === 'cooldown';
    const hapticLifecycleRef = React.useRef({
        messageId,
        experiencedStreamingOrCooldown: isActiveHapticPhase,
    });

    if (hapticLifecycleRef.current.messageId !== messageId) {
        hapticLifecycleRef.current = {
            messageId,
            experiencedStreamingOrCooldown: isActiveHapticPhase,
        };
    } else if (isActiveHapticPhase) {
        hapticLifecycleRef.current.experiencedStreamingOrCooldown = true;
    }

    React.useEffect(() => {
        toolRevealReadyRef.current = true;
    }, []);

    const isTouchContext = Boolean(hasTouchInput ?? isMobile);
    const alwaysShowMessageActions = Boolean(alwaysShowActions ?? isMobile);
    // 移动端尺寸/间距与桌面一致；底栏分组 + 左对齐
    const footerRowClass = isMobile ? MESSAGE_FOOTER_ROW_MOBILE_CLASS : MESSAGE_FOOTER_ROW_CLASS;
    const awaitingMessageCompletion = !isMessageCompleted;
    const animateActivityRows = awaitingMessageCompletion || Boolean(turnGroupingContext?.isWorking);

    const visibleParts = React.useMemo(() => {
        return parts
            .filter((part) => !isEmptyTextPart(part))
            .filter((part) => {
                const rawPart = part as Record<string, unknown>;
                return rawPart.type !== 'compaction';
            });
    }, [parts]);

    const toolParts = React.useMemo(() => {
        return visibleParts.filter((part): part is ToolPartType => part.type === 'tool');
    }, [visibleParts]);

    const toolRevealStateRef = React.useRef<{
        messageId: string;
        hasCommitted: boolean;
        persistedToolIds: Set<string>;
        animatedToolIds: Set<string>;
    }>({
        messageId,
        hasCommitted: false,
        persistedToolIds: readRevealedToolIds(messageId),
        animatedToolIds: new Set<string>(),
    });

    if (toolRevealStateRef.current.messageId !== messageId) {
        toolRevealStateRef.current = {
            messageId,
            hasCommitted: false,
            persistedToolIds: readRevealedToolIds(messageId),
            animatedToolIds: new Set<string>(),
        };
    }

    const currentToolIds = React.useMemo(() => {
        const ids = new Set<string>();

        for (const toolPart of toolParts) {
            ids.add(toolPart.id);
        }

        const activitySegments = turnGroupingContext?.activityGroupSegments;
        if (Array.isArray(activitySegments)) {
            for (const segment of activitySegments) {
                if (segment.anchorMessageId !== messageId) {
                    continue;
                }
                for (const activity of segment.parts) {
                    if (activity.kind !== 'tool') {
                        continue;
                    }
                    const toolId = (activity.part as { id?: unknown }).id;
                    if (typeof toolId === 'string' && toolId.length > 0) {
                        ids.add(toolId);
                    }
                }
            }
        }

        return Array.from(ids);
    }, [messageId, toolParts, turnGroupingContext?.activityGroupSegments]);
    const shouldAnimateNewToolMount = Boolean(turnGroupingContext?.isWorking && toolRevealReadyRef.current);
    const persistedToolIds = toolRevealStateRef.current.persistedToolIds;
    const animatedToolIds = toolRevealStateRef.current.animatedToolIds;

    if (shouldAnimateNewToolMount && toolRevealStateRef.current.hasCommitted) {
        for (const toolId of currentToolIds) {
            if (!persistedToolIds.has(toolId)) {
                animatedToolIds.add(toolId);
            }
        }
    }

    const animatedToolIdsKey = Array.from(animatedToolIds).join('\u0000');
    const animatedToolIdsLookup = React.useMemo(
        () => new Set(animatedToolIdsKey ? animatedToolIdsKey.split('\u0000') : []),
        [animatedToolIdsKey]
    );

    React.useEffect(() => {
        const nextPersistedToolIds = new Set(toolRevealStateRef.current.persistedToolIds);
        for (const toolId of currentToolIds) {
            nextPersistedToolIds.add(toolId);
        }
        toolRevealStateRef.current.persistedToolIds = nextPersistedToolIds;
        toolRevealStateRef.current.hasCommitted = true;
        writeRevealedToolIds(messageId, nextPersistedToolIds);
    }, [currentToolIds, messageId]);

    const assistantTextParts = React.useMemo(() => {
        return visibleParts.filter((part) => part.type === 'text');
    }, [visibleParts]);
    const assistantPlanText = React.useMemo(() => flattenAssistantTextParts(assistantTextParts), [assistantTextParts]);

    const openContextPreview = useUIStore((state) => state.openContextPreview);
    const isVSCode = isVSCodeRuntime();
    const isMiniChatSurface = chatSurfaceMode === 'mini-chat';

    const messagePreviewUrl = React.useMemo(() => {
        if (isVSCode || isMobile || isMiniChatSurface) {
            return null;
        }

        for (const part of assistantTextParts) {
            const text = (part as { text?: unknown }).text;
            if (typeof text !== 'string' || text.length === 0) {
                continue;
            }
            const url = extractLoopbackUrls(text)[0];
            if (!url) {
                continue;
            }
            return url.includes('0.0.0.0') ? url.replace('0.0.0.0', '127.0.0.1') : url;
        }
        for (const part of toolParts) {
            const state = (part as unknown as { state?: unknown }).state as Record<string, unknown> | undefined;
            const output = state && typeof state.output === 'string' ? state.output : null;
            if (!output) {
                continue;
            }
            // eslint-disable-next-line no-control-regex
            const url = extractLoopbackUrls(output.replace(/\x1b\[[0-9;]*m/g, ''))[0];
            if (!url) {
                continue;
            }
            return url.includes('0.0.0.0') ? url.replace('0.0.0.0', '127.0.0.1') : url;
        }
        return null;
    }, [assistantTextParts, isMobile, isMiniChatSurface, isVSCode, toolParts]);

    const forkFromMessage = useSessionUIStore((state) => state.forkFromMessage);
    const forkTransition = useSessionUIStore((state) => state.forkTransition);
    const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
    const getDirectoryForSession = useSessionUIStore((state) => state.getDirectoryForSession);
    const effectiveDirectory = useEffectiveDirectory();
    const isReviewSessionView = reviewTransferDirection === 'review-to-original';
    const effectiveReviewTransferDirection = (!isMobile && !isVSCode) ? reviewTransferDirection : null;
    const reviewTransferAction = React.useMemo(() => {
        const transferText = assistantPlanText.trim();
        if (!sessionId || !effectiveDirectory || !transferText || !effectiveReviewTransferDirection) return undefined;
        if (effectiveReviewTransferDirection === 'review-to-original') {
            return {
                ariaLabel: t('chat.messageBody.actions.sendReviewFeedback'),
                tooltip: t('chat.messageBody.actions.sendReviewFeedback'),
                onClick: async () => {
                    try {
                        await sendReviewFeedbackToOriginal(sessionId, effectiveDirectory, transferText);
                    } catch (error) {
                        console.error('[review-flow] failed to send review feedback', error);
                    }
                },
            };
        }
        return {
            ariaLabel: t('chat.messageBody.actions.sendImplementationResponse'),
            tooltip: t('chat.messageBody.actions.sendImplementationResponse'),
            onClick: async () => {
                try {
                    await sendImplementationResponseToReviewer(sessionId, effectiveDirectory, transferText);
                } catch (error) {
                    console.error('[review-flow] failed to send implementation response', error);
                }
            },
        };
    }, [assistantPlanText, effectiveDirectory, effectiveReviewTransferDirection, sessionId, t]);
    const [isForkPending, setIsForkPending] = React.useState(false);
    const chatRenderMode = useUIStore((state) => state.chatRenderMode);
    const collapsibleThinkingBlocks = useUIStore((state) => state.collapsibleThinkingBlocks);
    const showSplitAssistantMessageActions = useUIStore((state) => state.showSplitAssistantMessageActions);
    const timeFormatPreference = useUIStore((state) => state.timeFormatPreference);
    const isSortedRenderMode = chatRenderMode === 'sorted';
    const collapsedPreviewCount = 7;
    const isLastAssistantInTurn = turnGroupingContext?.isLastAssistantInTurn ?? false;
    const hasStopFinish = messageFinish === 'stop';
    const effectiveStreamPhase: StreamPhase = hasStopFinish ? 'completed' : streamPhase;

    const hasTools = toolParts.length > 0;

    const hasPendingTools = React.useMemo(() => {
        return toolParts.some((toolPart) => {
            const state = (toolPart as Record<string, unknown>).state as Record<string, unknown> | undefined ?? {};
            const status = state?.status;
            return status === 'pending' || status === 'running' || status === 'started';
        });
    }, [toolParts]);

    const isActiveTool = React.useCallback((toolPart: ToolPartType): boolean => {
        const state = (toolPart as Record<string, unknown>).state as Record<string, unknown> | undefined ?? {};
        const status = state?.status;
        return status === 'pending' || status === 'running' || status === 'started';
    }, []);

    const isToolFinalized = React.useCallback((toolPart: ToolPartType) => {
        const state = (toolPart as Record<string, unknown>).state as Record<string, unknown> | undefined ?? {};
        const status = state?.status;
        if (status === 'pending' || status === 'running' || status === 'started') {
            return false;
        }
        const time = state?.time as Record<string, unknown> | undefined ?? {};
        const endTime = typeof time?.end === 'number' ? time.end : undefined;
        const startTime = typeof time?.start === 'number' ? time.start : undefined;
        if (typeof endTime !== 'number') {
            return false;
        }
        if (typeof startTime === 'number' && endTime < startTime) {
            return false;
        }
        return true;
    }, []);

    const shouldShowTool = React.useCallback((toolPart: ToolPartType): boolean => {
        return isActiveTool(toolPart) || isToolFinalized(toolPart);
    }, [isActiveTool, isToolFinalized]);
    const hasStreamingHapticLifecycle = hapticLifecycleRef.current.experiencedStreamingOrCooldown;

    const toolHapticStateRef = React.useRef<{ messageId: string; initialized: boolean; observedPartIds: Set<string> }>({
        messageId,
        initialized: false,
        observedPartIds: new Set(),
    });

    React.useEffect(() => {
        if (toolHapticStateRef.current.messageId !== messageId) {
            toolHapticStateRef.current = { messageId, initialized: false, observedPartIds: new Set() };
        }
        if (!hasStreamingHapticLifecycle) return;
        if (!hasStreamingHapticSubscribers()) return;

        const tracker = toolHapticStateRef.current;
        const isInitialObservation = !tracker.initialized;
        tracker.initialized = true;

        for (const toolPart of toolParts) {
            if (tracker.observedPartIds.has(toolPart.id)) continue;
            if (!shouldShowTool(toolPart)) continue;

            if (!shouldEmitToolAppearanceHaptic(isInitialObservation, isActiveTool(toolPart))) {
                tracker.observedPartIds.add(toolPart.id);
                continue;
            }

            const eventSessionId = sessionId ?? (toolPart as ToolPartType & { sessionID?: string }).sessionID;
            if (!eventSessionId) continue;

            tracker.observedPartIds.add(toolPart.id);
            emitStreamingHapticEvent({
                sessionID: eventSessionId,
                messageID: messageId,
                partID: toolPart.id,
                kind: 'tool',
            });
        }
    }, [hasStreamingHapticLifecycle, isActiveTool, messageId, sessionId, shouldShowTool, toolParts]);

    const allToolsFinalized = React.useMemo(() => {
        if (toolParts.length === 0) {
            return true;
        }
        if (hasPendingTools) {
            return false;
        }
        return toolParts.every((toolPart) => isToolFinalized(toolPart));
    }, [toolParts, hasPendingTools, isToolFinalized]);

    const reasoningParts = React.useMemo(() => {
        return visibleParts.filter((part) => part.type === 'reasoning');
    }, [visibleParts]);

    const reasoningComplete = React.useMemo(() => {
        if (reasoningParts.length === 0) {
            return true;
        }
        return reasoningParts.every((part) => {
            const time = (part as Record<string, unknown>).time as { end?: number } | undefined;
            return typeof time?.end === 'number';
        });
    }, [reasoningParts]);

    // Message is considered to have an "open step" if info.finish is not yet present
    const hasOpenStep = typeof messageFinish !== 'string';

    const shouldHoldForReasoning =
        reasoningParts.length > 0 &&
        hasTools &&
        (hasPendingTools || hasOpenStep || !allToolsFinalized);

    const shouldHoldTools = awaitingMessageCompletion
        || (hasTools && (hasPendingTools || hasOpenStep || !allToolsFinalized));
    const shouldHoldReasoning = awaitingMessageCompletion || shouldHoldForReasoning;

    const hasAuxiliaryContent = hasTools || reasoningParts.length > 0;
    const isTextlessAssistantMessage = assistantTextParts.length === 0;
    const auxiliaryContentComplete = hasAuxiliaryContent && isTextlessAssistantMessage && !shouldHoldTools && !shouldHoldReasoning && allToolsFinalized && reasoningComplete;
    const auxiliaryCompletionAnnouncedRef = React.useRef(false);
    const soloReasoningScrollTriggeredRef = React.useRef(false);

    React.useEffect(() => {
        soloReasoningScrollTriggeredRef.current = false;
    }, [messageId]);

    React.useEffect(() => {
        if (!auxiliaryContentComplete) {
            auxiliaryCompletionAnnouncedRef.current = false;
            return;
        }
        if (auxiliaryCompletionAnnouncedRef.current) {
            return;
        }
        auxiliaryCompletionAnnouncedRef.current = true;
        onAuxiliaryContentComplete?.();
    }, [auxiliaryContentComplete, onAuxiliaryContentComplete]);

    React.useEffect(() => {
        if (awaitingMessageCompletion) {
            soloReasoningScrollTriggeredRef.current = false;
            return;
        }
        if (hasTools) {
            soloReasoningScrollTriggeredRef.current = false;
            return;
        }
        if (reasoningParts.length === 0) {
            return;
        }
        if (shouldHoldReasoning || !reasoningComplete) {
            return;
        }
        if (soloReasoningScrollTriggeredRef.current) {
            return;
        }
        soloReasoningScrollTriggeredRef.current = true;
        onContentChange?.('structural');
    }, [awaitingMessageCompletion, hasTools, onContentChange, reasoningComplete, reasoningParts.length, shouldHoldReasoning]);

    const hasCopyableText = Boolean(hasTextContent) && !awaitingMessageCompletion;

    const handleForkClick = React.useCallback(
        async (event: React.MouseEvent<HTMLButtonElement>) => {
            event.stopPropagation();
            event.preventDefault();
            if (!sessionId || !messageId || isForkPending || forkTransition) {
                return;
            }
            setIsForkPending(true);
            try {
                await forkFromMessage(sessionId, messageId);
            } finally {
                setIsForkPending(false);
            }
        },
        [forkFromMessage, forkTransition, isForkPending, messageId, sessionId]
    );

    const activityPartsForTurn = React.useMemo(() => {
        const all = turnGroupingContext?.activityParts;
        if (!isSortedRenderMode || !all) {
            return [];
        }
        return all;
    }, [isSortedRenderMode, turnGroupingContext?.activityParts]);

    const activityGroupSegmentsForMessage = React.useMemo(() => {
        const all = turnGroupingContext?.activityGroupSegments;
        if (!isSortedRenderMode || !all) {
            return [];
        }
        return all.filter((segment) => segment.anchorMessageId === messageId);
    }, [isSortedRenderMode, messageId, turnGroupingContext?.activityGroupSegments]);

    const hasAnchoredActivitySegments = activityGroupSegmentsForMessage.length > 0;

    const activityByPart = React.useMemo(() => {
        const byRef = new Map<Part, (typeof activityPartsForTurn)[number]>();
        const byId = new Map<string, (typeof activityPartsForTurn)[number]>();
        activityPartsForTurn.forEach((activity) => {
            byRef.set(activity.part, activity);
            const partId = (activity.part as { id?: unknown }).id;
            if (typeof partId === 'string' && partId.length > 0) {
                byId.set(partId, activity);
            }
        });

        return {
            get: (part: Part) => {
                const direct = byRef.get(part);
                if (direct) {
                    return direct;
                }
                const partId = (part as { id?: unknown }).id;
                if (typeof partId === 'string' && partId.length > 0) {
                    return byId.get(partId);
                }
                return undefined;
            },
        };
    }, [activityPartsForTurn]);

    const toggleActivityGroup = turnGroupingContext?.toggleGroup;
    const isActivityOwnerMessage = !isSortedRenderMode
        || !turnGroupingContext?.activityOwnerMessageId
        || turnGroupingContext.activityOwnerMessageId === messageId
        || hasAnchoredActivitySegments;

    const shouldRenderActivityGroup = isSortedRenderMode
        && isActivityOwnerMessage
        && hasAnchoredActivitySegments
        && Boolean(toggleActivityGroup);

    const shouldDeferSortedInlineText = isSortedRenderMode && !hasStopFinish;
    const showErrorMessage = Boolean(errorMessage);
    const errorIconName = errorVariant === 'info' ? 'information' : 'error-warning';
    const shouldShowMessageActions = hasCopyableText;
    const shouldShowTurnFooter = isLastAssistantInTurn && hasTextContent && (hasStopFinish || Boolean(errorMessage));
    const shouldRenderActionsInActivity = isSortedRenderMode;
    const shouldShowStandaloneMessageActions = showSplitAssistantMessageActions && shouldShowMessageActions && !shouldShowTurnFooter && !shouldRenderActionsInActivity;

    const messageActionButtons = React.useMemo(() => (
        <AssistantMessageActionButtons
            hasCopyableText={hasCopyableText}
            isTouchContext={isTouchContext}
            onCopyMessage={onCopyMessage}
            ttsText={assistantPlanText}
            reviewTransferAction={reviewTransferAction}
        />
    ), [assistantPlanText, hasCopyableText, isTouchContext, onCopyMessage, reviewTransferAction]);

    const renderJustificationActions = React.useCallback((activity: NonNullable<TurnGroupingContext['activityParts']>[number]) => {
        if (!showSplitAssistantMessageActions || !isSortedRenderMode) {
            return null;
        }

        const text = extractTextContent(activity.part).trim();
        if (!text) {
            return null;
        }

        const copyJustificationText = async () => {
            const result = await copyTextToClipboard(text);
            return result.ok;
        };

        return (
            <AssistantMessageActionButtons
                hasCopyableText={true}
                isTouchContext={isTouchContext}
                onCopyMessage={copyJustificationText}
                ttsText={text}
            />
        );
    }, [isSortedRenderMode, isTouchContext, showSplitAssistantMessageActions]);

    const lastRenderableTextPartIndex = React.useMemo(() => {
        if (!shouldShowStandaloneMessageActions) {
            return -1;
        }

        let lastIndex = -1;
        for (let index = 0; index < visibleParts.length; index += 1) {
            const part = visibleParts[index];
            if (!part || part.type !== 'text') {
                continue;
            }
            if (shouldDeferSortedInlineText) {
                continue;
            }
            const activity = activityByPart.get(part);
            if (activity?.kind === 'justification') {
                continue;
            }
            lastIndex = index;
        }

        return lastIndex;
    }, [activityByPart, shouldDeferSortedInlineText, shouldShowStandaloneMessageActions, visibleParts]);

    const shouldRenderStandaloneActionsAfterContent = shouldShowStandaloneMessageActions && lastRenderableTextPartIndex < 0;

    const renderedParts = React.useMemo(() => {
        const rendered: React.ReactNode[] = [];

        if (shouldRenderActivityGroup && toggleActivityGroup) {
            activityGroupSegmentsForMessage.forEach((segment) => {
                const visibleSegmentParts = showReasoningTraces
                    ? segment.parts
                    : segment.parts.filter((activity) => activity.kind !== 'reasoning');
                if (visibleSegmentParts.length === 0) {
                    return;
                }
                rendered.push(
                    <div key={`progressive-group-${segment.id}`}>
                        <TurnActivity
                            parts={visibleSegmentParts}
                            isExpanded={turnGroupingContext.isGroupExpanded === true}
                            collapsedPreviewCount={collapsedPreviewCount}
                            onToggle={toggleActivityGroup}
                            isMobile={isMobile}
                            expandedTools={expandedTools}
                            onToggleTool={onToggleTool}
                            onShowPopup={onShowPopup}
                            onContentChange={onContentChange}
                            streamPhase={effectiveStreamPhase}
                            showHeader={true}
                            animateRows={animateActivityRows}
                            animatedToolIds={animatedToolIdsLookup}
                            diffStats={turnGroupingContext.diffStats}
                            renderJustificationActions={renderJustificationActions}
                        />
                    </div>
                );
            });
        }

        // Flat rendering: iterate parts in natural order.
        // Group consecutive static tools (read, grep, glob, etc.) into compact rows.
        // Expandable tools (bash, edit, task) get individual rows.
        // Text renders inline at its natural position.
        let i = 0;
        while (i < visibleParts.length) {
            const part = visibleParts[i];

            if (part.type === 'text') {
                const activity = activityByPart.get(part);
                if (shouldDeferSortedInlineText) {
                    i += 1;
                    continue;
                }
                if (activity?.kind === 'justification') {
                    i += 1;
                    continue;
                }
                rendered.push(
                    <div key={`assistant-text-${messageId}-${part.id ?? i}`} ref={messageTextContentRef} data-message-text-export-source="true">
                        <AssistantTextPart
                            part={part}
                            sessionId={sessionId}
                            messageId={messageId}
                            streamPhase={effectiveStreamPhase}
                            chatRenderMode={chatRenderMode}
                            hasStreamingHapticLifecycle={hasStreamingHapticLifecycle}
                            onContentChange={onContentChange}
                            onShowPopup={onShowPopup}
                        />
                    </div>
                );
                if (shouldShowStandaloneMessageActions && i === lastRenderableTextPartIndex) {
                    rendered.push(
                        <div key={`message-actions-${messageId}`} className={isMobile ? INLINE_MESSAGE_ACTIONS_MOBILE_CLASS_NAME : INLINE_MESSAGE_ACTIONS_CLASS_NAME} data-message-actions="true">
                            <div className={MESSAGE_ACTION_GROUP_CLASS} data-message-action-group="true">
                                {messageActionButtons}
                            </div>
                        </div>
                    );
                }
                i++;
                continue;
            }

            if (part.type === 'reasoning') {
                const activity = activityByPart.get(part);
                if (activity?.kind === 'reasoning') {
                    i += 1;
                    continue;
                }
                if (showReasoningTraces) {
                    if (!collapsibleThinkingBlocks) {
                        // Non-collapsible mode: render thinking blocks as plain text inline.
                        rendered.push(
                            <AssistantTextPart
                                key={`reasoning-${messageId}-${part.id ?? i}`}
                                part={part}
                                sessionId={sessionId}
                                messageId={messageId}
                                streamPhase={effectiveStreamPhase}
                                chatRenderMode={chatRenderMode}
                                hasStreamingHapticLifecycle={hasStreamingHapticLifecycle}
                                onContentChange={onContentChange}
                                onShowPopup={onShowPopup}
                            />
                        );
                    } else {
                        // Per-part mode: each reasoning block at its natural position.
                        rendered.push(
                            <div key={`reasoning-${messageId}-${part.id ?? i}`} className={getToolRowBlockClass(isMobile)}>
                                <ReasoningPart
                                    part={part}
                                    messageId={messageId}
                                    streamPhase={effectiveStreamPhase}
                                    onContentChange={onContentChange}
                                />
                            </div>
                        );
                    }
                }
                i++;
                continue;
            }

            if (part.type === 'tool') {
                const toolPart = part as ToolPartType;
                const toolName = toolPart.tool?.toLowerCase() ?? '';

                if (isSortedRenderMode && !isActivityOwnerMessage) {
                    i += 1;
                    continue;
                }

                const activity = activityByPart.get(part);
                if (activity?.kind === 'tool' && !isStandaloneTool(toolName)) {
                    i += 1;
                    continue;
                }

                if (!shouldShowTool(toolPart)) {
                    i++;
                    continue;
                }

                // Expandable tools: bash, edit, write, task, question — individual rows
                if (isExpandableTool(toolName)) {
                    rendered.push(
                        <div key={`tool-${toolPart.id}`} className={getToolRowBlockClass(isMobile)}>
                            <FadeInOnReveal>
                                <ToolRevealOnMount animate={animatedToolIdsLookup.has(toolPart.id)} wipe>
                                    <ToolPart
                                        part={toolPart}
                                        messageId={messageId}
                                        isExpanded={expandedTools.has(toolPart.id)}
                                        onToggle={onToggleTool}
                                        isMobile={isMobile}
                                        alwaysShowActions={alwaysShowMessageActions}
                                        onContentChange={onContentChange}
                                        onShowPopup={onShowPopup}
                                        animateTailText={animatedToolIdsLookup.has(toolPart.id)}
                                    />
                                </ToolRevealOnMount>
                            </FadeInOnReveal>
                        </div>
                    );
                    i++;
                    continue;
                }

                // Static tools: one row per tool call (no grouping)
                rendered.push(
                    <div key={`static-tools-${toolPart.id}`} className={getToolRowBlockClass(isMobile)}>
                        <FadeInOnReveal>
                            <ToolRevealOnMount animate={animatedToolIdsLookup.has(toolPart.id)} wipe>
                                <StaticToolRow
                                    toolName={toolName}
                                    activities={[
                                        {
                                            id: toolPart.id,
                                            turnId: '',
                                            messageId,
                                            partIndex: 0,
                                            part: toolPart,
                                            kind: 'tool' as const,
                                        },
                                    ]}
                                    animateTailText={animatedToolIdsLookup.has(toolPart.id)}
                                />
                            </ToolRevealOnMount>
                        </FadeInOnReveal>
                    </div>
                );
                i++;
                continue;
            }

            // Unknown part type — skip
            i++;
        }

        return rendered;
    }, [
        activityByPart,
        activityGroupSegmentsForMessage,
        alwaysShowMessageActions,
        animatedToolIdsLookup,
        animateActivityRows,
        chatRenderMode,
        collapsibleThinkingBlocks,
        collapsedPreviewCount,
        expandedTools,
        isMobile,
        isActivityOwnerMessage,
        isSortedRenderMode,
        lastRenderableTextPartIndex,
        messageId,
        messageActionButtons,
        renderJustificationActions,
        sessionId,
        onContentChange,
        onShowPopup,
        onToggleTool,
        shouldRenderActivityGroup,
        shouldShowStandaloneMessageActions,
        shouldShowTool,
        effectiveStreamPhase,
        hasStreamingHapticLifecycle,
        showReasoningTraces,
        shouldDeferSortedInlineText,
        toggleActivityGroup,
        turnGroupingContext,
        visibleParts,
    ]);

    const turnDurationText = React.useMemo(() => {
        if (!isLastAssistantInTurn || !hasStopFinish) return undefined;
        const userCreatedAt = turnGroupingContext?.userMessageCreatedAt;
        if (typeof userCreatedAt !== 'number' || typeof messageCompletedAt !== 'number') return undefined;
        if (messageCompletedAt <= userCreatedAt) return undefined;
        return formatTurnDuration(messageCompletedAt - userCreatedAt);
    }, [isLastAssistantInTurn, hasStopFinish, turnGroupingContext?.userMessageCreatedAt, messageCompletedAt]);

    const footerTimestamp = React.useMemo(() => {
        void locale;
        const timestamp = typeof messageCompletedAt === 'number' && messageCompletedAt > 0
            ? messageCompletedAt
            : (typeof messageCreatedAt === 'number' && messageCreatedAt > 0 ? messageCreatedAt : null);
        if (timestamp === null) return null;

        const formatted = formatTimestampForDisplay(timestamp, timeFormatPreference);
        return formatted.length > 0 ? formatted : null;
    }, [messageCompletedAt, messageCreatedAt, timeFormatPreference, locale]);

    const canOpenMessagePreview = !isMiniChatSurface && !isMobile && !isVSCode;

    const finalTurnActionButtons = (
        <>
            {canOpenMessagePreview && messagePreviewUrl ? (
                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className={MESSAGE_ACTION_ICON_BUTTON_CLASS}
                            aria-label={t('chat.messageBody.actions.openPreviewAria')}
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={() => {
                                const directory = effectiveDirectory
                                    ?? (currentSessionId ? getDirectoryForSession(currentSessionId) : null);
                                if (!directory) {
                                    return;
                                }
                                openContextPreview(directory, messagePreviewUrl);
                            }}
                        >
                            <Icon weight={MESSAGE_ACTION_ICON_WEIGHT} name="global" className={MESSAGE_ACTION_ICON_CLASS} />
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent sideOffset={6}>{t('chat.messageBody.actions.openPreview')}</TooltipContent>
                </Tooltip>
            ) : null}
            {!isMiniChatSurface && !isReviewSessionView && sessionSurfaceActions.fork ? <Tooltip>
                <TooltipTrigger asChild>
                    <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        className={MESSAGE_ACTION_ICON_BUTTON_CLASS}
                        aria-label={t('chat.messageBody.actions.forkAria')}
                        aria-busy={isForkPending}
                        disabled={isForkPending || Boolean(forkTransition)}
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={(event) => {
                            void handleForkClick(event);
                        }}
                    >
                        <Icon
                            weight={MESSAGE_ACTION_ICON_WEIGHT}
                            name={isForkPending ? 'loader-4' : 'git-branch'}
                            className={cn(MESSAGE_ACTION_ICON_CLASS, isForkPending && 'animate-spin')}
                        />
                    </Button>
                </TooltipTrigger>
                <TooltipContent sideOffset={6}>{t('chat.messageBody.actions.fork')}</TooltipContent>
            </Tooltip> : null}
        </>
    );
 
      return (

         <div
              ref={messageContentRef}
              data-message-text-export-root="true"
              className={cn(
                 'relative w-full group/message'
             )}
              style={CONTAIN_LAYOUT_STYLE}
          >
              <TextSelectionMenu containerRef={messageContentRef} />
              <div>
                 <div
                     // 不用 overflow-hidden：工具行 -mx 洗底需要画进列 gutter，否则圆角会被裁成直角
                     className="message-content-text leading-relaxed text-foreground/90 [&_p:last-child]:mb-0 [&_ul:last-child]:mb-0 [&_ol:last-child]:mb-0"
                 >
                    {renderedParts}
                    {showErrorMessage && (
                        <FadeInOnReveal key="assistant-error">
                            <div className={cn(
                                'group/assistant-text relative flow-root my-1.5 break-words max-w-full',
                                // Info: quiet chip — 圆角/padding 与 tool row 几何一致
                                // Error: keep a clearer callout.
                                // 移动端保留完整卡片边界，与消息内容列左缘对齐.
                                errorVariant === 'info'
                                    ? cn(
                                        'inline-flex w-fit max-w-full border border-[var(--status-info-border)]/45 bg-[var(--status-info-background)]/40',
                                        isMobile
                                            ? 'items-start gap-1.5 rounded-lg px-2.5 py-1.5'
                                            : cn('items-center gap-1.5', TOOL_ROW_CHIP_GEOMETRY_CLASS),
                                    )
                                    : 'mt-3 flex items-center gap-2 rounded-lg border border-[var(--status-error-border)] bg-[var(--status-error-background)] p-3',
                            )}>
                                <Icon
                                    name={errorIconName}
                                    weight={errorVariant === 'info' ? MESSAGE_ACTION_ICON_WEIGHT : undefined}
                                    className={cn(
                                        'shrink-0',
                                        errorVariant === 'info'
                                            ? cn(
                                                // 与底栏 copy/edit/time 同尺寸 + medium stroke，避免相对正文感图标过细
                                                MESSAGE_ACTION_ICON_CLASS,
                                                'text-[var(--status-info)]/80',
                                                // 首行 leading-5 光学居中：图标略下移贴齐首行字心
                                                isMobile && 'mt-0.5',
                                            )
                                            : 'h-4 w-4 text-[var(--status-error)]',
                                    )}
                                />
                                <div className={cn(
                                    'min-w-0 break-words',
                                    errorVariant === 'info'
                                        ? cn(
                                            // 关键：.markdown-content 默认 --text-markdown（移动端 1rem），
                                            // 必须 ! 压回 meta，否则 14px 图标对着 16px 正文会失调.
                                            'text-muted-foreground [&_.markdown-content]:text-muted-foreground [&_p]:m-0',
                                            '[&_.markdown-content]:!leading-5',
                                            isMobile
                                                ? '[&_.markdown-content]:!text-[length:var(--text-meta)]'
                                                : '[&_.markdown-content]:!text-[13px]',
                                        )
                                        : 'flex-1',
                                )}>
                                    <SimpleMarkdownRenderer
                                        content={errorMessage ?? ''}
                                        onShowPopup={onShowPopup}
                                        className="[&_.markdown-content>*:first-child]:mt-0 [&_.markdown-content>*:last-child]:mb-0"
                                        enableFileReferences={false}
                                    />
                                </div>
                            </div>
                        </FadeInOnReveal>
                    )}
                </div>
                <MessageFilesDisplay files={parts} onShowPopup={onShowPopup} />
                {shouldRenderStandaloneActionsAfterContent && (
                    <div className={cn(isMobile ? INLINE_MESSAGE_ACTIONS_MOBILE_CLASS_NAME : INLINE_MESSAGE_ACTIONS_CLASS_NAME)} data-message-actions="true">
                        <div className={MESSAGE_ACTION_GROUP_CLASS} data-message-action-group="true">
                            {messageActionButtons}
                        </div>
                    </div>
                )}
                {shouldShowTurnFooter && (
                    <div
                        className={footerRowClass}
                        data-message-footer="true"
                        style={MESSAGE_FOOTER_CONTAINER_STYLE}
                    >
                        <div className={MESSAGE_ACTION_GROUP_CLASS} data-message-action-group="true">
                            {messageActionButtons}
                            {finalTurnActionButtons}
                        </div>
                        {(turnDurationText || footerTimestamp) ? (
                            <div className={MESSAGE_FOOTER_META_GROUP_CLASS}>
                                {turnDurationText ? (
                                    <Tooltip>
                                        <TooltipTrigger asChild>
                                            <span className={MESSAGE_FOOTER_META_CLASS}>
                                                <Icon weight={MESSAGE_ACTION_ICON_WEIGHT} name="hourglass" className={MESSAGE_FOOTER_META_ICON_CLASS} />
                                                <span className="message-footer__label">{turnDurationText}</span>
                                            </span>
                                        </TooltipTrigger>
                                        <TooltipContent>{turnDurationText}</TooltipContent>
                                    </Tooltip>
                                ) : null}
                                {footerTimestamp ? (
                                    <Tooltip>
                                        <TooltipTrigger asChild>
                                            <span
                                                className={MESSAGE_FOOTER_META_CLASS}
                                                aria-label={`Message time: ${footerTimestamp}`}
                                            >
                                                <Icon weight={MESSAGE_ACTION_ICON_WEIGHT} name="time" className={MESSAGE_FOOTER_META_ICON_CLASS} />
                                                <span className="message-footer__label">{footerTimestamp}</span>
                                            </span>
                                        </TooltipTrigger>
                                        <TooltipContent>{footerTimestamp}</TooltipContent>
                                    </Tooltip>
                                ) : null}
                            </div>
                        ) : null}
                        {!isMiniChatSurface && isLastAssistantInTurn && hasStopFinish ? (
                            <TurnChangedFilesDropdown activityParts={turnGroupingContext?.activityParts} />
                        ) : null}
                        {!isMiniChatSurface && isLastAssistantInTurn && hasStopFinish ? (
                            <TurnChangedFilePills
                                files={turnGroupingContext?.changedFiles}
                                isInteractive={turnGroupingContext?.isLatestTurn === true}
                            />
                        ) : null}
                    </div>
                )}

            </div>
        </div>
    );
});

const MessageBody = React.memo(({ isUser, ...props }: MessageBodyProps) => {

    if (isUser) {
        return (
            <UserMessageBody
                messageId={props.messageId}
                parts={props.parts}
                sourceParts={props.sourceParts}
                messageCreatedAt={props.messageCreatedAt}
                isMobile={props.isMobile}
                alwaysShowActions={props.alwaysShowActions}
                hasTouchInput={props.hasTouchInput}
                hasTextContent={props.hasTextContent}
                onCopyMessage={props.onCopyMessage}
                copiedMessage={props.copiedMessage}
                onShowPopup={props.onShowPopup}
                agentMention={props.agentMention}
                onEdit={props.onEdit}
                onRevert={props.onRevert}
                onFork={props.onFork}
                pendingMessageAction={props.pendingMessageAction}
                userActionsMode={props.userActionsMode}
                stickyUserHeaderEnabled={props.stickyUserHeaderEnabled}
            />
        );
    }

    return <AssistantMessageBody {...props} />;
});

export default MessageBody;
