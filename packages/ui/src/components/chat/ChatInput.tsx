import React from 'react';
import { useEvent, useResizeObserver } from '@reactuses/core';
import { isCapacitorApp } from '@/lib/platform';
import { isMobileOverlayFocusRestoreSuppressed } from '@/lib/mobileOverlayFocusRestore';
import { canUseNativeMediaPick, pickNativeMediaFiles, NATIVE_MEDIA_PICK_LIMIT } from '@/lib/native-media-pick';
import { useNativeIosComposer } from './useNativeIosComposer';
import { applyNativeComposerAccessoryVar, canUseNativeIosComposer, getNativeIosComposerPlugin, handoffNativeComposerSendToWeb, resolveComposerInsertCaret } from '@/lib/native-ios-composer';
import { ComposerDictation } from '@/components/dictation/ComposerDictation';
// sessionStore removed — currentSessionId comes from useSessionUIStore
import { getConfigDirectoryKey, useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import { useLeaderKeyStore } from '@/stores/useLeaderKeyStore';
import { useMessageQueueStore, getPendingAdmissionsForScope, getQueueForScope, legacyQueueScope, queueScopeKey, type QueueItem, type QueueScope, type QueuedMessage } from '@/stores/messageQueueStore';
import { useAutoReviewStore } from '@/stores/useAutoReviewStore';
import { usePermissionStore } from '@/stores/permissionStore';
import { autoRespondsPermission } from '@/stores/utils/permissionAutoAccept';
import { beginDraftEstablishingPaint, clearDraftEstablishingPaint, useSessionUIStore } from '@/sync/session-ui-store';
import { ascendingId } from '@/sync/message-id';
import { useSelectionStore } from '@/sync/selection-store';
import { useInputStore } from '@/sync/input-store';
import { draftKeyString, newSessionDraftKey, sessionDraftKey, type DraftKey, type DraftMention } from '@/sync/input-draft-types';
import { createDraftAttachmentResourceAdapter } from '@/sync/draft-attachment-resource-adapter';
import { buildQueueComposerRestoration, commitComposerRestoration } from '@/sync/message-composer-restoration';
import type { AttachedFile } from '@/stores/types/sessionTypes';
import * as sessionActions from '@/sync/session-actions';
import { commitMessageEdit } from '@/sync/session-actions';
import type { OptimisticSendTicket } from '@/sync/session-actions';
import { promoteQueueHeadOnAbort } from '@/sync/queue-abort-optimistic';
import {
    useDirectoryStore as useChildDirectoryStore,
    useDirectorySync,
    useSession,
    useSessionMaterializationStatus,
    useSessionMessages,
    useSessionStatus,
    useSyncDirectory,
    useUserMessageHistory,
} from '@/sync/sync-context';
import { useTranscriptData } from '@/sync/transcript-repository-observers';
import { getAllSyncSessionMap, getSyncMessages, resolveMaterializedSessionDirectory } from '@/sync/sync-refs';
import { useSync } from '@/sync/use-sync';
import { useInlineCommentDraftStore, type InlineCommentDraft } from '@/stores/useInlineCommentDraftStore';
import { useSnippetsStore } from '@/stores/useSnippetsStore';
import { appendInlineComments } from '@/lib/messages/inlineComments';
import { renderMagicPrompt } from '@/lib/magicPrompts';
import { startReviewFlow } from '@/lib/reviewFlow';
import { getRuntimeGeneration, getRuntimeKey } from '@/lib/runtime-switch';
import { getRuntimeTransportIdentity, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { dispatchQueuedMessage } from '@/hooks/useQueuedMessageAutoSend';
import { useMessageQueueServerScope } from '@/sync/use-message-queue-server';
import { lazyWithChunkRecovery } from '@/lib/chunkLoadRecovery';
import { ReviewFlowDialog, type ReviewFlowExecution } from '@/components/session/ReviewFlowDialog';
import { ActiveEditorFileSuggestion, AttachedFilesList, AttachedVSCodeFileChips } from './FileAttachment';
import { QueuedMessageChips } from './QueuedMessageChips';
import { AutoReviewBanner } from './AutoReviewBanner';
import { FileMentionAutocomplete, type FileMentionHandle } from './FileMentionAutocomplete';
import { CommandAutocomplete, type CommandAutocompleteHandle, type CommandInfo } from './CommandAutocomplete';
import { SkillAutocomplete, type SkillAutocompleteHandle, type SkillInfo } from './SkillAutocomplete';
import { SnippetAutocomplete, type SnippetAutocompleteHandle } from './SnippetAutocomplete';
import { cn, formatDirectoryName } from '@/lib/utils';
import { ModelControls } from './ModelControls';
import { LeaderKeyHint } from './LeaderKeyHint';
import { StatusRow } from './StatusRow';
import { PendingChangesBar } from './PendingChangesBar';
import ScrollToBottomButton from './components/ScrollToBottomButton';
import { useChatSurfaceMode } from './useChatSurfaceMode';
import { getSessionSurfaceActionAvailability, useSessionSurface } from './SessionSurfaceContext';
import type { ToolPopupContent } from './message/types';
import { MobileAgentButton } from './MobileAgentButton';
import { MobileModelButton } from './MobileModelButton';
import { useSessionActivity } from '@/hooks/useSessionActivity';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
// useMessageStore removed — messages now come from sync system
import { getElectronPathForFile, isVSCodeRuntime } from '@/lib/desktop';
import { isIMECompositionEvent } from '@/lib/ime';
import { SendCircleIcon, StopIcon } from '@/components/icons/StopIcon';
import { resolveComposerActionAvailability } from './chatPromptAvailability';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { getCycledPrimaryAgentName, getAgentDisplayName, getModelDisplayName, formatEffortLabel, resolveAgentModelSelection, type MobileControlsPanel } from './mobileControlsUtils';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from '@/components/ui/select';
import { COMPOSER_ICON_HOVER_CLASS, SELECTOR_CHIP_HOVER_CLASS } from '@/components/chat/message/parts/toolRowChrome';
import { Input } from '@/components/ui/input';
import { MobileResizableSheet } from '@/components/ui/MobileResizableSheet';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { hasActiveMobileOverlay, MOBILE_OVERLAY_ACTIVE_ATTRIBUTE } from '@/components/ui/MobileOverlayPresence';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { GitHubIssuePickerDialog } from '@/components/session/GitHubIssuePickerDialog';
import { GitHubPrPickerDialog } from '@/components/session/GitHubPrPickerDialog';
import { Icon } from "@/components/icon/Icon";
import { DraftPresetChips } from './DraftPresetChips';
import { ChatPromptComposer } from './ChatPromptComposer';
import { useChatSearchDirectory } from '@/hooks/useChatSearchDirectory';
import { matchesModelSearch } from '@/lib/search/modelSearch';
import { opencodeClient } from '@/lib/opencode/client';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { PROJECT_COLOR_MAP, PROJECT_ICON_MAP, ProjectIconImage } from '@/lib/projectMeta';
import { useGitBranchLabel, useGitBranches, useGitStore, useIsGitRepo } from '@/stores/useGitStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { queryClient } from '@/lib/queryRuntime';
import { readInstalledSkillsSnapshot, useInstalledSkillsQuery } from '@/queries/installedSkillsQueries';
import { useCommandsQuery } from '@/queries/commandQueries';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { normalizeDirectoryKey } from '@/lib/pathNormalization';
import { buildSessionTargetOptions } from '@/sync/session-worktree-contract';
import { DraftSessionBranchSelector } from './DraftSessionBranchSelector';
import { resolveDraftSessionBranchLabel } from './draftSessionBranchLabel';
import { hasExtractableGitChangedFiles } from './changedFiles';
import { useI18n } from '@/lib/i18n';
import { sessionEvents } from '@/lib/sessionEvents';
import { fetchResponseStyleInstruction } from '@/lib/responseStyle';
import { wrapSystemReminder } from '@/lib/systemReminder';
import { EMPTY_REVERTED_MESSAGE_DOCK_STATE, buildRevertedMessageDockState, type RevertedMessageDockState } from './revertedMessageDockState';
import { eventMatchesShortcut, getEffectiveShortcutCombo, normalizeCombo } from '@/lib/shortcuts';
import { isSyntheticPart } from '@/lib/messages/synthetic';
import { createUuid } from '@/lib/uuid';
import {
    buildHighlightParts,
    findSkillMentionRanges,
    mentionRangesToHighlightRanges,
    resolveAtomicReferenceSelection,
    resolveSkillMentionDeletion,
    tokenizeMarkdown,
    type HighlightRange,
    type MentionRange,
} from './composerHighlight';
import { ComposerTriggerIconMark } from './ComposerTriggerIconMark';
import { focusComposerTextarea, resolveComposerTextarea, shouldApplyComposerDomCorrection } from './composerFocus';
import { highlightFencedCode } from './composerCodeHighlight';
import {
    assignImageAttachmentFilenames,
    buildAttachmentCitationText,
    collectDetachedAttachmentFilenames,
    findAttachmentCitationRanges,
    isInlineAttachmentCitation,
    reconcileComposerAttachmentTextDeletion,
    resolveAttachmentCitationDeletion,
} from './attachmentCitations';
import {
    commitComposerAutocompleteRows,
    resolveComposerAutocompleteReplaceRange,
    resolveComposerAutocompleteTrigger,
    type ComposerAutocompleteListRow,
    type ComposerAutocompleteTrigger,
    type ComposerAutocompleteVisibleRows,
} from '@/lib/composer-autocomplete';
import {
    collectComposerMentionHighlights,
    collectConfirmableFileMentions,
    shouldHighlightFileMention,
    type FileMentionAutocompleteInputSource,
} from './fileMentionAutocompleteState';
import {
    collectFileDropReferences,
    isAbsoluteFileDropPath,
    normalizeFileDropPath,
} from './fileDropReferences';
import { SessionGoalRow } from '@/components/chat/SessionGoalRow';
import { SessionGoalButton, SessionGoalObjectiveCounter } from '@/components/chat/SessionGoalButton';
import { useSessionGoal } from '@/hooks/useSessionGoal';
import { useSessionGoalArmStore } from '@/stores/useSessionGoalArmStore';
import type { Part } from '@opencode-ai/sdk/v2/client';
import { consumesImmediateCommandText, getGoalCommandObjective, getLocalChatCommand, preservesComposerResources } from './localCommandClassifier';
import { promoteTypedSlashChipSlots, stripLeadingSlashCommandSlot } from './typedSlashChipPromotion';
import { consumeImmediateCommandText } from './immediateCommandTextConsumption';
import { runImmediateSessionCommand } from './immediateSessionCommandAction';
import {
    shouldConsumeRootAttachmentsOnSubmit,
} from './chat-input-recovery';
import { shouldOptimisticPrimarySend } from './optimisticPrimarySend';
import { resolveStagedEditBlurDisarm } from './stagedMessageEditDisarm';
import {
    composerSendPhase,
    selectComposerFlightKind,
    selectEstablishingPendingItems,
    selectIsEstablishingDraft,
    useComposerSendStore,
    type ComposerSendPhase,
} from '@/sync/composer-send-manager';
import { drainEstablishingFollowUps } from '@/sync/composer-send-drain';
import { runQueueMessageFireAndForget } from './queueMessageFireAndForget';
import { admitServerQueueMessageAndConsumeResources, assistantQueueAdmissionAvailable, attachedFilesToQueueCandidates, beginQueueAdmissionOptimisticClear, createServerQueueAdmissionCapture, createServerQueueAdmissionIdentity, isCompleteQueueSendConfig, isQueueAdmissionRuntimeCurrent } from './queueAdmission';
import { shouldShowPermissionAutoAcceptControl, togglePermissionAutoAccept } from './permissionAutoAccept';
import { getSlashTokenRange } from './commandSelection';
    import {
        advancePastTrailingBoundarySpace,
        appendUniqueDraftMention,
        insertTokenWithReferenceBoundaries,
        withReferenceInsertionBoundaries,
    } from './insertionBoundaries';
import { isCommandAllowedForSubmission } from './commandSelection';
import { clearActiveChatInputSurface, setActiveChatInputSurface } from './activeChatInputSurface';
import { resolveComposerVisibleAgents } from './chatComposerCatalog';
import { assertChatInputSurfaceReady, isChatInputCommandAllowed, resolveChatInputCommandContext, resolveChatInputDraftBusy, resolveChatInputSurface, resolveModelVariantKeys, useChatInputSurfaceContext, usePrimaryChatInputSurface, type ChatInputSurface } from './chatInputSurface';
import type { CommandAutocompleteContext } from './CommandAutocomplete';
import { assertDeliveryRequestRuntimeCurrent, createChatInputControllerWiring, primarySendOptionsFromDeliveryRequest } from './chatInputSurfaceWiring';
import {
    applyPrimaryComposerSelectionChange,
    applyPrimaryComposerSessionRestore,
    capturePrimaryComposerSendConfig,
    parseLatestAssistantExecutionFromMessages,
    parseLatestUserChoiceFromMessages,
    resolvePrimaryComposerSendConfig,
    resolvePrimaryComposerSessionSelection,
    shouldHoldPrimaryComposerUserPick,
} from './primaryComposerSelection';
import { canCompactPastedText, createPastedTextReference, getNextPastedTextReferenceIndex } from './pastedTextReferences';
import { decorateComposerReference, serializeComposerDocument, validateComposerDocument, type ComposerDocument, type SessionComposerReference } from '@/composer/document';
import { useComposerController } from '@/composer/use-composer-controller';
import { buildComposerSemanticParts, dedupeDeliveryAttachments, ensureSessionMentionTranscripts } from '@/composer/delivery';
import type { ComposerReferenceSemantic } from '@/composer/extensions';
import {
    COMPOSER_TRIGGER_ICON_SLOT,
    composerTriggerIconDisplay,
    composerTriggerIconVisual,
    stripComposerTriggerIconSlot,
    stripComposerTriggerIconSlotsForPlainText,
} from '@/composer/inline-visual';
import { buildAssistantQueueDeliveryParts, buildAssistantQueueSyntheticSidecar, buildSyntheticDeliveryParts, compileChatComposerDelivery, legacyTextToAuthoredPlan } from './chatComposerDelivery';
import { resolveComposerTextareaAutosize } from './composerTextareaAutosize';
import { queueModeAllowsMutations, shouldRemoveQueueItemAfterEditCommit } from './queuedMessageChipsState';

const COMPOSER_TEXT_LAYOUT_CLASS = 'box-border w-full whitespace-pre-wrap break-words px-3 typography-markdown [font-family:inherit] [font-style:inherit] [font-weight:inherit] leading-[inherit] tracking-[inherit] md:typography-ui-label';
const ToolOutputDialog = lazyWithChunkRecovery(() => import('./message/ToolOutputDialog'));
const EMPTY_QUEUE: QueueItem[] = [];
const EMPTY_INLINE_DRAFTS: InlineCommentDraft[] = [];
const EMPTY_AGENTS: import('@opencode-ai/sdk/v2').Agent[] = [];
const EMPTY_PROVIDERS: Array<{ id: string; name?: string; models: Array<Record<string, unknown> & { id: string; name?: string }> }> = [];
const FILE_MENTION_TOKEN = /^@[^\s]+$/;
const shouldEnableComposerSlashDirectoryQueries = ({
    inputMode,
    message,
    showCommandAutocomplete,
    showSkillAutocomplete,
}: {
    inputMode: 'normal' | 'shell';
    message: string;
    showCommandAutocomplete: boolean;
    showSkillAutocomplete: boolean;
}): boolean => (
    inputMode !== 'shell'
    && (
        showCommandAutocomplete
        || showSkillAutocomplete
        || /(^|\s)\/[A-Za-z0-9_-]*/.test(message)
    )
);
// Single-line URL pasted over a selection becomes a markdown link.
const PASTE_LINK_URL_PATTERN = /^(https?:\/\/|mailto:)\S+$/i;
const COMPACT_CHAT_PLACEHOLDER_MAX_WIDTH = 560;
const renameFileForAttachmentCitation = (file: File, filename: string): File => {
    if (file.name === filename) {
        return file;
    }

    return new File([file], filename, {
        type: file.type,
        lastModified: file.lastModified,
    });
};

const getInsertedTextFromChange = (previousValue: string, nextValue: string): string => {
    if (previousValue === nextValue) {
        return '';
    }

    let prefixLength = 0;
    while (
        prefixLength < previousValue.length
        && prefixLength < nextValue.length
        && previousValue[prefixLength] === nextValue[prefixLength]
    ) {
        prefixLength += 1;
    }

    let previousSuffix = previousValue.length;
    let nextSuffix = nextValue.length;
    while (
        previousSuffix > prefixLength
        && nextSuffix > prefixLength
        && previousValue[previousSuffix - 1] === nextValue[nextSuffix - 1]
    ) {
        previousSuffix -= 1;
        nextSuffix -= 1;
    }

    return nextValue.slice(prefixLength, nextSuffix);
};

const getFileMentionInputSourceForInsertedText = (insertedText: string): FileMentionAutocompleteInputSource => (
    insertedText.includes('@') ? 'paste' : 'manual'
);

const normalizeReferenceDeletionWhitespace = (text: string, caret: number): { text: string; caret: number } => {
    let start = caret;
    let end = caret;
    while (start > 0 && /\s/.test(text[start - 1])) start -= 1;
    while (end < text.length && /\s/.test(text[end])) end += 1;
    const separator = start > 0 && end < text.length ? ' ' : '';
    return {
        text: `${text.slice(0, start)}${separator}${text.slice(end)}`,
        caret: start + separator.length,
    };
};

const hasUserMessages = (sessionId: string, directory?: string) => {
    return getSyncMessages(sessionId, directory).some((message) => message.role === 'user');
};

const getRevertedPreview = (parts: Part[], fallback: string): string => {
    const text = parts
        .filter((part) => part.type === 'text' && !isSyntheticPart(part))
        .map((part) => {
            const record = part as Record<string, unknown>;
            return typeof record.text === 'string'
                ? record.text
                : typeof record.content === 'string'
                    ? record.content
                    : '';
        })
        .join('\n')
        .replace(/\s+/g, ' ')
        .trim();

    if (text) return text;
    const filePart = parts.find((part) => part.type === 'file') as (Part & { filename?: string }) | undefined;
    return filePart?.filename ? `[${filePart.filename}]` : fallback;
};

const FILE_URI_PREFIX = 'file://';

const encodeFilePath = (filepath: string): string => {
    let normalized = filepath.replace(/\\/g, '/');
    if (/^[A-Za-z]:/.test(normalized)) {
        normalized = `/${normalized}`;
    }
    return normalized
        .split('/')
        .map((segment, index) => {
            if (index === 1 && /^[A-Za-z]:$/.test(segment)) return segment;
            return encodeURIComponent(segment);
        })
        .join('/');
};

const toServerFileUrl = (filepath: string): string => {
    const normalized = filepath.replace(/\\/g, '/').trim();
    if (normalized.toLowerCase().startsWith(FILE_URI_PREFIX)) {
        return normalized;
    }
    return `file://${encodeFilePath(normalized)}`;
};

const collectFilePathsFromTransfer = (dataTransfer: DataTransfer | null | undefined): string[] => {
    if (!dataTransfer) {
        return [];
    }

    const paths = [
        ...collectFileDropReferences(dataTransfer).map(normalizeFileDropPath),
        ...Array.from(dataTransfer.files || [])
            .map((file) => getElectronPathForFile(file))
            .filter((path): path is string => Boolean(path)),
    ];

    return Array.from(new Set(paths.filter(isAbsoluteFileDropPath)));
};

const normalizePath = (value?: string | null): string | null => {
    if (typeof value !== 'string') {
        return null;
    }
    const trimmed = value.trim();
    if (!trimmed) {
        return null;
    }
    const normalized = trimmed.replace(/\\/g, '/');
    if (normalized === '/') {
        return '/';
    }
    return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
};

const getProjectDisplayLabel = (project: { label?: string; path: string }): string => {
    return formatDirectoryName(project.path);
};

const renderDraftTitle = (title: string, projectLabel: string | null): React.ReactNode => {
    if (!projectLabel) return title;
    const projectIndex = title.indexOf(projectLabel);
    if (projectIndex === -1) return title;

    return (
        <>
            {title.slice(0, projectIndex)}
            <span className="font-medium">{projectLabel}</span>
            {title.slice(projectIndex + projectLabel.length)}
        </>
    );
};

const MemoModelControls = React.memo(ModelControls);
const MemoComposerDictation = React.memo(ComposerDictation);
const MemoMobileAgentButton = React.memo(MobileAgentButton);
const MemoMobileModelButton = React.memo(MobileModelButton);
const MemoStatusRow = React.memo(StatusRow);

type RevertedMessageDockProps = {
    sessionId: string | null;
    directory?: string;
};

const RevertedMessageDock: React.FC<RevertedMessageDockProps> = React.memo(({ sessionId, directory }) => {
    const { t } = useI18n();
    const isMobile = useUIStore((state) => state.isMobile);
    const revertToMessage = useSessionUIStore((s) => s.revertToMessage);
    const forkFromMessage = useSessionUIStore((s) => s.forkFromMessage);
    const handleSlashRedo = useSessionUIStore((s) => s.handleSlashRedo);
    const [restoringId, setRestoringId] = React.useState<string | null>(null);
    const [forkingId, setForkingId] = React.useState<string | null>(null);
    const [collapsed, setCollapsed] = React.useState(true);
    const revertedStateRef = React.useRef<RevertedMessageDockState>(EMPTY_REVERTED_MESSAGE_DOCK_STATE);
    // Ticket 02 remediation: full transcript (messages + parts) from repository;
    // directory store only for session.revert metadata (outside transcript ownership).
    const syncDirectory = useSyncDirectory();
    const targetDirectory = directory || syncDirectory;
    const childStore = useChildDirectoryStore(targetDirectory);
    const transcriptData = useTranscriptData(sessionId ?? '', targetDirectory, childStore);
    // Narrow session list subscription — only re-renders when session array ref changes
    // (revert metadata lives on the session entity).
    const sessionList = useDirectorySync(
        (state) => state.session,
        targetDirectory,
    );
    const revertedState = React.useMemo(() => {
        const messages = transcriptData.messageOrder
            .map((id) => transcriptData.messagesByID[id])
            .filter((message): message is NonNullable<typeof message> => Boolean(message));
        const next = buildRevertedMessageDockState(
            {
                session: sessionList,
                messages,
                partsByMessageID: transcriptData.partsByMessageID,
            },
            sessionId,
            revertedStateRef.current,
        );
        revertedStateRef.current = next;
        return next;
    }, [sessionId, sessionList, transcriptData]);
    const revertMessageID = revertedState.revertMessageID;
    const userMessages = React.useMemo(
        () => revertedState.records.map((record) => record.message),
        [revertedState],
    );
    const noTextContent = t('chat.revertPopover.noTextContent');
    const items = React.useMemo(() => {
        if (!revertMessageID) return [];
        return revertedState.records.map((record) => ({
            id: record.message.id,
            text: getRevertedPreview(record.parts, noTextContent),
        }));
    }, [noTextContent, revertMessageID, revertedState]);
    const firstRevertedMessageId = items[0]?.id;

    React.useEffect(() => {
        setCollapsed(true);
    }, [revertMessageID, firstRevertedMessageId]);

    const handleRestore = React.useCallback(async (messageId: string) => {
        if (!sessionId || restoringId) return;
        setRestoringId(messageId);
        try {
            const nextMessage = userMessages.find((message) => message.id > messageId);
            if (nextMessage) {
                await revertToMessage(sessionId, nextMessage.id, { skipRedoPush: true });
            } else {
                await handleSlashRedo(sessionId, { fullUnrevert: true });
            }
        } finally {
            setRestoringId(null);
        }
    }, [handleSlashRedo, revertToMessage, restoringId, sessionId, userMessages]);

    const handleFork = React.useCallback(async (messageId: string) => {
        if (!sessionId || forkingId) return;
        setForkingId(messageId);
        try {
            await forkFromMessage(sessionId, messageId);
        } finally {
            setForkingId(null);
        }
    }, [forkFromMessage, forkingId, sessionId]);

    if (!sessionId || items.length === 0) return null;

    return (
        <div className={cn('w-full px-1', isMobile ? 'pb-1 text-xs' : 'pb-2')}>
            <div className={cn(
                'border border-border/60 bg-[var(--surface-elevated)] text-[var(--surface-elevated-foreground)] shadow-sm dark:shadow-none overflow-hidden',
                isMobile ? 'rounded-lg' : 'rounded-xl',
            )}>
                <button
                    type="button"
                    className={cn(
                        'flex w-full items-center text-left hover:bg-[var(--interactive-hover)] transition-colors',
                        isMobile ? 'gap-1.5 px-2 py-1' : 'gap-2 px-3 py-2',
                    )}
                    onClick={() => setCollapsed((value) => !value)}
                    aria-expanded={!collapsed}
                >
                    <span className="typography-ui-label font-medium text-foreground flex-shrink-0">
                        {t('chat.revertPopover.title')} messages {items.length}
                    </span>
                    <Icon
                        name="arrow-down-s"
                        className={cn("ml-auto text-muted-foreground transition-transform", isMobile ? 'size-3.5' : 'size-4', !collapsed && "rotate-180")}
                        aria-hidden="true"
                    />
                </button>
                {!collapsed && (
                    <div className={cn(
                        'flex flex-col overflow-y-auto',
                        isMobile ? 'max-h-[8rem] gap-1 px-2 pb-1.5' : 'max-h-[10.5rem] gap-1.5 px-3 pb-3',
                    )}>
                        {items.map((item) => (
                            <div key={item.id} className={cn('flex min-w-0 items-center', isMobile ? 'gap-1.5' : 'gap-2 py-1')}>
                                <span className="min-w-0 flex-1 truncate typography-ui-label text-foreground">
                                    {item.text}
                                </span>
                                <Button
                                    type="button"
                                    variant="secondary"
                                    size="xs"
                                    disabled={Boolean(restoringId || forkingId)}
                                    onClick={() => { void handleFork(item.id); }}
                                >
                                    {forkingId === item.id ? (
                                        <Icon name="loader-4" className="h-3 w-3 animate-spin" aria-hidden="true" />
                                    ) : (
                                        <Icon name="git-branch" className="h-3 w-3" aria-hidden="true" />
                                    )}
                                    {t('chat.revertPopover.fork')}
                                </Button>
                                <Button
                                    type="button"
                                    variant="secondary"
                                    size="xs"
                                    disabled={Boolean(restoringId || forkingId)}
                                    onClick={() => { void handleRestore(item.id); }}
                                >
                                    {restoringId === item.id ? (
                                        <Icon name="loader-4" className="h-3 w-3 animate-spin" aria-hidden="true" />
                                    ) : (
                                        <Icon name="arrow-go-forward" className="h-3 w-3" aria-hidden="true" />
                                    )}
                                    {t('chat.revertPopover.restore')}
                                </Button>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
});

RevertedMessageDock.displayName = 'RevertedMessageDock';

// Future expansion: set true to restore the + attachment menu (desktop dropdown
// and mobile bottom sheet) for actions beyond direct file attach.
const ATTACHMENT_EXPANSION_MENU_ENABLED = false;

type ComposerAttachmentControlsProps = {
    isVSCode: boolean;
    footerIconButtonClass: string;
    iconSizeClass: string;
    handlePickLocalFiles: () => void;
    handlePickLocalImages: () => void;
    openIssuePicker: () => void;
    openPrPicker: () => void;
    onOpenSettings?: () => void;
    onMenuOpenChange?: (open: boolean) => void;
    /** Mobile: open the attachment bottom sheet instead of the dropdown menu. */
    onOpenMobileSheet?: () => void;
    /** Android Capacitor：打开照片/文件二选一 sheet */
    onOpenAndroidPickSheet?: () => void;
    withTooltip?: boolean;
};

const ComposerAttachmentControls = React.memo(function ComposerAttachmentControls(props: ComposerAttachmentControlsProps) {
    const { t } = useI18n();
    const {
        isVSCode,
        footerIconButtonClass,
        iconSizeClass,
        handlePickLocalFiles,
        openIssuePicker,
        openPrPicker,
        onOpenSettings,
        withTooltip = false,
    } = props;

    const isMobileAttach = Boolean(props.onOpenMobileSheet);
    const attachLabel = t('chat.chatInput.actions.attachFiles');
    // Route mobile to the all-files picker too: the image-only input hid
    // documents (.json etc.) on iOS. WKWebView still offers the photo
    // library from the document picker's action sheet with accept="*/*".
    const handlePick = handlePickLocalFiles;

    const attachButton = (
        <button
            type="button"
            className={footerIconButtonClass}
            onClick={() => (props.onOpenAndroidPickSheet ? props.onOpenAndroidPickSheet() : handlePick())}
            // Keep the tap from dismissing the keyboard. On Android's
            // resizes-content viewport the keyboard-close relayout
            // moves this button mid-tap and the click never lands.
            // Mobile: always suppress focus transfer so attach is never treated
            // as tapping the textarea (pill expand / IME open). Desktop keeps
            // default so the field can stay focused after attach.
            onMouseDown={isMobileAttach ? (event) => event.preventDefault() : undefined}
            onPointerDownCapture={isMobileAttach ? (event) => {
                event.preventDefault();
            } : undefined}
            title={attachLabel}
            aria-label={attachLabel}
        >
            <Icon name="attachment-2" className={cn(iconSizeClass, 'text-current')} />
        </button>
    );

    return (
        <div className="flex items-center gap-x-1.5">
            <div className="relative inline-flex">
                {withTooltip ? (
                    <Tooltip>
                        <TooltipTrigger asChild>
                            {attachButton}
                        </TooltipTrigger>
                        <TooltipContent side="top" sideOffset={8}>
                            {attachLabel}
                        </TooltipContent>
                    </Tooltip>
                ) : attachButton}

                {ATTACHMENT_EXPANSION_MENU_ENABLED ? (
                    props.onOpenMobileSheet ? (
                        <button
                            type="button"
                            className={footerIconButtonClass}
                            onClick={props.onOpenMobileSheet}
                            onMouseDown={(event) => event.preventDefault()}
                            onPointerDownCapture={(event) => {
                                if (event.pointerType === 'touch') {
                                    event.preventDefault();
                                }
                            }}
                            title={t('chat.chatInput.actions.addAttachment')}
                            aria-label={t('chat.chatInput.actions.addAttachment')}
                        >
                            <Icon name="add-circle" className={cn(iconSizeClass, 'text-current')} />
                        </button>
                    ) : isVSCode ? null : (
                        <DropdownMenu onOpenChange={props.onMenuOpenChange}>
                            <DropdownMenuTrigger asChild>
                                <button
                                    type="button"
                                    className={footerIconButtonClass}
                                    title={t('chat.chatInput.actions.addAttachment')}
                                    aria-label={t('chat.chatInput.actions.addAttachment')}
                                >
                                    <Icon name="add-circle" className={cn(iconSizeClass, 'text-current')} />
                                </button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="start">
                                <DropdownMenuItem
                                    onSelect={() => {
                                        requestAnimationFrame(handlePickLocalFiles);
                                    }}
                                >
                                    <Icon name="attachment-2"/>
                                    {t('chat.chatInput.actions.attachFiles')}
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                    onSelect={() => {
                                        requestAnimationFrame(openIssuePicker);
                                    }}
                                >
                                    <Icon name="github"/>
                                    {t('chat.chatInput.actions.linkGithubIssue')}
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                    onSelect={() => {
                                        requestAnimationFrame(openPrPicker);
                                    }}
                                >
                                    <Icon name="git-pull-request"/>
                                    {t('chat.chatInput.actions.linkGithubPr')}
                                </DropdownMenuItem>
                            </DropdownMenuContent>
                        </DropdownMenu>
                    )
                ) : null}
            </div>

            {onOpenSettings ? (
                <button
                    type="button"
                    onClick={onOpenSettings}
                    className={footerIconButtonClass}
                    title={t('chat.chatInput.actions.modelAgentSettings')}
                    aria-label={t('chat.chatInput.actions.modelAgentSettings')}
                >
                    <Icon name="ai-agent" className={cn(iconSizeClass, 'text-current')} />
                </button>
            ) : null}
        </div>
    );
}, (prev, next) => (
    prev.isVSCode === next.isVSCode
    && prev.footerIconButtonClass === next.footerIconButtonClass
    && prev.iconSizeClass === next.iconSizeClass
    && prev.onOpenSettings === next.onOpenSettings
    && prev.onMenuOpenChange === next.onMenuOpenChange
    && prev.onOpenMobileSheet === next.onOpenMobileSheet
    && prev.onOpenAndroidPickSheet === next.onOpenAndroidPickSheet
    && prev.withTooltip === next.withTooltip
));

type PermissionAutoAcceptButtonProps = {
    sessionId: string | null;
    draftOpen: boolean;
    draftEnabled: boolean;
    enabled: boolean;
    saving: boolean;
    footerIconButtonClass: string;
    iconSizeClass: string;
    onSetDraftEnabled: (enabled: boolean) => void;
    onSetSessionEnabled: (sessionId: string, enabled: boolean) => Promise<void>;
    onOpenSessionFirst: () => void;
    onToggleFailed: () => void;
};

const PermissionAutoAcceptButton = React.memo(function PermissionAutoAcceptButton(props: PermissionAutoAcceptButtonProps) {
    const { t } = useI18n();
    const actionLabel = t(props.enabled
        ? 'chat.chatInput.permissionAutoAccept.disable'
        : 'chat.chatInput.permissionAutoAccept.enable');

    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <button
                    type="button"
                    disabled={props.saving}
                    aria-pressed={props.enabled}
                    aria-label={actionLabel}
                    className={props.footerIconButtonClass}
                    onClick={() => togglePermissionAutoAccept({
                        permissionScopeSessionId: props.sessionId,
                        newSessionDraftOpen: props.draftOpen,
                        draftPermissionAutoAcceptEnabled: props.draftEnabled,
                        permissionAutoAcceptEnabled: props.enabled,
                        setDraftPermissionAutoAcceptEnabled: props.onSetDraftEnabled,
                        setSessionAutoAccept: props.onSetSessionEnabled,
                        onOpenSessionFirst: props.onOpenSessionFirst,
                        onToggleFailed: props.onToggleFailed,
                    })}
                    onMouseDown={(event) => event.preventDefault()}
                    onPointerDownCapture={(event) => {
                        if (event.pointerType === 'touch') {
                            event.preventDefault();
                        }
                    }}
                >
                    <Icon name={props.enabled ? 'shield-check' : 'shield'} className={cn(props.iconSizeClass, 'text-current')} />
                </button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={8}>{actionLabel}</TooltipContent>
        </Tooltip>
    );
});

type ComposerActionButtonsProps = {
    isMobile: boolean;
    compact?: boolean;
    footerIconButtonClass: string;
    stopFooterIconButtonClass?: string;
    compactCircleButtonClass?: string;
    sendIconSizeClass: string;
    stopIconSizeClass: string;
    canSend: boolean;
    canAbort: boolean;
    hasContent: boolean;
    currentSessionId: string | null;
    newSessionDraftOpen: boolean;
    draftSubmitting?: boolean;
    submissionBlocked: boolean;
    /** Single composer send phase from composer-send-manager. */
    sendPhase: ComposerSendPhase;
    queueFrozen: boolean;
    queueFallbackAvailable: boolean;
    onPrimaryAction: () => void;
    onAbort: () => void;
};

const ComposerActionButtons = React.memo(function ComposerActionButtons(props: ComposerActionButtonsProps) {
    const {
        isMobile,
        compact = false,
        footerIconButtonClass,
        stopFooterIconButtonClass,
        compactCircleButtonClass,
        sendIconSizeClass,
        stopIconSizeClass,
        canSend,
        canAbort,
        hasContent,
        currentSessionId,
        newSessionDraftOpen,
        draftSubmitting,
        submissionBlocked,
        sendPhase,
        queueFrozen,
        queueFallbackAvailable,
        onPrimaryAction,
        onAbort,
    } = props;
    const { t } = useI18n();
    const actionAvailability = resolveComposerActionAvailability({
        canSend,
        hasSessionTarget: Boolean(currentSessionId || newSessionDraftOpen),
        draftSubmitting: Boolean(draftSubmitting),
        submissionBlocked,
        sendPhase,
        queueFrozen,
        queueFallbackAvailable,
    });

    // Match stop / attach / model: only block focus transfer so the soft keyboard
    // stays open. Do not invent a second activation path (pointerup) — stop works
    // with plain onClick on the same mobile form capture path.
    const keepKeyboardFocusProps = isMobile
        ? {
            onMouseDown: (event: React.MouseEvent<HTMLButtonElement>) => {
                event.preventDefault();
            },
            onPointerDownCapture: (event: React.PointerEvent<HTMLButtonElement>) => {
                if (event.pointerType === 'touch') {
                    event.preventDefault();
                }
            },
        }
        : {};

    const inFlight = sendPhase.inFlight;
    const queueInFlight = inFlight && sendPhase.flightKind === 'queue';
    const sendInFlight = inFlight && sendPhase.flightKind !== 'queue';
    const primaryAria = queueInFlight
        ? t('chat.chatInput.actions.queuingMessageAria')
        : sendInFlight
            ? t('chat.chatInput.actions.sendingMessageAria')
            : t(queueFrozen && queueFallbackAvailable && canAbort
                ? 'chat.chatInput.actions.sendMessageAria'
                : canAbort
                    ? 'chat.chatInput.actions.queueMessageAria'
                    : 'chat.chatInput.actions.sendMessageAria');
    const circleButtonClass = compact
        ? (compactCircleButtonClass ?? stopFooterIconButtonClass ?? footerIconButtonClass)
        : (stopFooterIconButtonClass ?? footerIconButtonClass);
    const circleGlyphClass = stopIconSizeClass;
    const showSendCircle = !canAbort && (!actionAvailability.sendDisabled || inFlight);

    const sendButton = (
        <button
            type={isMobile ? 'button' : 'submit'}
            data-composer-send="true"
            data-composer-circle={showSendCircle ? 'true' : undefined}
            disabled={actionAvailability.sendDisabled}
            aria-busy={inFlight || undefined}
            {...keepKeyboardFocusProps}
            onClick={(event) => {
                if (!isMobile) {
                    return;
                }
                event.preventDefault();
                onPrimaryAction();
            }}
            className={cn(
                showSendCircle ? circleButtonClass : footerIconButtonClass,
                showSendCircle
                    ? undefined
                    : actionAvailability.sendDisabled
                        ? actionAvailability.disabledClass
                        : 'text-primary hover:text-primary',
            )}
            aria-label={sendInFlight || (!canAbort && inFlight)
                ? t(queueInFlight ? 'chat.chatInput.actions.queuingMessageAria' : 'chat.chatInput.actions.sendingMessageAria')
                : t('chat.chatInput.actions.sendMessageAria')}
        >
            {showSendCircle ? (
                <SendCircleIcon className={circleGlyphClass} spinning={Boolean(inFlight && !canAbort)} />
            ) : (
                <Icon name="send-plane-2" className={sendIconSizeClass} />
            )}
        </button>
    );

    if (!canAbort) {
        return sendButton;
    }

    // Busy follow-up: same primary action as Enter (queue or steer). Use sendDisabled
    // (content + session + blocked), not queueDisabled — queue freeze still allows
    // steer while canAbort is true. Stack above the textarea (z-10).
    // Keep the floating control visible while queue admission is in flight even
    // after the composer cleared, so the user sees an immediate "queuing" state.
    const showFloatingSend = !compact && (hasContent || queueInFlight);
    const floatingSendReady = !actionAvailability.sendDisabled && !queueInFlight;
    return (
        <div className={cn('relative z-30 overflow-visible', compact && 'h-full')}>
            {showFloatingSend ? (
                <button
                    type="button"
                    data-composer-send="true"
                    data-composer-circle={floatingSendReady || queueInFlight ? 'true' : undefined}
                    disabled={actionAvailability.sendDisabled || queueInFlight}
                    aria-busy={queueInFlight || undefined}
                    {...keepKeyboardFocusProps}
                    onClick={(event) => {
                        event.preventDefault();
                        if (queueInFlight) return;
                        onPrimaryAction();
                    }}
                    className={cn(
                        floatingSendReady || queueInFlight ? circleButtonClass : footerIconButtonClass,
                        'absolute z-30 bottom-full left-1/2 -translate-x-1/2 mb-1',
                        floatingSendReady || queueInFlight
                            ? undefined
                            : actionAvailability.disabledClass,
                    )}
                    aria-label={primaryAria}
                >
                    {floatingSendReady || queueInFlight ? (
                        <SendCircleIcon className={circleGlyphClass} spinning={queueInFlight} />
                    ) : (
                        <Icon name="send-plane-2" className={sendIconSizeClass} />
                    )}
                </button>
            ) : null}
            <button
                type="button"
                data-composer-stop="true"
                onClick={onAbort}
                className={cn(
                    circleButtonClass,
                    'relative z-30'
                )}
                aria-label={t('chat.chatInput.actions.stopGeneratingAria')}
            >
                <StopIcon className={cn(circleGlyphClass)} />
            </button>
        </div>
    );
}, (prev, next) => (
    prev.isMobile === next.isMobile
    && prev.compact === next.compact
    && prev.footerIconButtonClass === next.footerIconButtonClass
    && prev.stopFooterIconButtonClass === next.stopFooterIconButtonClass
    && prev.compactCircleButtonClass === next.compactCircleButtonClass
    && prev.sendIconSizeClass === next.sendIconSizeClass
    && prev.stopIconSizeClass === next.stopIconSizeClass
    && prev.canSend === next.canSend
    && prev.canAbort === next.canAbort
    && prev.hasContent === next.hasContent
    && prev.currentSessionId === next.currentSessionId
    && prev.newSessionDraftOpen === next.newSessionDraftOpen
    &&     prev.draftSubmitting === next.draftSubmitting
    && prev.submissionBlocked === next.submissionBlocked
    && prev.sendPhase === next.sendPhase
    && prev.queueFrozen === next.queueFrozen
    && prev.queueFallbackAvailable === next.queueFallbackAvailable
    && prev.onPrimaryAction === next.onPrimaryAction
    && prev.onAbort === next.onAbort
));

const appendWithLineBreaks = (base: string, next: string): string => {
    const separator = !base
        ? ''
        : base.endsWith('\n\n')
            ? ''
            : base.endsWith('\n')
                ? '\n'
                : '\n\n';

    const nextWithTrailingBreaks = next.endsWith('\n\n')
        ? next
        : next.endsWith('\n')
            ? `${next}\n`
            : `${next}\n\n`;

    return `${base}${separator}${nextWithTrailingBreaks}`;
};

const appendInlineText = (base: string, next: string): string => {
    const nextTrimmed = next.trim();
    if (!nextTrimmed) {
        return base;
    }
    if (!base) {
        return `${nextTrimmed} `;
    }
    const separator = /[\s\n]$/.test(base) ? '' : ' ';
    return `${base}${separator}${nextTrimmed} `;
};

interface ChatInputProps {
    onOpenSettings?: () => void;
    scrollToBottom?: () => void;
    /** Mobile overlay: show the dual scroll-to-bottom affordances above composer layers. */
    showScrollToBottom?: boolean;
    onScrollToBottom?: () => void;
    submissionBlocked?: boolean;
    surface?: ChatInputSurface;
}

type AutocompleteOverlayPosition = {
    top: number;
    left: number;
    place: 'above' | 'below';
    maxHeight: number;
};

const createComposerDraftKey = (transportIdentity: string, currentSessionId: string | null, draftID: string | null | undefined, attachmentDraft: DraftKey | null): DraftKey | null => {
    // Prefer session / new-draft identity. Legacy activeAttachmentDraft is only a
    // fallback when neither session nor draft owner is available.
    if (currentSessionId) return sessionDraftKey({ transportIdentity }, currentSessionId);
    if (draftID) return newSessionDraftKey({ transportIdentity }, draftID);
    return attachmentDraft;
};

const EMPTY_PRIMARY_ATTACHMENT_VIEWS: ReadonlyArray<AttachedFile> = [];

const ChatInputRuntime: React.FC<ChatInputProps> = ({
    onOpenSettings,
    scrollToBottom,
    showScrollToBottom = false,
    onScrollToBottom,
    submissionBlocked = false,
    surface: surfaceProp,
}) => {
    const { t } = useI18n();
    const [attachmentPopup, setAttachmentPopup] = React.useState<ToolPopupContent>({
        open: false,
        title: '',
        content: '',
    });
    const [inputMode, setInputMode] = React.useState<'normal' | 'shell'>('normal');
    const [isDragging, setIsDragging] = React.useState(false);
    const [isInternalDrag, setIsInternalDrag] = React.useState(false);
    const [showFileMention, setShowFileMention] = React.useState(false);
    const [mentionQuery, setMentionQuery] = React.useState('');
    const [showCommandAutocomplete, setShowCommandAutocomplete] = React.useState(false);
    const [commandQuery, setCommandQuery] = React.useState('');
    const [showSkillAutocomplete, setShowSkillAutocomplete] = React.useState(false);
    const [skillQuery, setSkillQuery] = React.useState('');
    const [showSnippetAutocomplete, setShowSnippetAutocomplete] = React.useState(false);
    const [snippetQuery, setSnippetQuery] = React.useState('');
    const [nativeSuggestionRows, setNativeSuggestionRows] = React.useState<ComposerAutocompleteListRow[]>([]);
    const [nativeSuggestionHighlight, setNativeSuggestionHighlight] = React.useState(0);
    const [textareaSize, setTextareaSize] = React.useState<{ height: number; maxHeight: number } | null>(null);
    const [mobileControlsPanel, setMobileControlsPanel] = React.useState<MobileControlsPanel>(null);
    // PWA overlay keyboard-reveal retries (300/650ms). Cleared on unmount so
    // long sessions do not accumulate orphaned callbacks.
    const mobileOverlayRevealEarlyTimerRef = React.useRef<number | null>(null);
    const mobileOverlayRevealLateTimerRef = React.useRef<number | null>(null);
    const [mobileTextareaFocused, setMobileTextareaFocused] = React.useState(false);
    // Mobile browser / installed PWA: tapping a composer control while the
    // keyboard is up blurs the textarea first, and the keyboard-resize reflow
    // moves the control out from under the finger BEFORE the browser
    // synthesizes the click — the tap dismisses the keyboard but the control's
    // onClick never fires. Defer the blur-driven state flip so the pinned
    // composer holds still through the tap; a refocus cancels it. Capacitor
    // keeps the immediate flip.
    const mobileBlurTimerRef = React.useRef<number | null>(null);
    React.useEffect(() => () => {
        if (mobileBlurTimerRef.current !== null) {
            window.clearTimeout(mobileBlurTimerRef.current);
        }
        if (mobileOverlayRevealEarlyTimerRef.current !== null) {
            window.clearTimeout(mobileOverlayRevealEarlyTimerRef.current);
        }
        if (mobileOverlayRevealLateTimerRef.current !== null) {
            window.clearTimeout(mobileOverlayRevealLateTimerRef.current);
        }
    }, []);
    const [mobileAttachMenuOpen, setMobileAttachMenuOpen] = React.useState(false);
    const [androidMediaPickSheetOpen, setAndroidMediaPickSheetOpen] = React.useState(false);
    const [mobileDraftPicker, setMobileDraftPicker] = React.useState<'project' | null>(null);
    const mobileDraftProjectSheetId = React.useId();
    const [mobileDraftPickerQuery, setMobileDraftPickerQuery] = React.useState('');
    const [desktopDraftProjectQuery, setDesktopDraftProjectQuery] = React.useState('');
    const [desktopDraftProjectPickerOpen, setDesktopDraftProjectPickerOpen] = React.useState(false);
    // True while ANY MobileOverlayPanel is open (sessions sheet, model/agent
    // panels, pickers...).
    const [mobileOverlayHostBusy, setMobileOverlayHostBusy] = React.useState(false);
    // Timestamp until which a footer/chrome action (attach, agent, model, …)
    // owns the gesture. Textarea focus during that window is accidental and must
    // not expand the pill or open the soft keyboard.
    const suppressComposerFocusUntilRef = React.useRef(0);
    const markComposerActionGesture = React.useCallback(() => {
        // Footer/chrome actions must never be treated as "tap the input".
        suppressComposerFocusUntilRef.current = Date.now() + 500;
    }, []);
    // Keyboard restore across overlays: opening an overlay closes the keyboard;
    // if it was open at that moment, reopen it when the overlay closes.
    const lastMobileBlurAtRef = React.useRef(0);
    const restoreKeyboardAfterOverlayRef = React.useRef(false);
    // Message history navigation state (up/down arrow to recall previous messages)
    const [historyIndex, setHistoryIndex] = React.useState(-1); // -1 = not browsing, 0+ = index from most recent
    const primaryCycleAgentRef = React.useRef<(direction: 1 | -1) => void>(() => {});

    // TODO: port sendMessage to session-actions (complex — creates sessions, handles attachments, etc.)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const primarySendMessage = React.useRef((...args: any[]) =>
        Promise.resolve().then(() =>
            (useSessionUIStore.getState().sendMessage as (...a: unknown[]) => unknown)(...args),
        ),
    ).current;
    const primarySessionID = useSessionUIStore((s) => s.currentSessionId);
    const primaryProviderID = useConfigStore((state) => state.currentProviderId);
    const primaryModelID = useConfigStore((state) => state.currentModelId);
    const primaryAgentName = useConfigStore((state) => state.currentAgentName);
    const primaryVariant = useConfigStore((state) => state.currentVariant);
    const primarySelectionProviders = useConfigStore((state) => state.providers);
    const primarySelectionAgentsRaw = useConfigStore((state) => state.agents);
    const getPrimaryVisibleAgents = useConfigStore((state) => state.getVisibleAgents);
    const primarySelectionAgents = React.useMemo(
        () => resolveComposerVisibleAgents(getPrimaryVisibleAgents()),
        [getPrimaryVisibleAgents, primarySelectionAgentsRaw],
    );
    const primaryProviderConfigLoading = useConfigStore((state) => (
        state.providerConfigLoadingByDirectory[state.activeDirectoryKey] === true
    ));
    const primaryAgentConfigLoading = useConfigStore((state) => (
        state.agentConfigLoadingByDirectory[state.activeDirectoryKey] === true
    ));
    const primarySelectionVariants = React.useMemo(() => {
        const provider = primarySelectionProviders.find((entry) => entry.id === primaryProviderID);
        const model = provider?.models?.find((entry) => entry.id === primaryModelID) as { variants?: unknown } | undefined;
        return resolveModelVariantKeys(model);
    }, [primaryModelID, primaryProviderID, primarySelectionProviders]);
    const fallbackDirectory = useDirectoryStore((s) => s.currentDirectory);
    const primaryDirectory = useEffectiveDirectory() ?? fallbackDirectory;
    const { ensureSessionRenderable } = useSync();
    const currentSessionDirectoryForSync = useSessionUIStore(
        React.useCallback((s) => primarySessionID ? s.getDirectoryForSession(primarySessionID) : null, [primarySessionID]),
    );
    // Primary owns session selection restore (ModelControls adapter path skips its own restore).
    const primarySessionMessages = useSessionMessages(
        primarySessionID ?? '',
        currentSessionDirectoryForSync ?? undefined,
    );
    const primaryLatestUserChoice = React.useMemo(
        () => parseLatestUserChoiceFromMessages(primarySessionMessages),
        [primarySessionMessages],
    );
    const primaryLatestExecution = React.useMemo(
        () => parseLatestAssistantExecutionFromMessages(primarySessionMessages),
        [primarySessionMessages],
    );
    const primaryTranscriptRenderable = useSessionMaterializationStatus(
        primarySessionID ?? '',
        currentSessionDirectoryForSync ?? undefined,
    ).renderable;
    // Per-session entity for restore cascade tier 3 (session-entity). Narrow
    // subscription: one session entry, not the full sessions array.
    const primarySessionEntity = useSession(
        primarySessionID,
        currentSessionDirectoryForSync ?? undefined,
    );
    const primarySessionEntityAgent = primarySessionEntity?.agent;
    const primarySessionEntityModelId = primarySessionEntity?.model?.id;
    const primarySessionEntityProviderId = primarySessionEntity?.model?.providerID;
    const primarySessionEntityVariant = primarySessionEntity?.model?.variant;
    const primaryConfigScopeKey = useConfigStore((state) => state.activeDirectoryKey);
    const primarySelectionEditRevisionRef = React.useRef(0);
    const primarySelectionPinnedHistoryIdRef = React.useRef<string | null>(null);
    const primarySessionRestoreKeyRef = React.useRef<string | null>(null);
    const newSessionDraft = useSessionUIStore((s) => s.newSessionDraft);
    const primaryNewSessionDraftOpen = Boolean(newSessionDraft?.open);
    const draftSubmitting = useSessionUIStore((s) => s.newSessionDraft.draftSubmitting ?? false);
    const draftEstablishing = useSessionUIStore((s) => s.newSessionDraft.draftEstablishing ?? false);
    // Establishing prelude + claimed submission both own the draft send surface.
    const draftBusy = draftSubmitting || draftEstablishing;
    const openNewSessionDraft = useSessionUIStore((s) => s.openNewSessionDraft);
    const setDraftPermissionAutoAcceptEnabled = useSessionUIStore((s) => s.setDraftPermissionAutoAcceptEnabled);
    const permissionAutoAccept = usePermissionStore((s) => s.autoAccept);
    const permissionAutoAcceptSaving = usePermissionStore((s) => s.saving);
    const setSessionAutoAccept = usePermissionStore((s) => s.setSessionAutoAccept);
    const setNewSessionDraftTarget = useSessionUIStore((s) => s.setNewSessionDraftTarget);
    const availableWorktreesByProject = useSessionUIStore((s) => s.availableWorktreesByProject);
    const abortPromptSessionId = useSessionUIStore((s) => s.abortPromptSessionId);
    const clearAbortPrompt = useSessionUIStore((s) => s.clearAbortPrompt);
    const consumePendingInputText = useInputStore((s) => s.consumePendingInputText);
    const pendingPresetSubmit = useInputStore((s) => s.pendingPresetSubmit);
    const pendingInputText = useInputStore((s) => s.pendingInputText);
    const pendingInputMode = useInputStore((s) => s.pendingInputMode);
    const consumePendingSyntheticParts = useInputStore((s) => s.consumePendingSyntheticParts);
    const activeAttachmentDraft = useInputStore((s) => s.activeAttachmentDraft);
    const primaryInlineDrafts = useInlineCommentDraftStore(React.useCallback((state) => {
        const sessionKey = primarySessionID ?? (primaryNewSessionDraftOpen ? 'draft' : '');
        // useSyncExternalStore requires a stable snapshot. A fresh `[]` on every
        // read looks like a store change and trips "Maximum update depth exceeded".
        return sessionKey ? state.drafts[sessionKey] ?? EMPTY_INLINE_DRAFTS : EMPTY_INLINE_DRAFTS;
    }, [primaryNewSessionDraftOpen, primarySessionID]));
    const primaryHistory = useUserMessageHistory(primarySessionID ?? '');
    const composerTransportIdentity = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeTransportIdentity, getRuntimeTransportIdentity);
    const attachmentDraftTransport = activeAttachmentDraft?.transportIdentity ?? null;
    const attachmentDraftOwnerKind = activeAttachmentDraft?.owner.kind ?? null;
    const attachmentDraftOwnerID = activeAttachmentDraft?.owner.ownerID ?? null;
    const primaryDraftKey = React.useMemo(() => createComposerDraftKey(
        composerTransportIdentity,
        primarySessionID,
        newSessionDraft.draftID,
        attachmentDraftTransport && attachmentDraftOwnerKind && attachmentDraftOwnerID
            ? { transportIdentity: attachmentDraftTransport, owner: { kind: attachmentDraftOwnerKind, ownerID: attachmentDraftOwnerID } }
            : null,
    ), [attachmentDraftOwnerID, attachmentDraftOwnerKind, attachmentDraftTransport, composerTransportIdentity, primarySessionID, newSessionDraft.draftID]);
    const primaryDraftKeyID = primaryDraftKey ? draftKeyString(primaryDraftKey) : null;
    const primaryAttachmentViewsMap = useInputStore(React.useCallback((state) => (
        primaryDraftKeyID ? state.draftAttachmentViews[primaryDraftKeyID] : undefined
    ), [primaryDraftKeyID]));
    const primaryDraftRecord = useInputStore(React.useCallback((state) => (
        primaryDraftKeyID ? state.drafts[primaryDraftKeyID] : undefined
    ), [primaryDraftKeyID]));
    const primaryAttachedFiles = React.useMemo(() => {
        if (!primaryDraftRecord || !primaryAttachmentViewsMap) return EMPTY_PRIMARY_ATTACHMENT_VIEWS;
        const ordered = primaryDraftRecord.attachments.flatMap((attachment) => {
            const view = primaryAttachmentViewsMap[attachment.attachmentRefID];
            return view ? [view] : [];
        });
        return ordered.length === 0 ? EMPTY_PRIMARY_ATTACHMENT_VIEWS : ordered;
    }, [primaryAttachmentViewsMap, primaryDraftRecord]);
    React.useEffect(() => {
        if (!primaryDraftKey) return;
        void useInputStore.getState().hydrateDraftAttachments(primaryDraftKey);
    }, [primaryDraftKey]);
    const surfaceContext = useChatInputSurfaceContext();
    const primarySurfaceActive = useUIStore((state) => state.activeMainTab === 'chat');
    // Authoritative session_status only (same contract as AssistantView). Double-ESC
    // abort must not depend on useSessionActivity heuristics (pending-assistant /
    // idleCoversPendingAssistant) or the status-row `working.canAbort` path, both of
    // which can lag after abort + re-send. Missing status is idle, never `unknown`.
    const primarySessionStatus = useSessionStatus(primarySessionID ?? '', primaryDirectory ?? undefined);
    const primarySurface = usePrimaryChatInputSurface({
        kind: 'primary',
        surfaceID: 'primary',
        active: primarySurfaceActive,
        sessionID: primarySessionID,
        directory: primaryDirectory ?? null,
        activity: {
            phase: primarySessionStatus?.type === 'busy'
                ? 'busy'
                : primarySessionStatus?.type === 'retry'
                    ? 'retry'
                    : 'idle',
            canAbort: primarySessionStatus?.type === 'busy' || primarySessionStatus?.type === 'retry',
        },
        draftKey: primaryDraftKey,
        transportIdentity: composerTransportIdentity,
        runtimeGeneration: getRuntimeGeneration(),
        selection: {
            value: {
                providerID: primaryProviderID,
                modelID: primaryModelID,
                agent: primaryAgentName,
                variant: primaryVariant,
            },
            // Primary still owns global config stores, but ModelControls always
            // consumes the surface selection adapter. Ship variants here so the
            // thinking/effort control stays available after adapter-only renders.
            catalog: {
                providers: primarySelectionProviders,
                agents: primarySelectionAgents,
                variants: primarySelectionVariants,
                variantsReady: !primaryProviderConfigLoading,
                ready: !primaryProviderConfigLoading && !primaryAgentConfigLoading,
                loading: primaryProviderConfigLoading || primaryAgentConfigLoading,
            },
            flush: async () => {
                const sessionId = useSessionUIStore.getState().currentSessionId;
                if (!sessionId) {
                    return;
                }
                const generationAtStart = getRuntimeGeneration();
                const transportAtStart = getRuntimeTransportIdentity();
                const editRevisionAtStart = primarySelectionEditRevisionRef.current;
                const sessionAtStart = sessionId;
                const sessionDirectoryAtStart =
                    useSessionUIStore.getState().getDirectoryForSession(sessionAtStart) ?? null;
                const expectedConfigKey = getConfigDirectoryKey(sessionDirectoryAtStart);

                // Activate the session's Project/config scope before restore so
                // send capture cannot read another Project's active config.
                if (useConfigStore.getState().activeDirectoryKey !== expectedConfigKey) {
                    await useConfigStore.getState().activateDirectory(sessionDirectoryAtStart);
                }

                if (
                    getRuntimeGeneration() !== generationAtStart
                    || getRuntimeTransportIdentity() !== transportAtStart
                    || useSessionUIStore.getState().currentSessionId !== sessionAtStart
                    || useConfigStore.getState().activeDirectoryKey !== expectedConfigKey
                    || primarySelectionEditRevisionRef.current !== editRevisionAtStart
                ) {
                    return;
                }

                await ensureSessionRenderable(sessionAtStart, {
                    directory: sessionDirectoryAtStart ?? undefined,
                });

                const sessionDirectoryAfter =
                    useSessionUIStore.getState().getDirectoryForSession(sessionAtStart) ?? null;
                const expectedConfigKeyAfter = getConfigDirectoryKey(sessionDirectoryAfter);
                if (
                    getRuntimeGeneration() !== generationAtStart
                    || getRuntimeTransportIdentity() !== transportAtStart
                    || useSessionUIStore.getState().currentSessionId !== sessionAtStart
                    || sessionDirectoryAfter !== sessionDirectoryAtStart
                    || expectedConfigKeyAfter !== expectedConfigKey
                    || useConfigStore.getState().activeDirectoryKey !== expectedConfigKey
                    || primarySelectionEditRevisionRef.current !== editRevisionAtStart
                ) {
                    return;
                }

                const config = useConfigStore.getState();
                const catalog = {
                    providers: config.providers,
                    agents: config.getVisibleAgents(),
                };
                if (catalog.providers.length === 0 || catalog.agents.length === 0) {
                    return;
                }

                const messages = getSyncMessages(sessionAtStart, sessionDirectoryAfter ?? undefined);
                const latestChoice = parseLatestUserChoiceFromMessages(messages);
                const latestExecution = parseLatestAssistantExecutionFromMessages(messages);
                if (shouldHoldPrimaryComposerUserPick({
                    editRevision: editRevisionAtStart,
                    pinnedHistoryMessageId: primarySelectionPinnedHistoryIdRef.current,
                    latestHistoryMessageId: latestChoice?.id ?? null,
                })) {
                    return;
                }
                const memory = useSelectionStore.getState();
                const sessionRow = getAllSyncSessionMap().get(sessionAtStart);
                const sessionEntity = sessionRow?.model
                    ? {
                        agent: sessionRow.agent,
                        model: {
                            id: sessionRow.model.id,
                            providerID: sessionRow.model.providerID,
                            variant: sessionRow.model.variant,
                        },
                    }
                    : (sessionRow?.agent ? { agent: sessionRow.agent } : null);
                const resolved = resolvePrimaryComposerSessionSelection({
                    sessionId: sessionAtStart,
                    latestUserChoice: latestChoice,
                    latestExecution,
                    catalog,
                    memory,
                    sessionEntity,
                    fallbackAgentName: config.currentAgentName,
                });
                if (!resolved) {
                    return;
                }

                const restoreKey = [
                    sessionAtStart,
                    resolved.source,
                    resolved.messageId ?? '',
                    resolved.agent ?? '',
                    resolved.providerID,
                    resolved.modelID,
                    resolved.variant ?? '',
                    expectedConfigKey,
                ].join('|');
                if (primarySessionRestoreKeyRef.current === restoreKey) {
                    return;
                }

                applyPrimaryComposerSessionRestore(resolved, {
                    currentAgentName: config.currentAgentName,
                    setAgent: config.setAgent,
                    setProvider: config.setProvider,
                    setModel: config.setModel,
                    setCurrentVariant: config.setCurrentVariant,
                }, {
                    sessionId: sessionAtStart,
                    memory,
                });
                primarySessionRestoreKeyRef.current = restoreKey;
            },
            change: async (selection) => {
                // Explicit user pick: bump edit revision so an in-flight flush
                // cannot overwrite the new choice after ensureSessionRenderable.
                // Pin the latest known history message id (null while loading) so
                // restore/flush keep this pick until a newer user message arrives.
                primarySelectionEditRevisionRef.current += 1;
                const sessionId = useSessionUIStore.getState().currentSessionId;
                if (sessionId) {
                    const directory = useSessionUIStore.getState().getDirectoryForSession(sessionId) ?? undefined;
                    const latestChoice = parseLatestUserChoiceFromMessages(getSyncMessages(sessionId, directory));
                    primarySelectionPinnedHistoryIdRef.current = latestChoice?.id ?? null;
                } else {
                    primarySelectionPinnedHistoryIdRef.current = null;
                }
                // setAgent re-applies agent-scoped model memory and would clobber an
                // explicit model pick if called after setModel. applyPrimaryComposer-
                // SelectionChange only switches agents when needed, then applies the
                // provider/model/variant and persists the choice for later restores.
                const config = useConfigStore.getState();
                applyPrimaryComposerSelectionChange(selection, {
                    currentAgentName: config.currentAgentName,
                    setAgent: config.setAgent,
                    setProvider: config.setProvider,
                    setModel: config.setModel,
                    setCurrentVariant: config.setCurrentVariant,
                    saveAgentModelSelection: config.saveAgentModelSelection,
                }, {
                    sessionId,
                    memory: useSelectionStore.getState(),
                });
            },
        },
        resources: {
            attachments: primaryAttachedFiles,
            addAttachment: async (file) => {
                if (!primaryDraftKey) return;
                await createDraftAttachmentResourceAdapter(primaryDraftKey, () => useInputStore.getState()).addLocal(file);
            },
            removeAttachment: async (id) => {
                if (!primaryDraftKey) return false;
                return createDraftAttachmentResourceAdapter(primaryDraftKey, () => useInputStore.getState()).removeByAttachmentID(id);
            },
            clearAttachments: async () => {
                if (!primaryDraftKey) return false;
                return createDraftAttachmentResourceAdapter(primaryDraftKey, () => useInputStore.getState()).clearRootAttachments();
            },
            restoreAttachments: async (attachments) => {
                if (!primaryDraftKey) return false;
                return createDraftAttachmentResourceAdapter(primaryDraftKey, () => useInputStore.getState()).restoreRootAttachments(attachments);
            },
            pendingInput: pendingInputText === null ? null : { text: pendingInputText, mode: pendingInputMode },
            consumePendingInput: consumePendingInputText,
            pendingPreset: pendingPresetSubmit,
            consumePendingPreset: () => useInputStore.getState().consumePendingPresetSubmit(),
            consumeSyntheticParts: consumePendingSyntheticParts,
            restoreSyntheticParts: (parts) => useInputStore.setState((state) => ({ pendingSyntheticParts: [...parts, ...(state.pendingSyntheticParts ?? [])] })),
            inlineDrafts: primaryInlineDrafts,
            removeInlineDraft: (id) => {
                const sessionKey = primarySessionID ?? (primaryNewSessionDraftOpen ? 'draft' : '');
                if (sessionKey) useInlineCommentDraftStore.getState().removeDraft(sessionKey, id);
            },
            restoreInlineDrafts: (drafts) => {
                const sessionKey = primarySessionID ?? (primaryNewSessionDraftOpen ? 'draft' : '');
                if (!sessionKey || drafts.length === 0) return;
                useInlineCommentDraftStore.setState((state) => {
                    const current = state.drafts[sessionKey] ?? [];
                    const restoredIDs = new Set(drafts.map((draft) => draft.id));
                    return { drafts: { ...state.drafts, [sessionKey]: [...drafts, ...current.filter((draft) => !restoredIDs.has(draft.id))] } };
                });
            },
            history: primaryHistory,
            captureRuntime: () => useInputStore.getState().captureDraftRuntime(),
            getDraft: (key) => useInputStore.getState().getDraft(key),
            abortPrompt: { sessionID: abortPromptSessionId, clear: clearAbortPrompt },
        },
        backend: {
            send: (request) => {
                // Reject stale runtime so restoreFailedSubmission can reinstate composer resources.
                assertDeliveryRequestRuntimeCurrent(request, {
                    transportIdentity: getRuntimeTransportIdentity(),
                    runtimeGeneration: getRuntimeGeneration(),
                });
                // Pin first-submit session/directory; draft (null) keeps materialization path.
                const sendOptions = primarySendOptionsFromDeliveryRequest(request);
                return primarySendMessage(
                    request.text ?? '',
                    request.providerID,
                    request.modelID,
                    request.agent,
                    request.attachments ?? [],
                    request.agentMention,
                    request.parts,
                    request.variant,
                    request.inputMode,
                    sendOptions,
                );
            },
            sendQueued: (request) => dispatchQueuedMessage(request.sessionID ?? '', { delivery: request.options?.delivery === 'steer' ? 'steer' : undefined, queueItemID: request.queueItemID, manual: request.manual, scope: request.queueScope ? { state: 'bound', ...request.queueScope } : undefined }),
            create: async () => openNewSessionDraft(),
            compact: async (request) => opencodeClient.summarizeSession(request.sessionID ?? '', request.providerID ?? '', request.modelID ?? '', request.directory),
            abort: (request) => {
                if (request.sessionID) promoteQueueHeadOnAbort(request.sessionID);
                return sessionActions.abortCurrentOperation(request.sessionID ?? '');
            },
        },
        shortcuts: {
            cycle: (direction) => primaryCycleAgentRef.current(direction),
            new: () => openNewSessionDraft(),
            abort: () => {
                if (primarySessionID) promoteQueueHeadOnAbort(primarySessionID);
                return sessionActions.abortCurrentOperation(primarySessionID ?? '');
            },
            submit: () => {},
        },
        deliveryTarget: { kind: 'primary' },
    });
    const surface = resolveChatInputSurface(primarySurface, surfaceProp ?? surfaceContext);
    assertChatInputSurfaceReady(surface);
    // Publish the mounted composer so global shortcuts (Ctrl+X chords, etc.)
    // target the same surface as the visible session UI — including Assistant.
    React.useLayoutEffect(() => {
        if (!surface.active) {
            clearActiveChatInputSurface(surface.surfaceID);
            return;
        }
        setActiveChatInputSurface(surface);
        return () => clearActiveChatInputSurface(surface.surfaceID);
    }, [surface]);
    const controllerWiring = createChatInputControllerWiring(surface);
    const surfaceResources = surface.resources ?? (surface.kind === 'primary' ? primarySurface.resources : undefined);
    if (!surfaceResources) {
        throw new Error('chat-input-surface-resources-incomplete');
    }
    const attachedFiles = [...surfaceResources.attachments];
    const currentSessionId = surface.sessionID;
    const resolvedDraftBusy = resolveChatInputDraftBusy(surface, draftBusy);
    const newSessionDraftOpen = surface.kind === 'secondary' ? surface.commands!.hasNewDraft : primaryNewSessionDraftOpen;
    const surfaceHasNewDraft = newSessionDraftOpen;
    const currentDirectory = surface.directory ?? primaryDirectory;
    const draftKey = surface.draftKey ?? primaryDraftKey;
    // Command availability is supplied explicitly to CommandAutocomplete via
    // the surface command context. Primary surfaces derive hasMessages and
    // hasNewDraft from the primary session store; secondary surfaces inject
    // their own context so the autocomplete never reads the primary session
    // store or messages to decide command eligibility.
    const commandContext = React.useMemo<CommandAutocompleteContext>(() => {
        if (surface.kind === 'secondary') {
            return resolveChatInputCommandContext(surface, false, false);
        }
        const primaryHasMessages = currentSessionId
            ? hasUserMessages(currentSessionId, currentSessionDirectoryForSync ?? undefined)
            : false;
        return resolveChatInputCommandContext(surface, primaryHasMessages, newSessionDraftOpen);
    }, [surface, currentSessionId, currentSessionDirectoryForSync, newSessionDraftOpen]);
    const sendMessage = (text: string, providerID: string, modelID: string, agent: string | undefined, attachments: readonly AttachedFile[], agentMention: string | undefined, parts: readonly { text: string; attachments?: readonly AttachedFile[]; synthetic?: boolean }[] | undefined, variant: string | undefined, inputMode: 'normal' | 'shell', options: {
        delivery?: string;
        commitStagedMessageEdit?: boolean;
        messageID?: string;
        ticket?: OptimisticSendTicket;
    }) => {
        if (!controllerWiring) return Promise.reject(new Error('chat-input-surface-incomplete'));
        return controllerWiring.send({ providerID, modelID, agent, variant, text, attachments, agentMention, parts, systemContext: parts?.filter((part) => part.synthetic).map((part) => ({ text: part.text, synthetic: true })), inputMode, options });
    };
    const abortCurrentOperation = React.useCallback(() => {
        if (!controllerWiring) return Promise.reject(new Error('chat-input-surface-incomplete'));
        return controllerWiring.abort();
    }, [controllerWiring]);
    const projects = useProjectsStore((state) => state.projects);
    const activeProjectId = useProjectsStore((state) => state.activeProjectId);
    const setActiveProjectIdOnly = useProjectsStore((state) => state.setActiveProjectIdOnly);
    const [reviewDialogOpen, setReviewDialogOpen] = React.useState(false);
    const [reviewFlowSubmitting, setReviewFlowSubmitting] = React.useState(false);
    const permissionAutoAcceptEnabled = React.useMemo(() => {
        if (!currentSessionId) {
            return newSessionDraft.permissionAutoAcceptEnabled === true;
        }
        return autoRespondsPermission({
            autoAccept: permissionAutoAccept,
            sessions: [],
            sessionById: getAllSyncSessionMap(),
            sessionID: currentSessionId,
        } as never);
    }, [currentSessionId, newSessionDraft.permissionAutoAcceptEnabled, permissionAutoAccept]);
    // Secondary/assistant composers already carry their scoped agent catalog and
    // selection. Reusing EMPTY_AGENTS + undefined here forced the permission
    // auto-accept control to stay visible even when the selected agent has a
    // global allow rule (the same case where primary chat hides the shield).
    const primaryConfiguredAgents = useConfigStore((state) => state.agents);
    const currentAgentName = surface.kind === 'secondary'
        ? surface.selection.value.agent
        : primaryAgentName;
    const configuredAgents = surface.kind === 'secondary'
        ? resolveComposerVisibleAgents(surface.selection.catalog?.agents)
        : primaryConfiguredAgents;
    const showPermissionAutoAcceptControl = isVSCodeRuntime()
        || shouldShowPermissionAutoAcceptControl(configuredAgents, currentAgentName);
    const handlePermissionAutoAcceptToggleFailed = React.useCallback(() => {
        toast.error(t('chat.chatInput.toast.togglePermissionAutoAcceptFailed'));
    }, [t]);

    const selectionValue = surface.selection.value;
    const selectionChange = surface.selection.change;
    const selectionCatalog = surface.selection.catalog;
    const modelControlsSelectionAdapter = React.useMemo(() => ({
        selection: {
            providerID: selectionValue.providerID ?? '',
            modelID: selectionValue.modelID ?? '',
            agent: selectionValue.agent ?? null,
            variant: selectionValue.variant,
        },
        onChange: async (selection: { providerID: string; modelID: string; agent: string | null; variant?: string }) => {
            if (!selectionChange) throw new Error('chat-input-surface-selection-readonly');
            await selectionChange({ ...selection, agent: selection.agent ?? undefined, variant: selection.variant });
        },
        disabled: !surface.active,
        catalog: selectionCatalog,
    }), [selectionCatalog, selectionChange, selectionValue.agent, selectionValue.modelID, selectionValue.providerID, selectionValue.variant, surface.active]);

    // Session switch drops a previous conversation's user-pick hold and restore key.
    React.useEffect(() => {
        primarySelectionEditRevisionRef.current = 0;
        primarySelectionPinnedHistoryIdRef.current = null;
        primarySessionRestoreKeyRef.current = null;
    }, [primarySessionID]);

    // Primary surface owns session selection restore while ModelControls uses the
    // adapter (which disables ModelControls' own history/memory restore path).
    React.useEffect(() => {
        if (surface.kind !== 'primary' || !primarySessionID) {
            return;
        }
        if (primaryProviderConfigLoading || primaryAgentConfigLoading) {
            return;
        }
        if (primarySelectionProviders.length === 0 || primarySelectionAgents.length === 0) {
            return;
        }

        // Wait until the active config scope matches this session's Project key.
        // Otherwise restore would write Project B session selection into Project A.
        const expectedConfigKey = getConfigDirectoryKey(currentSessionDirectoryForSync);
        if (primaryConfigScopeKey !== expectedConfigKey) {
            return;
        }

        const memory = useSelectionStore.getState();
        const catalog = {
            providers: primarySelectionProviders,
            agents: primarySelectionAgents,
        };
        if (shouldHoldPrimaryComposerUserPick({
            editRevision: primarySelectionEditRevisionRef.current,
            pinnedHistoryMessageId: primarySelectionPinnedHistoryIdRef.current,
            latestHistoryMessageId: primaryLatestUserChoice?.id ?? null,
        })) {
            return;
        }
        const sessionEntity =
            primarySessionEntityProviderId && primarySessionEntityModelId
                ? {
                    agent: primarySessionEntityAgent,
                    model: {
                        id: primarySessionEntityModelId,
                        providerID: primarySessionEntityProviderId,
                        variant: primarySessionEntityVariant,
                    },
                }
                : (primarySessionEntityAgent
                    ? { agent: primarySessionEntityAgent }
                    : null);
        const resolved = resolvePrimaryComposerSessionSelection({
            sessionId: primarySessionID,
            latestUserChoice: primaryLatestUserChoice,
            latestExecution: primaryLatestExecution,
            catalog,
            memory,
            sessionEntity,
            fallbackAgentName: primaryAgentName,
            transcriptReady: primaryTranscriptRenderable,
        });
        if (!resolved) {
            return;
        }

        const restoreKey = [
            primarySessionID,
            resolved.source,
            resolved.messageId ?? '',
            resolved.agent ?? '',
            resolved.providerID,
            resolved.modelID,
            resolved.variant ?? '',
            primaryConfigScopeKey,
        ].join('|');
        if (primarySessionRestoreKeyRef.current === restoreKey) {
            return;
        }

        // Skip re-applying when live config already matches (manual pick or prior restore).
        if (
            (resolved.agent === undefined || resolved.agent === primaryAgentName)
            && resolved.providerID === primaryProviderID
            && resolved.modelID === primaryModelID
            && resolved.variant === primaryVariant
        ) {
            primarySessionRestoreKeyRef.current = restoreKey;
            return;
        }

        // Re-check scope immediately before apply — activateDirectory may have raced.
        if (useConfigStore.getState().activeDirectoryKey !== expectedConfigKey) {
            return;
        }

        const config = useConfigStore.getState();
        applyPrimaryComposerSessionRestore(resolved, {
            currentAgentName: config.currentAgentName,
            setAgent: config.setAgent,
            setProvider: config.setProvider,
            setModel: config.setModel,
            setCurrentVariant: config.setCurrentVariant,
        }, {
            sessionId: primarySessionID,
            memory,
        });
        primarySessionRestoreKeyRef.current = restoreKey;
    }, [
        surface.kind,
        primarySessionID,
        primaryLatestUserChoice,
        primaryLatestExecution,
        primaryTranscriptRenderable,
        primarySelectionProviders,
        primarySelectionAgents,
        primaryProviderConfigLoading,
        primaryAgentConfigLoading,
        primaryConfigScopeKey,
        currentSessionDirectoryForSync,
        primaryAgentName,
        primaryProviderID,
        primaryModelID,
        primaryVariant,
        primarySessionEntityAgent,
        primarySessionEntityModelId,
        primarySessionEntityProviderId,
        primarySessionEntityVariant,
    ]);

    const getVisibleAgents = useConfigStore((state) => state.getVisibleAgents);
    const primaryAgents = surface.kind === 'primary' ? getVisibleAgents() : EMPTY_AGENTS;
    const primaryProviders = useConfigStore((state) => surface.kind === 'primary' ? state.providers : EMPTY_PROVIDERS);
    // Secondary catalogs may arrive raw from scoped queries; apply the same
    // visible-agent filter primary chat uses so title/summary never leak in.
    const agents = surface.kind === 'secondary'
        ? resolveComposerVisibleAgents(surface.selection.catalog?.agents)
        : primaryAgents;
    const providers = surface.kind === 'secondary' ? surface.selection.catalog?.providers ?? EMPTY_PROVIDERS : primaryProviders;
    const secondarySelectionUnavailable = surface.kind === 'secondary' && (
        !surface.selection.catalog?.ready || Boolean(surface.selection.catalog.error)
    );
    const mobileAgentControlsDisabled = !surface.active || !surface.selection.change || secondarySelectionUnavailable;
    const isMobile = useUIStore((state) => state.isMobile);
    const setImagePreviewOpen = useUIStore((state) => state.setImagePreviewOpen);
    const handleShowAttachmentPopup = React.useCallback((content: ToolPopupContent) => {
        if (!content.image) return;
        setAttachmentPopup(content);
        setImagePreviewOpen(true);
    }, [setImagePreviewOpen]);
    const handleAttachmentPopupChange = React.useCallback((open: boolean) => {
        setAttachmentPopup((current) => ({ ...current, open }));
        setImagePreviewOpen(open);
    }, [setImagePreviewOpen]);
    const isLeaderKeyPending = useLeaderKeyStore((state) => state.pending);
    const inputBarOffset = useUIStore((state) => state.inputBarOffset);
    const persistChatDraft = useUIStore((state) => state.persistChatDraft);
    const inputSpellcheckEnabled = useUIStore((state) => state.inputSpellcheckEnabled);
    const isExpandedInput = useUIStore((state) => state.isExpandedInput);
    const setExpandedInput = useUIStore((state) => state.setExpandedInput);
    const setTimelineDialogOpen = useUIStore((state) => state.setTimelineDialogOpen);
    const sessionTitles = new Map(Array.from(getAllSyncSessionMap(), ([id, session]) => [id, session.title || id]));
    const composer = useComposerController({ draftKey, sessionTitles, persistenceEnabled: persistChatDraft });
    const composerDocument = composer.document;
    const message = composerDocument.text;
    const { replacePlainDocument, replaceProgrammaticText, applyBrowserEdit, insertReference, deleteReference, enterHistoryPreview, exitHistoryPreview, captureSubmission, recoverSubmission, confirmedFileMentions, mentions: composerMentions } = composer;
    const applyProgrammaticEdit = React.useCallback((nextText: string, mentionsUpdater?: (mentions: readonly DraftMention[], document: ComposerDocument) => DraftMention[]) => replaceProgrammaticText(nextText, mentionsUpdater), [replaceProgrammaticText]);
    const confirmedFileMentionValues = React.useMemo(
        () => new Set(confirmedFileMentions.map((mention) => mention.value)),
        [confirmedFileMentions],
    );
    const textareaRef = React.useRef<HTMLTextAreaElement>(null);
    const nativeCompositionActiveRef = React.useRef(false);
    const cursorPosRef = React.useRef(0);
    const autocompleteTriggerRef = React.useRef<ComposerAutocompleteTrigger | null>(null);
    const previousMessageLengthRef = React.useRef(message.length);
    const dropZoneRef = React.useRef<HTMLDivElement>(null);
    const dragEnterCountRef = React.useRef(0);
    const suppressNextFileDropTextInsertRef = React.useRef(false);
    const suppressNextFileDropTextInsertTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const suppressNextFileMentionPasteRef = React.useRef(false);
    const suppressNextFileMentionPasteTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const pendingDroppedAbsolutePathsRef = React.useRef<string[]>([]);
    const canAcceptDropRef = React.useRef(false);
    const mentionRef = React.useRef<FileMentionHandle>(null);
    const pendingSessionReferenceRef = React.useRef(false);
    const commandRef = React.useRef<CommandAutocompleteHandle>(null);
    const skillRef = React.useRef<SkillAutocompleteHandle>(null);
    const snippetRef = React.useRef<SnippetAutocompleteHandle>(null);
    const messageRef = React.useRef(message);
    const pendingPastedAttachmentFilenamesRef = React.useRef<Set<string>>(new Set());
    const getDocument = composer.getDocument;
    const replaceWithConfirmedFileMentions = React.useCallback((nextText: string, paths: readonly string[], directoryPaths: readonly string[] = []) => applyProgrammaticEdit(nextText, (mentions, document) => {
        const additions: DraftMention[] = [];
        const directorySet = new Set(directoryPaths);
        for (const path of paths) {
            let from = 0;
            const token = `@${path}`;
            while (from < document.text.length) {
                const start = document.text.indexOf(token, from);
                if (start < 0) break;
                additions.push({
                    kind: directorySet.has(path) ? 'directory' : 'file',
                    value: path,
                    path,
                    label: path,
                    range: { start, end: start + token.length },
                });
                from = start + token.length;
            }
        }
        const seen = new Set(mentions.map((mention) => `${mention.kind}:${mention.value}:${mention.range.start}:${mention.range.end}`));
        return [...mentions, ...additions.filter((mention) => !seen.has(`${mention.kind}:${mention.value}:${mention.range.start}:${mention.range.end}`))];
    }), [applyProgrammaticEdit]);
    const sessionSurface = useSessionSurface();
    const sessionSurfaceActions = getSessionSurfaceActionAvailability(sessionSurface);
    const { git: runtimeGit, vscode: vscodeApi } = useRuntimeAPIs();
    const cycleAgentShortcutOverride = useUIStore((state) => state.shortcutOverrides.cycle_agent);
    const shortcutOverrides = useUIStore((state) => state.shortcutOverrides);
    const cycleAgentShortcut = React.useMemo(() => (
        getEffectiveShortcutCombo('cycle_agent', cycleAgentShortcutOverride ? { cycle_agent: cycleAgentShortcutOverride } : undefined)
    ), [cycleAgentShortcutOverride]);
    const clearAllMessagesShortcut = React.useMemo(
        () => getEffectiveShortcutCombo('clear_all_messages', shortcutOverrides),
        [shortcutOverrides],
    );
    const { currentTheme } = useThemeSystem();
    const chatSearchDirectory = useChatSearchDirectory();
    const isGitRepo = useIsGitRepo(currentDirectory);
    const currentGitStatus = useGitStore((state) =>
        currentDirectory ? state.directories.get(currentDirectory)?.status ?? null : null,
    );
    const ensureGitStatus = useGitStore((state) => state.ensureStatus);
    const fetchGitStatus = useGitStore((state) => state.fetchStatus);
    const [showAbortStatus, setShowAbortStatus] = React.useState(false);
    const composerHighlightRef = React.useRef<HTMLDivElement | null>(null);
    const [isNarrowComposer, setIsNarrowComposer] = React.useState(false);
    React.useEffect(() => {
        if (!currentDirectory || !runtimeGit) return;
        void ensureGitStatus(currentDirectory, runtimeGit);
    }, [currentDirectory, runtimeGit, ensureGitStatus]);

    React.useEffect(() => {
        if (!currentDirectory || !runtimeGit) return;
        return sessionEvents.onGitRefreshHint((hint) => {
            if (normalizePath(hint.directory) !== normalizePath(currentDirectory)) return;
            void fetchGitStatus(currentDirectory, runtimeGit);
        });
    }, [currentDirectory, runtimeGit, fetchGitStatus]);

    const handleStartReviewFlow = React.useCallback(async (execution: ReviewFlowExecution) => {
        if (!currentSessionId) return;
        const directory = useSessionUIStore.getState().getDirectoryForSession(currentSessionId) || currentDirectory || '';
        if (!directory) {
            toast.error(t('diffView.reviewDialog.toast.noSessionDirectory'));
            return;
        }

        setReviewFlowSubmitting(true);
        try {
            await startReviewFlow({
                originalSessionID: currentSessionId,
                directory,
                providerID: execution.providerID,
                modelID: execution.modelID,
                agent: execution.agent || undefined,
                variant: execution.variant || undefined,
                generateHandoff: execution.generateHandoff,
                returnAfterHandoffRequest: execution.generateHandoff,
                autoReview: execution.autoReview,
            });
            setReviewDialogOpen(false);
        } catch (error) {
            console.error('[review-flow] failed to start review flow', error);
            toast.error(error instanceof Error ? error.message : t('diffView.reviewDialog.toast.startFailed'));
        } finally {
            setReviewFlowSubmitting(false);
        }
    }, [currentSessionId, currentDirectory, t]);

    const isDesktopExpanded = isExpandedInput && !isMobile;
    // Mobile fullscreen composer (entered via the drag handle's swipe-up).
    const isMobileExpanded = isExpandedInput && isMobile;
    const isComposerExpanded = isDesktopExpanded || isMobileExpanded;
    // The queue/composer stack shares one soft silhouette across desktop and mobile.
    const chatInputRadius = '1.5rem';
    const useCompactChatPlaceholder = isMobile || isNarrowComposer;
    const composerPlaceholder = currentSessionId || newSessionDraftOpen
        ? inputMode === 'shell'
            ? t('chat.chatInput.placeholder.shell')
            : t(useCompactChatPlaceholder ? 'chat.chatInput.placeholder.chatCompact' : 'chat.chatInput.placeholder.chat')
        : t('chat.chatInput.placeholder.selectSession');
    const compactComposerPlaceholder = t('chat.chatInput.placeholder.compactTap');

    React.useEffect(() => {
        const element = dropZoneRef.current;
        if (!element) return;

        const updateWidth = (width: number) => {
            const next = width > 0 && width < COMPACT_CHAT_PLACEHOLDER_MAX_WIDTH;
            setIsNarrowComposer((prev) => (prev === next ? prev : next));
        };

        updateWidth(element.clientWidth);

        if (typeof ResizeObserver === 'undefined') {
            const handleResize = () => updateWidth(element.clientWidth);
            window.addEventListener('resize', handleResize);
            return () => window.removeEventListener('resize', handleResize);
        }

        const observer = new ResizeObserver((entries) => {
            updateWidth(entries[0]?.contentRect.width ?? element.clientWidth);
        });
        observer.observe(element);
        return () => observer.disconnect();
    }, []);

    const sendableAttachedFiles = attachedFiles;

    const knownAgentNames = React.useMemo(
        () => new Set(agents.map((agent) => agent.name.toLowerCase())),
        [agents]
    );
    const knownAgentNamesRef = React.useRef(knownAgentNames);
    knownAgentNamesRef.current = knownAgentNames;

    // Known slash-invocations (commands + skills + built-ins) used to highlight
    // matching /tokens in the composer, the same way confirmed @files are.
    const shouldLoadSlashDirectories = shouldEnableComposerSlashDirectoryQueries({
        inputMode,
        message,
        showCommandAutocomplete,
        showSkillAutocomplete,
    });
    const commandsQuery = useCommandsQuery({ directory: currentDirectory, enabled: shouldLoadSlashDirectories });
    const availableCommands = React.useMemo(() => commandsQuery.data ?? [], [commandsQuery.data]);
    const installedSkillsQuery = useInstalledSkillsQuery({ directory: currentDirectory, enabled: shouldLoadSlashDirectories });
    const availableSkills = React.useMemo(() => installedSkillsQuery.data ?? [], [installedSkillsQuery.data]);
    const availableSkillNames = React.useMemo(
        () => new Map(availableSkills.map((skill) => [skill.name.toLowerCase(), skill.name])),
        [availableSkills],
    );
    const knownSlashNames = React.useMemo(() => {
        const names = new Set<string>([
            'init', 'review', 'undo', 'redo', 'fork', 'timeline', 'model', 'compact', 'summary', 'workspace-review', 'plan-feature', 'craft-goal', 'goal', 'catch-up', 'debug', 'weigh', 'explore',
        ]);
        if (!isMobile && !isVSCodeRuntime()) names.add('handoff-review');
        for (const command of availableCommands) names.add(command.name.toLowerCase());
        for (const skill of availableSkills) names.add(skill.name.toLowerCase());
        return names;
    }, [availableCommands, availableSkills, isMobile]);

    // Known commands and installed skills use the shared reference color.
    const composerCommandRanges = React.useMemo<HighlightRange[]>(() => {
        if (!message || !message.includes('/') || inputMode === 'shell' || knownSlashNames.size === 0) {
            return [];
        }
        const ranges: HighlightRange[] = [];
        const slashRegex = new RegExp(`(^|\\s)/(${COMPOSER_TRIGGER_ICON_SLOT})?([A-Za-z0-9][A-Za-z0-9_-]*)`, 'g');
        let match: RegExpExecArray | null;
        while ((match = slashRegex.exec(message)) !== null) {
            const slot = match[2] ?? '';
            const name = match[3];
            if (!knownSlashNames.has(name.toLowerCase())) {
                continue;
            }
            const slashStart = match.index + match[1].length;
            const tokenLength = 1 + slot.length + name.length;
            const skillName = availableSkillNames.get(name.toLowerCase());
            ranges.push(skillName
                ? {
                    start: slashStart,
                    end: slashStart + tokenLength,
                    style: 'mentionCommand',
                    priority: 102,
                    skillName,
                    visual: composerTriggerIconVisual(
                        { trigger: '/', icon: 'book-open', label: skillName },
                        message.slice(slashStart, slashStart + tokenLength),
                    ),
                }
                : {
                    start: slashStart,
                    end: slashStart + tokenLength,
                    style: 'mentionCommand',
                    visual: composerTriggerIconVisual(
                        { trigger: '/', icon: 'command', label: name },
                        message.slice(slashStart, slashStart + tokenLength),
                    ),
                });
        }
        return ranges;
    }, [availableSkillNames, inputMode, knownSlashNames, message]);

    // Snippet triggers (#name / #alias). Highlighted like commands once the
    // trigger matches a known snippet name or alias.
    const availableSnippets = useSnippetsStore((s) => s.snippets);
    const knownSnippetTriggers = React.useMemo(() => {
        const triggers = new Set<string>();
        for (const snippet of availableSnippets) {
            triggers.add(snippet.name.toLowerCase());
            for (const alias of snippet.aliases ?? []) triggers.add(alias.toLowerCase());
        }
        return triggers;
    }, [availableSnippets]);

    const composerSnippetRanges = React.useMemo<HighlightRange[]>(() => {
        if (!message || !message.includes('#') || inputMode === 'shell' || knownSnippetTriggers.size === 0) {
            return [];
        }
        const ranges: HighlightRange[] = [];
        const snippetRegex = /(^|\s)#([A-Za-z0-9][A-Za-z0-9_-]*)/g;
        let match: RegExpExecArray | null;
        while ((match = snippetRegex.exec(message)) !== null) {
            const trigger = match[2];
            if (!knownSnippetTriggers.has(trigger.toLowerCase())) {
                continue;
            }
            const hashStart = match.index + match[1].length;
            ranges.push({ start: hashStart, end: hashStart + 1 + trigger.length, style: 'mentionSnippet' });
        }
        return ranges;
    }, [inputMode, knownSnippetTriggers, message]);

    // @mention spans use the shared reference color. Computed as character ranges
    // so they can be merged with markdown highlight ranges in a single overlay.
    const composerMentionRanges = React.useMemo<MentionRange[]>(() => {
        if (!message || !message.includes('@') || inputMode === 'shell') {
            return [];
        }
        return collectComposerMentionHighlights(message, {
            confirmedValues: confirmedFileMentionValues,
            agentNames: knownAgentNames,
        });
    }, [confirmedFileMentionValues, inputMode, knownAgentNames, message]);

    const attachmentCitationRanges = React.useMemo<HighlightRange[]>(() => {
        if (!message || !message.includes('[') || inputMode === 'shell' || sendableAttachedFiles.length === 0) {
            return [];
        }

        const inlineAttachments = sendableAttachedFiles.filter(isInlineAttachmentCitation);
        const attachmentIcons = new Map(inlineAttachments.map((file) => [
            file.filename.trim().toLowerCase(),
            file.mimeType.startsWith('image/') ? 'image' as const : 'attachment' as const,
        ]));
        return findAttachmentCitationRanges(
            message,
            inlineAttachments.map((file) => file.filename),
        ).flatMap((range) => {
            const attachmentName = stripComposerTriggerIconSlot(message.slice(range.start + 1, range.end - 1)).trim();
            const attachmentIcon = attachmentIcons.get(attachmentName.toLowerCase());
            return [
                {
                    ...range,
                    style: 'mentionFile' as const,
                    priority: 101,
                    visual: composerTriggerIconVisual(
                        {
                            trigger: '[',
                            icon: attachmentIcon === 'image' ? 'file-image' : 'attachment-2',
                            label: attachmentName,
                            suffix: ']',
                        },
                        message.slice(range.start, range.end),
                    ),
                },
            ];
        });
    }, [inputMode, message, sendableAttachedFiles]);

    // Combined source-mode highlight: markdown syntax + @mentions. Returns null
    // when there's nothing to highlight so the overlay stays off for plain text.
    const nativeComposerOwnedInput = canUseNativeIosComposer(isMobile) && surface.kind === 'primary';
    const highlightedComposerContent = React.useMemo(() => {
        if (!message || inputMode === 'shell') {
            return null;
        }
        const ranges = [
            ...(nativeComposerOwnedInput ? [] : tokenizeMarkdown(message)),
            ...(nativeComposerOwnedInput ? [] : highlightFencedCode(message)),
            ...mentionRangesToHighlightRanges(composerMentionRanges),
            ...composerCommandRanges,
            ...composerSnippetRanges,
            ...attachmentCitationRanges,
            // Authoritative reference decorations win over slash rescans so
            // reserved-slot skills/sessions keep their metric-safe icon placement.
            ...composerDocument.references.map((reference): HighlightRange => ({
                start: reference.start,
                end: reference.end,
                priority: 103,
                ...decorateComposerReference(reference),
            })),
        ];
        return buildHighlightParts(message, ranges);
    }, [attachmentCitationRanges, composerCommandRanges, composerSnippetRanges, composerMentionRanges, composerDocument.references, inputMode, message, nativeComposerOwnedInput]);

    const sanitizeAttachmentsForSend = React.useCallback(
        (files: AttachedFile[] | undefined): AttachedFile[] => (files ?? [])
            .map((file) => ({
                ...file,
                dataUrl: file.source === 'server' && file.serverPath
                    ? toServerFileUrl(file.serverPath)
                    : file.dataUrl,
            })),
        [],
    );

    const [autocompleteOverlayPosition, setAutocompleteOverlayPosition] = React.useState<AutocompleteOverlayPosition | null>(null);
    const abortTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    // Issue linking state
    const [issuePickerOpen, setIssuePickerOpen] = React.useState(false);
    const [prPickerOpen, setPrPickerOpen] = React.useState(false);
    const [linkedIssue, setLinkedIssue] = React.useState<{ 
        number: number; 
        title: string; 
        url: string; 
        contextText: string;
        author?: { login: string; avatarUrl?: string };
    } | null>(null);
    const [linkedPr, setLinkedPr] = React.useState<{
        number: number;
        title: string;
        url: string;
        head: string;
        base: string;
        includeDiff: boolean;
        instructionsText: string;
        contextText: string;
        author?: { login: string; avatarUrl?: string };
    } | null>(null);

    // Message queue
    const followUpBehavior = useMessageQueueStore((state) => state.followUpBehavior);
    const currentQueueScope = React.useMemo<(Extract<QueueScope, { state: 'bound' }> & { deliveryTarget: import('@/stores/messageQueueStore').QueueDeliveryTarget; runtimeGeneration: number }) | null>(() => {
        const scope = controllerWiring?.queueScope;
        return scope ? {
            state: 'bound',
            transportIdentity: scope.transportIdentity,
            directory: scope.directory,
            sessionID: scope.sessionID,
            deliveryTarget: scope.deliveryTarget,
            runtimeGeneration: scope.runtimeGeneration,
        } : null;
    }, [controllerWiring]);
    const serverQueue = useMessageQueueServerScope({
        transportIdentity: currentQueueScope?.transportIdentity ?? '',
        directory: currentQueueScope?.directory ?? '',
        sessionID: currentQueueScope?.sessionID ?? '',
    });
    const legacyQueue = React.useMemo(() => currentSessionId ? legacyQueueScope(currentSessionId) : null, [currentSessionId]);
    const boundQueuedMessages = useMessageQueueStore(
        React.useCallback(
            (state) => {
                return currentQueueScope ? getQueueForScope(state, currentQueueScope) : EMPTY_QUEUE;
            },
            [currentQueueScope]
        )
    );
    const legacyQueuedMessages = useMessageQueueStore(
        React.useCallback(
            (state) => {
                return legacyQueue ? getQueueForScope(state, legacyQueue) : EMPTY_QUEUE;
            },
            [legacyQueue]
        )
    );
    const legacyQueuedMessagesForScope = React.useMemo(() => {
        if (legacyQueuedMessages.length === 0) return boundQueuedMessages;
        if (boundQueuedMessages.length === 0) return legacyQueuedMessages;
        return [...legacyQueuedMessages, ...boundQueuedMessages];
    }, [boundQueuedMessages, legacyQueuedMessages]);
    const queuedMessages = serverQueue.mode === 'server' ? EMPTY_QUEUE : legacyQueuedMessagesForScope;
    const legacyPendingAdmissions = useMessageQueueStore(
        React.useCallback(
            (state) => (currentQueueScope ? getPendingAdmissionsForScope(state, currentQueueScope) : EMPTY_QUEUE),
            [currentQueueScope],
        ),
    );
    const clearQueue = useMessageQueueStore((state) => state.clearQueue);
    const removeFromQueue = useMessageQueueStore((state) => state.removeFromQueue);

    // Inline comment drafts are surface-owned, including secondary composer recovery.
    const inlineDrafts = surfaceResources.inlineDrafts;
    const hasDrafts = inlineDrafts.length > 0;
    const [previewConsoleCount, previewAnnotationCount, reviewCount] = React.useMemo(() => {
        let previewConsole = 0;
        let previewAnnotation = 0;
        let review = 0;
        for (const draft of inlineDrafts) {
            if (draft.source === 'preview-console') previewConsole += 1;
            else if (draft.source === 'preview-annotation') previewAnnotation += 1;
            else review += 1;
        }
        return [previewConsole, previewAnnotation, review];
    }, [inlineDrafts]);
    const removePreviewDrafts = React.useCallback((source: 'preview-console' | 'preview-annotation') => {
        for (const draft of surfaceResources.inlineDrafts) {
            if (draft.source === source) {
                surfaceResources.removeInlineDraft(draft.id);
            }
        }
    }, [surfaceResources]);
    // Review comments are the inline-comment drafts that aren't preview sources.
    const removeReviewDrafts = React.useCallback(() => {
        for (const draft of surfaceResources.inlineDrafts) {
            if (draft.source !== 'preview-console' && draft.source !== 'preview-annotation') {
                surfaceResources.removeInlineDraft(draft.id);
            }
        }
    }, [surfaceResources]);

    // User message history for up/down arrow navigation.
    // Keep this on a narrow hook instead of full session message records.
    const userMessageHistory = surfaceResources.history;

    // Keep messageRef in sync with message state
    React.useEffect(() => {
        messageRef.current = message;
    }, [message]);

    React.useLayoutEffect(() => {
        setInputMode('normal');
        setHistoryIndex(-1);
    }, [draftKey?.transportIdentity, draftKey?.owner.kind, draftKey?.owner.ownerID]);

    // Welcome/new-session drafts own desktop focus so every entry path (including
    // Cmd+N and restored drafts) lands in the composer after its DOM commits.
    React.useLayoutEffect(() => {
        if (!newSessionDraftOpen || isMobile) {
            return;
        }

        const focusDraftInput = () => {
            const textarea = textareaRef.current;
            if (!textarea || textarea.disabled) {
                return;
            }
            textarea.focus({ preventScroll: true });
        };

        focusDraftInput();
        const frame = window.requestAnimationFrame(focusDraftInput);
        return () => window.cancelAnimationFrame(frame);
    }, [newSessionDraftOpen, isMobile]);


    // Session activity for queue availability and controls
    // The explicit surface activity wins for embedded composers. The scoped
    // fallback preserves the primary chat mapping without reading global current
    // session activity from a secondary surface.
    const scopedActivity = useSessionActivity(
        surface.kind === 'primary' ? currentSessionId : null,
        surface.kind === 'primary' ? currentDirectory ?? undefined : undefined,
    );
    const sessionPhase = surface.activity?.phase ?? scopedActivity.phase;
    const autoReviewRunning = useAutoReviewStore(React.useCallback((state) => {
        if (!currentSessionId) return false;
        const run = state.runsByOriginalSessionID[currentSessionId];
        return run?.status === 'running' && run.runtimeKey === getRuntimeKey();
    }, [currentSessionId]));

    const handleOpenMobilePanel = useEvent((panel: MobileControlsPanel) => {
        if (!isMobile) {
            return;
        }
        // Set the panel state BEFORE blurring: the collapse watcher and the
        // overlay-host observer must already see the overlay as open when the
        // keyboard-close lands, otherwise the composer folds into the pill
        // under the sheet. Mark as action so a residual focus on the textarea
        // cannot re-expand / re-open the IME under the sheet.
        markComposerActionGesture();
        setMobileControlsPanel(panel);
        textareaRef.current?.blur();
        void useConfigStore.getState().refreshCatalogsOnPickerOpen({ source: 'chatInput:mobilePanel' });
    });

    // Consume pending input text (e.g., from revert action)
    const pendingInput = surfaceResources.pendingInput;
    const consumePendingInput = surfaceResources.consumePendingInput;
    React.useEffect(() => {
        if (pendingInput === null) return;
        const pending = consumePendingInput();
        if (!pending) return;
        if (pending.mode === 'append') {
            if (!pending.text.trim()) return;
            const result = appendWithLineBreaks(messageRef.current, pending.text);
            messageRef.current = result;
            applyProgrammaticEdit(result);
        } else if (pending.mode === 'append-inline') {
            const result = appendInlineText(messageRef.current, pending.text);
            messageRef.current = result;
            applyProgrammaticEdit(result);
        } else {
            replacePlainDocument(pending.text);
        }
        // Focus textarea after setting message
        setTimeout(() => {
            textareaRef.current?.focus();
        }, 0);
    }, [pendingInput, consumePendingInput, replacePlainDocument, applyProgrammaticEdit]);

    const hasContent = message.trim().length > 0 || sendableAttachedFiles.length > 0 || hasDrafts;
    const hasQueuedMessages = serverQueue.mode === 'server'
        ? serverQueue.items.length > 0
        : queuedMessages.length > 0 || legacyPendingAdmissions.length > 0;
    const queueFrozen = !queueModeAllowsMutations(serverQueue.mode);
    const canSend = hasContent || hasQueuedMessages;

    const stagedEditMessageId = useSessionUIStore(
        (s) => (s.stagedMessageEdit?.sessionId === currentSessionId ? s.stagedMessageEdit.messageId : null),
    );

    const sessionIsRunning = sessionPhase === 'busy' || sessionPhase === 'retry';
    const canAbort = surface.activity?.canAbort ?? sessionIsRunning;

    const getCurrentInputSnapshot = React.useCallback(() => {
        const textarea = textareaRef.current;
        const currentMessage = textarea?.value ?? getDocument().text;
        if (currentMessage !== getDocument().text) {
            applyBrowserEdit(currentMessage, textarea?.selectionStart ?? currentMessage.length, textarea?.selectionEnd ?? textarea?.selectionStart ?? currentMessage.length);
        }
        const document = getDocument();
        return {
            message: document.text,
            document,
            hasContent: document.text.trim().length > 0 || sendableAttachedFiles.length > 0 || hasDrafts,
        };
    }, [applyBrowserEdit, getDocument, hasDrafts, sendableAttachedFiles.length]);

    // Keep a ref to handleSubmit so callbacks don't depend on it.
    type SubmitOptions = {
        queuedOnly?: boolean;
        queuedMessageId?: string;
        delivery?: 'steer';
        /** Submit this text instead of the composer input. Used by preset
            starter chips: on mobile the collapsed pill has no mounted textarea,
            so the DOM-first input snapshot would read empty content. */
        presetText?: string;
    };
    const handleSubmitRef = React.useRef<(options?: SubmitOptions) => Promise<void>>(async () => {});
    // Submit flight lives in composer-send-manager, scoped by surface so primary
    // and secondary composers cannot block each other. Establishing follow-ups
    // may enqueue while the primary create+prompt flight is still held.
    const composerSendScopeKey = surface.surfaceID;
    const establishingDraftID = newSessionDraft?.draftID ?? null;
    const submissionFlightKind = useComposerSendStore(
        React.useMemo(() => selectComposerFlightKind(composerSendScopeKey), [composerSendScopeKey]),
    );
    const isComposerEstablishing = useComposerSendStore(
        React.useMemo(() => selectIsEstablishingDraft(establishingDraftID), [establishingDraftID]),
    );
    const sendPhase = React.useMemo(
        () => composerSendPhase(submissionFlightKind, isComposerEstablishing),
        [submissionFlightKind, isComposerEstablishing],
    );
    const beginSubmissionFlight = (kind: 'send' | 'queue' = 'send'): boolean => (
        useComposerSendStore.getState().beginFlight(composerSendScopeKey, kind)
    );
    const endSubmissionFlight = () => {
        useComposerSendStore.getState().endFlight(composerSendScopeKey);
    };
    // Authoritative at call time: event handlers must not read a render snapshot.
    const isSubmissionInFlight = (): boolean => (
        useComposerSendStore.getState().isInFlight(composerSendScopeKey)
    );

    // Edit restored the old text into the composer, so put the caret there too:
    // typing should continue without a second tap (mobile shares this node with the
    // pill, so this is also what raises the keyboard). Keyed on the staged row so
    // re-editing a different message re-focuses, but typing never steals focus back.
    const stagedEditFocusedRowRef = React.useRef<string | null>(null);
    React.useEffect(() => {
        if (surface.kind !== 'primary' || !stagedEditMessageId) {
            stagedEditFocusedRowRef.current = null;
            return;
        }
        if (stagedEditFocusedRowRef.current === stagedEditMessageId) return;
        stagedEditFocusedRowRef.current = stagedEditMessageId;
        if (nativeComposerOwnedInput) {
            void getNativeIosComposerPlugin().focus();
            return;
        }
        if (!focusComposerTextarea(textareaRef)) {
            // Staging can land a frame before the textarea is mounted/enabled.
            requestAnimationFrame(() => focusComposerTextarea(textareaRef));
        }
    }, [nativeComposerOwnedInput, stagedEditMessageId, surface.kind]);
    const establishingPendingItems = useComposerSendStore(
        React.useMemo(() => selectEstablishingPendingItems(establishingDraftID), [establishingDraftID]),
    );
    // New-session establishing: later sends become client pending-admission chips
    // (same "Queuing…" UI) and drain into the real session queue after materialize.
    const enqueueEstablishingFollowUpFromComposer = useEvent(async (): Promise<boolean> => {
        const draftID = useSessionUIStore.getState().newSessionDraft.draftID;
        if (!draftID || !useComposerSendStore.getState().isEstablishing(draftID)) return false;
        const inputSnapshot = getCurrentInputSnapshot();
        if (!inputSnapshot.hasContent) return false;
        const serialization = serializeComposerDocument(inputSnapshot.document, 'queue-canonical');
        if (!serialization.ok) {
            toast.error(t('chat.chatInput.toast.messageSendFailed'));
            return false;
        }
        await surface.selection.flush();
        if (!useComposerSendStore.getState().isEstablishing(draftID)) return false;
        const configState = useConfigStore.getState();
        const sendConfig = capturePrimaryComposerSendConfig(configState);
        if (!sendConfig?.providerID || !sendConfig?.modelID) {
            toast.error(t('chat.chatInput.toast.messageSendFailed'));
            return false;
        }
        const attachments = sanitizeAttachmentsForSend(sendableAttachedFiles);
        const staged = useComposerSendStore.getState().enqueueEstablishingFollowUp({
            draftID,
            content: serialization.text,
            sendConfig: {
                providerID: sendConfig.providerID,
                modelID: sendConfig.modelID,
                ...(sendConfig.agent ? { agent: sendConfig.agent } : {}),
                ...(sendConfig.variant ? { variant: sendConfig.variant } : {}),
            },
            attachments,
            composerDocument: inputSnapshot.document,
        });
        if (!staged) return false;
        replacePlainDocument('');
        setHistoryIndex(-1);
        setExpandedInput(false);
        if (attachments.length > 0) {
            void surfaceResources.clearAttachments();
        }
        return true;
    });
    /**
     * Single entry for every submit path (button, Enter, form, preset) while a
     * new-session create owns the draft. Returns true when the manager took the
     * submit, so callers stop instead of starting a second createWithPrompt.
     */
    const claimedByEstablishingFollowUp = (): boolean => {
        if (currentSessionId) return false;
        const draftID = useSessionUIStore.getState().newSessionDraft.draftID;
        if (!useComposerSendStore.getState().isEstablishing(draftID)) return false;
        void enqueueEstablishingFollowUpFromComposer();
        return true;
    };

    // Add message to queue instead of sending.
    // Server + legacy: after inputSnapshot/flight, stage a stable admission identity
    // and clear the composer synchronously before the first await (selection.flush).
    // Flush/runtime/scope/config/compile/admit failures unstage and restore via
    // submission capture; committed admits keep the empty composer.
    const handleQueueMessage = useEvent(async () => {
        if (!surface.active) return;
        if (isSubmissionInFlight()) return;
        // A staged edit routed through the queue still means "delete the old turn,
        // then send the new content": run the delete first so the queue item is the
        // replacement, not an extra message. A failed delete keeps the staged edit
        // and drops the admission instead of parking a stale delete for a later
        // unrelated send.
        if (currentSessionId) {
            const stagedBeforeQueue = useSessionUIStore.getState().stagedMessageEdit;
            if (stagedBeforeQueue && stagedBeforeQueue.sessionId === currentSessionId) {
                useSessionUIStore.getState().beginMessageEditCommit(stagedBeforeQueue.sessionId, stagedBeforeQueue.messageId);
                try {
                    await commitMessageEdit(stagedBeforeQueue.sessionId, stagedBeforeQueue.messageId);
                } catch (error) {
                    console.warn('[chat-input] staged-edit delete failed before queue admission', error);
                    return;
                } finally {
                    useSessionUIStore.getState().endMessageEditCommit(stagedBeforeQueue.sessionId, stagedBeforeQueue.messageId);
                }
                if (useSessionUIStore.getState().stagedMessageEdit === stagedBeforeQueue) {
                    useSessionUIStore.getState().clearStagedMessageEdit(stagedBeforeQueue.sessionId);
                }
            }
        }
        const inputSnapshot = getCurrentInputSnapshot();
        const initialSerialization = serializeComposerDocument(inputSnapshot.document);
        if (!initialSerialization.ok) { toast.error(t('chat.chatInput.toast.messageSendFailed')); return; }
        const initialPlan = { chunks: initialSerialization.chunks ?? [], semantics: initialSerialization.semantics ?? [] };
        const logicalMessage = initialSerialization.text;
        const normalizedCommand = logicalMessage.trimStart();
        const requestedCommandName = initialPlan.chunks.every((chunk) => chunk.provenance === 'authored') && inputMode === 'normal' && normalizedCommand.startsWith('/')
            ? stripLeadingSlashCommandSlot(normalizedCommand.slice(1).trim()).split(/\s+/)[0]?.toLowerCase()
            : undefined;
        if (requestedCommandName && !isCommandAllowedForSubmission(requestedCommandName, (command) => isChatInputCommandAllowed(surface, {
            name: command.name,
            source: 'openchamber',
        }))) return;
        if (submissionBlocked) return;
        if (!inputSnapshot.hasContent || !currentSessionId) return;
        // A running turn remains submit-capable while queue ownership is frozen.
        // Steer uses the captured session/runtime path and avoids an unsafe queue admit.
        // Release is not needed here: we never took a flight before this branch.
        if (queueFrozen || !assistantQueueAdmissionAvailable(surface.deliveryTarget?.kind, serverQueue.mode)) {
            void handleSubmitRef.current(sessionIsRunning ? { delivery: 'steer' } : undefined);
            return;
        }
        // Resource-preserving commands never optimistic-clear or stage a chip.
        const resourcePolicy = initialPlan.chunks.every((chunk) => chunk.provenance === 'authored') && preservesComposerResources(logicalMessage, inputMode);
        if (resourcePolicy) {
            void handleSubmitRef.current();
            return;
        }
        // Claim flight before the first await so button/keyboard re-entry is blocked.
        if (!beginSubmissionFlight('queue')) return;
        // Pin surface/runtime/scope/session before flush so runtime switch cannot
        // pair new sendConfig with the pre-switch composer surface.
        const surfaceTransportAtStart = surface.transportIdentity;
        const surfaceGenerationAtStart = surface.runtimeGeneration;
        const draftRuntimeAtStart = surfaceResources.captureRuntime();
        const queueScopeAtStart = currentQueueScope;
        const primaryQueueSessionIdAtStart = surface.kind === 'primary'
            ? (currentQueueScope?.sessionID ?? currentSessionId)
            : null;
        const drafts = [...surfaceResources.inlineDrafts].sort((a, b) => a.createdAt - b.createdAt);
        const documentToQueue = drafts.length > 0
            ? validateComposerDocument(appendInlineComments(inputSnapshot.document.text, drafts), inputSnapshot.document.references).document
            : inputSnapshot.document;
        const serialized = serializeComposerDocument(documentToQueue, 'queue-canonical');
        if (!serialized.ok) {
            endSubmissionFlight();
            toast.error(t('chat.chatInput.toast.messageSendFailed'));
            return;
        }
        const attachmentsToQueue = sanitizeAttachmentsForSend(sendableAttachedFiles);
        const queueSubmissionCapture = captureSubmission();
        const queueAttachmentSnapshot = attachmentsToQueue;
        // Pre-await optimistic stage + clear (server pending chip or legacy placeholder).
        const identity = createServerQueueAdmissionIdentity();
        let stagedServerAdmission = false;
        let stagedLegacyRequestID: string | null = null;
        const unstageOptimisticAdmission = () => {
            if (stagedServerAdmission && queueScopeAtStart) {
                serverQueue.actions.unstageAdmission({
                    requestID: identity.requestID,
                    scope: { directory: queueScopeAtStart.directory, sessionID: queueScopeAtStart.sessionID },
                });
                stagedServerAdmission = false;
            }
            if (stagedLegacyRequestID && queueScopeAtStart) {
                // Ephemeral marker only — never a durable QueueItemStatus row.
                useMessageQueueStore.getState().unstageAdmission(queueScopeAtStart, stagedLegacyRequestID);
                stagedLegacyRequestID = null;
            }
        };
        const restoreQueueComposer = async (assistantSyntheticParts?: Parameters<typeof surfaceResources.restoreSyntheticParts>[0] | null) => {
            unstageOptimisticAdmission();
            if (queueSubmissionCapture) recoverSubmission(queueSubmissionCapture);
            if (queueAttachmentSnapshot.length > 0) {
                await surfaceResources.restoreAttachments(queueAttachmentSnapshot);
            }
            if (assistantSyntheticParts) surfaceResources.restoreSyntheticParts(assistantSyntheticParts);
            if (drafts.length > 0) surfaceResources.restoreInlineDrafts(drafts);
        };
        try {
            if (!queueScopeAtStart) {
                toast.error(t('chat.chatInput.toast.messageSendFailed'));
                return;
            }
            if (serverQueue.mode === 'server') {
                if (!draftKey) {
                    toast.error(t('chat.chatInput.toast.messageSendFailed'));
                    return;
                }
                beginQueueAdmissionOptimisticClear({
                    stage: () => {
                        serverQueue.actions.stageAdmission({
                            requestID: identity.requestID,
                            scope: { directory: queueScopeAtStart.directory, sessionID: queueScopeAtStart.sessionID },
                            item: {
                                queueItemID: identity.queueItemID,
                                operationID: identity.operationID,
                                messageID: identity.messageID,
                                content: serialized.text,
                                createdAt: identity.createdAt,
                                attachmentCount: attachmentsToQueue.length,
                                composerDocument: documentToQueue,
                                composerMentions,
                            },
                        });
                        stagedServerAdmission = true;
                    },
                    clearComposer: () => {
                        replacePlainDocument('');
                        setHistoryIndex(-1);
                        setExpandedInput(false);
                    },
                });
            } else {
                // Legacy: ephemeral pending-admission chip before await (not durable ledger).
                beginQueueAdmissionOptimisticClear({
                    stage: () => {
                        useMessageQueueStore.getState().bindLegacyQueue(legacyQueueScope(queueScopeAtStart.sessionID), queueScopeAtStart);
                        useMessageQueueStore.getState().stageAdmission(queueScopeAtStart, {
                            requestID: identity.requestID,
                            queueItemID: identity.queueItemID,
                            operationID: identity.operationID,
                            messageID: identity.messageID,
                            content: serialized.text,
                            createdAt: identity.createdAt,
                            attachmentCount: attachmentsToQueue.length,
                            composerDocument: documentToQueue,
                            composerMentions,
                        });
                        stagedLegacyRequestID = identity.requestID;
                    },
                    clearComposer: () => {
                        replacePlainDocument('');
                        setHistoryIndex(-1);
                        setExpandedInput(false);
                    },
                });
            }

            await surface.selection.flush();
            if (!isQueueAdmissionRuntimeCurrent(
                { transportIdentity: surfaceTransportAtStart, generation: surfaceGenerationAtStart },
                { transportIdentity: getRuntimeTransportIdentity(), generation: getRuntimeGeneration() },
            )) {
                await restoreQueueComposer();
                return;
            }
            if (!isQueueAdmissionRuntimeCurrent(draftRuntimeAtStart, surfaceResources.captureRuntime())) {
                await restoreQueueComposer();
                return;
            }
            if (
                primaryQueueSessionIdAtStart
                && useSessionUIStore.getState().currentSessionId !== primaryQueueSessionIdAtStart
            ) {
                await restoreQueueComposer();
                return;
            }
            // Re-check scope against live transport + primary session directory (not render-closed values).
            if (
                queueScopeAtStart.transportIdentity !== getRuntimeTransportIdentity()
                || queueScopeAtStart.runtimeGeneration !== getRuntimeGeneration()
                || queueScopeAtStart.sessionID !== (primaryQueueSessionIdAtStart ?? queueScopeAtStart.sessionID)
                || (
                    primaryQueueSessionIdAtStart
                    // Both sides name the same directory through different stores: the live
                    // one is `normalizePath`-ed, the scope carries the server spelling. On
                    // Windows those differ by separator alone, so a raw compare declared
                    // every admission stale and handed the message back to the composer.
                    && normalizeDirectoryKey(useSessionUIStore.getState().getDirectoryForSession(primaryQueueSessionIdAtStart)) !== normalizeDirectoryKey(queueScopeAtStart.directory)
                )
            ) {
                await restoreQueueComposer();
                return;
            }
            const scope = queueScopeAtStart;
            // Primary must read live config after flush (React selection.value can be stale).
            // Scope-check so activateDirectory failure cannot capture another Project's config.
            const sendConfig = surface.kind === 'primary'
                ? (() => {
                    const configState = useConfigStore.getState();
                    const sessionDirectory = primaryQueueSessionIdAtStart
                        ? (useSessionUIStore.getState().getDirectoryForSession(primaryQueueSessionIdAtStart) ?? null)
                        : null;
                    return capturePrimaryComposerSendConfig(configState, {
                        expectedConfigKey: getConfigDirectoryKey(sessionDirectory),
                        activeDirectoryKey: configState.activeDirectoryKey,
                    });
                })()
                : (surface.selection.value.providerID && surface.selection.value.modelID
                    ? { ...surface.selection.value, providerID: surface.selection.value.providerID, modelID: surface.selection.value.modelID }
                    : undefined);
            // New queue admission requires a complete sendConfig; keep composer resources.
            if (!isCompleteQueueSendConfig(sendConfig)) {
                await restoreQueueComposer();
                return;
            }

            if (serverQueue.mode === 'server') {
                if (!draftKey) {
                    await restoreQueueComposer();
                    toast.error(t('chat.chatInput.toast.messageSendFailed'));
                    return;
                }
                const admissionCapture = createServerQueueAdmissionCapture({
                    draftKey,
                    runtime: draftRuntimeAtStart,
                    document: inputSnapshot.document,
                    attachments: sendableAttachedFiles,
                    inlineDrafts: drafts,
                });
                const assistantSyntheticParts = scope.deliveryTarget.kind === 'assistant'
                    ? surfaceResources.consumeSyntheticParts()?.map((part) => ({ ...part, partID: part.partID ?? createUuid() })) ?? null
                    : null;
                let attachmentCandidates;
                let assistantCompiledAttachments: typeof attachmentsToQueue = [];
                const assistantDeliveryParts = scope.deliveryTarget.kind === 'assistant'
                    ? (() => {
                        const compiled = compileChatComposerDelivery({
                            plan: { chunks: serialized.chunks ?? [], semantics: serialized.semantics ?? [] },
                            agents,
                            installedSkillNames: new Set(readInstalledSkillsSnapshot(queryClient, currentDirectory).map((skill) => skill.name)),
                            directory: currentDirectory,
                            root: chatSearchDirectory || currentDirectory,
                            confirmedFilePaths: confirmedFileMentions.map((mention) => mention.path),
                            confirmedDirectoryPaths: confirmedFileMentions.filter((mention) => mention.kind === 'directory').map((mention) => mention.path),
                            citationAttachments: sendableAttachedFiles,
                        });
                        assistantCompiledAttachments = compiled.attachments;
                        return buildAssistantQueueDeliveryParts({
                            text: drafts.length > 0 ? appendInlineComments(compiled.text, drafts) : compiled.text,
                            attachments: [...attachmentsToQueue, ...compiled.attachments],
                            semanticParts: buildComposerSemanticParts(compiled.semantics, scope.directory),
                            syntheticParts: assistantSyntheticParts,
                        });
                    })()
                    : undefined;
                try {
                    const candidates = [
                        ...attachedFilesToQueueCandidates(attachmentsToQueue),
                        ...attachedFilesToQueueCandidates(assistantCompiledAttachments),
                        ...(assistantSyntheticParts ?? []).flatMap((part) => attachedFilesToQueueCandidates(part.attachments ?? [], part.partID)),
                    ];
                    const referencedAttachmentIDs = assistantDeliveryParts ? new Set(assistantDeliveryParts.flatMap((part) => part.type === 'file' ? [part.attachmentID] : [])) : null;
                    attachmentCandidates = candidates.filter((candidate, index) => candidates.findIndex((entry) => entry.attachmentID === candidate.attachmentID) === index && (!referencedAttachmentIDs || referencedAttachmentIDs.has(candidate.attachmentID)));
                } catch (error) {
                    await restoreQueueComposer(assistantSyntheticParts);
                    toast.error(t(error instanceof RangeError ? 'chat.chatInput.toast.attachmentsTooLarge' : 'chat.chatInput.toast.messageSendFailed'));
                    return;
                }
                const assistantSyntheticSidecar = assistantDeliveryParts && assistantSyntheticParts
                    ? buildAssistantQueueSyntheticSidecar(assistantDeliveryParts, assistantSyntheticParts.map((part) => ({ ...part, partID: part.partID })))
                    : undefined;
                try {
                    let admitCommitted = false;
                    const result = await admitServerQueueMessageAndConsumeResources({
                        capture: admissionCapture,
                        admit: async () => {
                            // Reuse the same identity staged before the first await.
                            const admission = await serverQueue.actions.admit({
                                requestID: identity.requestID,
                                scope: { directory: scope.directory, sessionID: scope.sessionID },
                                item: {
                                    queueItemID: identity.queueItemID,
                                    operationID: identity.operationID,
                                    messageID: identity.messageID,
                                    content: serialized.text,
                                    composerDocument: documentToQueue,
                                    composerMentions,
                                    sendConfig,
                                    deliveryTarget: scope.deliveryTarget,
                                    ...(assistantDeliveryParts ? { deliveryParts: assistantDeliveryParts } : {}),
                                    ...(assistantSyntheticSidecar ? { syntheticParts: assistantSyntheticSidecar } : {}),
                                    attachmentIssues: [],
                                    createdAt: identity.createdAt,
                                },
                                attachments: attachmentCandidates,
                            });
                            if (admission.status === 'committed') {
                                admitCommitted = true;
                                stagedServerAdmission = false;
                            }
                            return admission;
                        },
                        captureRuntime: surfaceResources.captureRuntime,
                        getCurrentDraftKey: () => draftKey,
                        getDocument,
                        // Body already cleared; helper no-ops when fingerprint drifted.
                        consumeBody: () => replacePlainDocument(''),
                        getAttachments: () => surfaceResources.attachments,
                        removeAttachment: surfaceResources.removeAttachment,
                        getInlineDrafts: () => surfaceResources.inlineDrafts,
                        removeInlineDraft: surfaceResources.removeInlineDraft,
                    });
                    if (!admitCommitted) {
                        await restoreQueueComposer(assistantSyntheticParts);
                        if (result.status === 'stale') {
                            toast.error(t('chat.chatInput.toast.messageSendFailed'));
                        }
                        return;
                    }
                    // partial = queue committed but composer attachment cleanup incomplete
                    if (result.status === 'partial') {
                        toast.error(t('chat.chatInput.toast.messageSendFailed'));
                        return;
                    }
                    if (result.status === 'committed' && !isMobile) textareaRef.current?.focus();
                } catch (error) {
                    await restoreQueueComposer(assistantSyntheticParts);
                    toast.error(t(error instanceof RangeError ? 'chat.chatInput.toast.attachmentsTooLarge' : 'chat.chatInput.toast.messageSendFailed'));
                }
                return;
            }
            // Primary-only legacy queue path. Assistant is handled above.
            // Promote the staged pending chip into a durable queued row with sendConfig.
            const confirmed = useMessageQueueStore.getState().confirmAdmission(scope, {
                requestID: identity.requestID,
                sendConfig,
                attachments: attachmentsToQueue.length > 0 ? attachmentsToQueue : undefined,
            });
            if (!confirmed.ok) {
                await restoreQueueComposer();
                toast.error(t('chat.chatInput.toast.messageSendFailed'));
                return;
            }
            stagedLegacyRequestID = null;
            // Consume inline drafts/attachments now that the row is confirmed.
            for (const draft of drafts) {
                surfaceResources.removeInlineDraft(draft.id);
            }
            if (attachmentsToQueue.length > 0) void surfaceResources.clearAttachments();
            if (!isMobile) {
                textareaRef.current?.focus();
            }
        } catch (error) {
            await restoreQueueComposer();
            toast.error(t(error instanceof RangeError ? 'chat.chatInput.toast.attachmentsTooLarge' : 'chat.chatInput.toast.messageSendFailed'));
        } finally {
            endSubmissionFlight();
        }
    });

    // Stable fire-and-forget entry for queue admission. Keeps internal toasts;
    // outer toast only for leaked rejections (restoreQueueComposer etc.).
    const queueMessageFromEvent = useEvent(() => {
        void runQueueMessageFireAndForget(
            () => handleQueueMessage(),
            () => {
                toast.error(t('chat.chatInput.toast.messageSendFailed'));
            },
        );
    });

    const handleQueuedMessageEdit = useEvent(async (content: string, attachments?: QueuedMessage['attachments'], composerDocument?: QueuedMessage['composerDocument'], composerMentions?: QueuedMessage['composerMentions']): Promise<boolean> => {
        if (queueFrozen || !surface.draftKey) return false;
        try {
            const payload = await buildQueueComposerRestoration({
                content,
                composerDocument,
                composerMentions,
                attachments,
            });
            const input = useInputStore.getState();
            const current = input.getDraft(surface.draftKey!);
            const committed = await commitComposerRestoration({
                key: surface.draftKey!,
                expectedRevision: current?.revision ?? 'absent',
                payload,
                runtime: input.captureDraftRuntime(),
            });
            // User action: require committed + current; durable-stale alone must not pop the queue item.
            if (!shouldRemoveQueueItemAfterEditCommit(committed)) {
                toast.error(t('chat.chatInput.toast.messageSendFailed'));
                return false;
            }
            // Focus is owned by QueuedMessageChips onEditCommitted after restore succeeds.
            return true;
        } catch {
            toast.error(t('chat.chatInput.toast.messageSendFailed'));
            return false;
        }
    });

    const handleQueuedMessageSend = useEvent((messageId: string) => {
        if (submissionBlocked || queueFrozen) return;
        if (controllerWiring) {
            void controllerWiring.sendQueued(messageId, { options: { delivery: 'steer' }, manual: true });
            return;
        }
        toast.error(t('chat.chatInput.toast.messageSendFailed'));
    });

    const handleOpenAgentPanel = useEvent(() => {
        markComposerActionGesture();
        setMobileControlsPanel('agent');
        textareaRef.current?.blur();
        void useConfigStore.getState().refreshCatalogsOnPickerOpen({ source: 'chatInput:mobileAgentPanel' });
    });

    const openIssuePicker = React.useCallback(() => {
        setIssuePickerOpen(true);
    }, []);

    const openPrPicker = React.useCallback(() => {
        setPrPickerOpen(true);
    }, []);

    const handleSubmit = async (options?: SubmitOptions) => {
        if (!surface.active) return;
        if (submissionBlocked) return;
        // Establishing owns the draft: stage a follow-up chip before the flight
        // gate below, which the in-progress create+prompt still holds.
        if (claimedByEstablishingFollowUp()) return;
        // Component-level flight: ignore every entry while a submit is in progress.
        if (isSubmissionInFlight()) return;
        const queuedOnly = options?.queuedOnly ?? false;
        const queuedMessageId = options?.queuedMessageId;
        const delivery = options?.delivery === 'steer' && sessionIsRunning ? 'steer' : undefined;
        const inputSnapshot = options?.presetText != null
            ? {
                message: options.presetText,
                document: { text: options.presetText, references: [] },
                hasContent: options.presetText.trim().length > 0 || sendableAttachedFiles.length > 0 || hasDrafts,
            }
            : getCurrentInputSnapshot();
        const submissionCapture = options?.presetText == null ? captureSubmission() : null;
        const inputAttachmentsSnapshot = attachedFiles;
        const serializedInput = serializeComposerDocument(inputSnapshot.document, 'direct-send-display');
        if (!serializedInput.ok) { toast.error(t('chat.chatInput.toast.messageSendFailed')); return; }
        const logicalInputMessage = serializedInput.text;
        const directPlan = { chunks: serializedInput.chunks ?? [], semantics: serializedInput.semantics ?? [] };
        const directInputIsAuthored = directPlan.chunks.every((chunk) => chunk.provenance === 'authored');
        const normalizedInput = logicalInputMessage.trimStart();
        const localCommand = directInputIsAuthored ? getLocalChatCommand(normalizedInput, inputMode) : null;
        const resourcePolicy = directInputIsAuthored && preservesComposerResources(logicalInputMessage, inputMode);
        const isModelCommand = directInputIsAuthored && inputMode === 'normal' && /^\/model(?:\s|$)/i.test(normalizedInput);
        const requestedCommandName = directInputIsAuthored && inputMode === 'normal' && normalizedInput.startsWith('/')
            ? stripLeadingSlashCommandSlot(normalizedInput.slice(1).trim()).split(/\s+/)[0]?.toLowerCase()
            : undefined;

        // Policy is resolved before model routing, queue admission, and every
        // resource-consuming local command. Rejection retains the full draft.
        if (requestedCommandName && !isCommandAllowedForSubmission(requestedCommandName, (command) => isChatInputCommandAllowed(surface, {
            name: command.name,
            source: 'openchamber',
        }))) {
            return;
        }

        if (queuedOnly && queueFrozen) return;

        if (!queuedOnly && isModelCommand) {
            setShowCommandAutocomplete(false);
            setCommandQuery('');

            if (isMobile) {
                handleOpenMobilePanel('model');
            } else {
                useUIStore.getState().setModelSelectorOpen(true);
                void useConfigStore.getState().refreshCatalogsOnPickerOpen({ source: 'chatInput:modelCommand' });
            }
            return;
        }
        if (!queuedOnly && localCommand && localCommand !== 'model') {
            // Local command handlers run below with their existing business actions.
        } else if (!queuedOnly && currentSessionId && hasQueuedMessages && queueFrozen) {
            return;
        } else if (!queuedOnly && currentSessionId && hasQueuedMessages && serverQueue.mode === 'server') {
            // No flight yet: queue path claims its own before its first await.
            if (inputSnapshot.hasContent) queueMessageFromEvent();
            return;
        } else if (!queuedOnly && currentSessionId && hasQueuedMessages) {
            if (inputSnapshot.hasContent) queueMessageFromEvent();
            const queuedHead = queuedMessages[0];
            if (queuedHead && controllerWiring) {
                await controllerWiring.sendQueued(queuedHead.queueItemID, { options: sessionIsRunning ? { delivery: 'steer' } : undefined });
            }
            return;
        }
        const queuedMessagesToSend = resourcePolicy ? [] : queuedMessageId
            ? queuedMessages.filter((message) => message.id === queuedMessageId)
            : queuedMessages;

        if (queuedOnly && autoReviewRunning) {
            return;
        }

        if (queuedOnly) {
            if (queuedMessagesToSend.length === 0 || !currentSessionId) return;
        } else if ((!inputSnapshot.hasContent && !hasQueuedMessages) || (!currentSessionId && !newSessionDraftOpen)) {
            return;
        }

        // Draft materialization already claimed elsewhere (legacy claim path with
        // no manager establishing): refuse instead of opening a second session.
        if (!currentSessionId && resolvedDraftBusy) return;

        // Claim flight before the first await so button/keyboard/preset re-entry is blocked.
        if (!beginSubmissionFlight()) return;
        // New-session create: open establishing before any await so later Enter/Send
        // can stage follow-up chips instead of being blocked by this flight.
        const establishingDraftIDAtSubmit = !currentSessionId && newSessionDraftOpen && !queuedOnly && !resourcePolicy
            ? (useSessionUIStore.getState().newSessionDraft.draftID ?? null)
            : null;
        const draftMessageID = establishingDraftIDAtSubmit
            ? ascendingId('msg')
            : undefined;
        if (establishingDraftIDAtSubmit && draftMessageID) {
            if (!useComposerSendStore.getState().beginEstablishing({
                draftID: establishingDraftIDAtSubmit,
                primaryMessageID: draftMessageID,
            })) {
                endSubmissionFlight();
                return;
            }
        }
        // Establishing spans the UI prelude (paint) and the manager claim. Both
        // are released together so a dropped create cannot strand either half.
        const abortEstablishing = (): void => {
            clearDraftEstablishingPaint();
            if (establishingDraftIDAtSubmit) {
                useComposerSendStore.getState().clearEstablishing(establishingDraftIDAtSubmit);
            }
        };
        // Land staged follow-ups into the materialized session queue, or clear
        // establishing when create never produced a session id.
        const drainOrClearEstablishingFollowUps = (draftID: string): void => {
            const sessionId = useSessionUIStore.getState().currentSessionId;
            const directory = (
                (sessionId ? useSessionUIStore.getState().getDirectoryForSession(sessionId) : null)
                ?? currentDirectory
                ?? ''
            );
            if (!sessionId || !directory) {
                useComposerSendStore.getState().clearEstablishing(draftID);
                return;
            }
            void drainEstablishingFollowUps({
                draftID,
                sessionID: sessionId,
                directory,
                transportIdentity: getRuntimeTransportIdentity(),
                runtimeGeneration: getRuntimeGeneration(),
                admitServer: serverQueue.mode === 'server'
                    ? async (item) => serverQueue.actions.admit({
                        requestID: item.requestID,
                        scope: { directory, sessionID: sessionId },
                        item: {
                            queueItemID: item.queueItemID,
                            operationID: item.operationID,
                            messageID: item.messageID,
                            content: item.content,
                            createdAt: item.createdAt,
                            sendConfig: item.sendConfig,
                            attachmentIssues: [],
                            ...(item.composerDocument ? { composerDocument: item.composerDocument } : {}),
                            ...(item.composerMentions ? { composerMentions: item.composerMentions } : {}),
                        },
                        attachments: item.attachments.length > 0
                            ? attachedFilesToQueueCandidates(item.attachments)
                            : undefined,
                    })
                    : undefined,
            });
        };
        // An auto-review run owns the turn and is not steerable, so a direct send
        // would be discarded by the runner. Queue instead: the queued-message
        // auto-send hook delivers it once the review finishes. This must happen
        // BEFORE the composer is cleared — handleQueueMessage reads the live
        // composer, and a cleared draft restored through recoverSubmission only
        // lands in the store on a later render, so the queue path would read an
        // empty composer and drop the message.
        if (currentSessionId && !queuedOnly && !resourcePolicy && autoReviewRunning) {
            endSubmissionFlight();
            queueMessageFromEvent();
            return;
        }
        // Direct messages leave the Composer before selection/configuration work
        // starts. The captured submission restores this exact draft if dispatch
        // cannot proceed. Local commands retain their existing resource policy.
        const clearedComposerBeforeDispatch = !queuedOnly && !resourcePolicy;
        if (clearedComposerBeforeDispatch) {
            replacePlainDocument('');
            setHistoryIndex(-1);
            setExpandedInput(false);
        }
        // When true, flight ownership transfers to sendPromise.finally (do not release in finally).
        let transferFlightToSendPromise = false;
        // Pre-await optimistic paint for an existing primary session (not secondary/queue/local-command).
        let optimisticTicket: OptimisticSendTicket | undefined;
        // Edit target painted as "editing" at submit time; released if we never dispatch.
        let messageEditCommitTarget: { sessionId: string; messageId: string } | undefined;
        let handedOptimisticToSendPromise = false;

        try {
        // Existing primary session ordinary send: paint user row + "sending message"
        // synchronously before selection.flush so the list does not wait on async work.
        // Incomplete provider/model snapshots skip the ticket (no fabricated display IDs).
        // Secondary surfaces keep their pending-row path and never create a primary ticket.
        // Shell skips tickets: routeMessage shell path does not settle/consume them.
        const shouldCreateOptimisticPrimarySend = shouldOptimisticPrimarySend({
            surfaceKind: surface.kind,
            currentSessionId,
            queuedOnly,
            resourcePolicy,
            inputMode,
            localCommand,
        });
        if (shouldCreateOptimisticPrimarySend && currentSessionId) {
            const sessionDirectoryForOptimistic =
                useSessionUIStore.getState().getDirectoryForSession(currentSessionId)
                ?? currentDirectory
                ?? null;
            // Staged edit: paint the target as "editing" instead of hiding it. The
            // transcript keeps every row it has until a remote delete confirms, so
            // the optimistic reply row and the pending edit never fight over it.
            const stagedEdit = useSessionUIStore.getState().stagedMessageEdit;
            if (stagedEdit && stagedEdit.sessionId === currentSessionId) {
                messageEditCommitTarget = { sessionId: stagedEdit.sessionId, messageId: stagedEdit.messageId };
                useSessionUIStore.getState().beginMessageEditCommit(stagedEdit.sessionId, stagedEdit.messageId);
            }
            const configState = useConfigStore.getState();
            const optimisticConfig = capturePrimaryComposerSendConfig(configState, {
                expectedConfigKey: getConfigDirectoryKey(sessionDirectoryForOptimistic),
                activeDirectoryKey: configState.activeDirectoryKey,
            });
            if (optimisticConfig?.providerID && optimisticConfig?.modelID) {
                const rootAttachments = sanitizeAttachmentsForSend(sendableAttachedFiles);
                optimisticTicket = sessionActions.beginOptimisticSend({
                    sessionId: currentSessionId,
                    directory: sessionDirectoryForOptimistic,
                    content: inputSnapshot.message,
                    providerID: optimisticConfig.providerID,
                    modelID: optimisticConfig.modelID,
                    agent: optimisticConfig.agent,
                    files: rootAttachments.map((attachment) => ({
                        type: 'file' as const,
                        mime: attachment.mimeType,
                        url: attachment.dataUrl,
                        filename: attachment.filename,
                    })),
                });
            }
        }

        // Primary: pin session before any await so A→B switch mid-flush aborts send.
        // Queued-only prefers the bound queue owner / first queued item owner when present.
        const primarySubmitSessionIdAtStart = surface.kind === 'primary'
            ? (() => {
                if (queuedOnly) {
                    const queuedOwner = queuedMessagesToSend[0]?.owner;
                    if (queuedOwner?.state === 'bound') return queuedOwner.sessionID;
                    if (queuedOwner?.state === 'unbound-legacy') return queuedOwner.sessionID;
                    if (currentQueueScope?.sessionID) return currentQueueScope.sessionID;
                }
                return currentSessionId;
            })()
            : null;
        const capturedSendConfig = queuedOnly ? queuedMessagesToSend[0]?.sendConfig : undefined;
        // Queued-only with a captured sendConfig already owns the selection; skip flush.
        if (!(queuedOnly && capturedSendConfig)) {
            await surface.selection.flush();
        }
        // Primary session must still be the one this handler started for.
        if (
            primarySubmitSessionIdAtStart !== null
            && useSessionUIStore.getState().currentSessionId !== primarySubmitSessionIdAtStart
        ) {
            return;
        }
        // Primary post-flush capture must use live config-store snapshot, not a
        // React closure over surface.selection.value. Queued captured sendConfig
        // stays authoritative (no live re-resolve). New-session draft (null id)
        // keeps draft active config without a session Project scope key.
        // Primary capture prefers the post-flush live config for the session
        // Project. Worktree→project lag can make expectedConfigKey GLOBAL while
        // activeDirectoryKey is still the parent project — capture returns
        // undefined even when the composer UI already has a model. Surface
        // selection is the user-visible truth and unblocks that silent path.
        const resolveSendConfig = async () => {
            let sendConfig = capturedSendConfig
                ? { ...capturedSendConfig }
                : surface.kind === 'primary'
                    ? (() => {
                        const configState = useConfigStore.getState();
                        if (!primarySubmitSessionIdAtStart) {
                            return resolvePrimaryComposerSendConfig({
                                captured: capturePrimaryComposerSendConfig(configState),
                                surfaceSelection: surface.selection.value,
                            });
                        }
                        const sessionDirectory = useSessionUIStore.getState().getDirectoryForSession(primarySubmitSessionIdAtStart)
                            ?? currentDirectory
                            ?? null;
                        return resolvePrimaryComposerSendConfig({
                            captured: capturePrimaryComposerSendConfig(configState, {
                                expectedConfigKey: getConfigDirectoryKey(sessionDirectory),
                                activeDirectoryKey: configState.activeDirectoryKey,
                            }),
                            surfaceSelection: surface.selection.value,
                        });
                    })()
                    : (surface.selection.value.providerID && surface.selection.value.modelID
                        ? { ...surface.selection.value, providerID: surface.selection.value.providerID, modelID: surface.selection.value.modelID }
                        : undefined);

            // One more activate+recapture when still incomplete — flush may have
            // no-op'd activateDirectory for an unresolved worktree path.
            if (
                surface.kind === 'primary'
                && primarySubmitSessionIdAtStart
                && (!sendConfig?.providerID || !sendConfig?.modelID)
            ) {
                const sessionDirectory = useSessionUIStore.getState().getDirectoryForSession(primarySubmitSessionIdAtStart)
                    ?? currentDirectory
                    ?? null;
                const expectedConfigKey = getConfigDirectoryKey(sessionDirectory);
                if (useConfigStore.getState().activeDirectoryKey !== expectedConfigKey) {
                    await useConfigStore.getState().activateDirectory(sessionDirectory);
                }
                if (
                    useSessionUIStore.getState().currentSessionId === primarySubmitSessionIdAtStart
                ) {
                    const configState = useConfigStore.getState();
                    sendConfig = resolvePrimaryComposerSendConfig({
                        captured: capturePrimaryComposerSendConfig(configState, {
                            expectedConfigKey: getConfigDirectoryKey(sessionDirectory),
                            activeDirectoryKey: configState.activeDirectoryKey,
                        }),
                        surfaceSelection: surface.selection.value,
                    });
                }
            }

            return sendConfig;
        };

        let sendConfig = await resolveSendConfig();
        let providerRefreshAttempted = false;

        let providerIdToSend = sendConfig?.providerID;
        let modelIdToSend = sendConfig?.modelID;
        let agentNameToSend = sendConfig?.agent;
        let variantToSend = sendConfig?.variant;

        if (!providerIdToSend || !modelIdToSend) {
            // Recovery: the provider catalog may have failed to load (or was cached
            // empty), leaving no selectable model. Force a refresh once and re-resolve
            // before declaring the send a failure — a healthy catalog should not strand
            // every following message.
            if (!providerRefreshAttempted) {
                providerRefreshAttempted = true;
                try {
                    await useConfigStore.getState().loadProviders({ forceRefresh: true, source: 'chat-input-send-recovery' });
                    sendConfig = await resolveSendConfig();
                    providerIdToSend = sendConfig?.providerID;
                    modelIdToSend = sendConfig?.modelID;
                    agentNameToSend = sendConfig?.agent;
                    variantToSend = sendConfig?.variant;
                } catch {
                    // loadProviders swallows errors; an unexpected throw still fails the send.
                }
            }

            if (!providerIdToSend || !modelIdToSend) {
                console.warn('Cannot send message: provider or model not selected');
                // Previously only console.warn'd after clearing the composer — draft
                // recovered in finally with no toast, so Send appeared broken.
                toast.error(t('chat.chatInput.toast.messageSendFailed'));
                return;
            }
        }

        // Sending is authoritative: if a question prompt is open, dismiss it
        // so the prompt cannot linger or strand the session. The dismiss clears
        // the card instantly (optimistic) and formally rejects the question.
        // Rejecting unblocks the agent's tool but does NOT end its turn, and a
        // prompt that arrives while the run is still active is discarded by the
        // OpenCode runner — so abort the rejected turn to reach idle and then
        // keep going down this same send. The message must never be handed to
        // the queue here: this submission already owns its payload
        // (inputSnapshot), while the queue path re-reads the composer we just
        // cleared and would silently admit nothing.
        if (currentSessionId && !queuedOnly && !resourcePolicy) {
            const dismissedQuestions = await sessionActions.dismissOpenQuestionsForSession(currentSessionId);
            if (dismissedQuestions) {
                await sessionActions.abortCurrentOperation(currentSessionId);
            }
        }

        // Pin first-submit session/directory so backend cannot re-route after a mid-flight switch.
        // draftMessageID / establishingDraftIDAtSubmit were claimed before the first await.
        const sendMessageOptions = {
            ...(delivery ? { delivery } : {}),
            commitStagedMessageEdit: !queuedOnly,
            ...(optimisticTicket
                ? { messageID: optimisticTicket.messageID, ticket: optimisticTicket }
                : draftMessageID
                    ? { messageID: draftMessageID }
                    : {}),
            ...(primarySubmitSessionIdAtStart
                ? {
                    sessionId: primarySubmitSessionIdAtStart,
                    directoryHint: (
                        useSessionUIStore.getState().getDirectoryForSession(primarySubmitSessionIdAtStart)
                        ?? currentDirectory
                        ?? null
                    ),
                }
                : surface.kind === 'primary' && currentSessionId
                    ? {
                        sessionId: currentSessionId,
                        directoryHint: (
                            useSessionUIStore.getState().getDirectoryForSession(currentSessionId)
                            ?? currentDirectory
                            ?? null
                        ),
                    }
                    : {}),
        };

        // Build the primary message (first part) and additional parts
        let primaryText = '';
        let primaryAttachments: AttachedFile[] = [];
        let agentMentionName: string | undefined;
        const additionalParts: Array<{ text: string; attachments?: AttachedFile[]; synthetic?: boolean }> = [];
        const currentSkillNames = new Set(readInstalledSkillsSnapshot(queryClient, currentDirectory).map((skill) => skill.name));
        const semanticReferences: ComposerReferenceSemantic[] = [];

        // Consume any pending synthetic parts (from conflict resolution, etc.)
        const syntheticParts = resourcePolicy ? undefined : surfaceResources.consumeSyntheticParts();

        // Process queued messages first
        for (let i = 0; i < queuedMessagesToSend.length; i++) {
            const queuedMsg = queuedMessagesToSend[i];
            const queuedSerialized = queuedMsg.composerDocument && serializeComposerDocument(queuedMsg.composerDocument, 'direct-send-display');
            const queuedPlan = queuedSerialized && queuedSerialized.ok ? { chunks: queuedSerialized.chunks ?? [], semantics: queuedSerialized.semantics ?? [] } : null;
            const queueDirectory = queuedMsg.owner?.state === 'bound' ? queuedMsg.owner.directory : currentDirectory;
            const queuedSkillNames = new Set(readInstalledSkillsSnapshot(queryClient, queueDirectory).map((skill) => skill.name));
            const compiled = compileChatComposerDelivery({
                plan: queuedPlan ?? legacyTextToAuthoredPlan(queuedMsg.content),
                agents,
                installedSkillNames: queuedSkillNames,
                directory: queueDirectory,
                root: queueDirectory,
                confirmedFilePaths: queuedMsg.composerMentions?.filter((mention) => mention.kind === 'file' || mention.kind === 'directory').map((mention) => mention.path || mention.value),
                confirmedDirectoryPaths: queuedMsg.composerMentions?.filter((mention) => mention.kind === 'directory').map((mention) => mention.path || mention.value),
                citationAttachments: queuedMsg.attachments,
            });
            semanticReferences.push(...compiled.semantics);

            // Use agent mention from first message that has one
            if (!agentMentionName && compiled.agent) {
                agentMentionName = compiled.agent;
            }

            if (i === 0) {
                // First queued message becomes primary
                primaryText = compiled.text;
                primaryAttachments = dedupeDeliveryAttachments([
                    ...sanitizeAttachmentsForSend(queuedMsg.attachments),
                    ...compiled.attachments,
                ]);
            } else {
                // Subsequent queued messages become additional parts
                const queuedAttachments = sanitizeAttachmentsForSend(queuedMsg.attachments);
                additionalParts.push({
                    text: compiled.text,
                    attachments: dedupeDeliveryAttachments([...queuedAttachments, ...compiled.attachments]),
                });
            }
        }

        // Add current input (skip for queued-only auto-send)
        if (!queuedOnly && inputSnapshot.hasContent) {
            const attachmentsToSend = sanitizeAttachmentsForSend(sendableAttachedFiles);
            const compiled = compileChatComposerDelivery({
                plan: directPlan,
                agents,
                installedSkillNames: currentSkillNames,
                directory: currentDirectory,
                root: chatSearchDirectory || currentDirectory,
                confirmedFilePaths: confirmedFileMentions.map((mention) => mention.path),
                confirmedDirectoryPaths: confirmedFileMentions.filter((mention) => mention.kind === 'directory').map((mention) => mention.path),
                citationAttachments: sendableAttachedFiles,
            });
            semanticReferences.push(...compiled.semantics);

            if (!agentMentionName && compiled.agent) {
                agentMentionName = compiled.agent;
            }

            if (queuedMessagesToSend.length === 0) {
                // No queue - current input is primary
                primaryText = compiled.text;
                primaryAttachments = dedupeDeliveryAttachments([...attachmentsToSend, ...compiled.attachments]);
            } else {
                // Has queue - current input is additional part
                additionalParts.push({
                    text: compiled.text,
                    attachments: dedupeDeliveryAttachments([...attachmentsToSend, ...compiled.attachments]),
                });
            }
        }

        const sessionKey = currentSessionId ?? (newSessionDraftOpen ? 'draft' : null);
        let drafts: InlineCommentDraft[] = [];
        if (!queuedOnly && sessionKey && !resourcePolicy) {
            drafts = [...surfaceResources.inlineDrafts].sort((a, b) => a.createdAt - b.createdAt);
        }

        if (drafts.length > 0) {
            if (queuedMessagesToSend.length === 0) {
                primaryText = appendInlineComments(primaryText, drafts);
            } else if (additionalParts.length > 0) {
                const lastPart = additionalParts[additionalParts.length - 1];
                lastPart.text = appendInlineComments(lastPart.text, drafts);
            } else {
                primaryText = appendInlineComments(primaryText, drafts);
            }
        }

        // Add synthetic parts (from conflict resolution, etc.)
        if (syntheticParts && syntheticParts.length > 0) {
            additionalParts.push(...buildSyntheticDeliveryParts(syntheticParts));
        }

        // Add linked issue as synthetic part (only the parts with synthetic: true)
        // The text part (synthetic: false) is completely dropped per requirements
        if (linkedIssue) {
            additionalParts.push({
                text: linkedIssue.contextText,
                synthetic: true,
            });
        }

        if (linkedPr) {
            additionalParts.push({
                text: linkedPr.instructionsText,
                synthetic: true,
            });
            additionalParts.push({
                text: linkedPr.contextText,
                synthetic: true,
            });
        }

        additionalParts.push(...buildComposerSemanticParts(semanticReferences, currentSessionId ? useSessionUIStore.getState().getDirectoryForSession(currentSessionId) || currentDirectory : currentDirectory));

        if (!primaryText && primaryAttachments.length === 0 && additionalParts.length === 0) return;

        // New-session draft: paint "establishing conversation" before clearing
        // the composer. Otherwise the draft dialog stays visible with an empty
        // input while response-style / snippet prep (and later createWithPrompt)
        // still run — claimDraftSubmission is too late for that gap.
        if (establishingDraftIDAtSubmit && draftMessageID) {
            const painted = await beginDraftEstablishingPaint({
                messageID: draftMessageID,
                providerID: providerIdToSend,
                modelID: modelIdToSend,
                agent: agentNameToSend,
                text: primaryText,
                attachments: primaryAttachments,
                additionalParts,
                agentMentionName,
            });
            if (!painted) {
                return;
            }
            // Establishing was claimed before the first await; abort if the draft rotated.
            if (!useComposerSendStore.getState().isEstablishing(establishingDraftIDAtSubmit)) {
                abortEstablishing();
                return;
            }
        }

        const restoreFailedSubmission = async (): Promise<boolean> => {
            // Drop the establishing prelude if claim never took over (or send aborted).
            abortEstablishing();
            if (currentQueueScope && queuedMessagesToSend.length > 0) {
                useMessageQueueStore.setState((state) => {
                    const scopeKey = queueScopeKey(currentQueueScope);
                    const currentQueue = state.queuedMessages[scopeKey] ?? [];
                    const restoredIds = new Set(queuedMessagesToSend.map((queuedMessage) => queuedMessage.id));
                    return {
                        queuedMessages: {
                            ...state.queuedMessages,
                            [scopeKey]: [
                                ...queuedMessagesToSend,
                                ...currentQueue.filter((queuedMessage) => !restoredIds.has(queuedMessage.id)),
                            ],
                        },
                    };
                });
            }

            if (queuedOnly) {
                if (syntheticParts) {
                    surfaceResources.restoreSyntheticParts(syntheticParts);
                }
                return true;
            }

            if (surfaceResources.pendingInput?.text === inputSnapshot.message) {
                surfaceResources.consumePendingInput();
            }
            if (submissionCapture) recoverSubmission(submissionCapture);
            // Skip restore CAS when there were no root attachments to reinstate.
            let attachmentsOk = true;
            if (inputAttachmentsSnapshot.length > 0) {
                attachmentsOk = await surfaceResources.restoreAttachments(inputAttachmentsSnapshot);
            }
            if (syntheticParts) surfaceResources.restoreSyntheticParts(syntheticParts);
            if (drafts.length > 0) surfaceResources.restoreInlineDrafts(drafts);
            return attachmentsOk;
        };

        // Clear queue and input
        if (!resourcePolicy && currentSessionId && queuedMessageId) {
            const queuedItem = currentQueueScope
                ? getQueueForScope(useMessageQueueStore.getState(), currentQueueScope).find((message) => message.id === queuedMessageId || message.queueItemID === queuedMessageId)
                : undefined;
            if (currentQueueScope && queuedItem?.queueItemID && queuedItem.operationID) {
                removeFromQueue(currentQueueScope, queuedItem.queueItemID, queuedItem.operationID);
            }
        } else if (!resourcePolicy && currentSessionId && hasQueuedMessages) {
            if (currentQueueScope) clearQueue(currentQueueScope);
        }
        if (!queuedOnly && !resourcePolicy) {
            replacePlainDocument('');
            // Clear per-session draft on submit
            // Reset message history navigation state
            setHistoryIndex(-1);
            // Close expanded input overlay when submitting
            setExpandedInput(false);
            // Delivery uses captured attachment views; draft cleanup stays best-effort.
            if (shouldConsumeRootAttachmentsOnSubmit({
                queuedOnly,
                resourcePolicy,
                rootAttachmentCount: inputAttachmentsSnapshot.length,
            })) {
                void surfaceResources.clearAttachments();
            }
        }

        const consumeImmediateCommand = () => consumeImmediateCommandText({
            currentSessionId,
            messageRef,
            replacePlainDocument,
        });

        // Handle local slash commands only in normal mode
        const normalizedCommand = primaryText.trimStart();
        if (inputMode === 'normal' && normalizedCommand.startsWith('/')) {
            // Reserved-slot chips (`/\u2003undo`) still parse as the bare name.
            const commandName = stripLeadingSlashCommandSlot(
                normalizedCommand.slice(1).trim(),
            )
                .split(/\s+/)[0]
                ?.toLowerCase();

            if (!isCommandAllowedForSubmission(commandName, (command) => isChatInputCommandAllowed(surface, {
                name: command.name,
                source: 'openchamber',
            }))) {
                return;
            }

            if (currentSessionId && (commandName === 'undo' || commandName === 'redo') && consumesImmediateCommandText(normalizedCommand, inputMode)) {
                consumeImmediateCommand();
            }

            if (commandName === 'undo' && currentSessionId) {
                try {
                    await useSessionUIStore.getState().handleSlashUndo(currentSessionId);
                    scrollToBottom?.();
                } catch (error) {
                    toast.error(error instanceof Error ? error.message : t('chat.chatInput.toast.messageSendFailed'));
                }
                return;
            }
            else if (commandName === 'new') {
                // resourcePolicy preserved the composer for this local command;
                // consume the command text synchronously (same contract as
                // compact/fork via runImmediateSessionCommand) before the
                // immediate create switches sessions.
                if (consumesImmediateCommandText(normalizedCommand, inputMode)) {
                    consumeImmediateCommand();
                }
                await controllerWiring?.shortcut('new');
                return;
            }
            else if (commandName === 'redo' && currentSessionId) {
                try {
                    await useSessionUIStore.getState().handleSlashRedo(currentSessionId);
                    scrollToBottom?.();
                } catch (error) {
                    toast.error(error instanceof Error ? error.message : t('chat.chatInput.toast.messageSendFailed'));
                }
                return;
            }
            else if (commandName === 'fork' && currentSessionId) {
                await runImmediateSessionCommand({
                    command: 'fork',
                    consumeCommandText: consumeImmediateCommand,
                    forkSession: () => useSessionUIStore.getState().forkCurrentSession(currentSessionId),
                    waitForConnection: sessionActions.waitForConnectionOrThrow,
                    getDirectoryForSession: () => useSessionUIStore.getState().getDirectoryForSession(currentSessionId),
                    summarizeSession: async () => undefined,
                    onCompactError: () => undefined,
                    onForkError: (error) => {
                        toast.error(error instanceof Error ? error.message : t('chat.chatInput.toast.messageSendFailed'));
                    },
                });
                return;
            }
            else if (commandName === 'timeline' && currentSessionId && sessionSurfaceActions.timeline) {
                setTimelineDialogOpen(true);
                return;
            }
            else if (commandName === 'compact' && currentSessionId) {
                // Compaction is a long-running background turn. The command
                // text is consumed synchronously before the first await, so
                // the composer is already free — run summarize without holding
                // the submission flight so Enter/Send can keep queueing
                // follow-ups while the session compacts. Failures surface via
                // onCompactError.
                void runImmediateSessionCommand({
                    command: 'compact',
                    consumeCommandText: consumeImmediateCommand,
                    forkSession: async () => undefined,
                    waitForConnection: sessionActions.waitForConnectionOrThrow,
                    getDirectoryForSession: () => surface.directory ?? '',
                    summarizeSession: (directory) => {
                        if (!draftKey) return Promise.reject(new Error('chat-input-surface-incomplete'));
                        return surface.backend.compact({
                            operation: 'compact', surfaceID: surface.surfaceID,
                            transportIdentity: surface.transportIdentity, runtimeGeneration: surface.runtimeGeneration,
                            sessionID: currentSessionId, directory, draftKey, deliveryTarget: surface.deliveryTarget,
                            providerID: providerIdToSend, modelID: modelIdToSend, agent: agentNameToSend, variant: variantToSend,
                        });
                    },
                    onCompactError: () => { toast.error(t('chat.chatInput.toast.compactFailed')); },
                    onForkError: () => undefined,
                });
                return;
            }
            else if (commandName === 'summary' && currentSessionId) {
                try {
                    await sessionActions.waitForConnectionOrThrow();
                    // Everything after `/summary ` is an optional topic hint
                    // the user wants the summary focused on.
                    const topic = normalizedCommand.replace(/^\/\u2003?summary\b/i, '').trim();
                    const topicLine = topic ? ` focused on: ${topic}` : '';
                    const topicBlock = topic
                        ? `The user asked you to focus this summary on: ${topic}. Prioritize that topic; mention unrelated threads only in passing.`
                        : '';
                    const visibleText = await renderMagicPrompt('session.summary.visible', { topic_line: topicLine });
                    const instructionsText = await renderMagicPrompt('session.summary.instructions', { topic_block: topicBlock });
                    await sendMessage(
                        visibleText,
                        providerIdToSend,
                        modelIdToSend,
                        agentNameToSend,
                        [],
                        agentMentionName,
                        [{ text: instructionsText, synthetic: true }],
                        variantToSend,
                        inputMode,
                        sendMessageOptions,
                    );
                    scrollToBottom?.();
                } catch (error) {
                    await restoreFailedSubmission();
                    toast.error(error instanceof Error ? error.message : t('chat.chatInput.toast.summaryFailed'));
                }
                return;
            }
            else if (commandName === 'workspace-review' && (currentSessionId || newSessionDraftOpen)) {
                try {
                    await sessionActions.waitForConnectionOrThrow();
                    const visibleText = await renderMagicPrompt('session.review.visible');
                    const instructionsText = await renderMagicPrompt('session.review.instructions');
                    await sendMessage(
                        visibleText,
                        providerIdToSend,
                        modelIdToSend,
                        agentNameToSend,
                        [],
                        agentMentionName,
                        [{ text: instructionsText, synthetic: true }],
                        variantToSend,
                        inputMode,
                        sendMessageOptions,
                    );
                    scrollToBottom?.();
                } catch (error) {
                    await restoreFailedSubmission();
                    toast.error(error instanceof Error ? error.message : t('chat.chatInput.toast.reviewFailed'));
                }
                return;
            }
            else if (commandName === 'handoff-review' && currentSessionId && !isMobile && !isVSCodeRuntime()) {
                setReviewDialogOpen(true);
                return;
            }
            else if (commandName === 'plan-feature' && (currentSessionId || newSessionDraftOpen)) {
                try {
                    await sessionActions.waitForConnectionOrThrow();
                    const visibleText = await renderMagicPrompt('session.plan.visible');
                    const instructionsText = await renderMagicPrompt('session.plan.instructions');
                    await sendMessage(
                        visibleText,
                        providerIdToSend,
                        modelIdToSend,
                        agentNameToSend,
                        [],
                        agentMentionName,
                        [{ text: instructionsText, synthetic: true }],
                        variantToSend,
                        inputMode,
                        sendMessageOptions,
                    );
                    scrollToBottom?.();
                } catch (error) {
                    await restoreFailedSubmission();
                    toast.error(error instanceof Error ? error.message : t('chat.chatInput.toast.planFeatureFailed'));
                }
                return;
            }
            else if (commandName === 'goal' && (currentSessionId || newSessionDraftOpen)) {
                // `/goal` only arms goal mode — never auto-sends. Strip the slash
                // token and leave any trailing objective in the composer so the
                // user can keep editing, then send as a normal armed message.
                abortEstablishing();
                useSessionGoalArmStore.getState().setArmed(true);
                const objectiveDraft = getGoalCommandObjective(normalizedCommand, inputMode) ?? '';
                replacePlainDocument(objectiveDraft);
                messageRef.current = objectiveDraft;
                setHistoryIndex(-1);
                if (!objectiveDraft) setExpandedInput(false);
                return;
            }
            else if (commandName === 'craft-goal' && (currentSessionId || newSessionDraftOpen)) {
                try {
                    await sessionActions.waitForConnectionOrThrow();
                    const idea = normalizedCommand.replace(/^\/\u2003?craft-goal\b/i, '').trim();
                    const visibleText = await renderMagicPrompt('session.craftGoal.visible', {
                        idea_block: idea ? `\n\nHere is my initial idea:\n${idea}` : '',
                    });
                    const instructionsText = await renderMagicPrompt('session.craftGoal.instructions');
                    await sendMessage(
                        visibleText,
                        providerIdToSend,
                        modelIdToSend,
                        agentNameToSend,
                        [],
                        agentMentionName,
                        [{ text: instructionsText, synthetic: true }],
                        variantToSend,
                        inputMode,
                        sendMessageOptions,
                    );
                    scrollToBottom?.();
                } catch (error) {
                    await restoreFailedSubmission();
                    toast.error(error instanceof Error ? error.message : t('chat.chatInput.toast.craftGoalFailed'));
                }
                return;
            }
            else if (commandName === 'catch-up' && (currentSessionId || newSessionDraftOpen)) {
                try {
                    await sessionActions.waitForConnectionOrThrow();
                    const visibleText = await renderMagicPrompt('session.catchup.visible');
                    const instructionsText = await renderMagicPrompt('session.catchup.instructions');
                    await sendMessage(
                        visibleText,
                        providerIdToSend,
                        modelIdToSend,
                        agentNameToSend,
                        [],
                        agentMentionName,
                        [{ text: instructionsText, synthetic: true }],
                        variantToSend,
                        inputMode,
                        sendMessageOptions,
                    );
                    scrollToBottom?.();
                } catch (error) {
                    await restoreFailedSubmission();
                    toast.error(error instanceof Error ? error.message : t('chat.chatInput.toast.catchUpFailed'));
                }
                return;
            }
            else if (commandName === 'debug' && (currentSessionId || newSessionDraftOpen)) {
                try {
                    await sessionActions.waitForConnectionOrThrow();
                    const visibleText = await renderMagicPrompt('session.debug.visible');
                    const instructionsText = await renderMagicPrompt('session.debug.instructions');
                    await sendMessage(
                        visibleText,
                        providerIdToSend,
                        modelIdToSend,
                        agentNameToSend,
                        [],
                        agentMentionName,
                        [{ text: instructionsText, synthetic: true }],
                        variantToSend,
                        inputMode,
                        sendMessageOptions,
                    );
                    scrollToBottom?.();
                } catch (error) {
                    await restoreFailedSubmission();
                    toast.error(error instanceof Error ? error.message : t('chat.chatInput.toast.debugFailed'));
                }
                return;
            }
            else if (commandName === 'weigh' && (currentSessionId || newSessionDraftOpen)) {
                try {
                    await sessionActions.waitForConnectionOrThrow();
                    const visibleText = await renderMagicPrompt('session.weigh.visible');
                    const instructionsText = await renderMagicPrompt('session.weigh.instructions');
                    await sendMessage(
                        visibleText,
                        providerIdToSend,
                        modelIdToSend,
                        agentNameToSend,
                        [],
                        agentMentionName,
                        [{ text: instructionsText, synthetic: true }],
                        variantToSend,
                        inputMode,
                        sendMessageOptions,
                    );
                    scrollToBottom?.();
                } catch (error) {
                    await restoreFailedSubmission();
                    toast.error(error instanceof Error ? error.message : t('chat.chatInput.toast.weighFailed'));
                }
                return;
            }
            else if (commandName === 'explore' && (currentSessionId || newSessionDraftOpen)) {
                try {
                    await sessionActions.waitForConnectionOrThrow();
                    const visibleText = await renderMagicPrompt('session.explore.visible');
                    const instructionsText = await renderMagicPrompt('session.explore.instructions');
                    await sendMessage(
                        visibleText,
                        providerIdToSend,
                        modelIdToSend,
                        agentNameToSend,
                        [],
                        agentMentionName,
                        [{ text: instructionsText, synthetic: true }],
                        variantToSend,
                        inputMode,
                        sendMessageOptions,
                    );
                    scrollToBottom?.();
                } catch (error) {
                    await restoreFailedSubmission();
                    toast.error(error instanceof Error ? error.message : t('chat.chatInput.toast.exploreFailed'));
                }
                return;
            }
        }

        const currentSessionDirectory = currentSessionId
            ? useSessionUIStore.getState().getDirectoryForSession(currentSessionId) || currentDirectory
            : currentDirectory;
        const shouldAddResponseStyle = surfaceHasNewDraft || (currentSessionId ? !hasUserMessages(currentSessionId, currentSessionDirectory) : false);
        if (shouldAddResponseStyle) {
            const responseStyleInstruction = await fetchResponseStyleInstruction().catch(() => null);
            if (responseStyleInstruction) {
                additionalParts.push({
                    text: wrapSystemReminder(responseStyleInstruction),
                    synthetic: true,
                });
            }
        }

        try {
            const expandText = useSnippetsStore.getState().expandText;
            primaryText = await expandText(primaryText);
            for (const part of additionalParts) {
                if (!part.synthetic) part.text = await expandText(part.text);
            }
        } catch (error) {
            console.warn('[ChatInput] Failed to expand snippets, sending original text:', error);
        }

        // Hand optimistic ticket / edit paint to the final send path; early exits
        // roll them back in finally. sendPromise rejection rolls back the ticket
        // only — sendMessage releases the editing paint around the commit, and the
        // settle below is the backstop for any path that never reaches that commit.
        handedOptimisticToSendPromise = true;
        const sendPromise = sendMessage(
            primaryText,
            providerIdToSend,
            modelIdToSend,
            agentNameToSend,
            primaryAttachments,
            agentMentionName,
            additionalParts.length > 0 ? additionalParts : undefined,
            variantToSend,
            inputMode,
            sendMessageOptions,
        );

        // Keep flight until send settles so a cleared composer cannot double-send.
        transferFlightToSendPromise = true;
        void sendPromise.finally(() => {
            endSubmissionFlight();
            // No-op once the commit already released it; the row must never be left
            // stuck in "editing" when a send settles without committing the edit.
            if (messageEditCommitTarget) {
                useSessionUIStore.getState().endMessageEditCommit(
                    messageEditCommitTarget.sessionId,
                    messageEditCommitTarget.messageId,
                );
            }
        });

        if (establishingDraftIDAtSubmit) {
            void sendPromise.then(() => {
                drainOrClearEstablishingFollowUps(establishingDraftIDAtSubmit);
            }).catch(() => {
                useComposerSendStore.getState().clearEstablishing(establishingDraftIDAtSubmit);
            });
        }

        if (typeof window === 'undefined') {
            scrollToBottom?.();
        } else {
            window.requestAnimationFrame(() => {
                scrollToBottom?.();
            });
        }

        void sendPromise.then(() => {
            // Clear linked issue after successful message send
            if (linkedIssue) {
                setLinkedIssue(null);
            }
            if (linkedPr) {
                setLinkedPr(null);
            }
        }).catch((error: unknown) => {
            if (optimisticTicket) {
                sessionActions.rollbackOptimisticSend(optimisticTicket);
            }
            void restoreFailedSubmission().then((ok) => {
                if (!ok) toast.error(t('chat.chatInput.toast.messageSendFailed'));
            });
            const rawMessage =
                error instanceof Error
                    ? error.message
                    : typeof error === 'string'
                        ? error
                        : String(error ?? '');
            const normalized = rawMessage.toLowerCase();

            console.error('Message send failed:', rawMessage || error);

            const isSoftNetworkError =
                normalized.includes('timeout') ||
                normalized.includes('timed out') ||
                normalized.includes('may still be processing') ||
                normalized.includes('being processed') ||
                normalized.includes('failed to fetch') ||
                normalized.includes('networkerror') ||
                normalized.includes('network error') ||
                normalized.includes('gateway timeout') ||
                normalized === 'failed to send message';

            if (normalized.includes('payload too large') || normalized.includes('413') || normalized.includes('entity too large')) {
                toast.error(t('chat.chatInput.toast.attachmentsTooLarge'));
                return;
            }

            if (isSoftNetworkError) {
                if (inputAttachmentsSnapshot.length > 0) {
                    toast.error(t('chat.chatInput.toast.sendAttachmentsFailed'));
                }
                return;
            }

            toast.error(rawMessage || t('chat.chatInput.toast.messageSendFailed'));
        });

        if (!isMobile) {
            textareaRef.current?.focus();
        }
        } finally {
            // Ticket not handed to sendPromise: rollback optimistic row and drop the
            // "editing" paint (flush stale, missing model, queue delegate, etc.).
            if (!handedOptimisticToSendPromise) {
                if (optimisticTicket) {
                    sessionActions.rollbackOptimisticSend(optimisticTicket);
                }
                if (messageEditCommitTarget) {
                    useSessionUIStore.getState().endMessageEditCommit(
                        messageEditCommitTarget.sessionId,
                        messageEditCommitTarget.messageId,
                    );
                }
            }
            if (!transferFlightToSendPromise) {
                if (clearedComposerBeforeDispatch && submissionCapture) {
                    recoverSubmission(submissionCapture);
                }
                endSubmissionFlight();
                // Early-exit / awaited magic-prompt paths do not use sendPromise.then
                // drain. If create already selected a session, land follow-ups there;
                // otherwise drop establishing so Mod+N is not stuck.
                if (establishingDraftIDAtSubmit) {
                    drainOrClearEstablishingFollowUps(establishingDraftIDAtSubmit);
                }
            }
        }
    };

    // Update ref with latest handleSubmit on every render
    handleSubmitRef.current = handleSubmit;

    // Primary action for send/queue button — respects selected follow-up behavior
    const handlePrimaryAction = React.useCallback(() => {
        if (claimedByEstablishingFollowUp()) return;
        if (isSubmissionInFlight()) return;
        const inputSnapshot = getCurrentInputSnapshot();
        // Only authoritative busy/retry (or an active auto-review) may queue/steer.
        // `unknown` must not count as running — assistant surfaces used to emit it
        // while session status was still loading, which parked idle sends in the
        // queue path and left the composer uncleared when legacy queue rejected them.
        const canQueue = inputMode === 'normal' && inputSnapshot.hasContent && currentSessionId && (sessionIsRunning || autoReviewRunning);
        const queueUsable = canQueue
            && queueModeAllowsMutations(serverQueue.mode)
            && assistantQueueAdmissionAvailable(surface.deliveryTarget?.kind, serverQueue.mode);
        if (followUpBehavior === 'queue' && queueUsable) {
            queueMessageFromEvent();
        } else if ((followUpBehavior === 'steer' && canQueue) || (followUpBehavior === 'queue' && canQueue && !queueUsable)) {
            // Queue-unavailable busy sessions steer into the captured running turn.
            void handleSubmitRef.current(canQueue ? { delivery: 'steer' } : undefined);
        } else {
            void handleSubmitRef.current();
        }
    }, [inputMode, getCurrentInputSnapshot, currentSessionId, sessionIsRunning, autoReviewRunning, followUpBehavior, queueMessageFromEvent, serverQueue.mode, surface.deliveryTarget?.kind, enqueueEstablishingFollowUpFromComposer]);

    // Draft welcome presets: submit immediately.
    const submitPresetPrompt = React.useCallback((text: string) => {
        if (isSubmissionInFlight()) return;
        // The text goes straight into the submit (see SubmitOptions.presetText)
        // instead of through the composer input — the collapsed mobile pill has
        // no mounted textarea to stage it in.
        const draft = (textareaRef.current?.value ?? messageRef.current).trim();
        const presetText = draft ? `${text}\n${draft}` : text;
        void handleSubmitRef.current({ presetText });
    }, []);

    // Dictation: insert the transcript inline; optionally submit immediately.
    // getCurrentInputSnapshot reads textareaRef.current.value first, so setting
    // it synchronously lets handleSubmit pick up the text in the same tick.
    const handleDictationInsert = React.useCallback((text: string) => {
        const next = appendInlineText(getDocument().text, text);
        applyProgrammaticEdit(next);
        if (textareaRef.current) textareaRef.current.value = next;
        setTimeout(() => {
            textareaRef.current?.focus();
        }, 0);
    }, [applyProgrammaticEdit]);

    const handleDictationInsertAndSend = React.useCallback((text: string) => {
        if (isSubmissionInFlight()) return;
        // Same as preset chips: the composed text goes into the submit as an
        // explicit override instead of being staged in the textarea, which may
        // not be mounted (collapsed mobile pill).
        const next = appendInlineText(textareaRef.current?.value ?? messageRef.current, text);
        void handleSubmitRef.current({ presetText: next });
    }, []);

    // Preset chips rendered outside this component (e.g. under the welcome
    // message on narrow surfaces) request a submit via the input store; consume
    // it here so it routes through the same command-aware submit path.
    const pendingPreset = surfaceResources.pendingPreset;
    const consumePendingPreset = surfaceResources.consumePendingPreset;
    React.useEffect(() => {
        if (pendingPreset == null) return;
        const text = consumePendingPreset();
        if (text) submitPresetPrompt(text);
    }, [pendingPreset, consumePendingPreset, submitPresetPrompt]);

    // OpenCode-compatible input_clear: wipe the composer body and any queued turns.
    const handleClearAllMessages = React.useCallback(() => {
        replacePlainDocument('');
        setHistoryIndex(-1);
        if (attachedFiles.length > 0) {
            surfaceResources.clearAttachments();
        }
        if (currentQueueScope) {
            clearQueue(currentQueueScope);
        }
        setShowCommandAutocomplete(false);
        setShowSkillAutocomplete(false);
        setShowSnippetAutocomplete(false);
        setShowFileMention(false);
        if (inputMode === 'shell') {
            setInputMode('normal');
        }
    }, [
        attachedFiles.length,
        surfaceResources,
        clearQueue,
        currentQueueScope,
        replacePlainDocument,
        inputMode,
    ]);

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (!surface.active) return;
        // Early return during IME composition to prevent interference with autocomplete.
        // Uses keyCode === 229 fallback for WebKit where compositionend fires before keydown.
        if (isIMECompositionEvent(e)) return;

        if (
            clearAllMessagesShortcut
            && eventMatchesShortcut(e, clearAllMessagesShortcut)
            && !isLeaderKeyPending
        ) {
            const textarea = textareaRef.current;
            const hasSelection = textarea
                ? textarea.selectionStart !== textarea.selectionEnd
                : false;
            // Preserve native copy when text is selected (Ctrl+C on Windows/Linux).
            if (!hasSelection) {
                e.preventDefault();
                handleClearAllMessages();
                return;
            }
        }

        if (inputMode === 'shell' && e.key === 'Escape') {
            e.preventDefault();
            setInputMode('normal');
            return;
        }

        if (inputMode === 'shell' && e.key === 'Backspace' && message.length === 0) {
            e.preventDefault();
            setInputMode('normal');
            return;
        }

        if ((e.key === 'Backspace' || e.key === 'Delete') && !e.metaKey && !e.ctrlKey) {
            const textarea = textareaRef.current;
            const selectionStart = textarea?.selectionStart ?? message.length;
            const selectionEnd = textarea?.selectionEnd ?? message.length;
            const referenceDeletion = deleteReference({ key: e.key, selectionStart, selectionEnd, altKey: e.altKey });
            if (referenceDeletion) {
                const normalizedDeletion = normalizeReferenceDeletionWhitespace(composer.getDocument().text, referenceDeletion.start);
                e.preventDefault();
                applyProgrammaticEdit(normalizedDeletion.text);
                requestAnimationFrame(() => {
                    textareaRef.current?.setSelectionRange(normalizedDeletion.caret, normalizedDeletion.caret);
                    adjustTextareaHeight();
                });
                updateAutocompleteState(normalizedDeletion.text, normalizedDeletion.caret);
                return;
            }
            const citationDeletion = resolveAttachmentCitationDeletion(
                message,
                attachedFiles
                    .filter(isInlineAttachmentCitation)
                    .map((file) => file.filename),
                { key: e.key, selectionStart, selectionEnd, altKey: e.altKey },
            );

            if (citationDeletion) {
                const removedFilenames = new Set(citationDeletion.removedFilenames.map((filename) => filename.toLowerCase()));
                const normalizedDeletion = normalizeReferenceDeletionWhitespace(citationDeletion.text, citationDeletion.caret);
                e.preventDefault();
                // Text first so store citation strip is a no-op; remove is the shared attachment sink.
                applyProgrammaticEdit(normalizedDeletion.text);
                for (const attachment of attachedFiles) {
                    if (removedFilenames.has(attachment.filename.toLowerCase())) {
                        void surfaceResources.removeAttachment(attachment.id);
                    }
                }
                requestAnimationFrame(() => {
                    if (textareaRef.current) {
                        textareaRef.current.selectionStart = normalizedDeletion.caret;
                        textareaRef.current.selectionEnd = normalizedDeletion.caret;
                    }
                    adjustTextareaHeight();
                });
                updateAutocompleteState(normalizedDeletion.text, normalizedDeletion.caret);
                return;
            }

            const skillDeletion = resolveSkillMentionDeletion(
                message,
                availableSkillNames.keys(),
                { key: e.key, selectionStart, selectionEnd, altKey: e.altKey },
            );
            if (skillDeletion) {
                const normalizedDeletion = normalizeReferenceDeletionWhitespace(skillDeletion.text, skillDeletion.caret);
                e.preventDefault();
                applyProgrammaticEdit(normalizedDeletion.text);
                requestAnimationFrame(() => {
                    if (textareaRef.current) {
                        textareaRef.current.selectionStart = normalizedDeletion.caret;
                        textareaRef.current.selectionEnd = normalizedDeletion.caret;
                    }
                    adjustTextareaHeight();
                });
                updateAutocompleteState(normalizedDeletion.text, normalizedDeletion.caret);
                return;
            }

            const hasCollapsedSelection = selectionStart === selectionEnd;

            if (hasCollapsedSelection && !e.altKey) {
                const probeIndex = e.key === 'Backspace' ? selectionStart - 1 : selectionStart;
                if (probeIndex >= 0 && probeIndex < message.length) {
                    const citationRange = findAttachmentCitationRanges(
                        message,
                        attachedFiles.map((file) => file.filename),
                    ).find((range) => probeIndex >= range.start && probeIndex < range.end);
                    if (citationRange) {
                        // Match attachment.filename after stripping the reserved icon well.
                        const filename = stripComposerTriggerIconSlot(message.slice(citationRange.start + 1, citationRange.end - 1)).trim();
                        const attachment = attachedFiles.find((file) => file.filename.toLowerCase() === filename.toLowerCase());
                        const removeUntil = message[citationRange.end] === ' ' ? citationRange.end + 1 : citationRange.end;
                        const nextMessage = `${message.slice(0, citationRange.start)}${message.slice(removeUntil)}`;
                        e.preventDefault();
                        // Text first so store citation strip is a no-op; remove is the shared attachment sink.
                        applyProgrammaticEdit(nextMessage);
                        if (attachment) void surfaceResources.removeAttachment(attachment.id);
                        requestAnimationFrame(() => {
                            if (textareaRef.current) {
                                textareaRef.current.selectionStart = citationRange.start;
                                textareaRef.current.selectionEnd = citationRange.start;
                            }
                            adjustTextareaHeight();
                        });
                        updateAutocompleteState(nextMessage, citationRange.start);
                        return;
                    }

                    let tokenStart = probeIndex;
                    while (tokenStart > 0 && !/\s/.test(message[tokenStart - 1])) {
                        tokenStart -= 1;
                    }

                    let tokenEnd = probeIndex + 1;
                    while (tokenEnd < message.length && !/\s/.test(message[tokenEnd])) {
                        tokenEnd += 1;
                    }

                    const token = message.slice(tokenStart, tokenEnd);
                    const mentionContent = token.slice(1);
                    const looksLikeFileMention = FILE_MENTION_TOKEN.test(token)
                        && !knownAgentNamesRef.current.has(mentionContent.toLowerCase())
                        && shouldHighlightFileMention({
                            mention: mentionContent,
                            confirmed: confirmedFileMentionValues.has(mentionContent),
                            terminated: tokenEnd < message.length && /\s/.test(message[tokenEnd]),
                        });

                    if (looksLikeFileMention) {
                        const removeUntil = message[tokenEnd] === ' ' ? tokenEnd + 1 : tokenEnd;
                        const nextMessage = `${message.slice(0, tokenStart)}${message.slice(removeUntil)}`;
                        e.preventDefault();
                        applyProgrammaticEdit(nextMessage);
                        requestAnimationFrame(() => {
                            if (textareaRef.current) {
                                textareaRef.current.selectionStart = tokenStart;
                                textareaRef.current.selectionEnd = tokenStart;
                            }
                            adjustTextareaHeight();
                        });
                        updateAutocompleteState(nextMessage, tokenStart);
                        return;
                    }
                }
            }
        }

        // Plain arrow keys navigate autocomplete; mod+arrow is reserved for session switching.
        const isPlainArrowKey = (e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.metaKey && !e.ctrlKey;
        if (showCommandAutocomplete && commandRef.current) {
            if (e.key === 'Enter' || e.key === 'Escape' || e.key === 'Tab' || isPlainArrowKey) {
                e.preventDefault();
                e.stopPropagation();
                commandRef.current.handleKeyDown(e.key);
                return;
            }
        }

        if (showSkillAutocomplete && skillRef.current) {
            if (e.key === 'Enter' || e.key === 'Escape' || e.key === 'Tab' || isPlainArrowKey) {
                e.preventDefault();
                e.stopPropagation();
                skillRef.current.handleKeyDown(e.key);
                return;
            }
        }

        if (showSnippetAutocomplete && snippetRef.current) {
            if (e.key === 'Enter' || e.key === 'Escape' || e.key === 'Tab' || isPlainArrowKey) {
                e.preventDefault();
                e.stopPropagation();
                snippetRef.current.handleKeyDown(e.key);
                return;
            }
        }

        if (showFileMention && mentionRef.current) {
            if (e.key === 'Enter' || e.key === 'Escape' || e.key === 'Tab' || isPlainArrowKey) {
                e.preventDefault();
                e.stopPropagation();
                mentionRef.current.handleKeyDown(e.key);
                return;
            }
        }

        if (isDesktopExpanded && e.key === 'Escape') {
            e.preventDefault();
            setExpandedInput(false);
            return;
        }

        const cycleAgentBackwardShortcut = cycleAgentShortcut && !cycleAgentShortcut.includes('shift')
            ? normalizeCombo(`shift+${cycleAgentShortcut}`)
            : '';
        const cycleAgentDirection = cycleAgentBackwardShortcut && eventMatchesShortcut(e, cycleAgentBackwardShortcut)
            ? -1
            : eventMatchesShortcut(e, cycleAgentShortcut)
                ? 1
                : 0;

        if (cycleAgentDirection !== 0 && !showCommandAutocomplete && !showSkillAutocomplete && !showSnippetAutocomplete && !showFileMention) {
            e.preventDefault();
            e.stopPropagation();
            void controllerWiring?.shortcut('cycle', cycleAgentDirection);
            // Primary and Assistant must keep the composer focused after Tab cycle.
            requestAnimationFrame(() => {
                textareaRef.current?.focus({ preventScroll: true });
            });
            return;
        }

        // Handle ArrowUp/ArrowDown for message history navigation
        // ArrowUp: only when cursor at start (position 0) or input is empty
        // ArrowDown: also works when cursor at end (to cycle forward through history)
        const isAnyAutocompleteOpen = showCommandAutocomplete || showSkillAutocomplete || showSnippetAutocomplete || showFileMention;
        const cursorAtStart = textareaRef.current?.selectionStart === 0 && textareaRef.current?.selectionEnd === 0;
        const cursorAtEnd = textareaRef.current?.selectionStart === message.length && textareaRef.current?.selectionEnd === message.length;
        const canNavigateHistoryUp = !isAnyAutocompleteOpen && (message.length === 0 || cursorAtStart);
        const canNavigateHistoryDown = !isAnyAutocompleteOpen && (message.length === 0 || cursorAtEnd);

        // Markdown-aware auto-pairing (source mode), normal input only.
        if (inputMode === 'normal' && !isAnyAutocompleteOpen && !e.metaKey && !e.ctrlKey && !e.altKey) {
            const ta = textareaRef.current;
            const selStart = ta?.selectionStart ?? -1;
            const selEnd = ta?.selectionEnd ?? -1;

            if (ta && selStart >= 0) {
                const applyEdit = (next: string, caretStart: number, caretEnd: number) => {
                    e.preventDefault();
                    applyProgrammaticEdit(next);
                    requestAnimationFrame(() => {
                        const current = textareaRef.current;
                        if (current) {
                            current.selectionStart = caretStart;
                            current.selectionEnd = caretEnd;
                        }
                        adjustTextareaHeight();
                    });
                    updateAutocompleteState(next, caretEnd);
                };

                // Wrap the current selection: select text, press ` * _ ~ ( [ { " '
                const WRAP_PAIRS: Record<string, [string, string]> = {
                    '`': ['`', '`'], '*': ['*', '*'], '_': ['_', '_'], '~': ['~', '~'],
                    '(': ['(', ')'], '[': ['[', ']'], '{': ['{', '}'],
                    '"': ['"', '"'], "'": ["'", "'"],
                };
                if (selEnd > selStart && WRAP_PAIRS[e.key]) {
                    const [open, close] = WRAP_PAIRS[e.key];
                    const selected = message.slice(selStart, selEnd);
                    const next = `${message.slice(0, selStart)}${open}${selected}${close}${message.slice(selEnd)}`;
                    applyEdit(next, selStart + open.length, selEnd + open.length);
                    return;
                }

                // Typing the third backtick at line start expands into a fenced
                // code block with the caret on the empty middle line (Slack-like).
                if (e.key === '`' && selStart === selEnd) {
                    const before = message.slice(0, selStart);
                    if (/(^|\n)``$/.test(before)) {
                        const after = message.slice(selEnd);
                        const next = `${before}\`\n\n\`\`\`${after}`;
                        const caret = before.length + 2; // after the completed ``` and first newline
                        applyEdit(next, caret, caret);
                        return;
                    }
                }
            }
        }

        // History recall is bare ↑/↓ only; mod+arrow switches sessions.
        if (e.key === 'ArrowUp' && !e.metaKey && !e.ctrlKey && canNavigateHistoryUp && userMessageHistory.length > 0) {
            e.preventDefault();
            if (historyIndex === -1) {
                // Entering history mode - save current input as draft
                setHistoryIndex(0);
                enterHistoryPreview({ text: userMessageHistory[0], references: [] });
            } else if (historyIndex < userMessageHistory.length - 1) {
                // Navigate to older message
                const newIndex = historyIndex + 1;
                setHistoryIndex(newIndex);
                enterHistoryPreview({ text: userMessageHistory[newIndex], references: [] });
            }
            // Move cursor to start after history navigation
            requestAnimationFrame(() => {
                textareaRef.current?.setSelectionRange(0, 0);
            });
            // If at oldest message, do nothing
            return;
        }

        if (e.key === 'ArrowDown' && !e.metaKey && !e.ctrlKey && canNavigateHistoryDown && historyIndex >= 0) {
            e.preventDefault();
            if (historyIndex === 0) {
                // Exit history mode - restore draft
                setHistoryIndex(-1);
                exitHistoryPreview();
            } else {
                // Navigate to newer message
                const newIndex = historyIndex - 1;
                setHistoryIndex(newIndex);
                enterHistoryPreview({ text: userMessageHistory[newIndex], references: [] });
            }
            return;
        }

        // Handle Enter/Ctrl+Enter based on selected follow-up behavior.
        // When enterkeyhint="send" is set on mobile, the keyboard shows
        // a send button; plain Enter should submit, Shift+Enter for newline.
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            // Establishing follow-ups bypass primary create+prompt flight so Enter
            // still stages "Queuing…" chips the same way the send button does.
            if (claimedByEstablishingFollowUp()) return;
            // Component-level flight: ignore keyboard re-entry while submit is active.
            if (isSubmissionInFlight()) return;

            const isCtrlEnter = e.ctrlKey || e.metaKey;

            // Queueing / steering only works when there's an existing busy
            // session (or an active auto-review run). `unknown` is not running.
            const canQueue = inputMode === 'normal' && hasContent && currentSessionId && (sessionIsRunning || autoReviewRunning);
            const queueUsable = canQueue
                && queueModeAllowsMutations(serverQueue.mode)
                && assistantQueueAdmissionAvailable(surface.deliveryTarget?.kind, serverQueue.mode);

            if (followUpBehavior === 'queue') {
                if (isCtrlEnter || !canQueue) {
                    handleSubmit();
                } else if (queueUsable) {
                    queueMessageFromEvent();
                } else {
                    // Queue-unavailable busy sessions steer into the captured turn.
                    handleSubmit({ delivery: 'steer' });
                }
            } else {
                // steer: Enter steers into the running turn, Ctrl+Enter sends now.
                if (isCtrlEnter || !canQueue) {
                    handleSubmit();
                } else {
                    handleSubmit({ delivery: 'steer' });
                }
            }
        }
    };

    const measureCaretInTextarea = React.useCallback((textarea: HTMLTextAreaElement, cursorPosition: number) => {
        const doc = textarea.ownerDocument;
        const win = doc.defaultView;
        if (!win) return null;

        const style = win.getComputedStyle(textarea);
        const mirror = doc.createElement('div');
        const mirrorStyle = mirror.style;

        mirrorStyle.position = 'absolute';
        mirrorStyle.visibility = 'hidden';
        mirrorStyle.pointerEvents = 'none';
        mirrorStyle.whiteSpace = 'pre-wrap';
        mirrorStyle.wordWrap = 'break-word';
        mirrorStyle.overflow = 'hidden';
        mirrorStyle.left = '-9999px';
        mirrorStyle.top = '0';

        mirrorStyle.width = `${textarea.clientWidth}px`;
        mirrorStyle.font = style.font;
        mirrorStyle.fontSize = style.fontSize;
        mirrorStyle.fontFamily = style.fontFamily;
        mirrorStyle.fontWeight = style.fontWeight;
        mirrorStyle.fontStyle = style.fontStyle;
        mirrorStyle.fontVariant = style.fontVariant;
        mirrorStyle.letterSpacing = style.letterSpacing;
        mirrorStyle.textTransform = style.textTransform;
        mirrorStyle.textIndent = style.textIndent;
        mirrorStyle.padding = style.padding;
        mirrorStyle.border = style.border;
        mirrorStyle.boxSizing = style.boxSizing;
        mirrorStyle.lineHeight = style.lineHeight;
        mirrorStyle.tabSize = style.tabSize;

        mirror.textContent = textarea.value.slice(0, cursorPosition);
        const marker = doc.createElement('span');
        marker.textContent = textarea.value.slice(cursorPosition, cursorPosition + 1) || ' ';
        mirror.appendChild(marker);

        doc.body.appendChild(mirror);
        const top = marker.offsetTop;
        const left = marker.offsetLeft;
        doc.body.removeChild(mirror);

        return { top, left };
    }, []);

    const updateAutocompleteOverlayPosition = React.useCallback(() => {
        if (!isDesktopExpanded) {
            setAutocompleteOverlayPosition(null);
            return;
        }

        if (!showCommandAutocomplete && !showSkillAutocomplete && !showSnippetAutocomplete && !showFileMention) {
            setAutocompleteOverlayPosition(null);
            return;
        }

        const textarea = textareaRef.current;
        const container = dropZoneRef.current;
        if (!textarea || !container) return;

        const cursor = textarea.selectionStart ?? message.length;
        const caret = measureCaretInTextarea(textarea, cursor);
        if (!caret) return;

        const textareaRect = textarea.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();

        const caretY = textareaRect.top - containerRect.top + (caret.top - textarea.scrollTop);
        const caretX = textareaRect.left - containerRect.left + (caret.left - textarea.scrollLeft);

        const popupMargin = 8;
        const estimatedPopupHeight = 260;
        const spaceAbove = caretY - popupMargin;
        const spaceBelow = containerRect.height - caretY - popupMargin;
        const place: 'above' | 'below' = spaceBelow >= estimatedPopupHeight || spaceBelow >= spaceAbove ? 'below' : 'above';

        const desiredWidth = showFileMention ? 520 : showCommandAutocomplete || showSnippetAutocomplete ? 450 : 360;
        const clampedLeft = Math.max(
            popupMargin,
            Math.min(caretX - 24, containerRect.width - desiredWidth - popupMargin)
        );

        const maxHeight = Math.max(120, Math.min(estimatedPopupHeight, place === 'below' ? spaceBelow : spaceAbove));

        setAutocompleteOverlayPosition({
            top: place === 'below' ? caretY + 22 : caretY - 6,
            left: clampedLeft,
            place,
            maxHeight,
        });
    }, [
        isDesktopExpanded,
        measureCaretInTextarea,
        message.length,
        showCommandAutocomplete,
        showFileMention,
        showSnippetAutocomplete,
        showSkillAutocomplete,
    ]);

    React.useLayoutEffect(() => {
        updateAutocompleteOverlayPosition();
    }, [
        updateAutocompleteOverlayPosition,
        message,
        showCommandAutocomplete,
        showSkillAutocomplete,
        showSnippetAutocomplete,
        showFileMention,
        isDesktopExpanded,
    ]);

    React.useEffect(() => {
        if (!isDesktopExpanded) return;
        const onResize = () => updateAutocompleteOverlayPosition();
        window.addEventListener('resize', onResize);
        return () => {
            window.removeEventListener('resize', onResize);
        };
    }, [isDesktopExpanded, updateAutocompleteOverlayPosition]);

    const startAbortIndicator = React.useCallback(() => {
        if (abortTimeoutRef.current) {
            clearTimeout(abortTimeoutRef.current);
            abortTimeoutRef.current = null;
        }

        setShowAbortStatus(true);

        abortTimeoutRef.current = setTimeout(() => {
            setShowAbortStatus(false);
            abortTimeoutRef.current = null;
        }, 1800);
    }, []);

    const handleAbort = React.useCallback(() => {
        surfaceResources.abortPrompt.clear();
        startAbortIndicator();

        if (surface.kind === 'secondary') {
            void controllerWiring?.shortcut('abort');
            return;
        }
        void abortCurrentOperation();
    }, [abortCurrentOperation, controllerWiring, startAbortIndicator, surface.kind, surfaceResources]);

    const handleCycleAgent = React.useCallback((direction: 1 | -1 = 1) => {
        if (secondarySelectionUnavailable) return;
        const nextAgentName = getCycledPrimaryAgentName(agents, surface.selection.value.agent ?? currentAgentName, direction);
        if (!nextAgentName) return;
        if (!surface.selection.change) return;
        const nextSelection = resolveAgentModelSelection({
            providerID: surface.selection.value.providerID ?? '',
            modelID: surface.selection.value.modelID ?? '',
            agent: surface.selection.value.agent ?? null,
        }, nextAgentName, agents, providers);
        void surface.selection.change({ ...surface.selection.value, ...nextSelection, agent: nextSelection.agent ?? undefined });
        // Keep keyboard/mobile cycle isomorphic with ModelControls agent changes.
        if (surface.kind === 'primary') {
            useUIStore.getState().addRecentAgent(nextAgentName);
            if (surface.sessionID) {
                useSelectionStore.getState().saveSessionAgentSelection(surface.sessionID, nextAgentName);
            }
        }
    }, [agents, currentAgentName, providers, secondarySelectionUnavailable, surface.kind, surface.selection, surface.sessionID]);
    primaryCycleAgentRef.current = handleCycleAgent;

    // Height the dictation transcript needs (null when idle): the overlay sits
    // absolutely over the composer, so the underlying textarea must grow for
    // the composer to grow — feed this into the autosize below.
    const dictationContentHeightRef = React.useRef<number | null>(null);
    const [dictationContentHeight, setDictationContentHeight] = React.useState<number | null>(null);
    const handleDictationContentHeightChange = React.useCallback((height: number | null) => {
        setDictationContentHeight((prev) => (prev === height ? prev : height));
    }, []);

    const adjustTextareaHeight = React.useCallback((options?: { allowShrink?: boolean }) => {
        const textarea = textareaRef.current;
        if (!textarea) {
            return;
        }

        const previousScrollTop = textarea.scrollTop;

        if (isComposerExpanded) {
            textarea.style.height = '100%';
            textarea.style.maxHeight = 'none';
            textarea.style.overflowY = 'auto';
            setTextareaSize(null);
            if (textarea.scrollTop !== previousScrollTop) {
                textarea.scrollTop = previousScrollTop;
            }
            return;
        }

        // Measure with overflow clipped so scrollHeight is content height,
        // not a leftover scrollport from a previous cap.
        textarea.style.overflow = 'hidden';
        textarea.style.overflowX = 'hidden';
        textarea.style.overflowY = 'hidden';

        if (options?.allowShrink ?? true) {
            textarea.style.height = 'auto';
        }

        const view = textarea.ownerDocument?.defaultView;
        const computedStyle = view ? view.getComputedStyle(textarea) : null;
        const lineHeight = computedStyle ? parseFloat(computedStyle.lineHeight) : NaN;
        const paddingTop = computedStyle ? parseFloat(computedStyle.paddingTop) : NaN;
        const paddingBottom = computedStyle ? parseFloat(computedStyle.paddingBottom) : NaN;
        const fallbackLineHeight = 22;
        const fallbackPadding = 16;
        const paddingTotal = Number.isNaN(paddingTop) || Number.isNaN(paddingBottom)
            ? fallbackPadding
            : paddingTop + paddingBottom;
        const targetLineHeight = Number.isNaN(lineHeight) ? fallbackLineHeight : lineHeight;
        const sized = resolveComposerTextareaAutosize({
            scrollHeight: textarea.scrollHeight || textarea.offsetHeight,
            dictationHeight: dictationContentHeightRef.current ?? 0,
            lineHeight: targetLineHeight,
            paddingTotal,
        });

        textarea.style.height = `${sized.height}px`;
        textarea.style.maxHeight = `${sized.maxHeight}px`;
        textarea.style.overflowY = sized.overflowY;
        if (textarea.scrollTop !== previousScrollTop) {
            textarea.scrollTop = previousScrollTop;
        }

        setTextareaSize((prev) => {
            if (prev && prev.height === sized.height && prev.maxHeight === sized.maxHeight) {
                return prev;
            }
            return { height: sized.height, maxHeight: sized.maxHeight };
        });
    }, [isComposerExpanded]);

    React.useLayoutEffect(() => {
        const allowShrink = message.length < previousMessageLengthRef.current;
        previousMessageLengthRef.current = message.length;
        adjustTextareaHeight({ allowShrink });
    }, [adjustTextareaHeight, message, isMobile]);

    React.useLayoutEffect(() => {
        dictationContentHeightRef.current = dictationContentHeight;
        // Growing transcript never shrinks mid-recording (matches typing);
        // dictation ending (null) releases the height back to the message.
        adjustTextareaHeight({ allowShrink: dictationContentHeight === null });
    }, [adjustTextareaHeight, dictationContentHeight]);

    const updateAutocompleteState = React.useCallback((
        value: string,
        cursorPosition: number,
        inputSource: FileMentionAutocompleteInputSource = 'manual',
        insertedText?: string,
    ) => {
        const trigger = resolveComposerAutocompleteTrigger({
            text: value,
            cursor: cursorPosition,
            inputMode,
            mentionInputSource: inputSource,
            insertedText,
        });
        autocompleteTriggerRef.current = trigger;
        if (!trigger) {
            setShowCommandAutocomplete(false);
            setShowFileMention(false);
            setShowSkillAutocomplete(false);
            setShowSnippetAutocomplete(false);
            setSkillQuery('');
            return;
        }
        if (trigger.kind === 'slash-command') {
            setCommandQuery(trigger.query);
            setShowCommandAutocomplete(true);
            setShowFileMention(false);
            setShowSkillAutocomplete(false);
            setShowSnippetAutocomplete(false);
            return;
        }
        setShowCommandAutocomplete(false);
        if (trigger.kind === 'slash-skill') {
            setSkillQuery(trigger.query);
            setShowSkillAutocomplete(true);
            setShowFileMention(false);
            setShowSnippetAutocomplete(false);
            return;
        }
        setShowSkillAutocomplete(false);
        setSkillQuery('');
        if (trigger.kind === 'snippet') {
            setSnippetQuery(trigger.query);
            setShowSnippetAutocomplete(true);
            setShowFileMention(false);
            return;
        }
        setShowSnippetAutocomplete(false);
        setMentionQuery(trigger.query);
        setShowFileMention(true);
    }, [
        inputMode,
        setCommandQuery,
        setMentionQuery,
        setShowCommandAutocomplete,
        setShowFileMention,
        setShowSkillAutocomplete,
        setShowSnippetAutocomplete,
        setSkillQuery,
        setSnippetQuery,
    ]);

    const commitBrowserTextChange = React.useCallback((nextText: string, selectionStart: number, selectionEnd: number, inputSource: FileMentionAutocompleteInputSource = 'manual', insertedText?: string) => {
        // Hand-typed complete slash commands paint as chips. Promote compact
        // `/undo` source text to the reserved-slot form (`/\u2003undo`) so icon
        // spacing matches autocomplete selection. Skip during IME composition
        // so partial CJK input is not rewritten mid-composition.
        let textToCommit = nextText;
        let caretStart = selectionStart;
        let caretEnd = selectionEnd;
        if (
            inputMode === 'normal'
            && !nativeCompositionActiveRef.current
            && knownSlashNames.size > 0
            && nextText.includes('/')
        ) {
            const promoted = promoteTypedSlashChipSlots(nextText, knownSlashNames, selectionEnd);
            if (promoted) {
                textToCommit = promoted.text;
                const delta = promoted.caret - selectionEnd;
                caretStart = selectionStart + delta;
                caretEnd = promoted.caret;
            }
        }

        const selection = applyBrowserEdit(textToCommit, caretStart, caretEnd, (mentions, document) => {
            let next = [...mentions];
            for (const addition of collectConfirmableFileMentions(document.text, {
                agentNames: knownAgentNames,
                includeUnterminatedPastedReferences: inputSource === 'paste',
            })) {
                next = appendUniqueDraftMention(next, {
                    kind: addition.kind,
                    value: addition.value,
                    path: addition.value,
                    label: addition.value,
                    range: { start: addition.start, end: addition.end },
                });
            }
            return next;
        });
        const document = getDocument();
        const shouldCorrectTextarea = selection.requiresTextCorrection
            || caretStart !== selection.start
            || caretEnd !== selection.end
            || textToCommit !== nextText;
        requestAnimationFrame(() => {
            const textarea = textareaRef.current;
            // Native dictation and IMEs own an active replacement range. Preserve
            // it when Composer accepted the browser value and caret unchanged.
            // Promotion always rewrites source text, so force DOM correction then.
            if (textarea && shouldApplyComposerDomCorrection(shouldCorrectTextarea, nativeCompositionActiveRef.current)) {
                textarea.value = document.text;
                textarea.setSelectionRange(selection.start, selection.end);
            }
            adjustTextareaHeight();
        });
        updateAutocompleteState(document.text, selection.end, inputSource, insertedText);
        return { document, selection };
    }, [adjustTextareaHeight, applyBrowserEdit, getDocument, inputMode, knownAgentNames, knownSlashNames, updateAutocompleteState]);

    const insertTextAtSelection = React.useCallback((
        text: string,
        inputSource: FileMentionAutocompleteInputSource = 'manual',
    ) => {
        if (!text) {
            return;
        }

        const textarea = textareaRef.current;
        if (!textarea) {
            const nextValue = message + text;
            commitBrowserTextChange(nextValue, nextValue.length, nextValue.length, inputSource, text);
            return;
        }

        const start = textarea.selectionStart ?? message.length;
        const end = textarea.selectionEnd ?? message.length;
        const nextValue = `${message.substring(0, start)}${text}${message.substring(end)}`;
        const cursorPosition = start + text.length;
        commitBrowserTextChange(nextValue, cursorPosition, cursorPosition, inputSource, text);
    }, [commitBrowserTextChange, message]);

    // Programmatic paste paths (pasted-text compaction, image citations, file
    // path mentions) replace the selection without a browser change event, so
    // orphaned attachments are reconciled against the resulting text here.
    const detachAttachmentsMissingCitations = useEvent((previousText: string, nextText: string) => {
        const detached = new Set(collectDetachedAttachmentFilenames(
            attachedFiles.map((file) => file.filename),
            previousText,
            nextText,
        ));
        if (detached.size === 0) return;
        for (const file of attachedFiles) {
            if (detached.has(file.filename)) {
                surfaceResources.removeAttachment(file.id);
            }
        }
    });

    // Store removeDraftAttachment clears inline citations in the same revision.
    const handleAttachedFileRemove = React.useCallback((file: AttachedFile) => {
        void surfaceResources.removeAttachment(file.id);
    }, [surfaceResources]);

    const clearDropTextSuppression = React.useCallback(() => {
        suppressNextFileDropTextInsertRef.current = false;
        pendingDroppedAbsolutePathsRef.current = [];
        if (suppressNextFileDropTextInsertTimeoutRef.current) {
            clearTimeout(suppressNextFileDropTextInsertTimeoutRef.current);
            suppressNextFileDropTextInsertTimeoutRef.current = null;
        }
    }, []);

    const scheduleDropTextSuppressionExpiry = React.useCallback(() => {
        if (suppressNextFileDropTextInsertTimeoutRef.current) {
            clearTimeout(suppressNextFileDropTextInsertTimeoutRef.current);
        }
        suppressNextFileDropTextInsertTimeoutRef.current = setTimeout(() => {
            clearDropTextSuppression();
        }, 700);
    }, [clearDropTextSuppression]);

    const clearFileMentionPasteSuppression = React.useCallback(() => {
        suppressNextFileMentionPasteRef.current = false;
        if (suppressNextFileMentionPasteTimeoutRef.current) {
            clearTimeout(suppressNextFileMentionPasteTimeoutRef.current);
            suppressNextFileMentionPasteTimeoutRef.current = null;
        }
    }, []);

    const markFileMentionPasteSuppression = React.useCallback(() => {
        suppressNextFileMentionPasteRef.current = true;
        if (suppressNextFileMentionPasteTimeoutRef.current) {
            clearTimeout(suppressNextFileMentionPasteTimeoutRef.current);
        }
        suppressNextFileMentionPasteTimeoutRef.current = setTimeout(() => {
            suppressNextFileMentionPasteRef.current = false;
            suppressNextFileMentionPasteTimeoutRef.current = null;
        }, 700);
    }, []);

    const handleBeforeInput = React.useCallback((e: React.FormEvent<HTMLTextAreaElement>) => {
        if (!isVSCodeRuntime() || !suppressNextFileDropTextInsertRef.current) {
            return;
        }

        const nativeInputEvent = e.nativeEvent as InputEvent | undefined;
        if (nativeInputEvent?.inputType === 'insertFromDrop') {
            e.preventDefault();
            clearDropTextSuppression();
        }
    }, [clearDropTextSuppression]);

    const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        // Leader chord owns the keyboard: ignore stray IME/text mutations so
        // compose letters never land in the controlled composer value.
        if (isLeaderKeyPending) {
            return;
        }

        const nativeInputEvent = e.nativeEvent as InputEvent | undefined;
        if (isVSCodeRuntime() && suppressNextFileDropTextInsertRef.current) {
            const candidateAbsolutePaths = pendingDroppedAbsolutePathsRef.current;
            const isLikelyDropTextInsertion = nativeInputEvent?.inputType === 'insertFromDrop'
                || candidateAbsolutePaths.some((path) => path.length > 0 && e.target.value.includes(path));

            if (isLikelyDropTextInsertion) {
                clearDropTextSuppression();
                return;
            }
        }

        const value = e.target.value;
        detachAttachmentsMissingCitations(messageRef.current, value);
        const cursorPosition = e.target.selectionStart ?? value.length;
        const pastedInsertedText = nativeInputEvent?.inputType?.startsWith('insertFromPaste')
            ? getInsertedTextFromChange(messageRef.current, value)
            : '';
        const isPasteInput = pastedInsertedText.includes('@') || suppressNextFileMentionPasteRef.current;
        if (suppressNextFileMentionPasteRef.current) {
            clearFileMentionPasteSuppression();
        }
        const inputSource: FileMentionAutocompleteInputSource = isPasteInput
            ? 'paste'
            : 'manual';

        if (inputMode === 'normal' && value.startsWith('!')) {
            const shellCommand = value.slice(1);
            const nextCursor = Math.max(0, cursorPosition - 1);
            setInputMode('shell');
            replacePlainDocument(shellCommand);
            adjustTextareaHeight();
            setShowCommandAutocomplete(false);
            setShowSkillAutocomplete(false);
            setShowFileMention(false);
            requestAnimationFrame(() => {
                if (textareaRef.current) {
                    textareaRef.current.selectionStart = nextCursor;
                    textareaRef.current.selectionEnd = nextCursor;
                }
            });
            return;
        }

        commitBrowserTextChange(value, cursorPosition, e.target.selectionEnd ?? cursorPosition, inputSource, pastedInsertedText);
    };

    React.useEffect(() => {
        return () => {
            clearDropTextSuppression();
            clearFileMentionPasteSuppression();
        };
    }, [clearDropTextSuppression, clearFileMentionPasteSuppression]);

    const addDroppedPathsAsMentions = React.useCallback((paths: string[]) => {
        const uniquePaths = Array.from(new Set(paths.map((path) => path.trim()).filter(Boolean)));
        if (uniquePaths.length === 0) {
            return;
        }

        const mentions = uniquePaths.map((path) => `@${path}`).join(' ');
        const textarea = textareaRef.current;
        const selectionStart = textarea?.selectionStart ?? message.length;
        const selectionEnd = textarea?.selectionEnd ?? message.length;
        const insertion = withReferenceInsertionBoundaries(
            mentions,
            message.slice(0, selectionStart),
            message.slice(selectionEnd),
        );
        const next = `${message.slice(0, selectionStart)}${insertion}${message.slice(selectionEnd)}`;
        detachAttachmentsMissingCitations(message, next);
        replaceWithConfirmedFileMentions(next, uniquePaths);
    }, [message, replaceWithConfirmedFileMentions, detachAttachmentsMissingCitations]);

    const handlePaste = React.useCallback(async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
        const pastedFilePaths = collectFilePathsFromTransfer(e.clipboardData);
        if (pastedFilePaths.length > 0 && (currentSessionId || newSessionDraftOpen)) {
            e.preventDefault();
            addDroppedPathsAsMentions(pastedFilePaths);
            return;
        }

        // Pasting a URL over a selection wraps it as a markdown link:
        // [selected text](pasted url).
        if (inputMode === 'normal' && (currentSessionId || newSessionDraftOpen)) {
            const ta = textareaRef.current;
            const selStart = ta?.selectionStart ?? -1;
            const selEnd = ta?.selectionEnd ?? -1;
            if (ta && selEnd > selStart) {
                const clipboardText = e.clipboardData.getData('text');
                const url = clipboardText.trim();
                const selected = message.slice(selStart, selEnd);
                if (
                    PASTE_LINK_URL_PATTERN.test(url)
                    && !/\s/.test(url)
                    && selected.trim().length > 0
                    && !selected.includes('](')
                ) {
                    e.preventDefault();
                    const next = `${message.slice(0, selStart)}[${selected}](${url})${message.slice(selEnd)}`;
                    const caret = selStart + 1 + selected.length + 2 + url.length + 1;
                    applyProgrammaticEdit(next);
                    requestAnimationFrame(() => {
                        const current = textareaRef.current;
                        if (current) {
                            current.selectionStart = caret;
                            current.selectionEnd = caret;
                        }
                        adjustTextareaHeight();
                    });
                    updateAutocompleteState(next, caret, getFileMentionInputSourceForInsertedText(url), url);
                    return;
                }
            }
        }

        // Prefer clipboard.files; only fall back to items. Reading both often
        // yields the same image twice (or png+tiff twins) with different name/size
        // keys, which then becomes two attachments for one paste.
        const filesFromClipboard = Array.from(e.clipboardData.files || [])
            .filter((file) => file.type.startsWith('image/'));
        const filesFromItems = Array.from(e.clipboardData.items || [])
            .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
            .map((item) => item.getAsFile())
            .filter((file): file is File => Boolean(file));
        // macOS often exposes the same screenshot as image/png + image/tiff via items.
        // When we only have items, keep a single preferred representation.
        const imageFiles = filesFromClipboard.length > 0
            ? filesFromClipboard
            : (() => {
                if (filesFromItems.length <= 1) return filesFromItems;
                const preferred = filesFromItems.find((file) => /image\/(png|webp|jpe?g|gif)/i.test(file.type));
                return preferred ? [preferred] : [filesFromItems[0]];
            })();
        const pastedText = e.clipboardData.getData('text');
        if (imageFiles.length === 0) {
            if (inputMode === 'normal' && canCompactPastedText(getDocument(), pastedText)) {
                e.preventDefault();
                const textBeforeReplacement = getDocument().text;
                const textarea = textareaRef.current;
                const selectionStart = textarea?.selectionStart ?? message.length;
                const selectionEnd = textarea?.selectionEnd ?? message.length;
                const reference = createPastedTextReference(
                    pastedText,
                    message,
                    getDocument().references.flatMap((item) => item.kind === 'paste' ? [{ id: item.id, token: item.display, text: item.text, characterCount: item.characterCount, index: item.index }] : []),
                    ({ index, count }) => t('chat.chatInput.pastedTextReference', { index, count }),
                    getNextPastedTextReferenceIndex(getDocument()),
                );
                const next = insertReference(selectionStart, selectionEnd, {
                    id: reference.id,
                    kind: 'paste',
                    text: reference.text,
                    characterCount: reference.characterCount,
                    index: reference.index,
                    display: reference.token,
                }, { inlineBoundaries: true, padDocumentEdges: true });
                const caret = advancePastTrailingBoundarySpace(next.document.text, next.caret);
                if (textareaRef.current) textareaRef.current.value = next.document.text;
                requestAnimationFrame(() => {
                    textareaRef.current?.setSelectionRange(caret, caret);
                    adjustTextareaHeight();
                });
                updateAutocompleteState(next.document.text, caret);
                detachAttachmentsMissingCitations(textBeforeReplacement, next.document.text);
                return;
            }
            if (pastedText.includes('@')) {
                markFileMentionPasteSuppression();
            }
            return;
        }

        if (!currentSessionId && !newSessionDraftOpen) {
            if (pastedText.includes('@')) {
                markFileMentionPasteSuppression();
            }
            return;
        }

        e.preventDefault();

        const assignedFilenames = assignImageAttachmentFilenames(
            imageFiles,
            [
                ...attachedFiles.map((file) => file.filename),
                ...pendingPastedAttachmentFilenamesRef.current,
            ],
        );
        const citationText = buildAttachmentCitationText(assignedFilenames);
        const textBeforeReplacement = getDocument().text;
        const textarea = textareaRef.current;
        const selectionStart = textarea?.selectionStart ?? message.length;
        const selectionEnd = textarea?.selectionEnd ?? message.length;
        const pastedTextReference = inputMode === 'normal' && canCompactPastedText(getDocument(), pastedText)
            ? createPastedTextReference(
                pastedText,
                message,
                getDocument().references.flatMap((item) => item.kind === 'paste' ? [{ id: item.id, token: item.display, text: item.text, characterCount: item.characterCount, index: item.index }] : []),
                ({ index, count }) => t('chat.chatInput.pastedTextReference', { index, count }),
                getNextPastedTextReferenceIndex(getDocument()),
            )
            : null;
        const insertionContent = pastedText
                ? `${pastedText}${/\s$/.test(pastedText) ? '' : ' '}${citationText}`
                : citationText;
        const insertionText = withReferenceInsertionBoundaries(
            insertionContent,
            message.slice(0, selectionStart),
            message.slice(selectionEnd),
        );
        if (pastedTextReference) {
            const inserted = insertReference(selectionStart, selectionEnd, {
                id: pastedTextReference.id,
                kind: 'paste',
                text: pastedTextReference.text,
                characterCount: pastedTextReference.characterCount,
                index: pastedTextReference.index,
                display: pastedTextReference.token,
            }, { inlineBoundaries: true, padDocumentEdges: true });
            const pasteCaret = advancePastTrailingBoundarySpace(inserted.document.text, inserted.caret);
            const nextText = `${inserted.document.text.slice(0, pasteCaret)}${citationText}${inserted.document.text.slice(pasteCaret)}`;
            // paste chip already left a trailing boundary space; citation follows immediately
            commitBrowserTextChange(nextText, pasteCaret + citationText.length, pasteCaret + citationText.length, getFileMentionInputSourceForInsertedText(nextText), citationText);
            detachAttachmentsMissingCitations(textBeforeReplacement, nextText);
        } else {
            insertTextAtSelection(insertionText, getFileMentionInputSourceForInsertedText(insertionText));
            // Mirror insertTextAtSelection's splice to know the resulting text.
            detachAttachmentsMissingCitations(textBeforeReplacement, `${message.slice(0, selectionStart)}${insertionText}${message.slice(selectionEnd)}`);
        }

        for (let index = 0; index < imageFiles.length; index += 1) {
            const filename = assignedFilenames[index];
            const file = renameFileForAttachmentCitation(imageFiles[index], filename);
            pendingPastedAttachmentFilenamesRef.current.add(filename);
            try {
                await surfaceResources.addAttachment(file);
            } catch (error) {
                console.error('Clipboard image attach failed', error);
                toast.error(error instanceof Error ? error.message : t('chat.chatInput.toast.clipboardAttachFailed'));
            } finally {
                pendingPastedAttachmentFilenamesRef.current.delete(filename);
            }
        }
    }, [surfaceResources, addDroppedPathsAsMentions, attachedFiles, adjustTextareaHeight, currentSessionId, getDocument, inputMode, insertReference, markFileMentionPasteSuppression, message, newSessionDraftOpen, insertTextAtSelection, t, updateAutocompleteState, commitBrowserTextChange, applyProgrammaticEdit, detachAttachmentsMissingCitations]);

    /**
     * Copy/cut emit semantic plain text (no reserved icon em-spaces) so pasting
     * a chip into another input does not leave a visible gap or break `\s` slash
     * parsers. ChatInput re-promotes known slash tokens on the next edit.
     */
    const writeComposerSelectionToClipboard = React.useCallback((
        event: React.ClipboardEvent<HTMLTextAreaElement>,
        mode: 'copy' | 'cut',
    ) => {
        const textarea = event.currentTarget;
        const selectionStart = textarea.selectionStart ?? 0;
        const selectionEnd = textarea.selectionEnd ?? selectionStart;
        if (selectionEnd <= selectionStart) return;

        const atomicSelection = resolveAtomicReferenceSelection(
            selectionStart,
            selectionEnd,
            [
                ...findAttachmentCitationRanges(
                    message,
                    attachedFiles.filter(isInlineAttachmentCitation).map((file) => file.filename),
                ),
                ...findSkillMentionRanges(message, availableSkillNames.keys()),
                ...getDocument().references,
            ],
        );
        const rangeStart = atomicSelection?.start ?? selectionStart;
        const rangeEnd = atomicSelection?.end ?? selectionEnd;
        const selected = message.slice(rangeStart, rangeEnd);
        const plain = stripComposerTriggerIconSlotsForPlainText(selected);
        if (plain === selected && !atomicSelection) return;

        event.preventDefault();
        event.clipboardData.setData('text/plain', plain);
        if (mode === 'cut') {
            const next = `${message.slice(0, rangeStart)}${message.slice(rangeEnd)}`;
            commitBrowserTextChange(next, rangeStart, rangeStart);
            requestAnimationFrame(() => {
                textareaRef.current?.setSelectionRange(rangeStart, rangeStart);
                adjustTextareaHeight();
            });
        } else if (atomicSelection && (atomicSelection.start !== selectionStart || atomicSelection.end !== selectionEnd)) {
            // Keep selection aligned with the chip the user intended to copy.
            requestAnimationFrame(() => {
                textareaRef.current?.setSelectionRange(rangeStart, rangeEnd);
            });
        }
    }, [adjustTextareaHeight, attachedFiles, availableSkillNames, commitBrowserTextChange, getDocument, message]);

    const handleCopy = React.useCallback((event: React.ClipboardEvent<HTMLTextAreaElement>) => {
        writeComposerSelectionToClipboard(event, 'copy');
    }, [writeComposerSelectionToClipboard]);

    const handleCut = React.useCallback((event: React.ClipboardEvent<HTMLTextAreaElement>) => {
        writeComposerSelectionToClipboard(event, 'cut');
    }, [writeComposerSelectionToClipboard]);

    const readComposerInsertCaret = (documentLength: number): number => {
        const textarea = textareaRef.current;
        const raw = textarea && document.activeElement === textarea
            ? textarea.selectionStart ?? cursorPosRef.current
            : cursorPosRef.current;
        return resolveComposerInsertCaret(documentLength, raw);
    };
    const restoreWebComposerFocus = () => {
        if (canUseNativeIosComposer(isMobile)) return;
        textareaRef.current?.focus();
    };

    const handleFileSelect = (file: { name: string; path: string; relativePath?: string; isDirectory?: boolean }) => {

        const cursorPosition = readComposerInsertCaret(message.length);
        const range = resolveComposerAutocompleteReplaceRange(
            message,
            cursorPosition,
            autocompleteTriggerRef.current,
        );
        const textBeforeCursor = message.substring(0, cursorPosition);
        const lastAtSymbol = textBeforeCursor.lastIndexOf('@');

        const mentionPath = (file.relativePath && file.relativePath.trim().length > 0)
            ? file.relativePath.trim()
            : (toProjectRelativeMentionPath(file.path) || file.name);
        const directoryPaths = file.isDirectory ? [mentionPath] : [];

        const startIndex = range?.start ?? (lastAtSymbol !== -1 ? lastAtSymbol : cursorPosition);
        const endIndex = range?.end ?? cursorPosition;
        const inserted = insertTokenWithReferenceBoundaries(message, startIndex, endIndex, `@${mentionPath}`);
        replaceWithConfirmedFileMentions(inserted.text, [mentionPath], directoryPaths);
        cursorPosRef.current = inserted.caret;
        requestAnimationFrame(() => {
            if (textareaRef.current) {
                textareaRef.current.selectionStart = inserted.caret;
                textareaRef.current.selectionEnd = inserted.caret;
            }
            adjustTextareaHeight();
            updateAutocompleteState(inserted.text, inserted.caret);
        });

        setShowFileMention(false);
        setMentionQuery('');

        restoreWebComposerFocus();
    };

    const handleAgentSelect = (agentName: string) => {
        const cursorPosition = readComposerInsertCaret(message.length);
        const range = resolveComposerAutocompleteReplaceRange(
            message,
            cursorPosition,
            autocompleteTriggerRef.current,
        );
        const textBeforeCursor = message.substring(0, cursorPosition);
        const lastAtSymbol = textBeforeCursor.lastIndexOf('@');
        const startIndex = range?.start ?? (lastAtSymbol !== -1 ? lastAtSymbol : cursorPosition);
        const endIndex = range?.end ?? cursorPosition;
        const inserted = insertTokenWithReferenceBoundaries(message, startIndex, endIndex, `@${agentName}`);
        applyProgrammaticEdit(inserted.text, (mentions) => appendUniqueDraftMention(mentions, {
            kind: 'agent',
            value: agentName,
            path: agentName,
            label: agentName,
            range: { start: inserted.start, end: inserted.end },
        }));

        cursorPosRef.current = inserted.caret;
        requestAnimationFrame(() => {
            if (textareaRef.current) {
                textareaRef.current.selectionStart = inserted.caret;
                textareaRef.current.selectionEnd = inserted.caret;
            }
            adjustTextareaHeight();
            updateAutocompleteState(inserted.text, inserted.caret);
        });

        setShowFileMention(false);
        setMentionQuery('');

        restoreWebComposerFocus();
    };

    const handleSessionSelect = useEvent((session: { id: string; title?: string }) => {
        if (pendingSessionReferenceRef.current) return;
        pendingSessionReferenceRef.current = true;
        void (async () => {
            try {
                const sessionDirectory = useSessionUIStore.getState().getAuthoritativeDirectoryForSession(session.id);
                if (!sessionDirectory) {
                    toast.error(t('chat.chatInput.toast.sessionReferenceLoadFailed'));
                    return;
                }

                await ensureSessionRenderable(session.id, { directory: sessionDirectory });

                if (!resolveMaterializedSessionDirectory(session.id, sessionDirectory)) {
                    toast.error(t('chat.chatInput.toast.sessionReferenceLoadFailed'));
                    return;
                }

                // Background prefetch: page the referenced transcript fully into the cache so
                // send-time inlining usually carries content. Failure is non-fatal — the send
                // boundary's session-mention instruction embeds a read-only retrieval recipe.
                void ensureSessionMentionTranscripts([{ type: 'session', sessionId: session.id }], sessionDirectory).catch(() => undefined);

                const document = getDocument();
                const cursorPosition = readComposerInsertCaret(document.text.length);
                const range = resolveComposerAutocompleteReplaceRange(
                    document.text,
                    cursorPosition,
                    autocompleteTriggerRef.current,
                );
                const textBeforeCursor = document.text.substring(0, cursorPosition);
                const lastAtSymbol = textBeforeCursor.lastIndexOf('@');
                const sessionTitle = getAllSyncSessionMap().get(session.id)?.title || session.title || session.id;
                const mentionStart = range?.start ?? (lastAtSymbol !== -1 ? lastAtSymbol : cursorPosition);
                const mentionEnd = range?.end ?? cursorPosition;
                const sessionReference: Omit<SessionComposerReference, 'start' | 'end'> = {
                    id: `session:${session.id}:${createUuid()}`,
                    kind: 'session',
                    sessionId: session.id,
                    display: composerTriggerIconDisplay({ trigger: '@', icon: 'chat-thread', label: sessionTitle }),
                };
                const inserted = insertReference(mentionStart, mentionEnd, sessionReference, { inlineBoundaries: true, padDocumentEdges: true });
                const caret = advancePastTrailingBoundarySpace(inserted.document.text, inserted.caret);
                cursorPosRef.current = caret;
                requestAnimationFrame(() => {
                    if (textareaRef.current) {
                        textareaRef.current.selectionStart = caret;
                        textareaRef.current.selectionEnd = caret;
                    }
                    adjustTextareaHeight();
                    updateAutocompleteState(inserted.document.text, caret);
                });
                setShowFileMention(false);
                setMentionQuery('');
                restoreWebComposerFocus();
            } catch {
                toast.error(t('chat.chatInput.toast.sessionReferenceLoadFailed'));
            } finally {
                pendingSessionReferenceRef.current = false;
            }
        })();
    });

    const insertSlashReference = useEvent((reference: Parameters<typeof insertReference>[2]): boolean => {
        const document = getDocument();
        const cursorPosition = readComposerInsertCaret(document.text.length);
        const range = resolveComposerAutocompleteReplaceRange(
            document.text,
            cursorPosition,
            autocompleteTriggerRef.current,
        ) ?? getSlashTokenRange(document.text, cursorPosition);
        if (!range) return false;

        // Trailing edge space keeps room for args; no leading edge space before `/`
        // (that auto space sits outside chip metrics and is what users undo to “fix” /loop).
        const inserted = insertReference(range.start, range.end, reference, {
            inlineBoundaries: true,
            padDocumentEdges: true,
            padLeadingDocumentEdge: false,
        });
        const insertedReference = inserted.document.references.some((candidate) => candidate.id === reference.id);
        const caret = advancePastTrailingBoundarySpace(inserted.document.text, inserted.caret);
        cursorPosRef.current = caret;
        requestAnimationFrame(() => {
            if (textareaRef.current) {
                textareaRef.current.selectionStart = caret;
                textareaRef.current.selectionEnd = caret;
            }
            adjustTextareaHeight();
            updateAutocompleteState(inserted.document.text, caret);
            if (insertedReference) {
                setShowCommandAutocomplete(false);
                setShowSkillAutocomplete(false);
            }
        });
        restoreWebComposerFocus();
        return insertedReference;
    });

    const handleSkillSelect = (skill: SkillInfo) => {
        if (insertSlashReference({
            id: `skill:${skill.name}:${createUuid()}`,
            kind: 'skill',
            skillName: skill.name,
            display: composerTriggerIconDisplay({ trigger: '/', icon: 'book-open', label: skill.name }),
        })) setSkillQuery('');
    };

    const handleSnippetSelect = (_snippet: unknown, trigger: string) => {
        const cursorPosition = readComposerInsertCaret(message.length);
        const range = resolveComposerAutocompleteReplaceRange(
            message,
            cursorPosition,
            autocompleteTriggerRef.current,
        );
        const textBeforeCursor = message.substring(0, cursorPosition);
        const lastHashSymbol = textBeforeCursor.lastIndexOf('#');
        const startIndex = range?.start ?? (lastHashSymbol !== -1 ? lastHashSymbol : cursorPosition);
        const endIndex = range?.end ?? cursorPosition;
        const newMessage = `${message.substring(0, startIndex)}#${trigger} ${message.substring(endIndex)}`;
        applyProgrammaticEdit(newMessage);
        const nextCursor = startIndex + trigger.length + 2;
        cursorPosRef.current = nextCursor;
        requestAnimationFrame(() => {
            if (textareaRef.current) {
                textareaRef.current.selectionStart = nextCursor;
                textareaRef.current.selectionEnd = nextCursor;
            }
            adjustTextareaHeight();
            updateAutocompleteState(newMessage, nextCursor);
        });
        setShowSnippetAutocomplete(false);
        setSnippetQuery('');
        restoreWebComposerFocus();
    };

    const handleCommandSelect = (command: CommandInfo, submit = false) => {
        if (!isChatInputCommandAllowed(surface, command)) return;

        const commandText = `/${command.name}`;

        if (!submit && command.isSkill) {
            if (insertSlashReference({
                id: `skill:${command.name}:${createUuid()}`,
                kind: 'skill',
                skillName: command.name,
                display: composerTriggerIconDisplay({ trigger: '/', icon: 'book-open', label: command.name }),
            })) setCommandQuery('');
            return;
        }

        // Same durable reserved-slot chip path for every non-built-in OpenCode
        // command (including when `isBuiltIn` is omitted). A missing flag used
        // to fall through to plain `/name ` and paint a compact trigger.
        if (!submit && command.source === 'opencode' && !command.isSkill && command.isBuiltIn !== true) {
            if (insertSlashReference({
                id: `command:${command.name}:${createUuid()}`,
                kind: 'command',
                commandName: command.name,
                reference: command.reference ?? command.name,
                display: composerTriggerIconDisplay({ trigger: '/', icon: 'command', label: command.name }),
            })) {
                setCommandQuery('');
                return;
            }
            // No slash token at the caret — fall through to reserved plain insert.
        }

        // Plain inserts still reserve the icon em-space so overlay metrics match
        // the durable chip path above (OpenChamber draft commands, failed insert).
        const plainInsert = command.isSkill ? `   ${commandText} ` : `${commandText} `;
        const promotedInsert = promoteTypedSlashChipSlots(
            plainInsert,
            new Set([...knownSlashNames, command.name.toLowerCase()]),
            plainInsert.length,
        );
        replacePlainDocument(promotedInsert?.text ?? plainInsert);

        const textareaElement = textareaRef.current as HTMLTextAreaElement & { _commandMetadata?: typeof command };
        if (textareaElement) {
            textareaElement._commandMetadata = command;
        }

        setShowCommandAutocomplete(false);
        setCommandQuery('');

        if (submit) {
            void handleSubmit({ presetText: commandText });
            return;
        }

        const refocus = () => {
            if (canUseNativeIosComposer(isMobile)) return;
            if (textareaRef.current) {
                try {
                    textareaRef.current.focus({ preventScroll: true });
                } catch {
                    textareaRef.current.focus();
                }
                textareaRef.current.setSelectionRange(textareaRef.current.value.length, textareaRef.current.value.length);
            }
        };

        requestAnimationFrame(() => {
            refocus();
            requestAnimationFrame(refocus);
        });
        setTimeout(refocus, 60);
    };

    React.useEffect(() => {

        if (currentSessionId && textareaRef.current && !isMobile) {
            textareaRef.current.focus();
        }
    }, [currentSessionId, isMobile]);

    React.useEffect(() => {
        if (!isMobile) {
            setMobileControlsPanel(null);
        }
    }, [isMobile]);

    const abortPromptSessionID = surfaceResources.abortPrompt.sessionID;
    const clearAbortPromptForSurface = surfaceResources.abortPrompt.clear;
    React.useEffect(() => {
        if (abortPromptSessionID && abortPromptSessionID !== currentSessionId) {
            clearAbortPromptForSurface();
        }
    }, [currentSessionId, abortPromptSessionID, clearAbortPromptForSurface]);

    React.useEffect(() => {
        canAcceptDropRef.current = Boolean(currentSessionId || newSessionDraftOpen);
    }, [currentSessionId, newSessionDraftOpen]);

    const hasDraggedFiles = React.useCallback((dataTransfer: DataTransfer | null | undefined): boolean => {
        if (!dataTransfer) return false;
        if (dataTransfer.files && dataTransfer.files.length > 0) return true;
        if (dataTransfer.types) {
            const types = Array.from(dataTransfer.types);
            const lowerTypes = types.map((type) => type.toLowerCase());
            if (lowerTypes.includes('files')) return true;
            if (lowerTypes.includes('text/uri-list')) return true;
            if (lowerTypes.includes('codefiles')) return true;
            if (lowerTypes.includes('application/x-openchamber-file-path')) return true;
            if (lowerTypes.some((type) => type.includes('vnd.code.tree'))) return true;
        }

        if (collectFileDropReferences(dataTransfer).length > 0) {
            return true;
        }

        return false;
    }, []);

    const collectDroppedFiles = React.useCallback((dataTransfer: DataTransfer | null | undefined): File[] => {
        if (!dataTransfer) return [];

        const directFiles = Array.from(dataTransfer.files || []);
        if (directFiles.length > 0) {
            return directFiles;
        }

        const fromItems = Array.from(dataTransfer.items || [])
            .filter((item) => item.kind === 'file')
            .map((item) => item.getAsFile())
            .filter((file): file is File => Boolean(file));

        return fromItems;
    }, []);

    const toProjectRelativeMentionPath = React.useCallback((absolutePath: string): string => {
        const normalizedAbsolutePath = absolutePath.replace(/\\/g, '/').trim();
        const normalizedRoot = (chatSearchDirectory || '').replace(/\\/g, '/').replace(/\/+$/, '');
        if (!normalizedRoot) {
            return normalizedAbsolutePath;
        }
        if (normalizedAbsolutePath === normalizedRoot) {
            return normalizedAbsolutePath;
        }
        const rootWithSlash = `${normalizedRoot}/`;
        if (normalizedAbsolutePath.startsWith(rootWithSlash)) {
            return normalizedAbsolutePath.slice(rootWithSlash.length);
        }
        return normalizedAbsolutePath;
    }, [chatSearchDirectory]);

    const handleDragEnter = (e: React.DragEvent) => {
        if (!hasDraggedFiles(e.dataTransfer)) {
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        dragEnterCountRef.current++;
        const isInternal = e.dataTransfer.types?.includes('application/x-openchamber-file-path') ?? false;
        if (isInternal !== isInternalDrag) {
            setIsInternalDrag(isInternal);
        }
        if ((currentSessionId || newSessionDraftOpen) && !isDragging) {
            setIsDragging(true);
        }
    };

    const handleDragOver = (e: React.DragEvent) => {
        if (!hasDraggedFiles(e.dataTransfer)) {
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'copy';
        if ((currentSessionId || newSessionDraftOpen) && !isDragging) {
            setIsDragging(true);
        }
    };

    const handleDragLeave = (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        dragEnterCountRef.current--;
        if (dragEnterCountRef.current <= 0) {
            dragEnterCountRef.current = 0;
            setIsDragging(false);
            setIsInternalDrag(false);
            clearDropTextSuppression();
        }
    };

    const handleDragEnd = () => {
        dragEnterCountRef.current = 0;
        setIsDragging(false);
        setIsInternalDrag(false);
        clearDropTextSuppression();
    };

    const handleDrop = async (e: React.DragEvent) => {
        dragEnterCountRef.current = 0;
        const draggedFiles = hasDraggedFiles(e.dataTransfer);
        if (!draggedFiles) {
            clearDropTextSuppression();
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        setIsDragging(false);

        if (!currentSessionId && !newSessionDraftOpen) return;

        // Internal drag: file tree → chat input (relative path as @mention)
        const internalPath = e.dataTransfer.getData('application/x-openchamber-file-path');
        if (internalPath && internalPath !== '.') {
            const mention = `@${internalPath}`;
            const textarea = textareaRef.current;
            const currentMessage = messageRef.current;
            if (textarea) {
                const pos = textarea.selectionStart ?? cursorPosRef.current;
                const end = textarea.selectionEnd ?? pos;
                const inserted = insertTokenWithReferenceBoundaries(currentMessage, pos, end, mention);
                applyProgrammaticEdit(inserted.text);
                requestAnimationFrame(() => {
                    textarea.selectionStart = inserted.caret;
                    textarea.selectionEnd = inserted.caret;
                    cursorPosRef.current = inserted.caret;
                    textarea.focus();
                });
            } else {
                const inserted = insertTokenWithReferenceBoundaries(currentMessage, currentMessage.length, currentMessage.length, mention);
                applyProgrammaticEdit(inserted.text);
            }
            clearDropTextSuppression();
            return;
        }

        const droppedFilePaths = collectFilePathsFromTransfer(e.dataTransfer);
        if (droppedFilePaths.length > 0) {
            if (isVSCodeRuntime()) {
                pendingDroppedAbsolutePathsRef.current = droppedFilePaths;
            }
            addDroppedPathsAsMentions(droppedFilePaths);
            if (!isVSCodeRuntime()) {
                clearDropTextSuppression();
            }
            return;
        }

        const files = collectDroppedFiles(e.dataTransfer);

        if (files.length > 0) {
            const citationText = buildAttachmentCitationText(files.map((file) => file.name));
            const insertionText = withReferenceInsertionBoundaries(
                citationText,
                messageRef.current.slice(0, textareaRef.current?.selectionStart ?? messageRef.current.length),
                messageRef.current.slice(textareaRef.current?.selectionEnd ?? messageRef.current.length),
            );
            insertTextAtSelection(insertionText);
            for (const file of files) {
                try {
                    await surfaceResources.addAttachment(file);
                } catch (error) {
                    console.error('File attach failed', error);
                    toast.error(error instanceof Error ? error.message : t('chat.chatInput.toast.attachFileFailed'));
                }
            }
        }
        clearDropTextSuppression();
    };

    const handleDropCapture = (e: React.DragEvent) => {
        if (!hasDraggedFiles(e.dataTransfer)) {
            return;
        }
        // Prevent native textarea drop text insertion for all runtimes
        e.preventDefault();
        if (isVSCodeRuntime()) {
            suppressNextFileDropTextInsertRef.current = true;
            scheduleDropTextSuppressionExpiry();
        }
    };

    const fileInputRef = React.useRef<HTMLInputElement>(null);
    const imageInputRef = React.useRef<HTMLInputElement>(null);

    const focusComposerAfterAttachmentSelection = useEvent((placeCaretAtEnd = true) => {
        // A completed picker hand-off is allowed to reclaim focus even when the
        // attach button's ordinary action-suppression window is still active.
        suppressComposerFocusUntilRef.current = 0;
        const focusAtEnd = () => {
            const textarea = resolveComposerTextarea(textareaRef);
            if (!textarea) return;
            focusComposerTextarea(textareaRef);
            if (!placeCaretAtEnd) return;
            const end = textarea.value.length;
            try {
                textarea.setSelectionRange(end, end);
            } catch {
                // Some browser pickers return while textarea selection is settling.
            }
        };
        focusAtEnd();
        window.requestAnimationFrame(focusAtEnd);
    });

    const attachFiles = React.useCallback(async (files: FileList | File[]) => {
        const list = Array.isArray(files) ? files : Array.from(files);

        if (list.length > 0) {
            const citationText = buildAttachmentCitationText(list.map((file) => file.name));
            const insertionText = withReferenceInsertionBoundaries(
                citationText,
                messageRef.current.slice(0, textareaRef.current?.selectionStart ?? messageRef.current.length),
                messageRef.current.slice(textareaRef.current?.selectionEnd ?? messageRef.current.length),
            );
            insertTextAtSelection(insertionText);
        }

        for (const file of list) {
            try {
                await surfaceResources.addAttachment(file);
            } catch (error) {
                console.error('File attach failed', error);
                toast.error(error instanceof Error ? error.message : t('chat.chatInput.toast.attachFileFailed'));
            }
        }
    }, [surfaceResources, insertTextAtSelection, t]);

    const handleVSCodePickFiles = React.useCallback(async () => {
        try {
            const data = (await vscodeApi?.pickFiles?.()) as {
                files?: Array<{ name: string; mimeType?: string; dataUrl?: string }>;
                skipped?: Array<{ name?: string; reason?: string }>;
            } | undefined;
            const picked = Array.isArray(data?.files) ? data.files : [];
            const skipped = Array.isArray(data?.skipped) ? data.skipped : [];

            if (skipped.length > 0) {
                const summary = skipped
                    .map((s: { name?: string; reason?: string }) => `${s?.name || 'file'}: ${s?.reason || 'skipped'}`)
                    .join('\n');
                toast.error(t('chat.chatInput.toast.someFilesSkipped', { summary }));
            }

            const asFiles = picked
                .map((file: { name: string; mimeType?: string; dataUrl?: string }) => {
                    if (!file?.dataUrl) return null;
                    try {
                        const [meta, base64] = file.dataUrl.split(',');
                        const mime = file.mimeType || (meta?.match(/data:(.*);base64/)?.[1] || 'application/octet-stream');
                        if (!base64) return null;
                        const binary = atob(base64);
                        const bytes = new Uint8Array(binary.length);
                        for (let i = 0; i < binary.length; i++) {
                            bytes[i] = binary.charCodeAt(i);
                        }
                        const blob = new Blob([bytes], { type: mime });
                        return new File([blob], file.name || 'file', { type: mime });
                    } catch (err) {
                        console.error('Failed to decode VS Code picked file', err);
                        return null;
                    }
                })
                .filter(Boolean) as File[];

            if (asFiles.length > 0) {
                focusComposerAfterAttachmentSelection(false);
                await attachFiles(asFiles);
                focusComposerAfterAttachmentSelection();
            }
        } catch (error) {
            console.error('VS Code file pick failed', error);
            toast.error(error instanceof Error ? error.message : t('chat.chatInput.toast.vscodePickFailed'));
        }
    }, [attachFiles, focusComposerAfterAttachmentSelection, t, vscodeApi]);

    const handlePickLocalFiles = React.useCallback(() => {
        if (isVSCodeRuntime()) {
            void handleVSCodePickFiles();
            return;
        }
        fileInputRef.current?.click();
    }, [handleVSCodePickFiles]);

    const handlePickLocalImages = React.useCallback(() => {
        if (isVSCodeRuntime()) {
            void handleVSCodePickFiles();
            return;
        }
        imageInputRef.current?.click();
    }, [handleVSCodePickFiles]);

    const handlePickAndroidPhotos = React.useCallback(async () => {
        if (!canUseNativeMediaPick()) { handlePickLocalImages(); return; }
        try {
            const files = await pickNativeMediaFiles(NATIVE_MEDIA_PICK_LIMIT);
            if (files === null) { handlePickLocalImages(); return; }
            if (files.length > 0) {
                focusComposerAfterAttachmentSelection(false);
                await attachFiles(files);
                focusComposerAfterAttachmentSelection();
            }
        } catch (error) {
            console.error('Native photo pick failed', error);
            toast.error(t('chat.chatInput.toast.attachFileFailed'));
        }
    }, [attachFiles, focusComposerAfterAttachmentSelection, handlePickLocalImages, t]);

    const handleLocalFileSelect = React.useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
        const files = event.target.files;
        if (!files || files.length === 0) return;
        focusComposerAfterAttachmentSelection(false);
        await attachFiles(files);
        event.target.value = '';
        focusComposerAfterAttachmentSelection();
    }, [attachFiles, focusComposerAfterAttachmentSelection]);

    const footerGapClass = 'gap-x-1.5 gap-y-0';
    const isVSCode = isVSCodeRuntime();
    const showDraftTargetSelectors = surface.kind === 'primary' && surfaceHasNewDraft && !isVSCode;

    const selectedDraftProject = React.useMemo(() => {
        const explicit = newSessionDraft?.selectedProjectId
            ? projects.find((project) => project.id === newSessionDraft.selectedProjectId) ?? null
            : null;
        if (explicit) {
            return explicit;
        }

        const active = activeProjectId
            ? projects.find((project) => project.id === activeProjectId) ?? null
            : null;
        if (active) {
            return active;
        }

        return projects[0] ?? null;
    }, [activeProjectId, newSessionDraft?.selectedProjectId, projects]);

    const selectedDraftProjectPath = React.useMemo(
        () => normalizePath(selectedDraftProject?.path ?? null),
        [selectedDraftProject?.path],
    );
    const draftProjectLabel = selectedDraftProject ? getProjectDisplayLabel(selectedDraftProject) : null;

    const selectedDraftProjectBranches = useGitBranches(selectedDraftProjectPath);
    const selectedDraftProjectBranchesFetchedAt = useGitStore(
        (s) => (selectedDraftProjectPath ? s.directories.get(selectedDraftProjectPath)?.lastBranchesFetch ?? 0 : 0),
    );
    const selectedDraftProjectIsGitRepo = useIsGitRepo(selectedDraftProjectPath);
    const hasDraftBranchList = Boolean(selectedDraftProjectBranches?.all);
    const fetchBranches = useGitStore((state) => state.fetchBranches);
    const [isDiscoveringDraftBranches, setIsDiscoveringDraftBranches] = React.useState(false);

    React.useEffect(() => {
        if (!showDraftTargetSelectors || !selectedDraftProjectPath || !runtimeGit || selectedDraftProjectIsGitRepo !== null) {
            return;
        }

        void fetchGitStatus(selectedDraftProjectPath, runtimeGit, { silent: true });
    }, [fetchGitStatus, runtimeGit, selectedDraftProjectIsGitRepo, selectedDraftProjectPath, showDraftTargetSelectors]);

    React.useEffect(() => {
        if (!showDraftTargetSelectors || !selectedDraftProjectPath || !selectedDraftProject || !runtimeGit || selectedDraftProjectIsGitRepo !== true) {
            setIsDiscoveringDraftBranches(false);
            return;
        }

        // Stale-while-revalidate: branches seeded from the persisted cache show
        // instantly. Refresh based on staleness (not mere presence) so a cached
        // list can't go stale, while only showing the discovering spinner when
        // there is nothing to display yet.
        const DRAFT_BRANCHES_SWR_TTL_MS = 30_000;
        const isStale =
            !selectedDraftProjectBranchesFetchedAt ||
            Date.now() - selectedDraftProjectBranchesFetchedAt > DRAFT_BRANCHES_SWR_TTL_MS;

        if (hasDraftBranchList && !isStale) {
            setIsDiscoveringDraftBranches(false);
            return;
        }

        let cancelled = false;
        setIsDiscoveringDraftBranches(!hasDraftBranchList);

        void fetchBranches(selectedDraftProjectPath, runtimeGit)
            .finally(() => {
                if (!cancelled) {
                    setIsDiscoveringDraftBranches(false);
                }
            });

        return () => {
            cancelled = true;
        };
    }, [fetchBranches, runtimeGit, selectedDraftProject, selectedDraftProjectBranchesFetchedAt, hasDraftBranchList, selectedDraftProjectIsGitRepo, selectedDraftProjectPath, showDraftTargetSelectors]);

    // Prefer the branches Query current, then fall back to status.current from
    // fetchGitStatus (often available sooner on mobile cold start).
    const selectedDraftProjectStatusBranch = useGitBranchLabel(selectedDraftProjectPath);
    const selectedDraftProjectCurrentBranch = (
        selectedDraftProjectBranches?.current?.trim()
        || selectedDraftProjectStatusBranch?.trim()
        || ''
    );

    const projectRootBranchOption = React.useMemo(() => {
        if (!selectedDraftProject) {
            return null;
        }
        const value = normalizePath(selectedDraftProject.path);
        if (!value) {
            return null;
        }
        if (!selectedDraftProjectCurrentBranch) {
            return null;
        }
        return {
            value,
            label: selectedDraftProjectCurrentBranch,
        };
    }, [selectedDraftProject, selectedDraftProjectCurrentBranch]);

    const worktreeBranchOptions = React.useMemo(() => {
        if (!selectedDraftProject) {
            return [];
        }

        const worktrees = (() => {
            if (!selectedDraftProjectPath) {
                return [];
            }
            return availableWorktreesByProject.get(selectedDraftProjectPath)
                ?? availableWorktreesByProject.get(selectedDraftProject.path)
                ?? [];
        })();

        return buildSessionTargetOptions({
            projectRoot: normalizePath(selectedDraftProject.path) ?? '',
            rootBranch: selectedDraftProjectCurrentBranch,
            worktrees,
            pendingBootstrapDirectory: newSessionDraft?.bootstrapPendingDirectory ?? null,
        }).filter((option) => option.kind === 'worktree');
    }, [availableWorktreesByProject, newSessionDraft?.bootstrapPendingDirectory, selectedDraftProject, selectedDraftProjectCurrentBranch, selectedDraftProjectPath]);

    const selectedDraftDirectory = React.useMemo(
        () => normalizePath(newSessionDraft?.bootstrapPendingDirectory ?? null)
            ?? normalizePath(newSessionDraft?.directoryOverride ?? null)
            ?? selectedDraftProjectPath,
        [newSessionDraft?.bootstrapPendingDirectory, newSessionDraft?.directoryOverride, selectedDraftProjectPath],
    );

    const shouldKeepMissingSelectedDraftDirectory = React.useMemo(() => {
        const pendingDirectory = normalizePath(newSessionDraft?.bootstrapPendingDirectory ?? null);
        return Boolean(
            newSessionDraft?.preserveDirectoryOverride
            ||
            newSessionDraft?.pendingWorktreeRequestId
            || (pendingDirectory && pendingDirectory === selectedDraftDirectory)
        );
    }, [newSessionDraft?.bootstrapPendingDirectory, newSessionDraft?.pendingWorktreeRequestId, newSessionDraft?.preserveDirectoryOverride, selectedDraftDirectory]);

    const draftBranchItems = React.useMemo(() => {
        const baseItems: Array<{ value: string; label: string }> = [];
        if (projectRootBranchOption) {
            baseItems.push(projectRootBranchOption);
        }
        baseItems.push(...worktreeBranchOptions);

        if (!selectedDraftDirectory) {
            return baseItems;
        }
        if (baseItems.some((option) => option.value === selectedDraftDirectory)) {
            return baseItems;
        }
        if (!shouldKeepMissingSelectedDraftDirectory) {
            return baseItems;
        }
        return [
            ...baseItems,
            { value: selectedDraftDirectory, label: formatDirectoryName(selectedDraftDirectory) },
        ];
    }, [projectRootBranchOption, selectedDraftDirectory, shouldKeepMissingSelectedDraftDirectory, worktreeBranchOptions]);

    // Chip label must be a real branch/worktree name — never a directory basename.
    // formatDirectoryName fallback previously painted the project folder name on the
    // branch chip and blocked DraftSessionBranchSelector's live currentBranch.
    const selectedDraftBranchLabel = React.useMemo(
        () => resolveDraftSessionBranchLabel({
            selectedDirectory: selectedDraftDirectory,
            projectRootOption: projectRootBranchOption,
            worktreeOptions: worktreeBranchOptions,
        }),
        [projectRootBranchOption, selectedDraftDirectory, worktreeBranchOptions],
    );

    const chatSurfaceMode = useChatSurfaceMode();
    const isMiniChatSurface = chatSurfaceMode === 'mini-chat';

    const hasPendingChanges = React.useMemo(() => {
        if (isMiniChatSurface) {
            return false;
        }
        if (isGitRepo !== true || !currentGitStatus || currentGitStatus.isClean) {
            return false;
        }
        // 短路谓词：超大变更集下避免为布尔值构造全量 GitChangedFile 数组。
        return hasExtractableGitChangedFiles(currentGitStatus.files);
    }, [currentGitStatus, isGitRepo, isMiniChatSurface]);

    const selectedDraftBranchIsKnown = React.useMemo(() => {
        if (!selectedDraftDirectory) {
            return true;
        }
        if (projectRootBranchOption?.value === selectedDraftDirectory) {
            return true;
        }
        return worktreeBranchOptions.some((option) => option.value === selectedDraftDirectory);
    }, [projectRootBranchOption?.value, selectedDraftDirectory, worktreeBranchOptions]);

    React.useEffect(() => {
        if (!newSessionDraft?.open) {
            return;
        }
        if (!newSessionDraft.preserveDirectoryOverride && !newSessionDraft.bootstrapPendingDirectory) {
            return;
        }
        if (!selectedDraftDirectory || !selectedDraftBranchIsKnown) {
            return;
        }
        // Create-time locks only need to survive until the new worktree is a known
        // selectable option. Keeping bootstrapPendingDirectory after that makes
        // selecting project root (main) a no-op because selectedDraftDirectory
        // prefers the bootstrap path over directoryOverride.
        if (newSessionDraft.preserveDirectoryOverride) {
            useSessionUIStore.getState().setDraftPreserveDirectoryOverride(false);
        }
        if (newSessionDraft.bootstrapPendingDirectory) {
            useSessionUIStore.getState().setDraftBootstrapPendingDirectory(null);
        }
    }, [
        newSessionDraft?.bootstrapPendingDirectory,
        newSessionDraft?.open,
        newSessionDraft?.preserveDirectoryOverride,
        selectedDraftBranchIsKnown,
        selectedDraftDirectory,
    ]);

    const shouldShowDraftBranchSelector = React.useMemo(() => {
        if (selectedDraftProjectIsGitRepo !== true) {
            return false;
        }
        if (isDiscoveringDraftBranches) {
            return false;
        }
        if (projectRootBranchOption) {
            return true;
        }
        return worktreeBranchOptions.length > 0;
    }, [isDiscoveringDraftBranches, projectRootBranchOption, selectedDraftProjectIsGitRepo, worktreeBranchOptions.length]);

    const handleDraftProjectChange = React.useCallback((projectId: string) => {
        const draft = useSessionUIStore.getState().newSessionDraft;
        // Only block while worktree creation is still in-flight. bootstrap /
        // preserve locks protect against automatic resets, not explicit picks.
        if (draft?.pendingWorktreeRequestId) {
            return;
        }
        const project = projects.find((entry) => entry.id === projectId);
        if (!project) {
            return;
        }
        if (activeProjectId !== projectId) {
            setActiveProjectIdOnly(projectId);
        }
        setNewSessionDraftTarget({
            projectId,
            directoryOverride: project.path,
        }, { force: true });
    }, [activeProjectId, projects, setActiveProjectIdOnly, setNewSessionDraftTarget]);

    const handleDraftDirectoryChange = React.useCallback((directory: string) => {
        const draft = useSessionUIStore.getState().newSessionDraft;
        // Only block while worktree creation is still in-flight. bootstrap /
        // preserve locks protect against automatic resets, not explicit picks.
        if (draft?.pendingWorktreeRequestId) {
            return;
        }
        if (!selectedDraftProject) {
            return;
        }
        setNewSessionDraftTarget({
            projectId: selectedDraftProject.id,
            directoryOverride: directory,
        }, { force: true });
    }, [selectedDraftProject, setNewSessionDraftTarget]);

    const renderProjectLabelWithIcon = React.useCallback((project: {
        id: string;
        path: string;
        label?: string;
        icon?: string | null;
        color?: string | null;
        iconImage?: { mime: string; updatedAt: number; source: 'custom' | 'auto' } | null;
        iconBackground?: string | null;
    }) => {
        const iconName = project.icon ? PROJECT_ICON_MAP[project.icon] : null;
        const iconColor = project.color ? PROJECT_COLOR_MAP[project.color] : undefined;
        const fallback = <Icon name={iconName ?? 'folder'} className="h-3.5 w-3.5" style={iconColor ? { color: iconColor } : undefined} />;
        return (
            <span className="inline-flex min-w-0 items-center gap-1.5">
                <span
                    className="flex h-4 w-4 shrink-0 items-center justify-center overflow-hidden text-muted-foreground"
                >
                    {project.iconImage ? <ProjectIconImage project={project} className="size-full object-contain" fallback={fallback} /> : fallback}
                </span>
                <span className="truncate">{getProjectDisplayLabel(project)}</span>
            </span>
        );
    }, []);

    React.useEffect(() => {
        if (!showDraftTargetSelectors || !selectedDraftProject || !selectedDraftDirectory) {
            return;
        }
        if (newSessionDraft?.pendingWorktreeRequestId || newSessionDraft?.bootstrapPendingDirectory || newSessionDraft?.preserveDirectoryOverride) {
            return;
        }
        const valid = draftBranchItems.some((option) => option.value === selectedDraftDirectory);
        if (valid) {
            return;
        }
        setNewSessionDraftTarget({
            projectId: selectedDraftProject.id,
            directoryOverride: selectedDraftProject.path,
        });
    }, [draftBranchItems, newSessionDraft?.bootstrapPendingDirectory, newSessionDraft?.pendingWorktreeRequestId, newSessionDraft?.preserveDirectoryOverride, selectedDraftDirectory, selectedDraftProject, setNewSessionDraftTarget, showDraftTargetSelectors]);

    const openMobileAttachSheet = React.useCallback(() => {
        // Mark the sheet open BEFORE blur so overlay-busy is true when the
        // keyboard-close lands. The trigger button blocks the tap's own focus
        // transfer, so the keyboard must be dismissed explicitly here.
        markComposerActionGesture();
        setMobileAttachMenuOpen(true);
        textareaRef.current?.blur();
    }, [markComposerActionGesture]);

    // Android Capacitor 专用，sheet 提供照片/文件二选一。
    const openAndroidMediaPickSheet = React.useCallback(() => {
        markComposerActionGesture();
        setAndroidMediaPickSheetOpen(true);
        textareaRef.current?.blur();
    }, [markComposerActionGesture]);

    // Watch the shared overlay portal root: active panels (sessions sheet,
    // model/agent panels, draft pickers, ...) count as busy. Retained hidden
    // panels opt out through their explicit active attribute.
    // Observing the host catches overlays whose open-state lives in other
    // components without threading their state here.
    React.useEffect(() => {
        if (!isMobile || typeof document === 'undefined') return;
        let host = document.getElementById('mobile-overlay-root');
        if (!host) {
            // Same lazy-create contract as MobileOverlayPanel's ensureOverlayRoot.
            host = document.createElement('div');
            host.id = 'mobile-overlay-root';
            document.body.appendChild(host);
        }
        const hostEl = host;
        const update = () => setMobileOverlayHostBusy(hasActiveMobileOverlay(hostEl.children));
        update();
        const observer = new MutationObserver(update);
        observer.observe(hostEl, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: [MOBILE_OVERLAY_ACTIVE_ATTRIBUTE],
        });
        return () => observer.disconnect();
    }, [isMobile]);

    // If the keyboard was open (or closed just moments ago by the overlay's own
    // blur) when an overlay appeared, bring it back once every overlay is gone.
    // The attach dropdown and the GitHub issue/PR pickers join the same chain,
    // so menu → picker → close restores the keyboard at the end of the flow.
    const mobileOverlayOpen = mobileOverlayHostBusy
        || Boolean(mobileControlsPanel)
        || mobileAttachMenuOpen
        || androidMediaPickSheetOpen
        || issuePickerOpen
        || prPickerOpen;
    const nativeModelName = getModelDisplayName(
        providers.find((provider) => provider.id === surface.selection.value.providerID),
        surface.selection.value.modelID,
        t('chat.modelControls.selectModel'),
    );
    const nativeModelVariant = surface.selection.value.variant?.trim();
    const handleNativeSuggestionRows = useEvent((payload: ComposerAutocompleteVisibleRows) => {
        setNativeSuggestionRows((previous) => commitComposerAutocompleteRows(previous, payload.rows));
        setNativeSuggestionHighlight((previous) => (
            previous === payload.highlightedIndex ? previous : payload.highlightedIndex
        ));
    });
    const evaluateChatInputCommandPolicy = useEvent((command: CommandInfo) => (
        isChatInputCommandAllowed(surface, command)
    ));
    const handleNativeAutocompleteAccept = useEvent((index: number) => {
        if (showCommandAutocomplete) {
            commandRef.current?.acceptIndex(index, true);
            return;
        }
        if (showSkillAutocomplete) {
            skillRef.current?.acceptIndex(index);
            return;
        }
        if (showFileMention) {
            mentionRef.current?.acceptIndex(index);
        }
    });
    const handleNativeAutocompleteDismiss = useEvent(() => {
        autocompleteTriggerRef.current = null;
        setShowCommandAutocomplete(false);
        setShowSkillAutocomplete(false);
        setShowSnippetAutocomplete(false);
        setShowFileMention(false);
        setNativeSuggestionRows([]);
        setNativeSuggestionHighlight(0);
    });
    const nativeIosComposerActive = useNativeIosComposer({
        enabled: isMobile && surface.kind === 'primary',
        isMobile,
        text: message,
        textPresetEpoch: composer.textPresetEpoch,
        placeholder: compactComposerPlaceholder,
        modelLabel: nativeModelName,
        modelVariantLabel: nativeModelVariant ? formatEffortLabel(nativeModelVariant) : '',
        canSend,
        canAbort,
        attachmentCount: attachedFiles.length,
        suppressed: mobileOverlayOpen,
        attachAria: t('chat.chatInput.actions.addAttachment'),
        attachTitle: t('chat.chatInput.actions.addAttachment'),
        attachPhotosLabel: t('chat.chatInput.actions.attachPhotos'),
        attachFilesLabel: t('chat.chatInput.actions.attachFiles'),
        attachCancelLabel: t('chat.chatInput.actions.attachCancel'),
        sendAria: t('chat.chatInput.actions.sendMessageAria'),
        queueAria: t('chat.chatInput.actions.queueMessageAria'),
        stopAria: t('chat.chatInput.actions.stopGeneratingAria'),
        modelAria: t('chat.modelControls.selectModel'),
        modelId: surface.selection.value.modelID,
        providerId: surface.selection.value.providerID,
        agentName: surface.selection.value.agent ?? '',
        agentLabel: getAgentDisplayName(agents, surface.selection.value.agent ?? undefined),
        agentAria: t('chat.modelControls.selectAgent'),
        attachments: attachedFiles,
        removeAttachmentNamedAria: (name) => t('chat.fileAttachment.actions.removeNamed', { name }),
        onText: (text, composing, selection) => {
            const nativeCaret = resolveComposerInsertCaret(
                text.length,
                selection?.end ?? selection?.start ?? text.length,
            );
            cursorPosRef.current = nativeCaret;
            if (composing) {
                if (textareaRef.current) textareaRef.current.value = text;
                applyProgrammaticEdit(text);
                return;
            }
            const previous = messageRef.current;
            const reconciled = reconcileComposerAttachmentTextDeletion(
                previous,
                text,
                attachedFiles.filter(isInlineAttachmentCitation).map((file) => file.filename),
            );
            const nextText = reconciled?.text ?? text;
            if (textareaRef.current) textareaRef.current.value = nextText;
            applyProgrammaticEdit(nextText);
            const cursor = resolveComposerInsertCaret(
                nextText.length,
                selection?.end ?? selection?.start ?? nextText.length,
            );
            cursorPosRef.current = cursor;
            updateAutocompleteState(nextText, cursor);
            if (!reconciled) return;
            const removed = new Set(reconciled.removedFilenames.map((filename) => filename.toLowerCase()));
            for (const attachment of attachedFiles) {
                if (removed.has(attachment.filename.toLowerCase())) {
                    void surfaceResources.removeAttachment(attachment.id);
                }
            }
        },
        onSend: (text) => {
            if (textareaRef.current) textareaRef.current.value = text;
            handoffNativeComposerSendToWeb({
                text,
                applyDocument: applyProgrammaticEdit,
                submit: handlePrimaryAction,
            });
        },
        onAbort: handleAbort,
        onAttach: markComposerActionGesture,
        onFiles: (files, skipped) => {
            if (skipped.length > 0) {
                toast.error(t('chat.chatInput.toast.someFilesSkipped', { summary: skipped.join('\n') }));
            }
            if (files.length === 0) return;
            void attachFiles(files);
        },
        onRemoveAttachment: (id) => {
            void surfaceResources.removeAttachment(id);
        },
        onOpenModel: () => handleOpenMobilePanel('model'),
        onCycleAgent: () => handleCycleAgent(),
        onOpenAgent: handleOpenAgentPanel,
        showScrollToBottom: Boolean(showScrollToBottom && onScrollToBottom),
        scrollAria: t('chat.scrollToBottom.aria'),
        onScrollToBottom: onScrollToBottom ?? (() => {}),
        autocompleteOpen: nativeSuggestionRows.length > 0 && (
            showCommandAutocomplete || showSkillAutocomplete || showFileMention
        ),
        autocompleteHighlightedIndex: nativeSuggestionHighlight,
        autocompleteRows: nativeSuggestionRows,
        caret: cursorPosRef.current,
        onAutocompleteAccept: handleNativeAutocompleteAccept,
        onAutocompleteDismiss: handleNativeAutocompleteDismiss,
        chipHighlights: highlightedComposerContent,
    });
    const nativeAccessoryRef = React.useRef<HTMLDivElement>(null);
    useResizeObserver(nativeIosComposerActive ? nativeAccessoryRef : null, () => {
        const height = nativeAccessoryRef.current?.getBoundingClientRect().height ?? 0;
        applyNativeComposerAccessoryVar(document.documentElement, height);
    });

    // Installed PWA (standalone): a focus() from a bare timeout is outside the
    // user gesture and iOS refuses to raise the keyboard for it (Safari
    // in-browser is lenient). MobileOverlayPanel dispatches
    // 'oc:mobile-overlay-closed' synchronously from the same React flush as
    // the click that closed it — refocus right there, while the gesture is
    // still live. Chained flows (attach menu → GitHub picker) set the skip ref
    // so the keyboard doesn't flash open under the next overlay.
    const mobilePickerDialogsOpenRef = React.useRef(false);
    mobilePickerDialogsOpenRef.current = issuePickerOpen || prPickerOpen;
    const skipNextOverlayCloseRestoreRef = React.useRef(false);
    const openSheetCountRef = React.useRef(0);
    const holdComposerFocusUntilRef = React.useRef(0);

    // Leaving the composer releases a staged edit. Deferred a tick because the
    // decision needs where focus *landed*, and because clicking Edit on another row
    // blurs before it re-stages — reading the staged row again catches that.
    const releaseStagedEditOnComposerBlur = useEvent(() => {
        const blurred = useSessionUIStore.getState().stagedMessageEdit;
        if (!blurred || blurred.sessionId !== currentSessionId) return;
        window.setTimeout(() => {
            const staged = useSessionUIStore.getState().stagedMessageEdit;
            const active = document.activeElement;
            const decision = resolveStagedEditBlurDisarm({
                surfaceKind: surface.kind,
                stagedSessionId: staged?.sessionId ?? null,
                stagedMessageId: staged?.messageId ?? null,
                blurredMessageId: blurred.messageId,
                submitInFlight: isSubmissionInFlight(),
                focusHeld: Date.now() < holdComposerFocusUntilRef.current,
                overlayOpen: openSheetCountRef.current > 0 || mobilePickerDialogsOpenRef.current,
                focusInsideComposer:
                    (active instanceof Element
                        && Boolean(
                            active.closest('[data-composer-content="true"]')
                            || active.closest('[data-slot="dropdown-menu-content"]'),
                        ))
                    // A composer chrome action (attach, agent, model, dictation,
                    // pickers) blur the textarea on purpose as part of the gesture;
                    // focus landing outside the field inside that window is not an
                    // abandonment of the staged edit.
                    || Date.now() < suppressComposerFocusUntilRef.current,
            });
            if (decision.action === 'disarm') {
                useSessionUIStore.getState().clearStagedMessageEdit(decision.sessionId);
            }
        }, 0);
    });
    React.useEffect(() => {
        if (!isMobile || isCapacitorApp() || typeof window === 'undefined') return;
        if (!window.matchMedia?.('(display-mode: standalone)')?.matches) return;
        const handleOverlayOpened = () => {
            openSheetCountRef.current += 1;
        };
        const handleOverlayClosed = () => {
            // Counter instead of a DOM check: the close event fires from a
            // layout-effect cleanup, when the closing sheet's portal nodes may
            // still be attached — the DOM can't tell "this sheet going away"
            // from "another sheet still up".
            openSheetCountRef.current = Math.max(0, openSheetCountRef.current - 1);
            if (skipNextOverlayCloseRestoreRef.current) {
                skipNextOverlayCloseRestoreRef.current = false;
                return;
            }
            if (!restoreKeyboardAfterOverlayRef.current) return;
            if (mobilePickerDialogsOpenRef.current) return;
            if (openSheetCountRef.current > 0) return;
            if (isMobileOverlayFocusRestoreSuppressed()) {
                // A session switch closed this overlay — the pending keyboard
                // restore belongs to the previous conversation's composer.
                restoreKeyboardAfterOverlayRef.current = false;
                return;
            }
            restoreKeyboardAfterOverlayRef.current = false;
            // iOS can still dismiss the freshly-raised keyboard when the tap
            // that closed the overlay finishes over non-input content — hold
            // focus through that window (see the onBlur guard).
            holdComposerFocusUntilRef.current = Date.now() + 600;
            textareaRef.current?.focus();
            // The native focus lands mid-commit; React's delegated onFocus may
            // not make it into this flush, leaving mobileComposerBusy false for
            // a beat — enough for the pill-collapse timer to unmount the
            // focused textarea and kill the rising keyboard. Set the state
            // explicitly instead of relying on the synthetic event.
            if (document.activeElement === textareaRef.current) {
                setMobileTextareaFocused(true);
            }
            // iOS reveals a field above the keyboard only for user-initiated
            // focus; a programmatic one leaves the composer parked behind it.
            // Reveal once the keyboard has mostly risen, and again after it
            // settles. Browsers own keyboard layout; Capacitor uses native
            // chrome choreography.
            const reveal = () => {
                const ta = textareaRef.current;
                if (!ta || document.activeElement !== ta) return;
                // Align the BOTTOM of the whole composer form with the visible
                // bottom: 'nearest' on the textarea alone leaves the footer
                // icon row parked behind the keyboard accessory bar.
                (composerFormRef.current ?? ta).scrollIntoView({ block: 'end' });
            };
            if (mobileOverlayRevealEarlyTimerRef.current !== null) {
                window.clearTimeout(mobileOverlayRevealEarlyTimerRef.current);
                mobileOverlayRevealEarlyTimerRef.current = null;
            }
            if (mobileOverlayRevealLateTimerRef.current !== null) {
                window.clearTimeout(mobileOverlayRevealLateTimerRef.current);
                mobileOverlayRevealLateTimerRef.current = null;
            }
            mobileOverlayRevealEarlyTimerRef.current = window.setTimeout(() => {
                mobileOverlayRevealEarlyTimerRef.current = null;
                reveal();
            }, 300);
            mobileOverlayRevealLateTimerRef.current = window.setTimeout(() => {
                mobileOverlayRevealLateTimerRef.current = null;
                reveal();
            }, 650);
        };
        window.addEventListener('oc:mobile-overlay-opened', handleOverlayOpened);
        window.addEventListener('oc:mobile-overlay-closed', handleOverlayClosed);
        return () => {
            if (mobileOverlayRevealEarlyTimerRef.current !== null) {
                window.clearTimeout(mobileOverlayRevealEarlyTimerRef.current);
                mobileOverlayRevealEarlyTimerRef.current = null;
            }
            if (mobileOverlayRevealLateTimerRef.current !== null) {
                window.clearTimeout(mobileOverlayRevealLateTimerRef.current);
                mobileOverlayRevealLateTimerRef.current = null;
            }
            window.removeEventListener('oc:mobile-overlay-opened', handleOverlayOpened);
            window.removeEventListener('oc:mobile-overlay-closed', handleOverlayClosed);
        };
    }, [isMobile]);
    React.useEffect(() => {
        if (!isMobile) return;
        if (mobileOverlayOpen) {
            if (mobileTextareaFocused || Date.now() - lastMobileBlurAtRef.current < 800) {
                restoreKeyboardAfterOverlayRef.current = true;
            }
            return;
        }
        if (!restoreKeyboardAfterOverlayRef.current) return;
        // Debounced: overlay chains hand off with a frame of "nothing open"
        // between steps (attach sheet closes → issue/PR picker opens a frame
        // later). Restoring instantly in that gap would pop the keyboard open
        // inside the next overlay — wait out the gap and cancel if another
        // overlay appears.
        const timer = window.setTimeout(() => {
            restoreKeyboardAfterOverlayRef.current = false;
            // A session switch closed the overlay — the pending restore was
            // armed for the previous conversation's composer.
            if (isMobileOverlayFocusRestoreSuppressed()) return;
            const textarea = textareaRef.current;
            if (textarea && document.activeElement !== textarea) {
                textarea.focus({ preventScroll: isCapacitorApp() });
            }
        }, 180);
        return () => window.clearTimeout(timer);
    }, [isMobile, mobileOverlayOpen, mobileTextareaFocused]);

    // Installed PWA viewport repair after the browser keyboard closes. Composer
    // expansion and keyboard chrome are CSS :has(:focus)-owned; this effect only
    // synchronizes WebKit's external visual viewport after its exit animation.
    React.useEffect(() => {
        if (!isMobile || isCapacitorApp() || typeof document === 'undefined') return;
        if (mobileTextareaFocused) return;
        if (!window.matchMedia?.('(display-mode: standalone)')?.matches) return;
        const root = document.documentElement;
        const timer = window.setTimeout(() => {
            if (document.activeElement === textareaRef.current) return;
            window.scrollTo(0, 0);
            document.body.scrollTop = 0;
            root.scrollTop = 0;
        }, 350);
        return () => window.clearTimeout(timer);
    }, [isMobile, mobileTextareaFocused]);

    // Reset the picker search whenever a draft picker sheet opens/closes.
    React.useEffect(() => {
        setMobileDraftPickerQuery('');
    }, [mobileDraftPicker]);

    // Used by scrollIntoView reveal and the composer <form> ref — browsers keep
    // their own keyboard handling; Capacitor uses native chrome choreography.
    const composerFormRef = React.useRef<HTMLFormElement | null>(null);

    const footerPaddingClass = isMobile ? 'px-1.5 py-1.5' : (isVSCode ? 'px-1.5 py-1' : 'px-2.5 py-1.5');
    const buttonSizeClass = isMobile ? 'h-8 w-8' : (isVSCode ? 'h-5 w-5' : 'h-6 w-6');
    const sendIconSizeClass = isMobile ? 'h-4 w-4' : (isVSCode ? 'h-3.5 w-3.5' : 'h-4 w-4');
    // Mobile: 24px circle inside the 32px send hit target so it matches the model chip.
    // Desktop/VS Code: the circle fills the already-compact control.
    const stopIconSizeClass = isMobile ? 'h-6 w-6' : 'size-full';
    const iconSizeClass = isMobile ? 'h-[1.125rem] w-[1.125rem]' : (isVSCode ? 'h-4 w-4' : 'h-[1.125rem] w-[1.125rem]');

    const iconButtonBaseClass = cn(
        'flex cursor-pointer items-center justify-center text-foreground transition-none outline-none focus:outline-none flex-shrink-0 disabled:cursor-not-allowed',
        COMPOSER_ICON_HOVER_CLASS,
    );
    const footerIconButtonClass = cn(iconButtonBaseClass, buttonSizeClass);
    const stopFooterIconButtonClass = cn(
        'flex cursor-pointer items-center justify-center transition-none outline-none focus:outline-none flex-shrink-0 disabled:cursor-not-allowed rounded-full hover:opacity-80',
        buttonSizeClass,
    );
    // Compact pill: same 24px visual as expanded mobile, not stretched to the cap.
    const compactCircleButtonClass = cn(
        'flex cursor-pointer items-center justify-center transition-none outline-none focus:outline-none flex-shrink-0 disabled:cursor-not-allowed rounded-full hover:opacity-80',
        'h-6 w-6',
    );
    React.useEffect(() => {
        return () => {
            if (abortTimeoutRef.current) {
                clearTimeout(abortTimeoutRef.current);
                abortTimeoutRef.current = null;
            }
        };
    }, []);

    const composerInputHeader = undefined;

    // gap-x-1.5 matches the send-button cluster so agent → model → send reads evenly.
    const mobileComposerControls = isMobile ? (
        <div
            data-composer-action="true"
            className="composer-mobile-model-controls flex min-w-0 flex-1 items-center justify-end gap-x-1.5"
        >
            <MemoMobileAgentButton
                onOpenAgentPanel={handleOpenAgentPanel}
                onCycleAgent={() => {
                    markComposerActionGesture();
                    handleCycleAgent();
                }}
                agentName={surface.selection.value.agent}
                agents={agents}
                disabled={mobileAgentControlsDisabled}
            />
            <MemoMobileModelButton
                onOpenModel={() => handleOpenMobilePanel('model')}
                providerID={surface.selection.value.providerID}
                modelID={surface.selection.value.modelID}
                provider={providers.find((p) => p.id === surface.selection.value.providerID)}
                variant={surface.selection.value.variant}
            />
        </div>
    ) : null;

    const composerAttachmentContent = (
        <div className="oc-mobile-composer-attachment-content relative z-10 flex flex-wrap items-center gap-1 px-3 pt-1">
            <AttachedVSCodeFileChips attachments={attachedFiles} onShowPopup={handleShowAttachmentPopup} onRemoveAttachedFile={handleAttachedFileRemove} />
            {surface.kind === 'primary' ? (
                <ActiveEditorFileSuggestion
                    attachedFiles={attachedFiles}
                    onAddVSCodeFile={(path, name, fileSize) => {
                        // Capture draftKey at click so async surface switches still write the target key.
                        if (!draftKey) return;
                        createDraftAttachmentResourceAdapter(draftKey, () => useInputStore.getState()).addVSCodeFile(path, name, fileSize);
                    }}
                    onAddVSCodeSelection={(path, file) => {
                        if (!draftKey) return;
                        return createDraftAttachmentResourceAdapter(draftKey, () => useInputStore.getState()).addVSCodeSelection(path, file);
                    }}
                />
            ) : null}
        </div>
    );

    const composerHighlightedContent = highlightedComposerContent?.map((part, index) => (
        <span key={`${index}-${part.text.length}`} className={part.className}>
            {part.visual ? <ComposerTriggerIconMark visual={part.visual} text={part.text} /> : part.text}
        </span>
    ));

    const mobileCompactComposerChrome = isMobile ? (
            <div
                className={cn(
                    'oc-mobile-composer-compact-chrome',
                    canAbort && 'oc-mobile-composer-compact-chrome--aborting',
                    canSend && !canAbort && 'oc-mobile-composer-compact-chrome--sending',
                    showScrollToBottom && onScrollToBottom && 'oc-mobile-composer-compact-chrome--with-scroll',
                )}
            >
                <div
                    data-mobile-composer-compact-slot="attach"
                    data-composer-action="true"
                    className="composer-mobile-actions flex shrink-0 items-center"
                >
                    <ComposerAttachmentControls
                        isVSCode={isVSCode}
                        footerIconButtonClass={footerIconButtonClass}
                        iconSizeClass={iconSizeClass}
                        handlePickLocalFiles={handlePickLocalFiles}
                        handlePickLocalImages={handlePickLocalImages}
                        openIssuePicker={openIssuePicker}
                        openPrPicker={openPrPicker}
                        onOpenMobileSheet={openMobileAttachSheet}
                        onOpenAndroidPickSheet={canUseNativeMediaPick() ? openAndroidMediaPickSheet : undefined}
                    />
                </div>
                <div
                    data-mobile-composer-compact-slot="trailing"
                    className="ml-auto flex shrink-0 items-center justify-end gap-x-1"
                >
                    {showScrollToBottom && onScrollToBottom ? (
                        <div data-composer-action="true" className="flex shrink-0 items-center">
                            <ScrollToBottomButton
                                placement="compact"
                                visible={showScrollToBottom}
                                onClick={onScrollToBottom}
                            />
                        </div>
                    ) : null}
                    {canAbort || canSend ? (
                        <div
                            data-mobile-composer-compact-slot="action"
                            data-composer-action="true"
                            className="flex shrink-0 items-center justify-end"
                        >
                            <ComposerActionButtons
                                isMobile
                                compact
                                footerIconButtonClass={footerIconButtonClass}
                                stopFooterIconButtonClass={stopFooterIconButtonClass}
                                compactCircleButtonClass={compactCircleButtonClass}
                                sendIconSizeClass={sendIconSizeClass}
                                stopIconSizeClass={stopIconSizeClass}
                                canSend={canSend}
                                canAbort={canAbort}
                                hasContent={false}
                                currentSessionId={currentSessionId}
                                newSessionDraftOpen={newSessionDraftOpen}
                                draftSubmitting={resolvedDraftBusy}
                                submissionBlocked={submissionBlocked}
                                sendPhase={sendPhase}
                                queueFrozen={queueFrozen}
                                // Abort-capable sessions can still steer when queue ownership is frozen.
                                queueFallbackAvailable={canAbort || sessionIsRunning}
                                onPrimaryAction={handlePrimaryAction}
                                onAbort={handleAbort}
                            />
                        </div>
                    ) : null}
                </div>
            </div>
    ) : null;

    const composerFooterContent = isMobile ? (
        <>
            <div
                className="oc-mobile-composer-full-chrome flex w-full min-w-0 items-center gap-x-1.5"
                data-composer-action="true"
            >
                <div className="composer-mobile-actions flex shrink-0 items-center gap-x-2 pl-1">
                    <ComposerAttachmentControls
                        isVSCode={isVSCode}
                        footerIconButtonClass={footerIconButtonClass}
                        iconSizeClass={iconSizeClass}
                        handlePickLocalFiles={handlePickLocalFiles}
                        handlePickLocalImages={handlePickLocalImages}
                        openIssuePicker={openIssuePicker}
                        openPrPicker={openPrPicker}
                        onOpenSettings={onOpenSettings}
                        onOpenMobileSheet={openMobileAttachSheet}
                        onOpenAndroidPickSheet={canUseNativeMediaPick() ? openAndroidMediaPickSheet : undefined}
                    />
                    {showPermissionAutoAcceptControl ? (
                        <PermissionAutoAcceptButton
                            sessionId={currentSessionId}
                            draftOpen={newSessionDraftOpen}
                            draftEnabled={newSessionDraft.permissionAutoAcceptEnabled === true}
                            enabled={permissionAutoAcceptEnabled}
                            saving={currentSessionId ? permissionAutoAcceptSaving : false}
                            footerIconButtonClass={footerIconButtonClass}
                            iconSizeClass={iconSizeClass}
                            onSetDraftEnabled={setDraftPermissionAutoAcceptEnabled}
                            onSetSessionEnabled={setSessionAutoAccept}
                            onOpenSessionFirst={openNewSessionDraft}
                            onToggleFailed={handlePermissionAutoAcceptToggleFailed}
                        />
                    ) : null}
                    <SessionGoalButton
                        sessionId={currentSessionId}
                        directory={currentSessionDirectoryForSync ?? currentDirectory}
                        draftOpen={newSessionDraftOpen}
                    />
                    <SessionGoalObjectiveCounter length={message.length} />
                </div>
                {mobileComposerControls}
                <div className="relative z-30 flex shrink-0 items-center justify-end gap-x-1.5">
                    <ComposerActionButtons
                        isMobile={isMobile}
                        footerIconButtonClass={footerIconButtonClass}
                        stopFooterIconButtonClass={stopFooterIconButtonClass}
                        sendIconSizeClass={sendIconSizeClass}
                        stopIconSizeClass={stopIconSizeClass}
                        canSend={canSend}
                        canAbort={canAbort}
                        hasContent={!!hasContent}
                        currentSessionId={currentSessionId}
                        newSessionDraftOpen={newSessionDraftOpen}
                        draftSubmitting={resolvedDraftBusy}
                        submissionBlocked={submissionBlocked}
                        sendPhase={sendPhase}
                        queueFrozen={queueFrozen}
                        queueFallbackAvailable={canAbort || sessionIsRunning}
                        onPrimaryAction={handlePrimaryAction}
                        onAbort={handleAbort}
                    />
                </div>
            </div>
        </>
    ) : (
        <>
            <div className={cn('flex flex-shrink-0 items-center', footerGapClass)}>
                <ComposerAttachmentControls
                    isVSCode={isVSCode}
                    footerIconButtonClass={footerIconButtonClass}
                    iconSizeClass={iconSizeClass}
                    handlePickLocalFiles={handlePickLocalFiles}
                    handlePickLocalImages={handlePickLocalImages}
                    openIssuePicker={openIssuePicker}
                    openPrPicker={openPrPicker}
                    onOpenSettings={onOpenSettings}
                    withTooltip
                />
                {showPermissionAutoAcceptControl ? (
                    <PermissionAutoAcceptButton
                        sessionId={currentSessionId}
                        draftOpen={newSessionDraftOpen}
                        draftEnabled={newSessionDraft.permissionAutoAcceptEnabled === true}
                        enabled={permissionAutoAcceptEnabled}
                        saving={currentSessionId ? permissionAutoAcceptSaving : false}
                        footerIconButtonClass={footerIconButtonClass}
                        iconSizeClass={iconSizeClass}
                        onSetDraftEnabled={setDraftPermissionAutoAcceptEnabled}
                        onSetSessionEnabled={setSessionAutoAccept}
                        onOpenSessionFirst={openNewSessionDraft}
                        onToggleFailed={handlePermissionAutoAcceptToggleFailed}
                    />
                ) : null}
                <SessionGoalButton
                    sessionId={currentSessionId}
                    directory={currentSessionDirectoryForSync ?? currentDirectory}
                    draftOpen={newSessionDraftOpen}
                />
                <SessionGoalObjectiveCounter length={message.length} />
            </div>
            <div className={cn('relative z-30 flex flex-1 items-center justify-end md:gap-x-1.5', footerGapClass)}>
                <MemoModelControls
                    className="min-w-0 flex-1 justify-end"
                    composerTextareaRef={textareaRef}
                    selectionAdapter={modelControlsSelectionAdapter}
                />
                <MemoComposerDictation
                    radius={chatInputRadius}
                    isMobile={isMobile}
                    footerIconButtonClass={footerIconButtonClass}
                    footerPaddingClass={footerPaddingClass}
                    iconSizeClass={iconSizeClass}
                    sendIconSizeClass={sendIconSizeClass}
                    onInsert={handleDictationInsert}
                    onInsertAndSend={handleDictationInsertAndSend}
                    onContentHeightChange={handleDictationContentHeightChange}
                    renderTrigger={false}
                    topAccessory={<span data-oc-composer-dictation-active="true" className="hidden" aria-hidden="true" />}
                />
                <ComposerActionButtons
                    isMobile={isMobile}
                    footerIconButtonClass={footerIconButtonClass}
                    stopFooterIconButtonClass={stopFooterIconButtonClass}
                    sendIconSizeClass={sendIconSizeClass}
                    stopIconSizeClass={stopIconSizeClass}
                    canSend={canSend}
                    canAbort={canAbort}
                    hasContent={!!hasContent}
                    currentSessionId={currentSessionId}
                    newSessionDraftOpen={newSessionDraftOpen}
                    draftSubmitting={resolvedDraftBusy}
                    submissionBlocked={submissionBlocked}
                    sendPhase={sendPhase}
                    queueFrozen={queueFrozen}
                    queueFallbackAvailable={canAbort || sessionIsRunning}
                    onPrimaryAction={handlePrimaryAction}
                    onAbort={handleAbort}
                />
            </div>
        </>
    );

    // Queue edit restores text async; hand focus back so the user can keep typing.
    // Desktop (PC client): survive draft external-document re-render + chip unmount
    // after the edit button loses DOM, which can drop focus to body.
    const focusComposerAfterQueueEdit = useEvent(() => {
        if (isMobile) {
            holdComposerFocusUntilRef.current = Date.now() + 600;
            const assertMobileFocus = () => {
                textareaRef.current?.focus({ preventScroll: isCapacitorApp() });
                if (document.activeElement === textareaRef.current) {
                    setMobileTextareaFocused(true);
                }
            };
            assertMobileFocus();
            window.requestAnimationFrame(assertMobileFocus);
            return;
        }
        const focusDesktop = () => {
            if (!focusComposerTextarea(textareaRef)) return;
            const textarea = resolveComposerTextarea(textareaRef);
            if (!textarea) return;
            const end = textarea.value.length;
            try {
                textarea.setSelectionRange(end, end);
            } catch {
                // Some hosts reject selection while the value is mid-commit.
            }
        };
        focusDesktop();
        window.requestAnimationFrame(() => {
            focusDesktop();
            window.setTimeout(focusDesktop, 0);
        });
    });

    // Gate trailing so an empty SessionGoalRow (no goal / disabled) does not keep
    // the queue shell open with only the composer-overlap spacer.
    const sessionGoalDirectory = currentSessionDirectoryForSync ?? currentDirectory;
    const { goal: sessionGoal, enabled: sessionGoalEnabled } = useSessionGoal(currentSessionId ?? '', sessionGoalDirectory);
    const sessionGoalLeading = currentSessionId && sessionGoalEnabled && sessionGoal
        ? (
            <SessionGoalRow
                sessionId={currentSessionId}
                directory={sessionGoalDirectory}
            />
        )
        : null;
    const queuedMessageSurface = (
        <QueuedMessageChips
            onEditMessage={handleQueuedMessageEdit}
            onSendMessage={handleQueuedMessageSend}
            onEditCommitted={focusComposerAfterQueueEdit}
            draftKey={draftKey}
            scope={currentQueueScope}
            draftTarget={draftKey ? {
                key: draftKey,
                expectedRevision: () => surfaceResources.getDraft(draftKey)?.revision ?? 'absent',
            } : null}
            clientPendingItems={establishingPendingItems}
            onRemoveClientPending={(requestID) => {
                const removed = useComposerSendStore.getState().removeEstablishingFollowUp(requestID);
                if (!removed) return;
                // Best-effort restore of discarded establishing follow-up text.
                if (removed.content) {
                    replacePlainDocument(removed.content);
                }
                if (removed.attachments.length > 0) {
                    void surfaceResources.restoreAttachments(removed.attachments);
                }
            }}
            trailing={sessionGoalLeading}
        />
    );

    return (
        <>
        <form
            ref={composerFormRef}
            onSubmit={(e) => { e.preventDefault(); handlePrimaryAction(); }}
            onPointerDownCapture={(event) => {
                if (!isMobile) return;
                const target = event.target;
                if (!(target instanceof Element)) return;
                // Only the textarea (and its highlight overlay) may claim focus /
                // expand the composer. Footer chrome (attach, agent, model, send, …)
                // is an explicit action — preventDefault so the browser never
                // focuses the field as a side effect of the tap.
                if (target.closest('textarea[data-chat-input="true"]')) return;
                if (target.closest('[data-chat-prompt-attachments="true"]')) return;
                const action = target.closest(
                    'button, [role="button"], a, label, input, select, [data-composer-action="true"], [data-chat-input-footer="true"]',
                );
                if (!action) return;
                markComposerActionGesture();
                event.preventDefault();
            }}
            className={cn(
                "relative w-full pt-0 pb-4",
                isDesktopExpanded && 'flex h-full min-h-0 flex-col pt-4',
                isMobileExpanded && 'flex h-full min-h-0 flex-col pt-1',
                isMobile && 'bottom-safe-area oc-mobile-composer'
            )}
            data-native-ios-composer={nativeIosComposerActive ? 'true' : undefined}
            style={isMobile && isCapacitorApp() && !nativeIosComposerActive && inputBarOffset > 0 && !mobileTextareaFocused
                ? { marginBottom: `${inputBarOffset}px` }
                : undefined}
        >
            {surfaceHasNewDraft && !isDesktopExpanded && !isMobile && !isVSCode && !isMiniChatSurface ? (
                <div className="chat-input-column mb-7 text-center">
                    <h1 className="text-balance text-2xl font-normal tracking-tight text-foreground md:text-3xl">
                        {renderDraftTitle(
                            draftProjectLabel
                                ? t('chat.emptyState.draftTitleWithProject', { project: draftProjectLabel })
                                : t('chat.emptyState.draftTitle'),
                            draftProjectLabel,
                        )}
                    </h1>
                </div>
            ) : null}
            <div className={cn('chat-input-column relative overflow-visible', isComposerExpanded && 'flex flex-1 min-h-0 flex-col')}>
                {nativeIosComposerActive ? null : (
                    <AttachedFilesList attachments={attachedFiles} onShowPopup={handleShowAttachmentPopup} onRemoveAttachedFile={handleAttachedFileRemove} />
                )}
                <AutoReviewBanner />
                {hasDrafts && (
                    <div className="flex flex-wrap items-center gap-2 pb-2">
                        {reviewCount > 0 ? (
                            <div
                                className="inline-flex items-center gap-1.5 rounded-xl border px-2.5 py-1"
                                style={{
                                    backgroundColor: currentTheme?.colors?.surface?.elevated,
                                    borderColor: currentTheme?.colors?.interactive?.border,
                                }}
                            >
                                <span className="text-xs font-medium text-muted-foreground">{t('chat.chatInput.reviewComments')}</span>
                                <span className="text-xs font-semibold" style={{ color: currentTheme?.colors?.status?.info }}>{reviewCount}</span>
                                <button
                                    type="button"
                                    className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded-full text-muted-foreground hover:bg-interactive-hover hover:text-foreground"
                                    style={{ minHeight: 0, minWidth: 0 }}
                                    onClick={removeReviewDrafts}
                                    aria-label={t('chat.chatInput.reviewCommentsRemove')}
                                    title={t('chat.chatInput.reviewCommentsRemove')}
                                >
                                    <Icon name="close" className="h-3 w-3" />
                                </button>
                            </div>
                        ) : null}
                        {previewConsoleCount > 0 ? (
                            <div
                                className="inline-flex items-center gap-1.5 rounded-xl border px-2.5 py-1"
                                style={{
                                    backgroundColor: currentTheme?.colors?.surface?.elevated,
                                    borderColor: currentTheme?.colors?.interactive?.border,
                                }}
                            >
                                <span className="text-xs font-medium text-muted-foreground">{t('chat.chatInput.devServerLogs')}</span>
                                <span className="text-xs font-semibold" style={{ color: currentTheme?.colors?.status?.info }}>{previewConsoleCount}</span>
                                <button
                                    type="button"
                                    className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded-full text-muted-foreground hover:bg-interactive-hover hover:text-foreground"
                                    style={{ minHeight: 0, minWidth: 0 }}
                                    onClick={() => removePreviewDrafts('preview-console')}
                                    aria-label={t('chat.chatInput.devServerLogsRemove')}
                                    title={t('chat.chatInput.devServerLogsRemove')}
                                >
                                    <Icon name="close" className="h-3 w-3" />
                                </button>
                            </div>
                        ) : null}
                        {previewAnnotationCount > 0 ? (
                            <div
                                className="inline-flex items-center gap-1.5 rounded-xl border px-2.5 py-1"
                                style={{
                                    backgroundColor: currentTheme?.colors?.surface?.elevated,
                                    borderColor: currentTheme?.colors?.interactive?.border,
                                }}
                            >
                                <span className="text-xs font-medium text-muted-foreground">{t('chat.chatInput.previewAnnotations')}</span>
                                <span className="text-xs font-semibold" style={{ color: currentTheme?.colors?.status?.info }}>{previewAnnotationCount}</span>
                                <button
                                    type="button"
                                    className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded-full text-muted-foreground hover:bg-interactive-hover hover:text-foreground"
                                    style={{ minHeight: 0, minWidth: 0 }}
                                    onClick={() => removePreviewDrafts('preview-annotation')}
                                    aria-label={t('chat.chatInput.previewContextRemove')}
                                    title={t('chat.chatInput.previewContextRemove')}
                                >
                                    <Icon name="close" className="h-3 w-3" />
                                </button>
                            </div>
                        ) : null}
                    </div>
                )}

                {/* Linked Issue row */}
                {linkedIssue && !isVSCode && (
                    <div className="pb-2 w-full px-1">
                        <div className="flex w-full items-center gap-1.5 text-sm h-5 px-1">
                            <button
                                type="button"
                                onClick={() => setIssuePickerOpen(true)}
                                className="flex min-w-0 flex-1 items-center gap-1.5 text-left hover:opacity-80 transition-opacity"
                            >
                                {linkedIssue.author?.avatarUrl && (
                                    <img
                                        src={linkedIssue.author.avatarUrl}
                                        alt={linkedIssue.author.login}
                                        className="h-5 w-5 rounded-full flex-shrink-0"
                                    />
                                )}
                                <span className="text-muted-foreground flex-shrink-0">
                                    #{linkedIssue.number}
                                    {linkedIssue.author && (
                                        <span className="ml-1">{t('chat.chatInput.linked.byAuthor', { author: linkedIssue.author.login })}</span>
                                    )}
                                </span>
                                <span className="text-foreground truncate">
                                    {linkedIssue.title}
                                </span>
                            </button>
                            <span className="flex items-center gap-0.5 flex-shrink-0">
                                <a
                                    href={linkedIssue.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="flex items-center justify-center h-6 w-6 hover:bg-[var(--interactive-hover)] rounded-full transition-colors"
                                    aria-label={t('chat.chatInput.linked.issue.openInBrowserAria')}
                                >
                                    <Icon name="external-link" className="h-4 w-4 text-muted-foreground" />
                                </a>
                                <button
                                    type="button"
                                    onClick={() => {
                                        setLinkedIssue(null);
                                    }}
                                    className="flex items-center justify-center h-6 w-6 hover:bg-[var(--interactive-hover)] rounded-full transition-colors"
                                    aria-label={t('chat.chatInput.linked.issue.removeAria')}
                                    title={t('chat.chatInput.linked.issue.removeAria')}
                                >
                                    <Icon name="close" className="h-4 w-4 text-muted-foreground" />
                                </button>
                            </span>
                        </div>
                    </div>
                )}
                {linkedPr && !isVSCode && (
                    <div className="pb-2 w-full px-1">
                        <div className="flex w-full items-center gap-1.5 text-sm h-5 px-1">
                            <button
                                type="button"
                                onClick={() => setPrPickerOpen(true)}
                                className="flex min-w-0 flex-1 items-center gap-1.5 text-left hover:opacity-80 transition-opacity"
                            >
                                {linkedPr.author?.avatarUrl && (
                                    <img
                                        src={linkedPr.author.avatarUrl}
                                        alt={linkedPr.author.login}
                                        className="h-5 w-5 rounded-full flex-shrink-0"
                                    />
                                )}
                                <span className="text-muted-foreground flex-shrink-0">
                                    {t('chat.chatInput.linked.pr.number', { number: linkedPr.number })}
                                    {linkedPr.author && (
                                        <span className="ml-1">{t('chat.chatInput.linked.byAuthor', { author: linkedPr.author.login })}</span>
                                    )}
                                </span>
                                <span className="text-foreground truncate">
                                    {linkedPr.title}
                                </span>
                                <span className="text-muted-foreground flex-shrink-0 typography-meta">
                                    {linkedPr.head} → {linkedPr.base}
                                </span>
                            </button>
                            <span className="flex items-center gap-0.5 flex-shrink-0">
                                <a
                                    href={linkedPr.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="flex items-center justify-center h-6 w-6 hover:bg-[var(--interactive-hover)] rounded-full transition-colors"
                                    aria-label={t('chat.chatInput.linked.pr.openInBrowserAria')}
                                >
                                    <Icon name="external-link" className="h-4 w-4 text-muted-foreground" />
                                </a>
                                <button
                                    type="button"
                                    onClick={() => {
                                        setLinkedPr(null);
                                    }}
                                    className="flex items-center justify-center h-6 w-6 hover:bg-[var(--interactive-hover)] rounded-full transition-colors"
                                    aria-label={t('chat.chatInput.linked.pr.removeAria')}
                                    title={t('chat.chatInput.linked.pr.removeAria')}
                                >
                                    <Icon name="close" className="h-4 w-4 text-muted-foreground" />
                                </button>
                            </span>
                        </div>
                    </div>
                )}
                <RevertedMessageDock
                    sessionId={currentSessionId}
                    directory={currentSessionDirectoryForSync ?? currentDirectory}
                />
                <div className={isMobile ? 'relative oc-mobile-composer-stack' : 'contents'}>
                <div className={isMobile ? 'oc-mobile-composer-expanded-layer' : 'contents'}>
                <div className={isMobile ? 'oc-mobile-composer-reveal' : 'contents'}>
                <div
                    ref={nativeAccessoryRef}
                    data-native-composer-accessories="true"
                >
                <MemoStatusRow
                    showAbortStatus={showAbortStatus}
                    showAssistantStatus={false}
                    showTodos
                    leftAccessory={newSessionDraftOpen || !hasPendingChanges ? null : <PendingChangesBar />}
                />
                {!isMobile && showDraftTargetSelectors ? (
                    <div className="mb-1.5 flex min-w-0 items-center gap-1.5 px-0.5">
                        {selectedDraftProject ? (
                            <Select
                                value={selectedDraftProject.id}
                                open={desktopDraftProjectPickerOpen}
                                onValueChange={handleDraftProjectChange}
                                onOpenChange={(open) => {
                                    setDesktopDraftProjectPickerOpen(open);
                                    if (!open) {
                                        setDesktopDraftProjectQuery('');
                                    }
                                }}
                            >
                                <SelectTrigger asChild size="sm">
                                    <button
                                        type="button"
                                        className={cn(
                                            'group relative inline-flex h-6 min-w-0 w-fit max-w-[42vw] items-center rounded-lg !border-0 px-1.5 py-1 pr-1.5 typography-micro font-medium text-foreground/80 transition-[padding] hover:pr-5 focus-visible:pr-5 data-[popup-open]:pr-5 sm:max-w-[18rem]',
                                            SELECTOR_CHIP_HOVER_CLASS,
                                        )}
                                    >
                                        <SelectValue>
                                            {renderProjectLabelWithIcon(selectedDraftProject)}
                                        </SelectValue>
                                        <Icon
                                            name="arrow-down-s"
                                            className="pointer-events-none absolute right-1 size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 group-data-[popup-open]:opacity-100"
                                            aria-hidden="true"
                                        />
                                    </button>
                                </SelectTrigger>
                                <SelectContent fitContent>
                                    <Input
                                        autoFocus
                                        value={desktopDraftProjectQuery}
                                        onChange={(event) => setDesktopDraftProjectQuery(event.target.value)}
                                        onKeyDown={(event) => event.stopPropagation()}
                                        placeholder={t('chat.chatInput.draftPicker.searchProjects')}
                                        className="mb-1 h-8 min-w-56"
                                    />
                                    {projects.filter((project) => (
                                        matchesModelSearch(getProjectDisplayLabel(project), desktopDraftProjectQuery)
                                        || matchesModelSearch(project.path, desktopDraftProjectQuery)
                                    )).map((project) => (
                                        <SelectItem key={project.id} value={project.id} className="max-w-[24rem] truncate">
                                            {renderProjectLabelWithIcon(project)}
                                        </SelectItem>
                                    ))}
                                    {/* Fixed footer action: replace the removed sidebar "add project" toolbar button. */}
                                    <SelectSeparator />
                                    <button
                                        type="button"
                                        className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left typography-ui-label text-foreground hover:bg-interactive-hover"
                                        onPointerDown={(event) => { event.stopPropagation(); }}
                                        onClick={(event) => {
                                            event.preventDefault();
                                            event.stopPropagation();
                                            setDesktopDraftProjectPickerOpen(false);
                                            requestAnimationFrame(() => sessionEvents.requestDirectoryDialog());
                                        }}
                                    >
                                        <Icon name="folder-add" className="h-4 w-4 shrink-0 text-muted-foreground" />
                                        <span>{t('chat.chatInput.draftPicker.newProject')}</span>
                                    </button>
                                </SelectContent>
                            </Select>
                        ) : (
                            <button
                                type="button"
                                className={cn(
                                    'inline-flex h-auto min-h-6 cursor-pointer items-center gap-1.5 rounded-lg px-2.5 py-1 typography-micro font-medium text-foreground/80',
                                    SELECTOR_CHIP_HOVER_CLASS,
                                )}
                                onClick={() => sessionEvents.requestDirectoryDialog()}
                            >
                                <Icon name="folder-add" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                                <span>{t('chat.chatInput.draftPicker.newProject')}</span>
                            </button>
                        )}

                        {selectedDraftProject && shouldShowDraftBranchSelector ? (
                            <DraftSessionBranchSelector
                                directory={selectedDraftDirectory}
                                projectDirectory={selectedDraftProjectPath}
                                label={selectedDraftBranchLabel}
                                projectRootOption={projectRootBranchOption}
                                worktreeOptions={worktreeBranchOptions}
                                onSelectDirectory={handleDraftDirectoryChange}
                            />
                        ) : null}
                    </div>
                ) : null}
                {isMobile && showDraftTargetSelectors ? (
                    <div className="oc-mobile-draft-target-selectors mb-1.5 flex min-w-0 items-center gap-1.5 px-0.5">
                        {selectedDraftProject ? (
                            <button
                                type="button"
                                className={cn(
                                    'inline-flex h-[1.625rem] min-w-0 max-w-[46%] shrink items-center gap-1.5 rounded-lg px-1.5 text-[11px] leading-none font-medium text-foreground/80',
                                    SELECTOR_CHIP_HOVER_CLASS,
                                )}
                                onClick={() => setMobileDraftPicker('project')}
                            >
                                {renderProjectLabelWithIcon(selectedDraftProject)}
                            </button>
                        ) : (
                            <button
                                type="button"
                                className={cn(
                                    'inline-flex h-[1.625rem] min-w-0 max-w-[46%] items-center gap-1.5 rounded-lg px-1.5 text-[11px] leading-none font-medium text-foreground/80',
                                    SELECTOR_CHIP_HOVER_CLASS,
                                )}
                                onClick={() => sessionEvents.requestDirectoryDialog()}
                            >
                                <Icon name="folder-add" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                                <span>{t('chat.chatInput.draftPicker.newProject')}</span>
                            </button>
                        )}
                        {selectedDraftProject && shouldShowDraftBranchSelector ? (
                            <DraftSessionBranchSelector
                                directory={selectedDraftDirectory}
                                projectDirectory={selectedDraftProjectPath}
                                label={selectedDraftBranchLabel}
                                projectRootOption={projectRootBranchOption}
                                worktreeOptions={worktreeBranchOptions}
                                onSelectDirectory={handleDraftDirectoryChange}
                                maxWidthClassName="max-w-[50%]"
                                presentation="mobile-sheet"
                            />
                        ) : null}
                    </div>
                ) : null}
                {queuedMessageSurface}
                </div>
                </div>
                <div
                    // Desktop: layout-transparent. Mobile: positioning host for
                    // the wrapper-level dictation overlay across pill/full states.
                    className={cn(
                        !isMobile && 'contents',
                        isMobile && 'contents',
                        isMobileExpanded && 'flex min-h-0 flex-1 flex-col',
                    )}
                >
                <div
                    className={isMobile ? 'oc-mobile-composer-motion-viewport' : 'contents'}
                >
                <ChatPromptComposer
                    value={message}
                    attachments={[]}
                    // Establishing keeps the textarea editable so follow-ups can stage chips.
                    disabled={(!currentSessionId && !newSessionDraftOpen) || (resolvedDraftBusy && !sendPhase.establishing)}
                    // canAbort = session busy (stop UI); an active flight blocks Enter re-entry.
                    // Establishing follow-ups intentionally ignore this pending gate in handlers.
                    pending={canAbort || (sendPhase.inFlight && !sendPhase.establishing)}
                    isMobile={isMobile}
                    onSubmit={handlePrimaryAction}
                    data-mobile-composer-surface={isMobile ? 'true' : undefined}
                    data-session-swipe-surface={isMobile ? 'true' : undefined}
                    expanded={isComposerExpanded}
                    focusedTone={inputMode === 'shell' ? 'info' : 'primary'}
                    className={cn(
                        'relative z-10',
                        isDragging && "ring-2 ring-primary ring-offset-2",
                        // Ctrl+X leader pending: subtle selection ring while waiting for M/A/N/C.
                        isLeaderKeyPending && "ring-1 ring-[var(--interactive-selection)] border-[var(--interactive-selection)]",
                        isMobile && 'oc-mobile-composer-surface',
                    )}
                    style={{
                        borderRadius: chatInputRadius,
                    }}
                    ref={dropZoneRef}
                    onDropCapture={handleDropCapture}
                    onDragEnter={handleDragEnter}
                    onDragOver={handleDragOver}
                    onDragLeave={handleDragLeave}
                    onDrop={handleDrop}
                    onDragEnd={handleDragEnd}
                    autoResize={false}
                    disableInputWhilePending={false}
                    contentClassName={isComposerExpanded ? 'flex-1 min-h-0' : undefined}
                    inputHeader={composerInputHeader}
                    attachmentContent={composerAttachmentContent}
                    highlightedContent={composerHighlightedContent}
                    highlightRef={composerHighlightRef}
                    inputRef={textareaRef}
                    textLayoutClassName={cn(
                        COMPOSER_TEXT_LAYOUT_CLASS,
                        isComposerExpanded
                            ? cn('h-full min-h-0', isMobile ? 'py-2.5' : 'py-4')
                            : isMobile
                                ? 'py-2.5'
                                : 'pt-4 pb-2',
                        inputMode === 'shell' ? 'font-mono' : 'typography-markdown md:typography-ui-label',
                    )}
                    inputOuterClassName={cn(isComposerExpanded && 'flex-1 min-h-0')}
                    inputStyle={{
                        flex: isComposerExpanded ? '1 1 auto' : 'none',
                        height: !isComposerExpanded && textareaSize ? `${textareaSize.height}px` : undefined,
                        maxHeight: !isComposerExpanded && textareaSize ? `${textareaSize.maxHeight}px` : undefined,
                        '--oc-composer-textarea-resting-height': isComposerExpanded
                            ? '100%'
                            : textareaSize
                                ? `${textareaSize.height}px`
                                : 'auto',
                        '--oc-composer-textarea-resting-max-height': !isComposerExpanded && textareaSize ? `${textareaSize.maxHeight}px` : 'none',
                        borderTopLeftRadius: chatInputRadius,
                        borderTopRightRadius: chatInputRadius,
                    } as React.CSSProperties}
                    footerClassName={cn(
                        // Keep footer chrome (and the floating follow-up send control)
                        // above the textarea highlight stack (z-10).
                        'z-30 bg-transparent flex-shrink-0',
                        footerPaddingClass,
                        isMobile ? 'flex items-center gap-x-1.5' : cn('flex items-center justify-between', footerGapClass),
                    )}
                    footerStyle={{
                        borderBottomLeftRadius: chatInputRadius,
                        borderBottomRightRadius: chatInputRadius,
                    }}
                    footerContent={composerFooterContent}
                    placeholder={composerPlaceholder}
                    onChange={(_value, event) => handleTextChange(event)}
                    textareaProps={{
                        readOnly: isLeaderKeyPending,
                        onCompositionStart: () => {
                            nativeCompositionActiveRef.current = true;
                        },
                        onCompositionEnd: (event) => {
                            nativeCompositionActiveRef.current = false;
                            const textarea = event.currentTarget;
                            commitBrowserTextChange(
                                textarea.value,
                                textarea.selectionStart ?? textarea.value.length,
                                textarea.selectionEnd ?? textarea.selectionStart ?? textarea.value.length,
                            );
                        },
                        onBeforeInput: handleBeforeInput,
                        onKeyDown: handleKeyDown,
                        onCopy: handleCopy,
                        onCut: handleCut,
                        onPaste: handlePaste,
                        onDragEnter: handleDragEnter,
                        onDragOver: handleDragOver,
                        onDropCapture: handleDropCapture,
                        onDrop: handleDrop,
                        onDragEnd: handleDragEnd,
                        onKeyUp: updateAutocompleteOverlayPosition,
                        onClick: () => {
                            updateAutocompleteOverlayPosition();
                        },
                        onScroll: (event) => {
                            updateAutocompleteOverlayPosition();
                            const scrollTop = event.currentTarget.scrollTop;
                            if (composerHighlightRef.current) {
                                composerHighlightRef.current.style.transform = `translateY(-${scrollTop}px)`;
                            }
                        },
                        onSelect: (event) => {
                            const textarea = event.currentTarget;
                            const selectionStart = textarea.selectionStart ?? 0;
                            const selectionEnd = textarea.selectionEnd ?? selectionStart;
                            if (nativeCompositionActiveRef.current) {
                                cursorPosRef.current = selectionEnd;
                                return;
                            }
                            const atomicSelection = resolveAtomicReferenceSelection(
                                selectionStart,
                                selectionEnd,
                                [
                                    ...findAttachmentCitationRanges(
                                        message,
                                        attachedFiles.filter(isInlineAttachmentCitation).map((file) => file.filename),
                                    ),
                                    ...findSkillMentionRanges(message, availableSkillNames.keys()),
                                    ...composerDocument.references,
                                ],
                            );
                            if (atomicSelection && (atomicSelection.start !== selectionStart || atomicSelection.end !== selectionEnd)) {
                                textarea.setSelectionRange(atomicSelection.start, atomicSelection.end);
                                cursorPosRef.current = atomicSelection.end;
                            } else {
                                cursorPosRef.current = selectionStart;
                            }
                            updateAutocompleteOverlayPosition();
                        },
                        onFocus: () => {
                            if (!isMobile) return;
                            // Footer action just ran (attach / agent / model / …):
                            // drop accidental focus so we never open the IME as
                            // if the user tapped the field.
                            if (Date.now() < suppressComposerFocusUntilRef.current) {
                                const textarea = textareaRef.current;
                                if (textarea) {
                                    textarea.blur();
                                }
                                return;
                            }
                            if (mobileBlurTimerRef.current !== null) {
                                window.clearTimeout(mobileBlurTimerRef.current);
                                mobileBlurTimerRef.current = null;
                            }
                            setMobileTextareaFocused(true);
                        },
                        onBlur: (event) => {
                            nativeCompositionActiveRef.current = false;
                            cursorPosRef.current = event.currentTarget.selectionStart ?? cursorPosRef.current;
                            releaseStagedEditOnComposerBlur();
                            if (!isMobile) return;
                            if (Date.now() < holdComposerFocusUntilRef.current) {
                                const textarea = textareaRef.current;
                                if (textarea) {
                                    textarea.focus();
                                    window.setTimeout(() => {
                                        if (Date.now() < holdComposerFocusUntilRef.current && document.activeElement !== textarea) textarea.focus();
                                    }, 50);
                                    return;
                                }
                            }
                            lastMobileBlurAtRef.current = Date.now();
                            if (isCapacitorApp()) {
                                setMobileTextareaFocused(false);
                                return;
                            }
                            if (mobileBlurTimerRef.current !== null) window.clearTimeout(mobileBlurTimerRef.current);
                            mobileBlurTimerRef.current = window.setTimeout(() => {
                                mobileBlurTimerRef.current = null;
                                setMobileTextareaFocused(false);
                            }, 120);
                        },
                        autoCorrect: isMobile ? 'on' : 'off',
                        autoCapitalize: isMobile ? 'sentences' : 'off',
                        spellCheck: isMobile || inputSpellcheckEnabled,
                        fillContainer: isComposerExpanded,
                        rows: 1,
                    }}
                >
                    <LeaderKeyHint />
                    {isDragging && (
                        <div
                            className="absolute inset-0 z-50 flex items-center justify-center bg-background/90"
                            style={{ borderRadius: chatInputRadius }}
                        >
                            <div className="text-center">
                                <div className="inline-flex justify-center">
                                    <button
                                        type="button"
                                        className={iconButtonBaseClass}
                                        onClick={() => handlePickLocalFiles()}
                                        title={t('chat.chatInput.actions.attachFiles')}
                                        aria-label={t('chat.chatInput.actions.attachFiles')}
                                    >
                                        <Icon name="attachment-2" className={cn(iconSizeClass, 'text-current')} />
                                    </button>
                                </div>
                                <p className="mt-2 typography-ui-label text-muted-foreground">
                                    {isInternalDrag ? t('chat.chatInput.drop.insertMention') : t('chat.chatInput.drop.attachFiles')}
                                </p>
                            </div>
                        </div>
                    )}

                    {showCommandAutocomplete && (
                        <CommandAutocomplete
                            ref={commandRef}
                            searchQuery={commandQuery}
                            directory={currentDirectory}
                            onCommandSelect={handleCommandSelect}
                            onClose={() => setShowCommandAutocomplete(false)}
                            commandPolicy={evaluateChatInputCommandPolicy}
                            commandContext={commandContext}
                            onRowsChange={nativeIosComposerActive ? handleNativeSuggestionRows : undefined}
                            style={isDesktopExpanded && autocompleteOverlayPosition
                                ? {
                                    left: `${autocompleteOverlayPosition.left}px`,
                                    top: `${autocompleteOverlayPosition.top}px`,
                                    bottom: 'auto',
                                    width: `min(450px, calc(100% - ${autocompleteOverlayPosition.left + 8}px))`,
                                    maxHeight: `${autocompleteOverlayPosition.maxHeight}px`,
                                    transform: autocompleteOverlayPosition.place === 'above' ? 'translateY(-100%)' : undefined,
                                }
                                : undefined}
                        />
                    )}
                    { }
                    {showSkillAutocomplete && (
                        <SkillAutocomplete
                            ref={skillRef}
                            searchQuery={skillQuery}
                            directory={currentDirectory}
                            onSkillSelect={handleSkillSelect}
                            onClose={() => setShowSkillAutocomplete(false)}
                            onRowsChange={nativeIosComposerActive ? handleNativeSuggestionRows : undefined}
                            style={isDesktopExpanded && autocompleteOverlayPosition
                                ? {
                                    left: `${autocompleteOverlayPosition.left}px`,
                                    top: `${autocompleteOverlayPosition.top}px`,
                                    bottom: 'auto',
                                    width: `min(360px, calc(100% - ${autocompleteOverlayPosition.left + 8}px))`,
                                    maxHeight: `${autocompleteOverlayPosition.maxHeight}px`,
                                    transform: autocompleteOverlayPosition.place === 'above' ? 'translateY(-100%)' : undefined,
                                }
                                : undefined}
                        />
                    )}

                    {showSnippetAutocomplete && (
                        <SnippetAutocomplete
                            ref={snippetRef}
                            searchQuery={snippetQuery}
                            onSnippetSelect={handleSnippetSelect}
                            onClose={() => setShowSnippetAutocomplete(false)}
                            style={isDesktopExpanded && autocompleteOverlayPosition
                                ? {
                                    left: `${autocompleteOverlayPosition.left}px`,
                                    top: `${autocompleteOverlayPosition.top}px`,
                                    bottom: 'auto',
                                    width: `min(450px, calc(100% - ${autocompleteOverlayPosition.left + 8}px))`,
                                    maxHeight: `${autocompleteOverlayPosition.maxHeight}px`,
                                    transform: autocompleteOverlayPosition.place === 'above' ? 'translateY(-100%)' : undefined,
                                }
                                : undefined}
                        />
                    )}

                    {showFileMention && (

                        <FileMentionAutocomplete
                            ref={mentionRef}
                            searchQuery={mentionQuery}
                            onFileSelect={handleFileSelect}
                            onAgentSelect={handleAgentSelect}
                            onSessionSelect={handleSessionSelect}
                            onClose={() => setShowFileMention(false)}
                            onRowsChange={nativeIosComposerActive ? handleNativeSuggestionRows : undefined}
                            style={isDesktopExpanded && autocompleteOverlayPosition
                                ? {
                                    left: `${autocompleteOverlayPosition.left}px`,
                                    top: `${autocompleteOverlayPosition.top}px`,
                                    bottom: 'auto',
                                    width: `min(520px, calc(100% - ${autocompleteOverlayPosition.left + 8}px))`,
                                    maxHeight: `${autocompleteOverlayPosition.maxHeight}px`,
                                    transform: autocompleteOverlayPosition.place === 'above' ? 'translateY(-100%)' : undefined,
                                }
                                : undefined}
                        />
                    )}
                </ChatPromptComposer>
                {/* Wrapper-level dictation engine + overlay: stays mounted across
                    collapsed ↔ expanded layout so a recording started from the
                    compact field survives the grow. Overlay covers the surface. */}
                {isMobile ? (
                    <MemoComposerDictation
                        radius={chatInputRadius}
                        isMobile={isMobile}
                        footerIconButtonClass={footerIconButtonClass}
                        footerPaddingClass={footerPaddingClass}
                        iconSizeClass={iconSizeClass}
                        sendIconSizeClass={sendIconSizeClass}
                        onInsert={handleDictationInsert}
                        onInsertAndSend={handleDictationInsertAndSend}
                        onContentHeightChange={handleDictationContentHeightChange}
                        renderTrigger={false}
                        topAccessory={<span data-oc-composer-dictation-active="true" className="hidden" aria-hidden="true" />}
                    />
                ) : null}
                </div>
                </div>
                </div>
                {isMobile ? (
                    <div
                        className="oc-mobile-composer-compact-layer"
                        data-oc-composer-compact-surface="true"
                    >
                        {mobileCompactComposerChrome}
                        <div
                            className={cn(
                                'oc-mobile-composer-compact-preview',
                                !message.trim() && 'oc-mobile-composer-compact-preview--placeholder',
                            )}
                            aria-hidden="true"
                        >
                            {message.trim() ? message : compactComposerPlaceholder}
                        </div>
                    </div>
                ) : null}
                </div>
                {/* Hidden host for the model/agent/variant bottom sheets. Kept
                    outside expanded chrome so an open panel survives (and stays
                    visible over) the collapsed composer. */}
                {isMobile ? (
                    <MemoModelControls
                        className="hidden"
                        composerTextareaRef={textareaRef}
                        selectionAdapter={modelControlsSelectionAdapter}
                        mobilePanel={mobileControlsPanel}
                        onMobilePanelChange={setMobileControlsPanel}
                    />
                ) : null}
            </div>
            {newSessionDraftOpen && !isDesktopExpanded && !isMobile && !isVSCode && !isMiniChatSurface ? (
                <DraftPresetChips onSubmit={submitPresetPrompt} className="chat-input-column mt-4" />
            ) : null}
        </form>
        {attachmentPopup.open ? (
            <React.Suspense fallback={null}>
                <ToolOutputDialog
                    popup={attachmentPopup}
                    onOpenChange={handleAttachmentPopupChange}
                    isMobile={isMobile}
                />
            </React.Suspense>
        ) : null}

        {/* Issue Picker Dialog */}
        <GitHubIssuePickerDialog
            open={issuePickerOpen}
            onOpenChange={setIssuePickerOpen}
            mode="select"
            onSelect={(issue) => {
                setLinkedIssue(issue);
                setLinkedPr(null);
            }}
        />
        <GitHubPrPickerDialog
            open={prPickerOpen}
            onOpenChange={setPrPickerOpen}
            onSelect={(pr) => {
                setLinkedPr(pr);
                setLinkedIssue(null);
            }}
        />
        <ReviewFlowDialog
            open={reviewDialogOpen}
            onOpenChange={setReviewDialogOpen}
            projectDirectory={currentSessionDirectoryForSync ?? currentDirectory ?? null}
            submitting={reviewFlowSubmitting}
            onConfirm={handleStartReviewFlow}
        />
        {/* Always-mounted picker inputs. They must NOT live inside
            ComposerAttachmentControls: that component mounts once per composer
            variant (pill / expanded footer), so a shared ref got nulled when a
            variant unmounted, and a variant swap while the OS file picker was
            open detached the clicked input — its change event was silently
            lost and the picked files never attached. */}
        <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={handleLocalFileSelect}
            accept="*/*"
        />
        <input
            ref={imageInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={handleLocalFileSelect}
            accept="image/*"
        />

        {/* Mobile attachment sheet: kept for ATTACHMENT_EXPANSION_MENU_ENABLED.
            Replaces the dropdown (which stole focus and dismissed the keyboard)
            and leaves room for more actions later. */}
        {ATTACHMENT_EXPANSION_MENU_ENABLED && isMobile ? (
            <MobileResizableSheet
                id="mobile-attach-menu-sheet"
                open={mobileAttachMenuOpen}
                onOpenChange={(open) => {
                    if (!open) setMobileAttachMenuOpen(false);
                }}
                title={<h2 className="truncate typography-ui-label font-semibold">{t('chat.chatInput.actions.addAttachment')}</h2>}
                ariaLabel={t('chat.chatInput.actions.addAttachment')}
                closeAriaLabel={t('mobile.surface.closeAria')}
                resizeAriaLabel={t('mobile.sessions.sheet.resizeAria')}
                fitContent
            >
                <div className="flex min-h-0 flex-col overflow-y-auto overscroll-contain px-3 pb-3">
                    <div
                        className="overflow-hidden rounded-2xl bg-[var(--surface-muted)]"
                        data-page-scroll-lock="true"
                    >
                        <Button
                            type="button"
                            variant="ghost"
                            size="lg"
                            className="h-auto min-h-12 w-full justify-start gap-3 rounded-none supports-[corner-shape:squircle]:rounded-none px-4 border-b border-[var(--surface-subtle)] last:border-b-0"
                            data-mobile-press-feedback="none"
                            onClick={() => {
                                // The native file/photo picker takes over next — restoring
                                // the keyboard in between would flash it open and shut.
                                restoreKeyboardAfterOverlayRef.current = false;
                                setMobileAttachMenuOpen(false);
                                requestAnimationFrame(handlePickLocalFiles);
                            }}
                        >
                            <Icon name="attachment-2" className="size-5 flex-shrink-0 text-muted-foreground" />
                            <span className="truncate">{t('chat.chatInput.actions.attachFiles')}</span>
                        </Button>
                        <Button
                            type="button"
                            variant="ghost"
                            size="lg"
                            className="h-auto min-h-12 w-full justify-start gap-3 rounded-none supports-[corner-shape:squircle]:rounded-none px-4 border-b border-[var(--surface-subtle)] last:border-b-0"
                            data-mobile-press-feedback="none"
                            onClick={() => {
                                // Hand-off to the picker: don't sync-restore the
                                // keyboard under the overlay that opens next frame.
                                skipNextOverlayCloseRestoreRef.current = true;
                                setMobileAttachMenuOpen(false);
                                requestAnimationFrame(openIssuePicker);
                            }}
                        >
                            <Icon name="github" className="size-5 flex-shrink-0 text-muted-foreground" />
                            <span className="truncate">{t('chat.chatInput.actions.linkGithubIssue')}</span>
                        </Button>
                        <Button
                            type="button"
                            variant="ghost"
                            size="lg"
                            className="h-auto min-h-12 w-full justify-start gap-3 rounded-none supports-[corner-shape:squircle]:rounded-none px-4 border-b border-[var(--surface-subtle)] last:border-b-0"
                            data-mobile-press-feedback="none"
                            onClick={() => {
                                skipNextOverlayCloseRestoreRef.current = true;
                                setMobileAttachMenuOpen(false);
                                requestAnimationFrame(openPrPicker);
                            }}
                        >
                            <Icon name="git-pull-request" className="size-5 flex-shrink-0 text-muted-foreground" />
                            <span className="truncate">{t('chat.chatInput.actions.linkGithubPr')}</span>
                        </Button>
                    </div>
                </div>
            </MobileResizableSheet>
        ) : null}

        {/* Android Capacitor photo/file chooser: the all-files WebView input opens
            the system file manager and loses the gallery experience; iOS keeps the
            single attach flow (WKWebView's picker already offers the photo library). */}
        {isMobile ? (
            <MobileResizableSheet
                id="android-media-pick-sheet"
                open={androidMediaPickSheetOpen}
                onOpenChange={(open) => {
                    if (!open) setAndroidMediaPickSheetOpen(false);
                }}
                title={<h2 className="truncate typography-ui-label font-semibold">{t('chat.chatInput.actions.addAttachment')}</h2>}
                ariaLabel={t('chat.chatInput.actions.addAttachment')}
                closeAriaLabel={t('mobile.surface.closeAria')}
                resizeAriaLabel={t('mobile.sessions.sheet.resizeAria')}
                fitContent
            >
                <div className="flex min-h-0 flex-col overflow-y-auto overscroll-contain px-3 pb-3">
                    <div
                        className="overflow-hidden rounded-2xl bg-[var(--surface-muted)]"
                        data-page-scroll-lock="true"
                    >
                        <Button
                            type="button"
                            variant="ghost"
                            size="lg"
                            className="h-auto min-h-12 w-full justify-start gap-3 rounded-none supports-[corner-shape:squircle]:rounded-none px-4 border-b border-[var(--surface-subtle)] last:border-b-0"
                            data-mobile-press-feedback="none"
                            onClick={() => {
                                restoreKeyboardAfterOverlayRef.current = false;
                                setAndroidMediaPickSheetOpen(false);
                                requestAnimationFrame(handlePickAndroidPhotos);
                            }}
                        >
                            <Icon name="file-image" className="size-5 flex-shrink-0 text-muted-foreground" />
                            <span className="truncate">{t('chat.chatInput.actions.attachPhotos')}</span>
                        </Button>
                        <Button
                            type="button"
                            variant="ghost"
                            size="lg"
                            className="h-auto min-h-12 w-full justify-start gap-3 rounded-none supports-[corner-shape:squircle]:rounded-none px-4 border-b border-[var(--surface-subtle)] last:border-b-0"
                            data-mobile-press-feedback="none"
                            onClick={() => {
                                restoreKeyboardAfterOverlayRef.current = false;
                                setAndroidMediaPickSheetOpen(false);
                                requestAnimationFrame(handlePickLocalFiles);
                            }}
                        >
                            <Icon name="attachment-2" className="size-5 flex-shrink-0 text-muted-foreground" />
                            <span className="truncate">{t('chat.chatInput.actions.attachFiles')}</span>
                        </Button>
                    </div>
                </div>
            </MobileResizableSheet>
        ) : null}

        {/* Mobile draft target pickers: bottom sheets replacing the inline
            project/branch Selects (which desktop keeps). */}
        {isMobile && showDraftTargetSelectors && selectedDraftProject ? (
            <>
                <MobileResizableSheet
                    id={`mobile-draft-project-picker-sheet-${mobileDraftProjectSheetId}`}
                    open={mobileDraftPicker === 'project'}
                    onOpenChange={(open) => {
                        if (!open) setMobileDraftPicker(null);
                    }}
                    ariaLabel={t('chat.chatInput.draftPicker.projectTitle')}
                    closeAriaLabel={t('mobile.surface.closeAria')}
                    resizeAriaLabel={t('mobile.sessions.sheet.resizeAria')}
                >
                    <div className="shrink-0 px-3 pb-2 pt-1" data-mobile-sheet-no-dismiss="">
                        <Input
                            value={mobileDraftPickerQuery}
                            onChange={(event) => setMobileDraftPickerQuery(event.target.value)}
                            placeholder={t('chat.chatInput.draftPicker.searchProjects')}
                            className="h-9"
                        />
                    </div>
                    <ScrollableOverlay outerClassName="min-h-0 flex-1" disableHorizontal>
                        <div className="flex flex-col px-3 pb-2">
                            {projects
                                .filter((project) => {
                                    return matchesModelSearch(getProjectDisplayLabel(project), mobileDraftPickerQuery)
                                        || matchesModelSearch(project.path, mobileDraftPickerQuery);
                                })
                                .map((project) => (
                                    <button
                                        key={project.id}
                                        type="button"
                                        className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-2.5 text-left typography-ui-label hover:bg-[var(--interactive-hover)]"
                                        onClick={() => {
                                            handleDraftProjectChange(project.id);
                                            setMobileDraftPicker(null);
                                        }}
                                    >
                                        <span className="min-w-0 flex-1">{renderProjectLabelWithIcon(project)}</span>
                                        {project.id === selectedDraftProject.id ? (
                                            <Icon name="check" className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                                        ) : null}
                                    </button>
                                ))}
                        </div>
                    </ScrollableOverlay>
                    {/* Fixed footer action: replace the removed sidebar "add project" toolbar button. */}
                    <div className="shrink-0 px-3 pb-4 pt-1">
                        <button
                            type="button"
                            className="flex w-full cursor-pointer items-center gap-2 rounded-lg border-t border-border/50 px-2 py-2.5 text-left typography-ui-label hover:bg-[var(--interactive-hover)]"
                            onClick={() => {
                                setMobileDraftPicker(null);
                                sessionEvents.requestDirectoryDialog();
                            }}
                        >
                            <Icon name="folder-add" className="h-4 w-4 shrink-0 text-muted-foreground" />
                            <span>{t('chat.chatInput.draftPicker.newProject')}</span>
                        </button>
                    </div>
                </MobileResizableSheet>
            </>
        ) : null}
        </>
    );
};

const ChatInputComponent: React.FC<ChatInputProps> = (props) => {
    const contextSurface = useChatInputSurfaceContext();
    const surface = props.surface ?? contextSurface;
    if (surface && !surface.active) return null;
    return <ChatInputRuntime {...props} surface={surface ?? undefined} />;
};

ChatInputComponent.displayName = 'ChatInput';

export const ChatInput = React.memo(ChatInputComponent);
