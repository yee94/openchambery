import React from 'react';
import { runtimeFetch } from '@/lib/runtime-fetch';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import type { ThemeMode } from '@/types/theme';
import { useUIStore } from '@/stores/useUIStore';
import { useMessageQueueStore, type FollowUpBehavior } from '@/stores/messageQueueStore';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { NumberInput } from '@/components/ui/number-input';
import { Radio } from '@/components/ui/radio';
import { Input } from '@/components/ui/input';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { Icon } from "@/components/icon/Icon";
import { invokeDesktop, isDesktopShell, isVSCodeRuntime, isWebRuntime } from '@/lib/desktop';
import { useDeviceInfo } from '@/lib/device';
import { usePwaDetection } from '@/hooks/usePwaDetection';
import { updateDesktopSettings } from '@/lib/persistence';
import { CODE_FONT_OPTIONS, DEFAULT_MONO_FONT, DEFAULT_UI_FONT, UI_FONT_OPTIONS, type MonoFontOption, type UiFontOption } from '@/lib/fontOptions';
import { useI18n, type Locale } from '@/lib/i18n';
import { useConfigStore } from '@/stores/useConfigStore';
import { useSidebarBrandStore } from '@/stores/useSidebarBrandStore';
import { normalizeMobileKeyboardMode, supportsMobileKeyboardResizeContent, type MobileKeyboardMode } from '@/lib/mobileKeyboardMode';
import {
    setDirectoryShowHidden,
    useDirectoryShowHidden,
} from '@/lib/directoryShowHidden';
import {
    SettingsField,
    SettingsGroup,
    SettingsRow,
} from '@/components/sections/shared/SettingsGroup';

interface Option<T extends string> {
    id: T;
    labelKey: string;
    descriptionKey?: string;
}

type ResponsiveSettingsGroupProps = {
    isMobile: boolean;
    label?: React.ReactNode;
    children: React.ReactNode;
    description?: React.ReactNode;
    className?: string;
};

type ResponsiveSettingsFieldProps = {
    isMobile: boolean;
    itemId?: string;
    label: React.ReactNode;
    description?: React.ReactNode;
    descriptionPlacement?: 'inside' | 'outside';
    children: React.ReactNode;
    className?: string;
    copyClassName?: string;
    controlClassName?: string;
};

const ResponsiveSettingsField = ({
    isMobile,
    itemId,
    label,
    description,
    descriptionPlacement,
    children,
    className,
    copyClassName,
    controlClassName,
}: ResponsiveSettingsFieldProps) => (
    <SettingsField
        itemId={itemId}
        label={label}
        description={description}
        descriptionPlacement={descriptionPlacement}
        groupClassName={cn('oc-settings-detail-group', isMobile && 'oc-mobile-settings-detail-group')}
        className={className}
        copyClassName={copyClassName}
        controlClassName={controlClassName}
    >
        {children}
    </SettingsField>
);

const ResponsiveSettingsGroup = ({
    isMobile,
    label,
    children,
    description,
    className,
}: ResponsiveSettingsGroupProps) => {
    return (
        <SettingsGroup
            label={label}
            description={description}
            className={cn('oc-settings-detail-group', isMobile && 'oc-mobile-settings-detail-group', className)}
        >
            {children}
        </SettingsGroup>
    );
};

type ResponsiveSettingsRowProps = {
    isMobile: boolean;
    itemId?: string;
    label: React.ReactNode;
    mobileLabel?: React.ReactNode | null;
    description?: React.ReactNode;
    children: React.ReactNode;
    className?: string;
    copyClassName?: string;
    controlClassName?: string;
};

const ResponsiveSettingsRow = ({
    isMobile,
    itemId,
    label,
    mobileLabel,
    description,
    children,
    className,
    copyClassName,
    controlClassName,
}: ResponsiveSettingsRowProps) => {
    return (
        <SettingsRow
            itemId={itemId}
            label={isMobile && mobileLabel !== undefined ? mobileLabel : label}
            description={description}
            className={className}
            copyClassName={copyClassName}
            controlClassName={controlClassName}
        >
            {children}
        </SettingsRow>
    );
};

type SettingsRadioOptionProps = {
    selected: boolean;
    onSelect: () => void;
    label: React.ReactNode;
    ariaLabel: string;
};

const SettingsRadioOption = ({
    selected,
    onSelect,
    label,
    ariaLabel,
}: SettingsRadioOptionProps) => (
    <div
        className="oc-settings-group-row group flex cursor-pointer items-center gap-2 text-left"
        role="button"
        tabIndex={0}
        aria-pressed={selected}
        onClick={onSelect}
        onKeyDown={(event) => {
            if (event.key === ' ' || event.key === 'Enter') {
                event.preventDefault();
                onSelect();
            }
        }}
    >
        <Radio checked={selected} onChange={onSelect} ariaLabel={ariaLabel} />
        <span className={cn('typography-ui-label font-normal', selected ? 'text-foreground' : 'text-foreground/50')}>
            {label}
        </span>
    </div>
);

const THEME_MODE_OPTIONS: Array<{ value: ThemeMode; labelKey: string }> = [
    {
        value: 'system',
        labelKey: 'settings.openchamber.visual.option.themeMode.system',
    },
    {
        value: 'light',
        labelKey: 'settings.openchamber.visual.option.themeMode.light',
    },
    {
        value: 'dark',
        labelKey: 'settings.openchamber.visual.option.themeMode.dark',
    },
];

const DIFF_LAYOUT_OPTIONS: Option<'dynamic' | 'inline' | 'side-by-side'>[] = [
    {
        id: 'dynamic',
        labelKey: 'settings.openchamber.visual.option.diffLayout.dynamic.label',
        descriptionKey: 'settings.openchamber.visual.option.diffLayout.dynamic.description',
    },
    {
        id: 'inline',
        labelKey: 'settings.openchamber.visual.option.diffLayout.inline.label',
        descriptionKey: 'settings.openchamber.visual.option.diffLayout.inline.description',
    },
    {
        id: 'side-by-side',
        labelKey: 'settings.openchamber.visual.option.diffLayout.sideBySide.label',
        descriptionKey: 'settings.openchamber.visual.option.diffLayout.sideBySide.description',
    },
];

const MERMAID_RENDERING_OPTIONS: Option<'svg' | 'ascii'>[] = [
    {
        id: 'svg',
        labelKey: 'settings.openchamber.visual.option.mermaidRendering.svg.label',
        descriptionKey: 'settings.openchamber.visual.option.mermaidRendering.svg.description',
    },
    {
        id: 'ascii',
        labelKey: 'settings.openchamber.visual.option.mermaidRendering.ascii.label',
        descriptionKey: 'settings.openchamber.visual.option.mermaidRendering.ascii.description',
    },
];

const DEFAULT_PWA_INSTALL_NAME = 'OpenChamber - AI Coding Assistant';
const PWA_ORIENTATION_OPTIONS: Option<'system' | 'portrait' | 'landscape'>[] = [
    {
        id: 'system',
        labelKey: 'settings.openchamber.visual.option.pwaOrientation.system.label',
        descriptionKey: 'settings.openchamber.visual.option.pwaOrientation.system.description',
    },
    {
        id: 'portrait',
        labelKey: 'settings.openchamber.visual.option.pwaOrientation.portrait.label',
        descriptionKey: 'settings.openchamber.visual.option.pwaOrientation.portrait.description',
    },
    {
        id: 'landscape',
        labelKey: 'settings.openchamber.visual.option.pwaOrientation.landscape.label',
        descriptionKey: 'settings.openchamber.visual.option.pwaOrientation.landscape.description',
    },
];

const MOBILE_KEYBOARD_MODE_OPTIONS: Option<MobileKeyboardMode>[] = [
    {
        id: 'native',
        labelKey: 'settings.openchamber.visual.option.mobileKeyboardMode.native.label',
        descriptionKey: 'settings.openchamber.visual.option.mobileKeyboardMode.native.description',
    },
    {
        id: 'resize-content',
        labelKey: 'settings.openchamber.visual.option.mobileKeyboardMode.resizeContent.label',
        descriptionKey: 'settings.openchamber.visual.option.mobileKeyboardMode.resizeContent.description',
    },
];

type PwaInstallNameWindow = Window & {
    __OPENCHAMBER_SET_PWA_INSTALL_NAME__?: (value: string) => string;
    __OPENCHAMBER_SET_PWA_ORIENTATION__?: (value: 'system' | 'portrait' | 'landscape') => 'system' | 'portrait' | 'landscape';
    __OPENCHAMBER_UPDATE_PWA_MANIFEST__?: () => void;
};

const normalizePwaOrientation = (value: unknown): 'system' | 'portrait' | 'landscape' => {
    return value === 'portrait' || value === 'landscape' ? value : 'system';
};

const USER_MESSAGE_RENDERING_OPTIONS: Option<'markdown' | 'plain'>[] = [
    {
        id: 'markdown',
        labelKey: 'settings.openchamber.visual.option.userMessageRendering.markdown.label',
        descriptionKey: 'settings.openchamber.visual.option.userMessageRendering.markdown.description',
    },
    {
        id: 'plain',
        labelKey: 'settings.openchamber.visual.option.userMessageRendering.plain.label',
        descriptionKey: 'settings.openchamber.visual.option.userMessageRendering.plain.description',
    },
];

const CHAT_RENDER_MODE_OPTIONS: Option<'sorted' | 'live'>[] = [
    {
        id: 'sorted',
        labelKey: 'settings.openchamber.visual.option.chatRenderMode.sorted.label',
        descriptionKey: 'settings.openchamber.visual.option.chatRenderMode.sorted.description',
    },
    {
        id: 'live',
        labelKey: 'settings.openchamber.visual.option.chatRenderMode.live.label',
        descriptionKey: 'settings.openchamber.visual.option.chatRenderMode.live.description',
    },
];

const MESSAGE_STREAM_TRANSPORT_OPTIONS: Option<'auto' | 'ws' | 'sse'>[] = [
    {
        id: 'auto',
        labelKey: 'settings.openchamber.visual.option.messageTransport.auto.label',
        descriptionKey: 'settings.openchamber.visual.option.messageTransport.auto.description',
    },
    {
        id: 'ws',
        labelKey: 'settings.openchamber.visual.option.messageTransport.ws.label',
        descriptionKey: 'settings.openchamber.visual.option.messageTransport.ws.description',
    },
    {
        id: 'sse',
        labelKey: 'settings.openchamber.visual.option.messageTransport.sse.label',
        descriptionKey: 'settings.openchamber.visual.option.messageTransport.sse.description',
    },
];

const ACTIVITY_RENDER_MODE_OPTIONS: Option<'collapsed' | 'summary'>[] = [
    {
        id: 'collapsed',
        labelKey: 'settings.openchamber.visual.option.activityRenderMode.collapsed.label',
        descriptionKey: 'settings.openchamber.visual.option.activityRenderMode.collapsed.description',
    },
    {
        id: 'summary',
        labelKey: 'settings.openchamber.visual.option.activityRenderMode.summary.label',
        descriptionKey: 'settings.openchamber.visual.option.activityRenderMode.summary.description',
    },
];

const TIME_FORMAT_OPTIONS: Option<'auto' | '12h' | '24h'>[] = [
    {
        id: 'auto',
        labelKey: 'settings.openchamber.visual.option.timeFormat.auto.label',
        descriptionKey: 'settings.openchamber.visual.option.timeFormat.auto.description',
    },
    {
        id: '24h',
        labelKey: 'settings.openchamber.visual.option.timeFormat.24h.label',
        descriptionKey: 'settings.openchamber.visual.option.timeFormat.24h.description',
    },
    {
        id: '12h',
        labelKey: 'settings.openchamber.visual.option.timeFormat.12h.label',
        descriptionKey: 'settings.openchamber.visual.option.timeFormat.12h.description',
    },
];

const WEEK_START_OPTIONS: Option<'auto' | 'monday' | 'sunday'>[] = [
    {
        id: 'auto',
        labelKey: 'settings.openchamber.visual.option.weekStart.auto.label',
        descriptionKey: 'settings.openchamber.visual.option.weekStart.auto.description',
    },
    {
        id: 'monday',
        labelKey: 'settings.openchamber.visual.option.weekStart.monday.label',
    },
    {
        id: 'sunday',
        labelKey: 'settings.openchamber.visual.option.weekStart.sunday.label',
    },
];

const FOLLOW_UP_BEHAVIOR_OPTIONS: Option<FollowUpBehavior>[] = [
    {
        id: 'steer',
        labelKey: 'settings.openchamber.visual.option.followUpBehavior.steer.label',
    },
    {
        id: 'queue',
        labelKey: 'settings.openchamber.visual.option.followUpBehavior.queue.label',
    },
];

const normalizeUserMessageRenderingMode = (mode: unknown): 'markdown' | 'plain' => {
    return mode === 'markdown' ? 'markdown' : 'plain';
};

type VisibleSetting = 'sessionAssist' | 'sessionGoal' | 'theme' | 'sidebarBrand' | 'pwaInstallName' | 'pwaOrientation' | 'mobileKeyboardMode' | 'timeFormat' | 'weekStart' | 'fontSize' | 'codeFontSize' | 'terminalFontSize' | 'editorFontSize' | 'spacing' | 'inputBarOffset' | 'mermaidRendering' | 'userMessageRendering' | 'chatRenderMode' | 'messageTransport' | 'activityRenderMode' | 'collapsibleUserMessages' | 'stickyUserHeader' | 'promptNavigatorEnabled' | 'wideChatLayout' | 'codeBlockLineWrap' | 'splitAssistantMessageActions' | 'subagentReadOnlyBanner' | 'diffLayout' | 'mobileStatusBar' | 'dotfiles' | 'fileViewerPreview' | 'reasoning' | 'showToolFileIcons' | 'showTurnChangedFiles' | 'showSubagentTaskDetails' | 'expandedTools' | 'followUpBehavior' | 'terminalQuickKeys' | 'fileEditorKeymap' | 'persistDraft' | 'inputSpellcheck' | 'reportUsage' | 'expandedEditorToolbar';

interface OpenChamberVisualSettingsProps {
    /** Which settings to show. If undefined, shows all. */
    visibleSettings?: VisibleSetting[];
    /** The owning surface is already rendering the mobile settings flow. */
    mobile?: boolean;
}

export const OpenChamberVisualSettings: React.FC<OpenChamberVisualSettingsProps> = ({ visibleSettings, mobile }) => {
    const { locale, locales, setLocale, label, t } = useI18n();
    const tUnsafe = React.useCallback((key: string) => t(key as Parameters<typeof t>[0]), [t]);
    const { isMobile: deviceIsMobile } = useDeviceInfo();
    const isMobile = mobile ?? deviceIsMobile;
    const { browserTab } = usePwaDetection();
    const directoryShowHidden = useDirectoryShowHidden();
    const showReasoningTraces = useUIStore(state => state.showReasoningTraces);
    const sessionRecapEnabled = useUIStore(state => state.sessionRecapEnabled);
    const sessionSuggestionEnabled = useUIStore(state => state.sessionSuggestionEnabled);
    const sessionTitleRefreshEnabled = useUIStore(state => state.sessionTitleRefreshEnabled);
    const setSessionRecapEnabled = useUIStore(state => state.setSessionRecapEnabled);
    const setSessionSuggestionEnabled = useUIStore(state => state.setSessionSuggestionEnabled);
    const setSessionTitleRefreshEnabled = useUIStore(state => state.setSessionTitleRefreshEnabled);
    const sessionGoalEnabled = useUIStore(state => state.sessionGoalEnabled);
    const setSessionGoalEnabled = useUIStore(state => state.setSessionGoalEnabled);
    const sessionGoalDefaultBudgetEnabled = useUIStore(state => state.sessionGoalDefaultBudgetEnabled);
    const setSessionGoalDefaultBudgetEnabled = useUIStore(state => state.setSessionGoalDefaultBudgetEnabled);
    const sessionGoalDefaultBudget = useUIStore(state => state.sessionGoalDefaultBudget);
    const setSessionGoalDefaultBudget = useUIStore(state => state.setSessionGoalDefaultBudget);
    const setShowReasoningTraces = useUIStore(state => state.setShowReasoningTraces);
    const collapsibleThinkingBlocks = useUIStore(state => state.collapsibleThinkingBlocks);
    const setCollapsibleThinkingBlocks = useUIStore(state => state.setCollapsibleThinkingBlocks);

    const mermaidRenderingMode = useUIStore(state => state.mermaidRenderingMode);
    const setMermaidRenderingMode = useUIStore(state => state.setMermaidRenderingMode);
    const userMessageRenderingMode = useUIStore(state => state.userMessageRenderingMode);
    const setUserMessageRenderingMode = useUIStore(state => state.setUserMessageRenderingMode);
    const collapsibleUserMessages = useUIStore(state => state.collapsibleUserMessages);
    const setCollapsibleUserMessages = useUIStore(state => state.setCollapsibleUserMessages);
    const stickyUserHeader = useUIStore(state => state.stickyUserHeader);
    const promptNavigatorEnabled = useUIStore(state => state.promptNavigatorEnabled);
    const setStickyUserHeader = useUIStore(state => state.setStickyUserHeader);
    const setPromptNavigatorEnabled = useUIStore(state => state.setPromptNavigatorEnabled);
    const expandedEditorToolbar = useUIStore(state => state.expandedEditorToolbar);
    const setExpandedEditorToolbar = useUIStore(state => state.setExpandedEditorToolbar);
    const wideChatLayoutEnabled = useUIStore(state => state.wideChatLayoutEnabled);
    const setWideChatLayoutEnabled = useUIStore(state => state.setWideChatLayoutEnabled);
    const codeBlockLineWrap = useUIStore(state => state.codeBlockLineWrap);
    const setCodeBlockLineWrap = useUIStore(state => state.setCodeBlockLineWrap);
    const chatRenderMode = useUIStore(state => state.chatRenderMode);
    const setChatRenderMode = useUIStore(state => state.setChatRenderMode);
    const activityRenderMode = useUIStore(state => state.activityRenderMode);
    const setActivityRenderMode = useUIStore(state => state.setActivityRenderMode);
    const fontSize = useUIStore(state => state.fontSize);
    const setFontSize = useUIStore(state => state.setFontSize);
    const codeFontSize = useUIStore(state => state.codeFontSize);
    const setCodeFontSize = useUIStore(state => state.setCodeFontSize);
    const terminalFontSize = useUIStore(state => state.terminalFontSize);
    const setTerminalFontSize = useUIStore(state => state.setTerminalFontSize);
    const editorFontSize = useUIStore(state => state.editorFontSize);
    const setEditorFontSize = useUIStore(state => state.setEditorFontSize);
    const uiFont = useUIStore(state => state.uiFont);
    const setUiFont = useUIStore(state => state.setUiFont);
    const monoFont = useUIStore(state => state.monoFont);
    const setMonoFont = useUIStore(state => state.setMonoFont);
    const padding = useUIStore(state => state.padding);
    const setPadding = useUIStore(state => state.setPadding);
    const inputBarOffset = useUIStore(state => state.inputBarOffset);
    const setInputBarOffset = useUIStore(state => state.setInputBarOffset);
    const mobileKeyboardMode = useUIStore(state => state.mobileKeyboardMode);
    const setMobileKeyboardMode = useUIStore(state => state.setMobileKeyboardMode);
    const diffLayoutPreference = useUIStore(state => state.diffLayoutPreference);
    const setDiffLayoutPreference = useUIStore(state => state.setDiffLayoutPreference);
    const showTerminalQuickKeysOnDesktop = useUIStore(state => state.showTerminalQuickKeysOnDesktop);
    const setShowTerminalQuickKeysOnDesktop = useUIStore(state => state.setShowTerminalQuickKeysOnDesktop);
    const fileEditorKeymap = useUIStore(state => state.fileEditorKeymap);
    const setFileEditorKeymap = useUIStore(state => state.setFileEditorKeymap);
    const followUpBehavior = useMessageQueueStore(state => state.followUpBehavior);
    const setFollowUpBehavior = useMessageQueueStore(state => state.setFollowUpBehavior);
    const persistChatDraft = useUIStore(state => state.persistChatDraft);
    const setPersistChatDraft = useUIStore(state => state.setPersistChatDraft);
    const inputSpellcheckEnabled = useUIStore(state => state.inputSpellcheckEnabled);
    const setInputSpellcheckEnabled = useUIStore(state => state.setInputSpellcheckEnabled);
    const showToolFileIcons = useUIStore(state => state.showToolFileIcons);
    const setShowToolFileIcons = useUIStore(state => state.setShowToolFileIcons);
    const showTurnChangedFiles = useUIStore(state => state.showTurnChangedFiles);
    const setShowTurnChangedFiles = useUIStore(state => state.setShowTurnChangedFiles);
    const showExpandedBashTools = useUIStore(state => state.showExpandedBashTools);
    const setShowExpandedBashTools = useUIStore(state => state.setShowExpandedBashTools);
    const showSubagentTaskDetails = useUIStore(state => state.showSubagentTaskDetails);
    const setShowSubagentTaskDetails = useUIStore(state => state.setShowSubagentTaskDetails);
    const timeFormatPreference = useUIStore(state => state.timeFormatPreference);
    const setTimeFormatPreference = useUIStore(state => state.setTimeFormatPreference);
    const weekStartPreference = useUIStore(state => state.weekStartPreference);
    const setWeekStartPreference = useUIStore(state => state.setWeekStartPreference);
    const showSplitAssistantMessageActions = useUIStore(state => state.showSplitAssistantMessageActions);
    const setShowSplitAssistantMessageActions = useUIStore(state => state.setShowSplitAssistantMessageActions);
    const sidebarBrandName = useSidebarBrandStore(state => state.sidebarBrandName);
    const setSidebarBrandName = useSidebarBrandStore(state => state.setSidebarBrandName);
    const allowPromptingSubagentSessions = useUIStore(state => state.allowPromptingSubagentSessions);
    const setAllowPromptingSubagentSessions = useUIStore(state => state.setAllowPromptingSubagentSessions);
    const messageStreamTransport = useConfigStore((state) => state.settingsMessageStreamTransport);
    const setMessageStreamTransport = useConfigStore((state) => state.setSettingsMessageStreamTransport);
    const effectiveMessageStreamTransport = messageStreamTransport;
    const settingsDefaultFileViewerPreview = useConfigStore((state) => state.settingsDefaultFileViewerPreview);
    const setSettingsDefaultFileViewerPreview = useConfigStore((state) => state.setSettingsDefaultFileViewerPreview);
    const isSettingsDialogOpen = useUIStore(state => state.isSettingsDialogOpen);
    const {
        themeMode,
        setThemeMode,
        availableThemes,
        customThemesLoading,
        reloadCustomThemes,
        lightThemeId,
        darkThemeId,
        setLightThemePreference,
        setDarkThemePreference,
    } = useThemeSystem();

    const [themesReloading, setThemesReloading] = React.useState(false);

    // macOS-desktop-only vibrancy toggle. Changing it needs a full relaunch
    // (vibrancy is a window-creation option), so we persist + restart on save.
    const macVibrancySupported = React.useMemo(
        () => isDesktopShell() && typeof window !== 'undefined' && window.__OPENCHAMBER_ELECTRON__?.macVibrancySupported === true,
        [],
    );
    const macVibrancyEnabled = typeof window !== 'undefined' && window.__OPENCHAMBER_ELECTRON__?.macVibrancy === true;
    const [vibrancyChecked, setVibrancyChecked] = React.useState(macVibrancyEnabled);
    const [vibrancyRestarting, setVibrancyRestarting] = React.useState(false);

    // macOS-desktop-only dock badge that counts chats with unseen activity.
    // The tray sync (mac-only) pumps the count to the main process, so the
    // toggle is offered only where it actually has an effect. No relaunch needed.
    const dockBadgeSupported = React.useMemo(
        () => isDesktopShell() && typeof window !== 'undefined'
            && (window as unknown as { __OPENCHAMBER_PLATFORM__?: string }).__OPENCHAMBER_PLATFORM__ === 'darwin',
        [],
    );
    const dockBadgeEnabled = useUIStore(state => state.dockBadgeEnabled);
    const setDockBadgeEnabled = useUIStore(state => state.setDockBadgeEnabled);
    const [chatRenderPreviewTick, setChatRenderPreviewTick] = React.useState(0);
    const reportUsage = useUIStore(state => state.reportUsage);
    const setReportUsage = useUIStore(state => state.setReportUsage);

    // Sync reportUsage changes to server settings
    const handleReportUsageChange = React.useCallback((enabled: boolean) => {
        setReportUsage(enabled);
        void updateDesktopSettings({ reportUsage: enabled });
    }, [setReportUsage]);

    const shouldAnimateChatPreview = isSettingsDialogOpen
        && (visibleSettings ? visibleSettings.includes('chatRenderMode') : true);

    React.useEffect(() => {
        if (!shouldAnimateChatPreview) {
            return;
        }

        // Use requestAnimationFrame for smoother animation without setInterval overhead
        let rafId: number | null = null;
        let lastTime = Date.now();
        
        const tick = () => {
            const now = Date.now();
            // Update every ~420ms
            if (now - lastTime >= 420) {
                setChatRenderPreviewTick((prev) => (prev + 1) % 24);
                lastTime = now;
            }
            rafId = requestAnimationFrame(tick);
        };
        
        // Only run when visible
        if (typeof document === 'undefined' || document.visibilityState === 'visible') {
            rafId = requestAnimationFrame(tick);
        }
        
        const onVisibility = () => {
            if (document.visibilityState === 'visible' && rafId === null) {
                rafId = requestAnimationFrame(tick);
            } else if (document.visibilityState !== 'visible' && rafId !== null) {
                cancelAnimationFrame(rafId);
                rafId = null;
            }
        };
        
        document.addEventListener('visibilitychange', onVisibility);

        return () => {
            document.removeEventListener('visibilitychange', onVisibility);
            if (rafId !== null) {
                cancelAnimationFrame(rafId);
            }
        };
    }, [shouldAnimateChatPreview]);

    const handleUserMessageRenderingModeChange = React.useCallback((mode: 'markdown' | 'plain') => {
        setUserMessageRenderingMode(mode);
        void updateDesktopSettings({ userMessageRenderingMode: mode });
    }, [setUserMessageRenderingMode]);

    const handleStickyUserHeaderChange = React.useCallback((enabled: boolean) => {
        setStickyUserHeader(enabled);
        void updateDesktopSettings({ stickyUserHeader: enabled });
    }, [setStickyUserHeader]);

    const handlePromptNavigatorEnabledChange = React.useCallback((enabled: boolean) => {
        setPromptNavigatorEnabled(enabled);
        void updateDesktopSettings({ promptNavigatorEnabled: enabled });
    }, [setPromptNavigatorEnabled]);

    const handleExpandedEditorToolbarChange = React.useCallback((enabled: boolean) => {
        setExpandedEditorToolbar(enabled);
        void updateDesktopSettings({ expandedEditorToolbar: enabled });
    }, [setExpandedEditorToolbar]);

    const handleCollapsibleUserMessagesChange = React.useCallback((enabled: boolean) => {
        setCollapsibleUserMessages(enabled);
        void updateDesktopSettings({ collapsibleUserMessages: enabled });
    }, [setCollapsibleUserMessages]);

    const handleWideChatLayoutChange = React.useCallback((enabled: boolean) => {
        setWideChatLayoutEnabled(enabled);
        void updateDesktopSettings({ wideChatLayoutEnabled: enabled });
    }, [setWideChatLayoutEnabled]);

    const handleShowSplitAssistantMessageActionsChange = React.useCallback((enabled: boolean) => {
        setShowSplitAssistantMessageActions(enabled);
        void updateDesktopSettings({ showSplitAssistantMessageActions: enabled });
    }, [setShowSplitAssistantMessageActions]);

    const handleInputSpellcheckChange = React.useCallback((enabled: boolean) => {
        setInputSpellcheckEnabled(enabled);
        void updateDesktopSettings({ inputSpellcheckEnabled: enabled });
    }, [setInputSpellcheckEnabled]);

    const handleChatRenderModeChange = React.useCallback((mode: 'sorted' | 'live') => {
        setChatRenderMode(mode);
        void updateDesktopSettings({ chatRenderMode: mode });
    }, [setChatRenderMode]);

    const handleMessageStreamTransportChange = React.useCallback((mode: 'auto' | 'ws' | 'sse') => {
        setMessageStreamTransport(mode);
        void updateDesktopSettings({ messageStreamTransport: mode });
    }, [setMessageStreamTransport]);

    const handleActivityRenderModeChange = React.useCallback((mode: 'collapsed' | 'summary') => {
        setActivityRenderMode(mode);
        void updateDesktopSettings({ activityRenderMode: mode });
    }, [setActivityRenderMode]);

    const handleMermaidRenderingModeChange = React.useCallback((mode: 'svg' | 'ascii') => {
        setMermaidRenderingMode(mode);
        void updateDesktopSettings({ mermaidRenderingMode: mode });
    }, [setMermaidRenderingMode]);

    const handleShowToolFileIconsChange = React.useCallback((enabled: boolean) => {
        setShowToolFileIcons(enabled);
        void updateDesktopSettings({ showToolFileIcons: enabled });
    }, [setShowToolFileIcons]);

    const handleShowTurnChangedFilesChange = React.useCallback((enabled: boolean) => {
        setShowTurnChangedFiles(enabled);
        void updateDesktopSettings({ showTurnChangedFiles: enabled });
    }, [setShowTurnChangedFiles]);

    const handleFileViewerPreviewChange = React.useCallback((enabled: boolean) => {
        setSettingsDefaultFileViewerPreview(enabled);
        void updateDesktopSettings({ defaultFileViewerPreview: enabled });
        window.dispatchEvent(new CustomEvent('openchamber:file-viewer-preview-mode-changed', { detail: { enabled } }));
    }, [setSettingsDefaultFileViewerPreview]);

    const handleShowExpandedBashToolsChange = React.useCallback((enabled: boolean) => {
        setShowExpandedBashTools(enabled);
        void updateDesktopSettings({ showExpandedBashTools: enabled });
    }, [setShowExpandedBashTools]);

    const handleShowSubagentTaskDetailsChange = React.useCallback((enabled: boolean) => {
        setShowSubagentTaskDetails(enabled);
        void updateDesktopSettings({ showSubagentTaskDetails: enabled });
    }, [setShowSubagentTaskDetails]);

    const handleTimeFormatPreferenceChange = React.useCallback((value: 'auto' | '12h' | '24h') => {
        setTimeFormatPreference(value);
        void updateDesktopSettings({ timeFormatPreference: value });
    }, [setTimeFormatPreference]);

    const handleWeekStartPreferenceChange = React.useCallback((value: 'auto' | 'monday' | 'sunday') => {
        setWeekStartPreference(value);
        void updateDesktopSettings({ weekStartPreference: value });
    }, [setWeekStartPreference]);

    const lightThemes = React.useMemo(
        () => availableThemes
            .filter((theme) => theme.metadata.variant === 'light')
            .sort((a, b) => a.metadata.name.localeCompare(b.metadata.name)),
        [availableThemes],
    );

    const darkThemes = React.useMemo(
        () => availableThemes
            .filter((theme) => theme.metadata.variant === 'dark')
            .sort((a, b) => a.metadata.name.localeCompare(b.metadata.name)),
        [availableThemes],
    );

    const selectedLightTheme = React.useMemo(
        () => lightThemes.find((theme) => theme.metadata.id === lightThemeId) ?? lightThemes[0],
        [lightThemes, lightThemeId],
    );

    const selectedDarkTheme = React.useMemo(
        () => darkThemes.find((theme) => theme.metadata.id === darkThemeId) ?? darkThemes[0],
        [darkThemes, darkThemeId],
    );

    const formatThemeLabel = React.useCallback((themeName: string, variant: 'light' | 'dark') => {
        const suffix = variant === 'dark' ? ' Dark' : ' Light';
        return themeName.endsWith(suffix) ? themeName.slice(0, -suffix.length) : themeName;
    }, []);

    const shouldShow = (setting: VisibleSetting): boolean => {
        if (!visibleSettings) return true;
        return visibleSettings.includes(setting);
    };

    const isVSCode = isVSCodeRuntime();
    const hasThemeSettings = shouldShow('theme') && !isVSCode;
    const hasLocalizationSettings = shouldShow('theme') || shouldShow('timeFormat') || shouldShow('weekStart');
    const hasAppearanceSettings = isVSCode
        ? (hasLocalizationSettings || shouldShow('sidebarBrand'))
        : (shouldShow('theme') || shouldShow('sidebarBrand') || shouldShow('pwaInstallName') || shouldShow('pwaOrientation') || shouldShow('mobileKeyboardMode') || shouldShow('timeFormat') || shouldShow('weekStart'));
    const hasLayoutSettings = shouldShow('fontSize') || shouldShow('codeFontSize') || shouldShow('terminalFontSize') || shouldShow('editorFontSize') || shouldShow('spacing') || shouldShow('inputBarOffset');
    const hasNavigationSettings = (shouldShow('terminalQuickKeys') && !isMobile) || shouldShow('fileEditorKeymap') || shouldShow('expandedEditorToolbar');
    const hasBehaviorSettings = shouldShow('mermaidRendering')
        || shouldShow('userMessageRendering')
        || shouldShow('chatRenderMode')
        || shouldShow('messageTransport')
        || (shouldShow('activityRenderMode') && chatRenderMode === 'sorted')
        || shouldShow('collapsibleUserMessages')
        || shouldShow('stickyUserHeader')
        || (shouldShow('promptNavigatorEnabled') && !isVSCode)
        || shouldShow('wideChatLayout')
        || shouldShow('codeBlockLineWrap')
        || shouldShow('splitAssistantMessageActions')
        || shouldShow('subagentReadOnlyBanner')
        || shouldShow('diffLayout')
        || shouldShow('dotfiles')
        || shouldShow('fileViewerPreview')
        || shouldShow('reasoning')
        || shouldShow('followUpBehavior')
        || shouldShow('persistDraft')
        || shouldShow('showToolFileIcons')
        || shouldShow('showSubagentTaskDetails')
        || shouldShow('expandedTools')
        || (!isMobile && shouldShow('inputSpellcheck'));

    const showPwaInstallNameSetting = shouldShow('pwaInstallName') && isWebRuntime() && browserTab && !isDesktopShell() && !isVSCode;
    const showPwaOrientationSetting = shouldShow('pwaOrientation') && isWebRuntime() && !isDesktopShell() && !isVSCode;
    const showMobileKeyboardModeSetting = shouldShow('mobileKeyboardMode') && isWebRuntime() && !isDesktopShell() && !isVSCode && supportsMobileKeyboardResizeContent();
    const [pwaInstallName, setPwaInstallName] = React.useState('');
    const [pwaOrientation, setPwaOrientation] = React.useState<'system' | 'portrait' | 'landscape'>('system');
    const selectedTimeFormatLabel = React.useMemo(() => {
        const option = TIME_FORMAT_OPTIONS.find((item) => item.id === timeFormatPreference);
        return tUnsafe(option?.labelKey ?? 'settings.openchamber.visual.option.timeFormat.auto.label');
    }, [timeFormatPreference, tUnsafe]);
    const selectedWeekStartLabel = React.useMemo(() => {
        const option = WEEK_START_OPTIONS.find((item) => item.id === weekStartPreference);
        return tUnsafe(option?.labelKey ?? 'settings.openchamber.visual.option.weekStart.auto.label');
    }, [weekStartPreference, tUnsafe]);
    const selectedPwaOrientationLabel = React.useMemo(() => {
        const option = PWA_ORIENTATION_OPTIONS.find((item) => item.id === pwaOrientation);
        return option ? tUnsafe(option.labelKey) : undefined;
    }, [pwaOrientation, tUnsafe]);
    const selectedMobileKeyboardModeLabel = React.useMemo(() => {
        const option = MOBILE_KEYBOARD_MODE_OPTIONS.find((item) => item.id === mobileKeyboardMode);
        return option ? tUnsafe(option.labelKey) : undefined;
    }, [mobileKeyboardMode, tUnsafe]);

    const applyPwaInstallName = React.useCallback(async (value: string) => {
        if (typeof window === 'undefined') {
            return;
        }

        const win = window as PwaInstallNameWindow;
        const normalized = value.trim().replace(/\s+/g, ' ').slice(0, 64);
        const persistedValue = normalized;

        await updateDesktopSettings({ pwaAppName: persistedValue });

        if (typeof win.__OPENCHAMBER_SET_PWA_INSTALL_NAME__ === 'function') {
            const resolved = win.__OPENCHAMBER_SET_PWA_INSTALL_NAME__(persistedValue);
            setPwaInstallName(resolved);
            return;
        }

        setPwaInstallName(persistedValue || DEFAULT_PWA_INSTALL_NAME);
        win.__OPENCHAMBER_UPDATE_PWA_MANIFEST__?.();
    }, []);

    const applyPwaOrientation = React.useCallback(async (value: 'system' | 'portrait' | 'landscape') => {
        if (typeof window === 'undefined') {
            return;
        }

        const win = window as PwaInstallNameWindow;
        const normalized = normalizePwaOrientation(value);

        await updateDesktopSettings({ pwaOrientation: normalized });

        if (typeof win.__OPENCHAMBER_SET_PWA_ORIENTATION__ === 'function') {
            const resolved = win.__OPENCHAMBER_SET_PWA_ORIENTATION__(normalized);
            setPwaOrientation(resolved);
            return;
        }

        setPwaOrientation(normalized);
        win.__OPENCHAMBER_UPDATE_PWA_MANIFEST__?.();
    }, []);

    React.useEffect(() => {
        if (typeof window === 'undefined' || (!showPwaInstallNameSetting && !showPwaOrientationSetting && !showMobileKeyboardModeSetting)) {
            return;
        }

        let cancelled = false;

        const loadPwaInstallName = async () => {
            try {
                const response = await runtimeFetch('/api/config/settings', {
                    method: 'GET',
                    headers: { Accept: 'application/json' },
                    cache: 'no-store',
                });

                if (!response.ok) {
                    if (!cancelled) {
                        setPwaInstallName(DEFAULT_PWA_INSTALL_NAME);
                    }
                    return;
                }

                const settings = await response.json().catch(() => ({}));
                const raw = typeof settings?.pwaAppName === 'string' ? settings.pwaAppName : '';
                const normalized = raw.trim().replace(/\s+/g, ' ').slice(0, 64);
                const orientation = normalizePwaOrientation(settings?.pwaOrientation);
                const nextMobileKeyboardMode = normalizeMobileKeyboardMode(settings?.mobileKeyboardMode);

                if (!cancelled) {
                    if (showPwaInstallNameSetting) {
                        setPwaInstallName(normalized || DEFAULT_PWA_INSTALL_NAME);
                    }
                    if (showPwaOrientationSetting) {
                        setPwaOrientation(orientation);
                    }
                    if (showMobileKeyboardModeSetting) {
                        setMobileKeyboardMode(nextMobileKeyboardMode);
                    }
                }
            } catch {
                if (!cancelled) {
                    if (showPwaInstallNameSetting) {
                        setPwaInstallName(DEFAULT_PWA_INSTALL_NAME);
                    }
                    if (showPwaOrientationSetting) {
                        setPwaOrientation('system');
                    }
                    if (showMobileKeyboardModeSetting) {
                        setMobileKeyboardMode('native');
                    }
                }
            }
        };

        void loadPwaInstallName();

        return () => {
            cancelled = true;
        };
    }, [setMobileKeyboardMode, showMobileKeyboardModeSetting, showPwaInstallNameSetting, showPwaOrientationSetting]);

    return (
        <div className="oc-settings-section-stack">

                {/* --- Appearance & Themes --- */}
                {hasAppearanceSettings && (
                    <>
                        {hasThemeSettings && (
                            <ResponsiveSettingsGroup
                                isMobile={isMobile}
                                label={t('settings.openchamber.visual.section.colorMode')}
                            >
                                <div
                                    className="oc-settings-group-row flex flex-wrap items-center justify-end gap-1"
                                    role="group"
                                    aria-label={t('settings.openchamber.visual.section.colorMode')}
                                >
                                    {THEME_MODE_OPTIONS.map((option) => (
                                        <Button
                                            key={option.value}
                                            variant="chip"
                                            size="xs"
                                            aria-pressed={themeMode === option.value}
                                            className="oc-mobile-settings-chip !font-normal"
                                            onClick={() => setThemeMode(option.value)}
                                        >
                                            {tUnsafe(option.labelKey)}
                                        </Button>
                                    ))}
                                </div>

                                <>
                                    <ResponsiveSettingsRow
                                        isMobile={isMobile}
                                        itemId="appearance.light-theme"
                                        label={t('settings.openchamber.visual.field.lightTheme')}
                                    >
                                        <Select value={selectedLightTheme?.metadata.id ?? ''} onValueChange={setLightThemePreference}>
                                            <SelectTrigger aria-label={t('settings.openchamber.visual.field.selectLightThemeAria')} className="w-fit">
                                                <SelectValue placeholder={t('settings.openchamber.visual.field.selectThemePlaceholder')}>
                                                    {selectedLightTheme
                                                        ? formatThemeLabel(selectedLightTheme.metadata.name, 'light')
                                                        : undefined}
                                                </SelectValue>
                                            </SelectTrigger>
                                            <SelectContent>
                                                {lightThemes.map((theme) => (
                                                    <SelectItem key={theme.metadata.id} value={theme.metadata.id}>
                                                        {formatThemeLabel(theme.metadata.name, 'light')}
                                                    </SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                    </ResponsiveSettingsRow>
                                    <ResponsiveSettingsRow
                                        isMobile={isMobile}
                                        itemId="appearance.dark-theme"
                                        label={t('settings.openchamber.visual.field.darkTheme')}
                                    >
                                        <Select value={selectedDarkTheme?.metadata.id ?? ''} onValueChange={setDarkThemePreference}>
                                            <SelectTrigger aria-label={t('settings.openchamber.visual.field.selectDarkThemeAria')} className="w-fit">
                                                <SelectValue placeholder={t('settings.openchamber.visual.field.selectThemePlaceholder')}>
                                                    {selectedDarkTheme
                                                        ? formatThemeLabel(selectedDarkTheme.metadata.name, 'dark')
                                                        : undefined}
                                                </SelectValue>
                                            </SelectTrigger>
                                            <SelectContent>
                                                {darkThemes.map((theme) => (
                                                    <SelectItem key={theme.metadata.id} value={theme.metadata.id}>
                                                        {formatThemeLabel(theme.metadata.name, 'dark')}
                                                    </SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                    </ResponsiveSettingsRow>
                                </>

                                <ResponsiveSettingsRow
                                    isMobile={isMobile}
                                    label={null}
                                    mobileLabel={null}
                                >
                                    <button
                                        type="button"
                                        disabled={customThemesLoading || themesReloading}
                                        onClick={() => {
                                            const startedAt = Date.now();
                                            setThemesReloading(true);
                                            void reloadCustomThemes().finally(() => {
                                                const elapsed = Date.now() - startedAt;
                                                if (elapsed < 500) {
                                                    window.setTimeout(() => {
                                                        setThemesReloading(false);
                                                    }, 500 - elapsed);
                                                    return;
                                                }
                                                setThemesReloading(false);
                                            });
                                        }}
                                        className="inline-flex items-center typography-ui-label font-normal text-foreground underline decoration-[1px] underline-offset-2 hover:text-foreground/80 disabled:cursor-not-allowed disabled:text-muted-foreground/60"
                                    >
                                        {themesReloading ? t('settings.openchamber.visual.actions.reloadingThemes') : t('settings.openchamber.visual.actions.reloadThemes')}
                                    </button>
                                    <Tooltip>
                                        <TooltipTrigger asChild>
                                            <button
                                                type="button"
                                                className="flex items-center justify-center rounded-md p-1 text-muted-foreground/70 hover:text-foreground"
                                                aria-label={t('settings.openchamber.visual.field.themeImportInfoAria')}
                                            >
                                                <Icon name="information" className="h-3.5 w-3.5" />
                                            </button>
                                        </TooltipTrigger>
                                        <TooltipContent sideOffset={8}>
                                            {t('settings.openchamber.visual.field.themeImportInfoTooltip')}
                                        </TooltipContent>
                                    </Tooltip>
                                </ResponsiveSettingsRow>

                                {macVibrancySupported && (
                                    <div data-settings-item="appearance.window-transparency" className="oc-settings-group-row flex flex-col gap-1.5">
                                        <div
                                            className="group flex cursor-pointer items-start gap-2 py-0.5"
                                            role="button"
                                            tabIndex={0}
                                            aria-pressed={vibrancyChecked}
                                            onClick={() => { if (!vibrancyRestarting) setVibrancyChecked(!vibrancyChecked); }}
                                            onKeyDown={(event) => {
                                                if (event.key === ' ' || event.key === 'Enter') {
                                                    event.preventDefault();
                                                    if (!vibrancyRestarting) setVibrancyChecked(!vibrancyChecked);
                                                }
                                            }}
                                        >
                                            <Checkbox
                                                checked={vibrancyChecked}
                                                onChange={setVibrancyChecked}
                                                disabled={vibrancyRestarting}
                                                ariaLabel={t('settings.openchamber.visual.field.macVibrancy')}
                                            />
                                            <div className="flex min-w-0 flex-col">
                                                <span className="typography-ui-label text-foreground">
                                                    {t('settings.openchamber.visual.field.macVibrancy')}
                                                </span>
                                                <span className="typography-meta text-muted-foreground">
                                                    {t('settings.openchamber.visual.field.macVibrancyHint')}
                                                </span>
                                            </div>
                                        </div>
                                        {vibrancyChecked !== macVibrancyEnabled && (
                                            <div className="pl-6">
                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    disabled={vibrancyRestarting}
                                                    onClick={() => {
                                                        setVibrancyRestarting(true);
                                                        void invokeDesktop('desktop_set_vibrancy', { enabled: vibrancyChecked });
                                                    }}
                                                >
                                                    {vibrancyRestarting
                                                        ? t('settings.openchamber.visual.actions.restarting')
                                                        : t('settings.openchamber.visual.actions.saveAndRestart')}
                                                </Button>
                                            </div>
                                        )}
                                    </div>
                                )}

                                {dockBadgeSupported && (
                                    <div data-settings-item="appearance.dock-badge" className="oc-settings-group-row flex flex-col gap-1.5">
                                        <div
                                            className="group flex cursor-pointer items-start gap-2 py-0.5"
                                            role="button"
                                            tabIndex={0}
                                            aria-pressed={dockBadgeEnabled}
                                            onClick={() => setDockBadgeEnabled(!dockBadgeEnabled)}
                                            onKeyDown={(event) => {
                                                if (event.key === ' ' || event.key === 'Enter') {
                                                    event.preventDefault();
                                                    setDockBadgeEnabled(!dockBadgeEnabled);
                                                }
                                            }}
                                        >
                                            <Checkbox
                                                checked={dockBadgeEnabled}
                                                onChange={setDockBadgeEnabled}
                                                ariaLabel={t('settings.openchamber.visual.field.dockBadge')}
                                            />
                                            <div className="flex min-w-0 flex-col">
                                                <span className="typography-ui-label text-foreground">
                                                    {t('settings.openchamber.visual.field.dockBadge')}
                                                </span>
                                                <span className="typography-meta text-muted-foreground">
                                                    {t('settings.openchamber.visual.field.dockBadgeHint')}
                                                </span>
                                            </div>
                                        </div>
                                    </div>
                                )}
                            </ResponsiveSettingsGroup>
                        )}

                        {hasLocalizationSettings && (
                            <ResponsiveSettingsGroup
                                isMobile={isMobile}
                                label={t('settings.openchamber.visual.section.localization')}
                            >
                                <ResponsiveSettingsRow
                                    isMobile={isMobile}
                                    itemId="appearance.language"
                                    label={t('settings.appearance.language.label')}
                                    description={t('settings.appearance.language.description')}
                                >
                                    <Select value={locale} onValueChange={(value) => setLocale(value as Locale)}>
                                        <SelectTrigger aria-label={t('settings.appearance.language.select')} className="w-fit">
                                            <SelectValue>{label(locale)}</SelectValue>
                                        </SelectTrigger>
                                        <SelectContent>
                                            {locales.map((availableLocale) => (
                                                <SelectItem key={availableLocale} value={availableLocale}>
                                                    {label(availableLocale)}
                                                </SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                </ResponsiveSettingsRow>

                                {(shouldShow('timeFormat') || shouldShow('weekStart')) && (
                                    <>
                                        {shouldShow('timeFormat') && (
                                            <ResponsiveSettingsRow
                                                isMobile={isMobile}
                                                itemId="appearance.time-format"
                                                label={t('settings.openchamber.visual.field.timeFormat')}
                                            >
                                                <Select value={timeFormatPreference} onValueChange={(value: 'auto' | '12h' | '24h') => handleTimeFormatPreferenceChange(value)}>
                                                    <SelectTrigger aria-label={t('settings.openchamber.visual.field.selectTimeFormatAria')} className="w-fit">
                                                        <SelectValue>{selectedTimeFormatLabel}</SelectValue>
                                                    </SelectTrigger>
                                                    <SelectContent>
                                                        {TIME_FORMAT_OPTIONS.map((option) => (
                                                            <SelectItem key={option.id} value={option.id}>{tUnsafe(option.labelKey)}</SelectItem>
                                                        ))}
                                                    </SelectContent>
                                                </Select>
                                            </ResponsiveSettingsRow>
                                        )}

                                        {shouldShow('weekStart') && (
                                            <ResponsiveSettingsRow
                                                isMobile={isMobile}
                                                itemId="appearance.week-start"
                                                label={t('settings.openchamber.visual.field.weekStartsOn')}
                                            >
                                                <Select value={weekStartPreference} onValueChange={(value: 'auto' | 'monday' | 'sunday') => handleWeekStartPreferenceChange(value)}>
                                                    <SelectTrigger aria-label={t('settings.openchamber.visual.field.selectWeekStartAria')} className="w-fit">
                                                        <SelectValue>{selectedWeekStartLabel}</SelectValue>
                                                    </SelectTrigger>
                                                    <SelectContent>
                                                        {WEEK_START_OPTIONS.map((option) => (
                                                            <SelectItem key={option.id} value={option.id}>{tUnsafe(option.labelKey)}</SelectItem>
                                                        ))}
                                                    </SelectContent>
                                                </Select>
                                            </ResponsiveSettingsRow>
                                        )}
                                    </>
                                )}
                            </ResponsiveSettingsGroup>
                        )}

                        {shouldShow('sidebarBrand') && (
                            <ResponsiveSettingsField
                                isMobile={isMobile}
                                itemId="appearance.sidebar-brand"
                                label={t('settings.openchamber.visual.field.sidebarBrand')}
                                description={t('settings.openchamber.visual.field.sidebarBrandHint')}
                                descriptionPlacement="outside"
                            >
                                <Input
                                    value={sidebarBrandName}
                                    onChange={(event) => setSidebarBrandName(event.target.value)}
                                    maxLength={64}
                                    aria-label={t('settings.openchamber.visual.field.sidebarBrandAria')}
                                />
                            </ResponsiveSettingsField>
                        )}

                        {(showPwaInstallNameSetting || showPwaOrientationSetting || showMobileKeyboardModeSetting) && (
                            <>
                                {showPwaInstallNameSetting && (
                                    <ResponsiveSettingsField
                                        isMobile={isMobile}
                                        itemId="appearance.pwa-install-name"
                                        label={t('settings.openchamber.visual.field.installAppName')}
                                        description={t('settings.openchamber.visual.field.installAppNameHint')}
                                    >
                                        <Input
                                            value={pwaInstallName}
                                            onChange={(event) => {
                                                setPwaInstallName(event.target.value);
                                            }}
                                            onBlur={() => {
                                                void applyPwaInstallName(pwaInstallName);
                                            }}
                                            onKeyDown={(event) => {
                                                if (event.key === 'Enter') {
                                                    event.preventDefault();
                                                    void applyPwaInstallName(pwaInstallName);
                                                }
                                            }}
                                            maxLength={64}
                                            aria-label={t('settings.openchamber.visual.field.pwaInstallAppNameAria')}
                                        />
                                        <Button size="sm"
                                            type="button"
                                            variant="ghost"
                                            onClick={() => {
                                                setPwaInstallName(DEFAULT_PWA_INSTALL_NAME);
                                                void applyPwaInstallName('');
                                            }}
                                            className="h-7 w-7 px-0 text-muted-foreground hover:text-foreground"
                                            aria-label={t('settings.openchamber.visual.actions.resetInstallAppNameAria')}
                                            title={t('settings.common.actions.reset')}
                                        >
                                            <Icon name="restart" className="h-3.5 w-3.5" />
                                        </Button>
                                    </ResponsiveSettingsField>
                                )}

                                {showPwaOrientationSetting && (
                                    <ResponsiveSettingsField
                                        isMobile={isMobile}
                                        itemId="appearance.pwa-orientation"
                                        label={t('settings.openchamber.visual.field.installOrientation')}
                                        description={t('settings.openchamber.visual.field.installOrientationHint')}
                                        descriptionPlacement="outside"
                                    >
                                        <Select
                                            value={pwaOrientation}
                                            onValueChange={(value) => {
                                                const orientation = normalizePwaOrientation(value);
                                                setPwaOrientation(orientation);
                                                void applyPwaOrientation(orientation);
                                            }}
                                        >
                                            <SelectTrigger aria-label={t('settings.openchamber.visual.field.pwaInstallOrientationAria')} className="w-full">
                                                <SelectValue placeholder={t('settings.openchamber.visual.field.selectOrientationPlaceholder')}>
                                                    {selectedPwaOrientationLabel}
                                                </SelectValue>
                                            </SelectTrigger>
                                            <SelectContent>
                                                {PWA_ORIENTATION_OPTIONS.map((option) => (
                                                    <SelectItem key={option.id} value={option.id}>
                                                        {tUnsafe(option.labelKey)}
                                                    </SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                        <Button size="sm"
                                            type="button"
                                            variant="ghost"
                                            onClick={() => {
                                                setPwaOrientation('system');
                                                void applyPwaOrientation('system');
                                            }}
                                            disabled={pwaOrientation === 'system'}
                                            className="h-7 w-7 px-0 text-muted-foreground hover:text-foreground"
                                            aria-label={t('settings.openchamber.visual.actions.resetInstallOrientationAria')}
                                            title={t('settings.common.actions.reset')}
                                        >
                                            <Icon name="restart" className="h-3.5 w-3.5" />
                                        </Button>
                                    </ResponsiveSettingsField>
                                )}

                                {showMobileKeyboardModeSetting && (
                                    <ResponsiveSettingsField
                                        isMobile={isMobile}
                                        itemId="appearance.mobile-keyboard-mode"
                                        label={t('settings.openchamber.visual.field.mobileKeyboardMode')}
                                        description={t('settings.openchamber.visual.field.mobileKeyboardModeHint')}
                                        descriptionPlacement="outside"
                                    >
                                        <Select
                                            value={mobileKeyboardMode}
                                            onValueChange={(value) => {
                                                const mode = normalizeMobileKeyboardMode(value);
                                                setMobileKeyboardMode(mode);
                                                void updateDesktopSettings({ mobileKeyboardMode: mode });
                                            }}
                                        >
                                            <SelectTrigger aria-label={t('settings.openchamber.visual.field.mobileKeyboardModeAria')} className="w-full">
                                                <SelectValue placeholder={t('settings.openchamber.visual.field.selectMobileKeyboardModePlaceholder')}>
                                                    {selectedMobileKeyboardModeLabel}
                                                </SelectValue>
                                            </SelectTrigger>
                                            <SelectContent>
                                                {MOBILE_KEYBOARD_MODE_OPTIONS.map((option) => (
                                                    <SelectItem key={option.id} value={option.id}>
                                                        {tUnsafe(option.labelKey)}
                                                    </SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                        <Button size="sm"
                                            type="button"
                                            variant="ghost"
                                            onClick={() => {
                                                setMobileKeyboardMode('native');
                                                void updateDesktopSettings({ mobileKeyboardMode: 'native' });
                                            }}
                                            disabled={mobileKeyboardMode === 'native'}
                                            className="h-7 w-7 px-0 text-muted-foreground hover:text-foreground"
                                            aria-label={t('settings.openchamber.visual.actions.resetMobileKeyboardModeAria')}
                                            title={t('settings.common.actions.reset')}
                                        >
                                            <Icon name="restart" className="h-3.5 w-3.5" />
                                        </Button>
                                    </ResponsiveSettingsField>
                                )}
                            </>
                        )}
                    </>
                )}

                {/* --- UI Scaling & Layout --- */}
                {hasLayoutSettings && (
                    <>
                        <ResponsiveSettingsGroup
                            isMobile={isMobile}
                            label={t('settings.openchamber.visual.section.spacingAndLayout')}
                        >
                            <>

                            {shouldShow('fontSize') && !isMobile && (
                                <ResponsiveSettingsRow
                                    isMobile={isMobile}
                                    itemId="appearance.interface-font-size"
                                    label={t('settings.openchamber.visual.field.interfaceFont')}
                                >
                                        <Select value={uiFont} onValueChange={(value) => setUiFont(value as UiFontOption)}>
                                            <SelectTrigger aria-label={t('settings.openchamber.visual.field.selectInterfaceFontAria')} className="w-[13rem]">
                                                <SelectValue>{UI_FONT_OPTIONS.find((option) => option.id === uiFont)?.label}</SelectValue>
                                            </SelectTrigger>
                                            <SelectContent>
                                                {UI_FONT_OPTIONS.map((option) => (
                                                    <SelectItem key={option.id} value={option.id}>
                                                        <span style={{ fontFamily: option.stack }}>{option.label}</span>
                                                    </SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                        <Button size="sm"
                                            type="button"
                                            variant="ghost"
                                            onClick={() => setUiFont(DEFAULT_UI_FONT)}
                                            disabled={uiFont === DEFAULT_UI_FONT}
                                            className="h-7 w-7 px-0 text-muted-foreground hover:text-foreground"
                                            aria-label={t('settings.openchamber.visual.actions.resetInterfaceFontAria')}
                                            title={t('settings.common.actions.reset')}
                                        >
                                            <Icon name="restart" className="h-3.5 w-3.5" />
                                        </Button>
                                </ResponsiveSettingsRow>
                            )}

                            {shouldShow('terminalFontSize') && (
                                <ResponsiveSettingsRow
                                    isMobile={isMobile}
                                    itemId="appearance.code-font"
                                    label={t('settings.openchamber.visual.field.codeFont')}
                                >
                                        <Select value={monoFont} onValueChange={(value) => setMonoFont(value as MonoFontOption)}>
                                            <SelectTrigger aria-label={t('settings.openchamber.visual.field.selectCodeFontAria')} className="w-full max-w-[13rem]">
                                                <SelectValue>{CODE_FONT_OPTIONS.find((option) => option.id === monoFont)?.label}</SelectValue>
                                            </SelectTrigger>
                                            <SelectContent>
                                                {CODE_FONT_OPTIONS.map((option) => (
                                                    <SelectItem key={option.id} value={option.id}>
                                                        <span style={{ fontFamily: option.stack }}>{option.label}</span>
                                                    </SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                        <Button size="sm"
                                            type="button"
                                            variant="ghost"
                                            onClick={() => setMonoFont(DEFAULT_MONO_FONT)}
                                            disabled={monoFont === DEFAULT_MONO_FONT}
                                            className="h-7 w-7 px-0 text-muted-foreground hover:text-foreground"
                                            aria-label={t('settings.openchamber.visual.actions.resetCodeFontAria')}
                                            title={t('settings.common.actions.reset')}
                                        >
                                            <Icon name="restart" className="h-3.5 w-3.5" />
                                        </Button>
                                </ResponsiveSettingsRow>
                            )}

                            {shouldShow('fontSize') && !isMobile && (
                                <ResponsiveSettingsRow
                                    isMobile={isMobile}
                                    label={t('settings.openchamber.visual.field.interfaceFontSize')}
                                >
                                        <NumberInput
                                            value={fontSize}
                                            onValueChange={setFontSize}
                                            min={50}
                                            max={200}
                                            step={5}
                                            aria-label={t('settings.openchamber.visual.field.fontSizePercentageAria')}
                                            className="w-16"
                                        />
                                        <Button size="sm"
                                            type="button"
                                            variant="ghost"
                                            onClick={() => setFontSize(100)}
                                            disabled={fontSize === 100}
                                            className="h-7 w-7 px-0 text-muted-foreground hover:text-foreground"
                                            aria-label={t('settings.openchamber.visual.actions.resetFontSizeAria')}
                                            title={t('settings.common.actions.reset')}
                                        >
                                            <Icon name="restart" className="h-3.5 w-3.5" />
                                        </Button>
                                </ResponsiveSettingsRow>
                            )}

                            {shouldShow('codeFontSize') && !isMobile && (
                                <ResponsiveSettingsRow
                                    isMobile={isMobile}
                                    itemId="appearance.code-font-size"
                                    label={t('settings.openchamber.visual.field.codeFontSize')}
                                >
                                        <NumberInput
                                            value={codeFontSize}
                                            onValueChange={setCodeFontSize}
                                            min={50}
                                            max={200}
                                            step={5}
                                            aria-label={t('settings.openchamber.visual.field.codeFontSizePercentageAria')}
                                            className="w-16"
                                        />
                                        <Button size="sm"
                                            type="button"
                                            variant="ghost"
                                            onClick={() => setCodeFontSize(100)}
                                            disabled={codeFontSize === 100}
                                            className="h-7 w-7 px-0 text-muted-foreground hover:text-foreground"
                                            aria-label={t('settings.openchamber.visual.actions.resetCodeFontSizeAria')}
                                            title={t('settings.common.actions.reset')}
                                        >
                                            <Icon name="restart" className="h-3.5 w-3.5" />
                                        </Button>
                                </ResponsiveSettingsRow>
                            )}

                            {shouldShow('terminalFontSize') && (
                                <ResponsiveSettingsRow
                                    isMobile={isMobile}
                                    itemId="appearance.terminal-font-size"
                                    label={t('settings.openchamber.visual.field.terminalFontSize')}
                                >
                                        <NumberInput
                                            value={terminalFontSize}
                                            onValueChange={setTerminalFontSize}
                                            min={9}
                                            max={52}
                                            step={1}
                                            className="w-16"
                                        />
                                        <Button size="sm"
                                            type="button"
                                            variant="ghost"
                                            onClick={() => setTerminalFontSize(13)}
                                            disabled={terminalFontSize === 13}
                                            className="h-7 w-7 px-0 text-muted-foreground hover:text-foreground"
                                            aria-label={t('settings.openchamber.visual.actions.resetTerminalFontSizeAria')}
                                            title={t('settings.common.actions.reset')}
                                        >
                                            <Icon name="restart" className="h-3.5 w-3.5" />
                                        </Button>
                                </ResponsiveSettingsRow>
                            )}

                            {shouldShow('editorFontSize') && (
                                <ResponsiveSettingsRow
                                    isMobile={isMobile}
                                    itemId="appearance.editor-font-size"
                                    label={t('settings.openchamber.visual.field.editorFontSize')}
                                >
                                        <NumberInput
                                            value={editorFontSize}
                                            onValueChange={setEditorFontSize}
                                            min={9}
                                            max={32}
                                            step={1}
                                            className="w-16"
                                        />
                                        <Button size="sm"
                                            type="button"
                                            variant="ghost"
                                            onClick={() => setEditorFontSize(13)}
                                            disabled={editorFontSize === 13}
                                            className="h-7 w-7 px-0 text-muted-foreground hover:text-foreground"
                                            aria-label={t('settings.openchamber.visual.actions.resetEditorFontSizeAria')}
                                            title={t('settings.common.actions.reset')}
                                        >
                                            <Icon name="restart" className="h-3.5 w-3.5" />
                                        </Button>
                                </ResponsiveSettingsRow>
                            )}

                            {shouldShow('spacing') && (
                                <ResponsiveSettingsRow
                                    isMobile={isMobile}
                                    itemId="appearance.spacing-density"
                                    label={t('settings.openchamber.visual.field.spacingDensity')}
                                >
                                        <NumberInput
                                            value={padding}
                                            onValueChange={setPadding}
                                            min={50}
                                            max={200}
                                            step={5}
                                            className="w-16"
                                        />
                                        <Button size="sm"
                                            type="button"
                                            variant="ghost"
                                            onClick={() => setPadding(100)}
                                            disabled={padding === 100}
                                            className="h-7 w-7 px-0 text-muted-foreground hover:text-foreground"
                                            aria-label={t('settings.openchamber.visual.actions.resetSpacingAria')}
                                            title={t('settings.common.actions.reset')}
                                        >
                                            <Icon name="restart" className="h-3.5 w-3.5" />
                                        </Button>
                                </ResponsiveSettingsRow>
                            )}

                            {shouldShow('inputBarOffset') && (
                                <ResponsiveSettingsRow
                                    isMobile={isMobile}
                                    itemId="appearance.input-bar-offset"
                                    label={(
                                        <span className="flex items-center gap-1.5">
                                            <span>{t('settings.openchamber.visual.field.inputBarOffset')}</span>
                                            <Tooltip>
                                                <TooltipTrigger asChild>
                                                    <Icon name="information" className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
                                                </TooltipTrigger>
                                                <TooltipContent sideOffset={8} className="max-w-xs">
                                                    {t('settings.openchamber.visual.field.inputBarOffsetTooltip')}
                                                </TooltipContent>
                                            </Tooltip>
                                        </span>
                                    )}
                                >
                                        <NumberInput
                                            value={inputBarOffset}
                                            onValueChange={setInputBarOffset}
                                            min={0}
                                            max={100}
                                            step={5}
                                            className="w-16"
                                        />
                                        <Button size="sm"
                                            type="button"
                                            variant="ghost"
                                            onClick={() => setInputBarOffset(0)}
                                            disabled={inputBarOffset === 0}
                                            className="h-7 w-7 px-0 text-muted-foreground hover:text-foreground"
                                            aria-label={t('settings.openchamber.visual.actions.resetInputBarOffsetAria')}
                                            title={t('settings.common.actions.reset')}
                                        >
                                            <Icon name="restart" className="h-3.5 w-3.5" />
                                        </Button>
                                </ResponsiveSettingsRow>
                            )}

                            </>

                        </ResponsiveSettingsGroup>
                    </>
                )}

                {/* --- Navigation --- */}
                {hasNavigationSettings && (
                    <>
                        <ResponsiveSettingsGroup
                            isMobile={isMobile}
                            label={t('settings.openchamber.visual.section.navigation')}
                        >
                            {shouldShow('fileEditorKeymap') && (
                                <ResponsiveSettingsRow
                                    isMobile={isMobile}
                                    itemId="appearance.file-editor-keymap"
                                    label={t('settings.openchamber.visual.field.fileEditorKeymap')}
                                >
                                    <div
                                        role="radiogroup"
                                        aria-label={t('settings.openchamber.visual.field.fileEditorKeymap')}
                                        className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1"
                                    >
                                        {(['default', 'vim'] as const).map((keymap) => {
                                            const selected = fileEditorKeymap === keymap;
                                            const labelText = t(`settings.openchamber.visual.option.fileEditorKeymap.${keymap}`);
                                            return (
                                                <button
                                                    key={keymap}
                                                    type="button"
                                                    className="flex cursor-pointer items-center gap-2 py-0.5 text-left"
                                                    role="radio"
                                                    aria-checked={selected}
                                                    onClick={() => setFileEditorKeymap(keymap)}
                                                >
                                                    <span
                                                        aria-hidden
                                                        className={cn(
                                                            'relative flex h-[14px] w-[14px] min-h-[14px] min-w-[14px] shrink-0 self-center items-center justify-center rounded-full transition-[background-color,box-shadow] duration-200 ease-out',
                                                            selected
                                                                ? 'bg-[color-mix(in_srgb,var(--primary-base)_80%,transparent)] shadow-none'
                                                                : 'bg-[var(--surface-muted)] shadow-[inset_0_0_0_1px_var(--interactive-border)]'
                                                        )}
                                                    >
                                                        <span className={cn('block h-[5px] w-[5px] rounded-full bg-white', !selected && 'opacity-0')} />
                                                    </span>
                                                    <span className={cn('typography-ui-label font-normal', selected ? 'text-foreground' : 'text-foreground/50')}>
                                                        {labelText}
                                                    </span>
                                                </button>
                                            );
                                        })}
                                    </div>
                                </ResponsiveSettingsRow>
                            )}
                            {shouldShow('expandedEditorToolbar') && (
                                <ResponsiveSettingsRow
                                    isMobile={isMobile}
                                    itemId="appearance.expanded-editor-toolbar"
                                    label={t('settings.openchamber.visual.field.expandedEditorToolbar')}
                                >
                                    <Checkbox
                                        checked={expandedEditorToolbar}
                                        onChange={handleExpandedEditorToolbarChange}
                                        ariaLabel={t('settings.openchamber.visual.field.expandedEditorToolbarAria')}
                                    />
                                </ResponsiveSettingsRow>
                            )}
                            {shouldShow('terminalQuickKeys') && !isMobile && !isDesktopShell() && (
                                <ResponsiveSettingsRow
                                    isMobile={isMobile}
                                    itemId="appearance.terminal-quick-keys"
                                    label={(
                                        <span className="flex min-w-0 items-center gap-1.5">
                                            <span>{t('settings.openchamber.visual.field.terminalQuickKeys')}</span>
                                            <Tooltip>
                                                <TooltipTrigger asChild>
                                                    <Icon name="information" className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
                                                </TooltipTrigger>
                                                <TooltipContent sideOffset={8} className="max-w-xs">
                                                    {t('settings.openchamber.visual.field.terminalQuickKeysTooltip')}
                                                </TooltipContent>
                                            </Tooltip>
                                        </span>
                                    )}
                                >
                                    <Checkbox
                                        checked={showTerminalQuickKeysOnDesktop}
                                        onChange={setShowTerminalQuickKeysOnDesktop}
                                        ariaLabel={t('settings.openchamber.visual.field.terminalQuickKeysAria')}
                                    />
                                </ResponsiveSettingsRow>
                            )}
                        </ResponsiveSettingsGroup>
                    </>
                )}

                {hasBehaviorSettings && (
                    <div className="oc-settings-section-stack">

                            {(shouldShow('userMessageRendering') || shouldShow('mermaidRendering') || shouldShow('chatRenderMode') || shouldShow('messageTransport') || (shouldShow('activityRenderMode') && chatRenderMode === 'sorted') || (shouldShow('diffLayout') && !isVSCode) || shouldShow('followUpBehavior')) && (
                                <div className="grid grid-cols-1 gap-y-[var(--oc-settings-section-stack-gap)] md:grid-cols-[minmax(0,16rem)_minmax(0,16rem)] md:justify-start md:gap-x-[var(--oc-settings-section-stack-gap)]">
                                    {shouldShow('chatRenderMode') && (
                                        <ResponsiveSettingsGroup
                                            isMobile={isMobile}
                                            label={t('settings.openchamber.visual.section.chatRenderMode')}
                                            className="md:col-span-2"
                                        >
                                            <div data-settings-item="chat.render-mode" className="oc-settings-group-row">
                                            <div role="radiogroup" aria-label={t('settings.openchamber.visual.section.chatRenderModeAria')} className="grid w-full grid-cols-1 gap-3 sm:grid-cols-2">
                                                {CHAT_RENDER_MODE_OPTIONS.map((option) => {
                                                    const selected = chatRenderMode === option.id;
                                                    const previewPhase = chatRenderPreviewTick % 12;
                                                    return (
                                                        <button
                                                            key={option.id}
                                                            type="button"
                                                            onClick={() => handleChatRenderModeChange(option.id)}
                                                            aria-pressed={selected}
                                                            className={cn(
                                                                'flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors',
                                                                selected
                                                                    ? 'border-primary bg-primary/5'
                                                                    : 'border-border hover:border-border/80 hover:bg-muted/50'
                                                            )}
                                                        >
                                                            <span className={cn('typography-ui-label', selected ? 'text-foreground' : 'text-muted-foreground')}>
                                                                {tUnsafe(option.labelKey)}
                                                            </span>
                                                            <div className="mt-2 w-full rounded-md border border-border/60 bg-muted/30 p-2">
                                                                {option.id === 'live' ? (
                                                                    <div className="space-y-1.5">
                                                                        {[0, 1, 2].map((index) => {
                                                                            const rowStart = index * 3 + 1;
                                                                            const rowProgressPhase = previewPhase - rowStart + 1;
                                                                            const rowProgress = rowProgressPhase <= 0
                                                                                ? 0
                                                                                : rowProgressPhase === 1
                                                                                    ? 42
                                                                                    : rowProgressPhase === 2
                                                                                        ? 68
                                                                                        : 92;
                                                                            const visible = rowProgress > 0;
                                                                            return (
                                                                                <div
                                                                                    key={index}
                                                                                    className={cn(
                                                                                        'flex items-center gap-1.5 transition-all duration-300 motion-reduce:transition-none',
                                                                                        visible ? 'translate-y-0 opacity-100' : 'translate-y-1 opacity-0'
                                                                                    )}
                                                                                >
                                                                                    <span className="h-2 w-2 shrink-0 rounded-full bg-muted-foreground/55" />
                                                                                    <span
                                                                                        className="h-1.5 rounded bg-muted-foreground/30 transition-all duration-300 motion-reduce:transition-none"
                                                                                        style={{ width: `${rowProgress}%` }}
                                                                                    />
                                                                                </div>
                                                                            );
                                                                        })}
                                                                    </div>
                                                                ) : (
                                                                    <div className="space-y-1.5">
                                                                        {[0, 1, 2].map((index) => {
                                                                            const visible = previewPhase >= (index + 1) * 3;
                                                                            return (
                                                                                <div
                                                                                    key={index}
                                                                                    className={cn(
                                                                                        'flex items-center gap-1.5 transition-all duration-300 motion-reduce:transition-none',
                                                                                        visible ? 'translate-y-0 opacity-100' : 'translate-y-1 opacity-0'
                                                                                    )}
                                                                                >
                                                                                    <span className="h-2 w-2 shrink-0 rounded-full bg-muted-foreground/55" />
                                                                                    <span
                                                                                        className="h-1.5 rounded bg-muted-foreground/30"
                                                                                        style={{ width: '92%' }}
                                                                                    />
                                                                                </div>
                                                                            );
                                                                        })}
                                                                    </div>
                                                                )}
                                                            </div>
                                                        </button>
                                                    );
                                                })}
                                            </div>
                                            </div>
                                        </ResponsiveSettingsGroup>
                                    )}

                                    {shouldShow('messageTransport') && (
                                        <ResponsiveSettingsGroup
                                            isMobile={isMobile}
                                            label={t('settings.openchamber.visual.section.messageStreamTransport')}
                                            className="md:col-span-2"
                                        >
                                            <div data-settings-item="chat.message-transport" className="oc-settings-group-row flex flex-col gap-2">
                                                <div className="flex flex-wrap items-center gap-1">
                                                    {MESSAGE_STREAM_TRANSPORT_OPTIONS.map((option) => (
                                                        <Button
                                                            key={option.id}
                                                            variant="chip"
                                                            size="xs"
                                                            aria-pressed={effectiveMessageStreamTransport === option.id}
                                                            className="!font-normal"
                                                            onClick={() => handleMessageStreamTransportChange(option.id)}
                                                        >
                                                            {tUnsafe(option.labelKey)}
                                                        </Button>
                                                    ))}
                                                </div>
                                                <span className="typography-meta text-muted-foreground">
                                                    {(() => {
                                                        const option = MESSAGE_STREAM_TRANSPORT_OPTIONS.find((item) => item.id === effectiveMessageStreamTransport);
                                                        return option?.descriptionKey ? tUnsafe(option.descriptionKey) : '';
                                                    })()}
                                                </span>
                                            </div>
                                        </ResponsiveSettingsGroup>
                                    )}

                                    {shouldShow('activityRenderMode') && chatRenderMode === 'sorted' && (
                                        <ResponsiveSettingsGroup
                                            isMobile={isMobile}
                                            label={t('settings.openchamber.visual.section.activityDefault')}
                                            className="md:col-span-2"
                                        >
                                            <div role="radiogroup" aria-label={t('settings.openchamber.visual.section.activityDefaultAria')}>
                                                {ACTIVITY_RENDER_MODE_OPTIONS.map((option) => {
                                                    const selected = activityRenderMode === option.id;
                                                    return (
                                                        <SettingsRadioOption
                                                            key={option.id}
                                                            selected={selected}
                                                            onSelect={() => handleActivityRenderModeChange(option.id)}
                                                            label={tUnsafe(option.labelKey)}
                                                            ariaLabel={t('settings.openchamber.visual.field.activityDefaultModeAria', { option: tUnsafe(option.labelKey) })}
                                                        />
                                                    );
                                                })}
                                            </div>
                                        </ResponsiveSettingsGroup>
                                    )}

                                    {shouldShow('expandedTools') && (
                                        <ResponsiveSettingsGroup
                                            isMobile={isMobile}
                                            label={t('settings.openchamber.visual.section.showToolsOpenedByDefault')}
                                            className="md:col-span-2"
                                        >
                                            <div
                                                className="oc-settings-group-row group flex cursor-pointer items-center gap-2"
                                                role="button"
                                                tabIndex={0}
                                                aria-pressed={showExpandedBashTools}
                                                onClick={() => handleShowExpandedBashToolsChange(!showExpandedBashTools)}
                                                onKeyDown={(event) => {
                                                    if (event.key === ' ' || event.key === 'Enter') {
                                                        event.preventDefault();
                                                        handleShowExpandedBashToolsChange(!showExpandedBashTools);
                                                    }
                                                }}
                                            >
                                                <Checkbox
                                                    checked={showExpandedBashTools}
                                                    onChange={handleShowExpandedBashToolsChange}
                                                    ariaLabel={t('settings.openchamber.visual.field.showExpandedBashToolsAria')}
                                                />
                                                <span className="typography-ui-label text-foreground">{t('settings.openchamber.visual.field.bash')}</span>
                                            </div>
                                        </ResponsiveSettingsGroup>
                                    )}

                                    {shouldShow('userMessageRendering') && (
                                        <ResponsiveSettingsGroup
                                            isMobile={isMobile}
                                            label={t('settings.openchamber.visual.section.userMessageRendering')}
                                        >
                                            <div role="radiogroup" aria-label={t('settings.openchamber.visual.section.userMessageRenderingAria')}>
                                                {USER_MESSAGE_RENDERING_OPTIONS.map((option) => {
                                                    const selected = normalizeUserMessageRenderingMode(userMessageRenderingMode) === option.id;
                                                    return (
                                                        <SettingsRadioOption
                                                            key={option.id}
                                                            selected={selected}
                                                            onSelect={() => handleUserMessageRenderingModeChange(option.id)}
                                                            label={tUnsafe(option.labelKey)}
                                                            ariaLabel={t('settings.openchamber.visual.field.userMessageRenderingAria', { option: tUnsafe(option.labelKey) })}
                                                        />
                                                    );
                                                })}
                                            </div>
                                        </ResponsiveSettingsGroup>
                                    )}

                                    {shouldShow('mermaidRendering') && (
                                        <ResponsiveSettingsGroup
                                            isMobile={isMobile}
                                            label={t('settings.openchamber.visual.section.mermaidRendering')}
                                        >
                                            <div role="radiogroup" aria-label={t('settings.openchamber.visual.section.mermaidRenderingAria')}>
                                                {MERMAID_RENDERING_OPTIONS.map((option) => {
                                                    const selected = mermaidRenderingMode === option.id;
                                                    return (
                                                        <SettingsRadioOption
                                                            key={option.id}
                                                            selected={selected}
                                                            onSelect={() => handleMermaidRenderingModeChange(option.id)}
                                                            label={tUnsafe(option.labelKey)}
                                                            ariaLabel={t('settings.openchamber.visual.field.mermaidRenderingAria', { option: tUnsafe(option.labelKey) })}
                                                        />
                                                    );
                                                })}
                                            </div>
                                        </ResponsiveSettingsGroup>
                                    )}

                                    {shouldShow('diffLayout') && !isVSCode && (
                                        <ResponsiveSettingsGroup
                                            isMobile={isMobile}
                                            label={t('settings.openchamber.visual.section.diffLayout')}
                                        >
                                            <div role="radiogroup" aria-label={t('settings.openchamber.visual.section.diffLayoutAria')}>
                                                {DIFF_LAYOUT_OPTIONS.map((option) => {
                                                    const selected = diffLayoutPreference === option.id;
                                                    return (
                                                        <SettingsRadioOption
                                                            key={option.id}
                                                            selected={selected}
                                                            onSelect={() => setDiffLayoutPreference(option.id)}
                                                            label={tUnsafe(option.labelKey)}
                                                            ariaLabel={t('settings.openchamber.visual.field.diffLayoutAria', { option: tUnsafe(option.labelKey) })}
                                                        />
                                                    );
                                                })}
                                            </div>
                                        </ResponsiveSettingsGroup>
                                    )}

                                    {shouldShow('followUpBehavior') && (
                                        <ResponsiveSettingsGroup
                                            isMobile={isMobile}
                                            label={t('settings.openchamber.visual.section.followUpBehavior')}
                                        >
                                            <div data-settings-item="chat.follow-up-behavior" role="radiogroup" aria-label={t('settings.openchamber.visual.section.followUpBehaviorAria')}>
                                                {FOLLOW_UP_BEHAVIOR_OPTIONS.map((option) => {
                                                    const selected = followUpBehavior === option.id;
                                                    return (
                                                        <SettingsRadioOption
                                                            key={option.id}
                                                            selected={selected}
                                                            onSelect={() => setFollowUpBehavior(option.id)}
                                                            label={tUnsafe(option.labelKey)}
                                                            ariaLabel={t('settings.openchamber.visual.field.followUpBehaviorAria', { option: tUnsafe(option.labelKey) })}
                                                        />
                                                    );
                                                })}
                                            </div>
                                        </ResponsiveSettingsGroup>
                                    )}

                                </div>
                            )}

                            {/* The goal loop runs in the web server — VS Code only renders
                                goal state, so the settings section is hidden there too. */}
                            {shouldShow('sessionGoal') && !isVSCode && (
                                <ResponsiveSettingsGroup
                                    isMobile={isMobile}
                                    label={(
                                        <div className="flex items-center gap-1.5">
                                            <span>{t('settings.openchamber.visual.goal.sectionTitle')}</span>
                                            <Tooltip>
                                                <TooltipTrigger asChild>
                                                    <Icon name="information" className="h-3.5 w-3.5 cursor-help text-muted-foreground/60" />
                                                </TooltipTrigger>
                                                <TooltipContent sideOffset={8} className="max-w-sm">
                                                    {t('settings.openchamber.visual.goal.description')}
                                                </TooltipContent>
                                            </Tooltip>
                                        </div>
                                    )}
                                >
                                    <ResponsiveSettingsRow
                                        isMobile={isMobile}
                                        itemId="chat.session-goal"
                                        label={t('settings.openchamber.visual.field.sessionGoal')}
                                    >
                                        <Checkbox
                                            checked={sessionGoalEnabled}
                                            onChange={setSessionGoalEnabled}
                                            ariaLabel={t('settings.openchamber.visual.field.sessionGoalAria')}
                                        />
                                    </ResponsiveSettingsRow>
                                    <ResponsiveSettingsRow
                                        isMobile={isMobile}
                                        itemId="chat.session-goal-budget"
                                        label={t('settings.openchamber.visual.goal.budgetLabel')}
                                    >
                                        <Checkbox
                                            checked={sessionGoalDefaultBudgetEnabled}
                                            onChange={setSessionGoalDefaultBudgetEnabled}
                                            disabled={!sessionGoalEnabled}
                                            ariaLabel={t('settings.openchamber.visual.goal.budgetAria')}
                                        />
                                        {sessionGoalEnabled && sessionGoalDefaultBudgetEnabled ? (
                                            <NumberInput
                                                value={sessionGoalDefaultBudget}
                                                onValueChange={(value) => {
                                                    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
                                                        setSessionGoalDefaultBudget(Math.floor(value));
                                                    }
                                                }}
                                                min={1000}
                                                max={100000000}
                                                step={50000}
                                            />
                                        ) : null}
                                    </ResponsiveSettingsRow>
                                </ResponsiveSettingsGroup>
                            )}

                            {(shouldShow('sessionAssist') || shouldShow('collapsibleUserMessages') || shouldShow('stickyUserHeader') || (shouldShow('promptNavigatorEnabled') && !isVSCode) || shouldShow('wideChatLayout') || shouldShow('codeBlockLineWrap') || shouldShow('splitAssistantMessageActions') || shouldShow('subagentReadOnlyBanner') || shouldShow('dotfiles') || shouldShow('fileViewerPreview') || shouldShow('persistDraft') || shouldShow('showToolFileIcons') || shouldShow('showSubagentTaskDetails') || shouldShow('showTurnChangedFiles') || (!isMobile && shouldShow('inputSpellcheck')) || shouldShow('reasoning')) && (
                                <div className="oc-settings-section-stack">
                                    {(shouldShow('sessionAssist') || shouldShow('subagentReadOnlyBanner')) && (
                                        <ResponsiveSettingsGroup
                                            isMobile={isMobile}
                                            label={<span data-settings-item="chat.session-assistance">{t('settings.openchamber.visual.section.sessionAssistance')}</span>}
                                        >
                                            {shouldShow('sessionAssist') && (
                                        <>
                                        <div
                                            data-settings-item="chat.session-recap"
                                            className="group flex cursor-pointer items-center gap-2 py-0.5"
                                            role="button"
                                            tabIndex={0}
                                            aria-pressed={sessionRecapEnabled}
                                            onClick={() => setSessionRecapEnabled(!sessionRecapEnabled)}
                                            onKeyDown={(event) => {
                                                if (event.key === ' ' || event.key === 'Enter') {
                                                    event.preventDefault();
                                                    setSessionRecapEnabled(!sessionRecapEnabled);
                                                }
                                            }}
                                        >
                                            <Checkbox
                                                checked={sessionRecapEnabled}
                                                onChange={setSessionRecapEnabled}
                                                ariaLabel={t('settings.openchamber.visual.field.sessionRecapAria')}
                                            />
                                            <span className="typography-ui-label text-foreground">{t('settings.openchamber.visual.field.sessionRecap')}</span>
                                        </div>
                                        <div
                                            data-settings-item="chat.session-suggestion"
                                            className="group flex cursor-pointer items-center gap-2 py-0.5"
                                            role="button"
                                            tabIndex={0}
                                            aria-pressed={sessionSuggestionEnabled}
                                            onClick={() => setSessionSuggestionEnabled(!sessionSuggestionEnabled)}
                                            onKeyDown={(event) => {
                                                if (event.key === ' ' || event.key === 'Enter') {
                                                    event.preventDefault();
                                                    setSessionSuggestionEnabled(!sessionSuggestionEnabled);
                                                }
                                            }}
                                        >
                                            <Checkbox
                                                checked={sessionSuggestionEnabled}
                                                onChange={setSessionSuggestionEnabled}
                                                ariaLabel={t('settings.openchamber.visual.field.sessionSuggestionAria')}
                                            />
                                            <span className="typography-ui-label text-foreground">{t('settings.openchamber.visual.field.sessionSuggestion')}</span>
                                        </div>
                                        <div
                                            data-settings-item="chat.session-title-refresh"
                                            className="group flex cursor-pointer items-center gap-2 py-0.5"
                                            role="button"
                                            tabIndex={0}
                                            aria-pressed={sessionTitleRefreshEnabled}
                                            onClick={() => setSessionTitleRefreshEnabled(!sessionTitleRefreshEnabled)}
                                            onKeyDown={(event) => {
                                                if (event.key === ' ' || event.key === 'Enter') {
                                                    event.preventDefault();
                                                    setSessionTitleRefreshEnabled(!sessionTitleRefreshEnabled);
                                                }
                                            }}
                                        >
                                            <Checkbox
                                                checked={sessionTitleRefreshEnabled}
                                                onChange={setSessionTitleRefreshEnabled}
                                                ariaLabel={t('settings.openchamber.visual.field.sessionTitleRefreshAria')}
                                            />
                                            <span className="typography-ui-label text-foreground">{t('settings.openchamber.visual.field.sessionTitleRefresh')}</span>
                                        </div>
                                        </>
                                            )}
                                            {shouldShow('subagentReadOnlyBanner') && (
                                                <div
                                                    data-settings-item="chat.subagent-read-only-banner"
                                                    className="group flex cursor-pointer items-center gap-2 py-0.5"
                                                    role="button"
                                                    tabIndex={0}
                                                    aria-pressed={allowPromptingSubagentSessions}
                                                    onClick={() => setAllowPromptingSubagentSessions(!allowPromptingSubagentSessions)}
                                                    onKeyDown={(event) => {
                                                        if (event.key === ' ' || event.key === 'Enter') {
                                                            event.preventDefault();
                                                            setAllowPromptingSubagentSessions(!allowPromptingSubagentSessions);
                                                        }
                                                    }}
                                                >
                                                    <Checkbox
                                                        checked={allowPromptingSubagentSessions}
                                                        onChange={setAllowPromptingSubagentSessions}
                                                        ariaLabel={t('settings.openchamber.visual.field.allowPromptingSubagentSessionsAria')}
                                                    />
                                                    <span className="typography-ui-label text-foreground">{t('settings.openchamber.visual.field.allowPromptingSubagentSessions')}</span>
                                                </div>
                                            )}
                                        </ResponsiveSettingsGroup>
                                    )}
                                    {shouldShow('reasoning') && (
                                        <ResponsiveSettingsGroup
                                            isMobile={isMobile}
                                            label={<span data-settings-item="chat.reasoning">{t('settings.openchamber.visual.section.reasoning')}</span>}
                                        >
                                    {shouldShow('reasoning') && (
                                        <div
                                            data-settings-item="chat.reasoning-traces"
                                            className="group flex cursor-pointer items-center gap-2 py-0.5"
                                            role="button"
                                            tabIndex={0}
                                            aria-pressed={showReasoningTraces}
                                            onClick={() => setShowReasoningTraces(!showReasoningTraces)}
                                            onKeyDown={(event) => {
                                                if (event.key === ' ' || event.key === 'Enter') {
                                                    event.preventDefault();
                                                    setShowReasoningTraces(!showReasoningTraces);
                                                }
                                            }}
                                        >
                                            <Checkbox
                                                checked={showReasoningTraces}
                                                onChange={setShowReasoningTraces}
                                                ariaLabel={t('settings.openchamber.visual.field.showReasoningTracesAria')}
                                            />
                                            <span className="typography-ui-label text-foreground">{t('settings.openchamber.visual.field.showReasoningTraces')}</span>
                                        </div>
                                    )}

                                    {shouldShow('reasoning') && showReasoningTraces && (
                                        <div
                                            className="group flex cursor-pointer items-center gap-2 py-0.5"
                                            role="button"
                                            tabIndex={0}
                                            aria-pressed={collapsibleThinkingBlocks}
                                            onClick={() => setCollapsibleThinkingBlocks(!collapsibleThinkingBlocks)}
                                            onKeyDown={(event) => {
                                                if (event.key === ' ' || event.key === 'Enter') {
                                                    event.preventDefault();
                                                    setCollapsibleThinkingBlocks(!collapsibleThinkingBlocks);
                                                }
                                            }}
                                        >
                                            <Checkbox
                                                checked={collapsibleThinkingBlocks}
                                                onChange={setCollapsibleThinkingBlocks}
                                                ariaLabel={t('settings.openchamber.visual.field.collapsibleThinkingBlocksAria')}
                                            />
                                            <span className="typography-ui-label text-foreground">{t('settings.openchamber.visual.field.collapsibleThinkingBlocks')}</span>
                                        </div>
                                    )}
                                        </ResponsiveSettingsGroup>
                                    )}

                                    {(shouldShow('collapsibleUserMessages') || shouldShow('stickyUserHeader') || (shouldShow('promptNavigatorEnabled') && !isVSCode) || shouldShow('wideChatLayout') || shouldShow('splitAssistantMessageActions') || shouldShow('codeBlockLineWrap')) && (
                                        <ResponsiveSettingsGroup
                                            isMobile={isMobile}
                                            label={<span data-settings-item="chat.message-appearance">{t('settings.openchamber.visual.section.messageAppearance')}</span>}
                                        >
                                    {shouldShow('collapsibleUserMessages') && (
                                        <div
                                            data-settings-item="chat.collapsible-user-messages"
                                            className="group flex cursor-pointer items-center gap-2 py-0.5"
                                            role="button"
                                            tabIndex={0}
                                            aria-pressed={collapsibleUserMessages}
                                            onClick={() => handleCollapsibleUserMessagesChange(!collapsibleUserMessages)}
                                            onKeyDown={(event) => {
                                                if (event.key === ' ' || event.key === 'Enter') {
                                                    event.preventDefault();
                                                    handleCollapsibleUserMessagesChange(!collapsibleUserMessages);
                                                }
                                            }}
                                        >
                                            <Checkbox
                                                checked={collapsibleUserMessages}
                                                onChange={handleCollapsibleUserMessagesChange}
                                                ariaLabel={t('settings.openchamber.visual.field.collapsibleUserMessagesAria')}
                                            />
                                            <span className="typography-ui-label text-foreground">{t('settings.openchamber.visual.field.collapsibleUserMessages')}</span>
                                        </div>
                                    )}

                                    {shouldShow('stickyUserHeader') && (
                                        <div
                                            data-settings-item="chat.sticky-user-header"
                                            className="group flex cursor-pointer items-center gap-2 py-0.5"
                                            role="button"
                                            tabIndex={0}
                                            aria-pressed={stickyUserHeader}
                                            onClick={() => handleStickyUserHeaderChange(!stickyUserHeader)}
                                            onKeyDown={(event) => {
                                                if (event.key === ' ' || event.key === 'Enter') {
                                                    event.preventDefault();
                                                    handleStickyUserHeaderChange(!stickyUserHeader);
                                                }
                                            }}
                                        >
                                            <Checkbox
                                                checked={stickyUserHeader}
                                                onChange={handleStickyUserHeaderChange}
                                                ariaLabel={t('settings.openchamber.visual.field.stickyUserHeaderAria')}
                                            />
                                            <span className="typography-ui-label text-foreground">{t('settings.openchamber.visual.field.stickyUserHeader')}</span>
                                        </div>
                                    )}

                                    {shouldShow('promptNavigatorEnabled') && !isVSCode && (
                                        <div
                                            data-settings-item="chat.prompt-navigator"
                                            className="group flex cursor-pointer items-center gap-2 py-0.5"
                                            role="button"
                                            tabIndex={0}
                                            aria-pressed={promptNavigatorEnabled}
                                            onClick={() => handlePromptNavigatorEnabledChange(!promptNavigatorEnabled)}
                                            onKeyDown={(event) => {
                                                if (event.key === ' ' || event.key === 'Enter') {
                                                    event.preventDefault();
                                                    handlePromptNavigatorEnabledChange(!promptNavigatorEnabled);
                                                }
                                            }}
                                        >
                                            <Checkbox
                                                checked={promptNavigatorEnabled}
                                                onChange={handlePromptNavigatorEnabledChange}
                                                ariaLabel={t('settings.openchamber.visual.field.promptNavigatorEnabledAria')}
                                            />
                                            <span className="typography-ui-label text-foreground">{t('settings.openchamber.visual.field.promptNavigatorEnabled')}</span>
                                        </div>
                                    )}

                                    {shouldShow('wideChatLayout') && (
                                        <div
                                            data-settings-item="chat.wide-layout"
                                            className="group flex cursor-pointer items-center gap-2 py-0.5"
                                            role="button"
                                            tabIndex={0}
                                            aria-pressed={wideChatLayoutEnabled}
                                            onClick={() => handleWideChatLayoutChange(!wideChatLayoutEnabled)}
                                            onKeyDown={(event) => {
                                                if (event.key === ' ' || event.key === 'Enter') {
                                                    event.preventDefault();
                                                    handleWideChatLayoutChange(!wideChatLayoutEnabled);
                                                }
                                            }}
                                        >
                                            <Checkbox
                                                checked={wideChatLayoutEnabled}
                                                onChange={handleWideChatLayoutChange}
                                                ariaLabel={t('settings.openchamber.visual.field.wideChatLayoutAria')}
                                            />
                                            <span className="typography-ui-label text-foreground">{t('settings.openchamber.visual.field.wideChatLayout')}</span>
                                        </div>
                                    )}

                                    {shouldShow('splitAssistantMessageActions') && (
                                        <div
                                            data-settings-item="chat.inline-assistant-actions"
                                            className="group flex cursor-pointer items-center gap-2 py-0.5"
                                            role="button"
                                            tabIndex={0}
                                            aria-pressed={showSplitAssistantMessageActions}
                                            onClick={() => handleShowSplitAssistantMessageActionsChange(!showSplitAssistantMessageActions)}
                                            onKeyDown={(event) => {
                                                if (event.key === ' ' || event.key === 'Enter') {
                                                    event.preventDefault();
                                                    handleShowSplitAssistantMessageActionsChange(!showSplitAssistantMessageActions);
                                                }
                                            }}
                                        >
                                            <Checkbox
                                                checked={showSplitAssistantMessageActions}
                                                onChange={handleShowSplitAssistantMessageActionsChange}
                                                ariaLabel={t('settings.openchamber.visual.field.showSplitAssistantMessageActionsAria')}
                                            />
                                            <div className="flex min-w-0 items-center gap-1.5">
                                                <span className="typography-ui-label text-foreground">{t('settings.openchamber.visual.field.showSplitAssistantMessageActions')}</span>
                                                <Tooltip>
                                                    <TooltipTrigger asChild>
                                                        <Icon name="information" className="h-3.5 w-3.5 cursor-help text-muted-foreground/60" />
                                                    </TooltipTrigger>
                                                    <TooltipContent sideOffset={8} className="max-w-xs">
                                                        {t('settings.openchamber.visual.field.showSplitAssistantMessageActionsTooltip')}
                                                    </TooltipContent>
                                                </Tooltip>
                                            </div>
                                        </div>
                                    )}

                                    {shouldShow('codeBlockLineWrap') && (
                                        <div
                                            data-settings-item="chat.code-block-line-wrap"
                                            className="group flex cursor-pointer items-center gap-2 py-0.5"
                                            role="button"
                                            tabIndex={0}
                                            aria-pressed={codeBlockLineWrap}
                                            onClick={() => setCodeBlockLineWrap(!codeBlockLineWrap)}
                                            onKeyDown={(event) => {
                                                if (event.key === ' ' || event.key === 'Enter') {
                                                    event.preventDefault();
                                                    setCodeBlockLineWrap(!codeBlockLineWrap);
                                                }
                                            }}
                                        >
                                            <Checkbox
                                                checked={codeBlockLineWrap}
                                                onChange={setCodeBlockLineWrap}
                                                ariaLabel={t('settings.openchamber.visual.field.codeBlockLineWrapAria')}
                                            />
                                            <span className="typography-ui-label text-foreground">{t('settings.openchamber.visual.field.codeBlockLineWrap')}</span>
                                        </div>
                                    )}
                                        </ResponsiveSettingsGroup>
                                    )}

                                    {(shouldShow('showToolFileIcons') || shouldShow('showTurnChangedFiles') || shouldShow('dotfiles') || shouldShow('fileViewerPreview')) && (
                                        <ResponsiveSettingsGroup
                                            isMobile={isMobile}
                                            label={<span data-settings-item="chat.tools-and-files">{t('settings.openchamber.visual.section.toolsAndFiles')}</span>}
                                        >
                                    {shouldShow('showToolFileIcons') && (
                                        <div
                                            data-settings-item="chat.tool-file-icons"
                                            className="group flex cursor-pointer items-center gap-2 py-0.5"
                                            role="button"
                                            tabIndex={0}
                                            aria-pressed={showToolFileIcons}
                                            onClick={() => handleShowToolFileIconsChange(!showToolFileIcons)}
                                            onKeyDown={(event) => {
                                                if (event.key === ' ' || event.key === 'Enter') {
                                                    event.preventDefault();
                                                    handleShowToolFileIconsChange(!showToolFileIcons);
                                                }
                                            }}
                                        >
                                            <Checkbox
                                                checked={showToolFileIcons}
                                                onChange={handleShowToolFileIconsChange}
                                                ariaLabel={t('settings.openchamber.visual.field.showToolFileIconsAria')}
                                            />
                                            <span className="typography-ui-label text-foreground">{t('settings.openchamber.visual.field.showToolFileIcons')}</span>
                                        </div>
                                    )}

                                    {shouldShow('showSubagentTaskDetails') && (
                                        <div
                                            data-settings-item="chat.subagent-task-details"
                                            className="group flex cursor-pointer items-start gap-2 py-0.5"
                                            role="button"
                                            tabIndex={0}
                                            aria-pressed={showSubagentTaskDetails}
                                            onClick={() => handleShowSubagentTaskDetailsChange(!showSubagentTaskDetails)}
                                            onKeyDown={(event) => {
                                                if (event.key === ' ' || event.key === 'Enter') {
                                                    event.preventDefault();
                                                    handleShowSubagentTaskDetailsChange(!showSubagentTaskDetails);
                                                }
                                            }}
                                        >
                                            <Checkbox
                                                checked={showSubagentTaskDetails}
                                                onChange={handleShowSubagentTaskDetailsChange}
                                                ariaLabel={t('settings.openchamber.visual.field.showSubagentTaskDetailsAria')}
                                                className="mt-0.5"
                                            />
                                            <span className="min-w-0 flex flex-col gap-0.5">
                                                <span className="typography-ui-label text-foreground">{t('settings.openchamber.visual.field.showSubagentTaskDetails')}</span>
                                                <span className="typography-meta text-muted-foreground">{t('settings.openchamber.visual.field.showSubagentTaskDetailsHint')}</span>
                                            </span>
                                        </div>
                                    )}

                                    {shouldShow('showTurnChangedFiles') && (
                                        <div
                                            data-settings-item="chat.changed-files"
                                            className="group flex cursor-pointer items-center gap-2 py-0.5"
                                            role="button"
                                            tabIndex={0}
                                            aria-pressed={showTurnChangedFiles}
                                            onClick={() => handleShowTurnChangedFilesChange(!showTurnChangedFiles)}
                                            onKeyDown={(event) => {
                                                if (event.key === ' ' || event.key === 'Enter') {
                                                    event.preventDefault();
                                                    handleShowTurnChangedFilesChange(!showTurnChangedFiles);
                                                }
                                            }}
                                        >
                                            <Checkbox
                                                checked={showTurnChangedFiles}
                                                onChange={handleShowTurnChangedFilesChange}
                                                ariaLabel={t('settings.openchamber.visual.field.showTurnChangedFilesAria')}
                                            />
                                            <span className="typography-ui-label text-foreground">{t('settings.openchamber.visual.field.showTurnChangedFiles')}</span>
                                        </div>
                                    )}

                                    {shouldShow('dotfiles') && !isVSCodeRuntime() && (
                                        <div
                                            data-settings-item="chat.dotfiles"
                                            className="group flex cursor-pointer items-center gap-2 py-0.5"
                                            role="button"
                                            tabIndex={0}
                                            aria-pressed={directoryShowHidden}
                                            onClick={() => setDirectoryShowHidden(!directoryShowHidden)}
                                            onKeyDown={(event) => {
                                                if (event.key === ' ' || event.key === 'Enter') {
                                                    event.preventDefault();
                                                    setDirectoryShowHidden(!directoryShowHidden);
                                                }
                                            }}
                                        >
                                            <Checkbox
                                                checked={directoryShowHidden}
                                                onChange={setDirectoryShowHidden}
                                                ariaLabel={t('settings.openchamber.visual.field.showDotfilesAria')}
                                            />
                                            <span className="typography-ui-label text-foreground">{t('settings.openchamber.visual.field.showDotfiles')}</span>
                                        </div>
                                    )}

                                    {shouldShow('fileViewerPreview') && (
                                        <div
                                            className="group flex cursor-pointer items-center gap-2 py-0.5"
                                            role="button"
                                            tabIndex={0}
                                            aria-pressed={settingsDefaultFileViewerPreview}
                                            onClick={() => handleFileViewerPreviewChange(!settingsDefaultFileViewerPreview)}
                                            onKeyDown={(event) => {
                                                if (event.key === ' ' || event.key === 'Enter') {
                                                    event.preventDefault();
                                                    handleFileViewerPreviewChange(!settingsDefaultFileViewerPreview);
                                                }
                                            }}
                                        >
                                            <span onClick={(event) => event.stopPropagation()}>
                                                <Checkbox
                                                    checked={settingsDefaultFileViewerPreview}
                                                    onChange={handleFileViewerPreviewChange}
                                                    ariaLabel={t('settings.openchamber.defaults.field.openFilesPreviewAria')}
                                                />
                                            </span>
                                            <span className="typography-ui-label text-foreground">{t('settings.openchamber.defaults.field.openFilesPreview')}</span>
                                        </div>
                                    )}
                                        </ResponsiveSettingsGroup>
                                    )}

                                    {(shouldShow('persistDraft') || (!isMobile && shouldShow('inputSpellcheck'))) && (
                                        <ResponsiveSettingsGroup
                                            isMobile={isMobile}
                                            label={<span data-settings-item="chat.composer">{t('settings.openchamber.visual.section.composer')}</span>}
                                        >
                                    {shouldShow('persistDraft') && (
                                        <div
                                            data-settings-item="chat.persist-drafts"
                                            className="group flex cursor-pointer items-center gap-2 py-0.5"
                                            role="button"
                                            tabIndex={0}
                                            aria-pressed={persistChatDraft}
                                            onClick={() => setPersistChatDraft(!persistChatDraft)}
                                            onKeyDown={(event) => {
                                                if (event.key === ' ' || event.key === 'Enter') {
                                                    event.preventDefault();
                                                    setPersistChatDraft(!persistChatDraft);
                                                }
                                            }}
                                        >
                                            <Checkbox
                                                checked={persistChatDraft}
                                                onChange={setPersistChatDraft}
                                                ariaLabel={t('settings.openchamber.visual.field.persistDraftMessagesAria')}
                                            />
                                            <span className="typography-ui-label text-foreground">{t('settings.openchamber.visual.field.persistDraftMessages')}</span>
                                        </div>
                                    )}

                                    {!isMobile && shouldShow('inputSpellcheck') && (
                                        <div
                                            data-settings-item="chat.spellcheck"
                                            className="group flex cursor-pointer items-center gap-2 py-0.5"
                                            role="button"
                                            tabIndex={0}
                                            aria-pressed={inputSpellcheckEnabled}
                                            onClick={() => handleInputSpellcheckChange(!inputSpellcheckEnabled)}
                                            onKeyDown={(event) => {
                                                if (event.key === ' ' || event.key === 'Enter') {
                                                    event.preventDefault();
                                                    handleInputSpellcheckChange(!inputSpellcheckEnabled);
                                                }
                                            }}
                                        >
                                            <Checkbox
                                                checked={inputSpellcheckEnabled}
                                                onChange={handleInputSpellcheckChange}
                                                ariaLabel={t('settings.openchamber.visual.field.enableSpellcheckInTextInputsAria')}
                                            />
                                            <span className="typography-ui-label text-foreground">{t('settings.openchamber.visual.field.enableSpellcheckInTextInputs')}</span>
                                        </div>
                                    )}
                                        </ResponsiveSettingsGroup>
                                    )}

                                </div>
                            )}

                    </div>
                )}

                {/* --- Privacy & Data --- */}
                {shouldShow('reportUsage') && (
                    <ResponsiveSettingsGroup
                        isMobile={isMobile}
                        label={t('settings.openchamber.visual.section.privacy')}
                        description={t('settings.openchamber.visual.field.sendAnonymousUsageReportsHint')}
                    >
                        <ResponsiveSettingsRow
                            isMobile={isMobile}
                            itemId="appearance.usage-reports"
                            label={t('settings.openchamber.visual.field.sendAnonymousUsageReports')}
                        >
                            <Checkbox
                                checked={reportUsage}
                                onChange={handleReportUsageChange}
                                ariaLabel={t('settings.openchamber.visual.field.sendAnonymousUsageReportsAria')}
                            />
                        </ResponsiveSettingsRow>
                    </ResponsiveSettingsGroup>
                )}

            </div>
    );
};
