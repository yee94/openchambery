import React from 'react';
import type { Agent } from '@opencode-ai/sdk/v2';
import { createPortal } from 'react-dom';
import type { EditPermissionMode } from '@/stores/types/sessionTypes';
import type { ModelMetadata } from '@/types';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Kbd } from '@/components/ui/kbd';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { ModelLogo } from '@/components/ui/ModelLogo';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Icon } from "@/components/icon/Icon";
import type { IconName } from "@/components/icon/icons";
import { ModelPickerList, type ModelPickerEntry, type ModelPickerProvider } from '@/components/model-picker/ModelPickerList';
import { MobileModelPickerPanel } from '@/components/model-picker/MobileModelPickerPanel';
import { useIsVSCodeRuntime } from '@/hooks/useRuntimeAPIs';
import { isDesktopShell } from '@/lib/desktop';
import { getAgentColor } from '@/lib/agentColors';
import { useDeviceInfo } from '@/lib/device';
import { mergeModelMetadataWithLiveModel } from '@/lib/modelMetadata';
import { getModelDisplayName as getSharedModelDisplayName } from '@/lib/modelDisplay';
import { getEditModeColors } from '@/lib/permissions/editModeColors';
import { cn, fuzzyMatch } from '@/lib/utils';
import { AgentAvatar } from '@/components/chat/AgentAvatar';
import { AgentCycleLabel } from '@/components/chat/AgentCycleLabel';
import { useAgentCycleLabelReveal } from '@/components/chat/useAgentCycleLabelReveal';
import { COMPOSER_ICON_HOVER_CLASS, COMPOSER_TRIGGER_CHROME_CLASS } from '@/components/chat/message/parts/toolRowChrome';
import { useContextStore } from '@/stores/contextStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { resolveComposerVisibleAgents } from '@/components/chat/chatComposerCatalog';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSelectionStore } from '@/sync/selection-store';
import { useDirectorySync, useSessionMessages } from '@/sync/sync-context';
import { useSync } from '@/sync/use-sync';
import { getSessionMaterializationStatus } from '@/sync/materialization';
import { useUIStore } from '@/stores/useUIStore';
import { useModelLists } from '@/hooks/useModelLists';
import { useIsTextTruncated } from '@/hooks/useIsTextTruncated';
import { getCycledPrimaryAgentName, isPrimaryMode, resolveAgentModelSelection, type ControlledModelSelection, type MobileControlsPanel } from './mobileControlsUtils';
import { getCurrentIntlLocale, useI18n } from '@/lib/i18n';
import { useOpenCodeReadiness } from '@/hooks/useOpenCodeReadiness';
import { eventMatchesShortcut, getEffectiveShortcutCombo, normalizeCombo } from '@/lib/shortcuts';
import { markStartupTrace } from '@/lib/startupTrace';
import { focusComposerTextarea, resolveComposerTextarea } from './composerFocus';
import { resolveChatInputSelectionVariantOptions, resolveModelVariantKeys } from './chatInputSurface';

type IconComponent = IconName;

type ProviderModel = Record<string, unknown> & { id: string; name?: string };
export type ModelControlsCatalog = {
    providers: Array<{ id: string; name?: string; models: ProviderModel[] }>;
    agents: Agent[];
    /** Variants for the selection value's provider/model pair. */
    variants?: readonly string[];
    variantsReady?: boolean;
    ready: boolean;
    loading?: boolean;
    error?: boolean;
};

type PermissionAction = 'allow' | 'ask' | 'deny';
type PermissionRule = { permission: string; pattern: string; action: PermissionAction };
const buildModelRefKey = (providerID: string, modelID: string) => `${providerID}:${modelID}`;
const INSTANT_DROPDOWN_CLASS = 'transition-none animate-none data-[starting-style]:!opacity-100 data-[starting-style]:!scale-100 data-[ending-style]:!opacity-100 data-[ending-style]:!scale-100';

const asPermissionRuleset = (value: unknown): PermissionRule[] | null => {
    if (!Array.isArray(value)) {
        return null;
    }
    const rules: PermissionRule[] = [];
    for (const entry of value) {
        if (!entry || typeof entry !== 'object') {
            continue;
        }
        const candidate = entry as Partial<PermissionRule>;
        if (typeof candidate.permission !== 'string' || typeof candidate.pattern !== 'string' || typeof candidate.action !== 'string') {
            continue;
        }
        if (candidate.action !== 'allow' && candidate.action !== 'ask' && candidate.action !== 'deny') {
            continue;
        }
        rules.push({ permission: candidate.permission, pattern: candidate.pattern, action: candidate.action });
    }
    return rules;
};

const resolveWildcardPermissionAction = (ruleset: unknown, permission: string): PermissionAction | undefined => {
    const rules = asPermissionRuleset(ruleset);
    if (!rules || rules.length === 0) {
        return undefined;
    }

    for (let i = rules.length - 1; i >= 0; i -= 1) {
        const rule = rules[i];
        if (rule.permission === permission && rule.pattern === '*') {
            return rule.action;
        }
    }

    for (let i = rules.length - 1; i >= 0; i -= 1) {
        const rule = rules[i];
        if (rule.permission === '*' && rule.pattern === '*') {
            return rule.action;
        }
    }

    return undefined;
};

interface CapabilityDefinition {
    key: 'tool_call' | 'reasoning';
    icon: IconComponent;
    label: string;
    isActive: (metadata?: ModelMetadata) => boolean;
}

const CAPABILITY_DEFINITIONS: CapabilityDefinition[] = [
    {
        key: 'tool_call',
        icon: "tools",
        label: 'Tool calling',
        isActive: (metadata) => metadata?.tool_call === true,
    },
    {
        key: 'reasoning',
        icon: "brain-ai-3",
        label: 'Reasoning',
        isActive: (metadata) => metadata?.reasoning === true,
    },
];

interface ModalityIconDefinition {
    icon: IconComponent;
    label: string;
}

type ModalityIcon = {
    key: string;
    icon: IconComponent;
    label: string;
};

type ModelApplyResult = 'applied' | 'provider-missing' | 'model-missing';

const MODALITY_ICON_MAP: Record<string, ModalityIconDefinition> = {
    text: { icon: "text", label: 'Text' },
    image: { icon: "file-image", label: 'Image' },
    video: { icon: "file-video", label: 'Video' },
    audio: { icon: "file-music", label: 'Audio' },
    pdf: { icon: "file-pdf", label: 'PDF' },
};

const normalizeModality = (value: string) => value.trim().toLowerCase();

const getModalityIcons = (metadata: ModelMetadata | undefined, direction: 'input' | 'output'): ModalityIcon[] => {
    const modalityList = direction === 'input' ? metadata?.modalities?.input : metadata?.modalities?.output;
    if (!Array.isArray(modalityList) || modalityList.length === 0) {
        return [];
    }

    const uniqueValues = Array.from(new Set(modalityList.map((item) => normalizeModality(item))));

    const result: ModalityIcon[] = [];
    for (const modality of uniqueValues) {
        const definition = MODALITY_ICON_MAP[modality];
        if (!definition) {
            continue;
        }
        result.push({
            key: modality,
            icon: definition.icon,
            label: definition.label,
        });
    }
    return result;
};

const formatCompactNumber = (value: number) => new Intl.NumberFormat(getCurrentIntlLocale(), {
    notation: 'compact',
    compactDisplay: 'short',
    maximumFractionDigits: 1,
    minimumFractionDigits: 0,
}).format(value);

const formatUsdCurrency = (value: number) => new Intl.NumberFormat(getCurrentIntlLocale(), {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 4,
    minimumFractionDigits: 2,
}).format(value);

const formatKnowledgeDate = (value: Date) => new Intl.DateTimeFormat(getCurrentIntlLocale(), { month: 'short', year: 'numeric' }).format(value);

const formatReleaseDate = (value: Date) => new Intl.DateTimeFormat(getCurrentIntlLocale(), {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
}).format(value);

const ADD_PROVIDER_ID = '__add_provider__';

const IconBadge: React.FC<{ iconName: IconComponent; label: string }> = ({ iconName, label }) => (
    <span
        className="flex size-5 items-center justify-center rounded-xl bg-muted/60 text-muted-foreground"
        title={label}
        aria-label={label}
        role="img"
    >
        <Icon name={iconName} className="size-3.5" />
    </span>
);

const EditModeIcon: React.FC<{ mode: EditPermissionMode; className?: string }> = ({ mode, className }) => {
    const combinedClassName = cn(className, 'flex-shrink-0');
    const modeColors = getEditModeColors(mode);
    const iconColor = modeColors ? modeColors.text : 'var(--foreground)';
    const iconStyle = { color: iconColor };

    if (mode === 'full') {
        return <Icon name="pencil-ai" className={combinedClassName} style={iconStyle} />;
    }
    if (mode === 'allow') {
        return <Icon name="checkbox-circle" className={combinedClassName} style={iconStyle} />;
    }
    if (mode === 'deny') {
        return <Icon name="close-circle" className={combinedClassName} style={iconStyle} />;
    }
    return <Icon name="question" className={combinedClassName} style={iconStyle} />;
};

const formatTokens = (value?: number | null) => {
    if (typeof value !== 'number' || Number.isNaN(value)) {
        return '—';
    }

    if (value === 0) {
        return '0';
    }

    const formatted = formatCompactNumber(value);
    return formatted.endsWith('.0') ? formatted.slice(0, -2) : formatted;
};

const formatCost = (value?: number | null) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return '—';
    }

    return formatUsdCurrency(value);
};

const getCapabilityIcons = (metadata?: ModelMetadata) => {
    const result: { key: string; icon: IconComponent; label: string }[] = [];
    for (const definition of CAPABILITY_DEFINITIONS) {
        if (definition.isActive(metadata)) {
            result.push({ key: definition.key, icon: definition.icon, label: definition.label });
        }
    }
    return result;
};

const formatKnowledge = (knowledge?: string) => {
    if (!knowledge) {
        return '—';
    }

    const match = knowledge.match(/^(\d{4})-(\d{2})$/);
    if (match) {
        const year = Number.parseInt(match[1], 10);
        const monthIndex = Number.parseInt(match[2], 10) - 1;
        const knowledgeDate = new Date(Date.UTC(year, monthIndex, 1));
        if (!Number.isNaN(knowledgeDate.getTime())) {
            return formatKnowledgeDate(knowledgeDate);
        }
    }

    return knowledge;
};

const formatDate = (value?: string) => {
    if (!value) {
        return '—';
    }

    const parsedDate = new Date(value);
    if (Number.isNaN(parsedDate.getTime())) {
        return value;
    }

    return formatReleaseDate(parsedDate);
};

export type ModelControlsSelection = ControlledModelSelection & { variant?: string };

export type ModelControlsSelectionAdapter = {
    selection: ModelControlsSelection;
    onChange: (selection: ModelControlsSelection) => Promise<void>;
    disabled?: boolean;
    catalog?: ModelControlsCatalog;
};

interface ModelControlsProps {
    className?: string;
    composerTextareaRef: React.RefObject<HTMLTextAreaElement | null>;
    mobilePanel?: MobileControlsPanel;
    onMobilePanelChange?: (panel: MobileControlsPanel) => void;
    /**
     * When true, the desktop agent trigger is not rendered in the model cluster.
     * Pass a mount node via `agentPortalContainer` to place it in the left icon bar.
     */
    relocateAgent?: boolean;
    agentPortalContainer?: HTMLElement | null;
    selectionAdapter?: ModelControlsSelectionAdapter;
}

export const ModelControls: React.FC<ModelControlsProps> = ({
    className,
    composerTextareaRef,
    mobilePanel,
    onMobilePanelChange,
    relocateAgent = false,
    agentPortalContainer = null,
    selectionAdapter,
}) => {
    const { t } = useI18n();
    const { isReady, isUnavailable } = useOpenCodeReadiness();
    const readinessLabel = isUnavailable || selectionAdapter?.catalog?.error ? t('common.unavailable') : t('common.loading');
    const isProviderConfigLoading = useConfigStore((state) => (
        state.providerConfigLoadingByDirectory[state.activeDirectoryKey] === true
    ));
    const isAgentConfigLoading = useConfigStore((state) => (
        state.agentConfigLoadingByDirectory[state.activeDirectoryKey] === true
    ));
    const selectionCatalog = selectionAdapter?.catalog;
    const isModelControlReady = isReady && (selectionCatalog?.ready ?? !isProviderConfigLoading) && !selectionCatalog?.loading && !selectionCatalog?.error && !selectionAdapter?.disabled;
    const isAgentControlReady = isReady && (selectionCatalog?.ready ?? !isAgentConfigLoading) && !selectionCatalog?.loading && !selectionCatalog?.error && !selectionAdapter?.disabled;
    const areModelControlsReady = isModelControlReady && isAgentControlReady;
    const storedProviders = useConfigStore((state) => state.providers);
    const providers = selectionCatalog?.providers ?? storedProviders;
    const storedProviderId = useConfigStore((state) => state.currentProviderId);
    const storedModelId = useConfigStore((state) => state.currentModelId);
    const currentProviderId = selectionAdapter?.selection.providerID ?? storedProviderId;
    const currentModelId = selectionAdapter?.selection.modelID ?? storedModelId;
    const storedCurrentVariant = useConfigStore((state) => state.currentVariant);
    const currentVariant = selectionAdapter ? selectionAdapter.selection.variant : storedCurrentVariant;
    const storedAgentName = useConfigStore((state) => state.currentAgentName);
    const currentAgentName = selectionAdapter ? selectionAdapter.selection.agent ?? undefined : storedAgentName;
    const settingsDefaultVariant = useConfigStore((state) => state.settingsDefaultVariant);
    const settingsDefaultAgent = useConfigStore((state) => state.settingsDefaultAgent);
    const setProvider = useConfigStore((state) => state.setProvider);
    const setSelectedProvider = useConfigStore((state) => state.setSelectedProvider);
    const setModel = useConfigStore((state) => state.setModel);
    const setCurrentVariant = useConfigStore((state) => state.setCurrentVariant);
    const getCurrentModelVariants = useConfigStore((state) => state.getCurrentModelVariants);
    const setAgent = useConfigStore((state) => state.setAgent);
    const getCurrentProvider = useConfigStore((state) => state.getCurrentProvider);
    const getModelMetadata = useConfigStore((state) => state.getModelMetadata);
    const modelsMetadata = useConfigStore((state) => state.modelsMetadata);
    const getCurrentAgent = useConfigStore((state) => state.getCurrentAgent);
    const getVisibleAgents = useConfigStore((state) => state.getVisibleAgents);

    // Same visibility pipeline as primary chat: catalog or store, then drop
    // hidden internals (title/summary/compaction) before mode filtering.
    const agents = resolveComposerVisibleAgents(selectionCatalog?.agents ?? getVisibleAgents());
    const primaryAgents = React.useMemo(() => agents.filter((agent) => agent.mode === 'primary'), [agents]);
    const tracedReadyRef = React.useRef(false);

    React.useEffect(() => {
        if (tracedReadyRef.current || !areModelControlsReady) return;
        tracedReadyRef.current = true;
        markStartupTrace('ModelControls:ready', {
            providers: providers.length,
            agents: agents.length,
            currentProviderId,
            currentModelId,
            currentAgentName,
        });
    }, [agents.length, areModelControlsReady, currentAgentName, currentModelId, currentProviderId, providers.length]);

    const currentSessionId = useSessionUIStore((s) => selectionAdapter ? null : s.currentSessionId);
    const getDirectoryForSession = useSessionUIStore((s) => s.getDirectoryForSession);
    const sync = useSync();

    const getSessionModelSelection = useSelectionStore((state) => state.getSessionModelSelection);
    const saveSessionModelSelection = useSelectionStore((state) => state.saveSessionModelSelection);
    const saveSessionAgentSelection = useSelectionStore((state) => state.saveSessionAgentSelection);
    const saveAgentModelForSession = useSelectionStore((state) => state.saveAgentModelForSession);
    const getAgentModelForSession = useSelectionStore((state) => state.getAgentModelForSession);
    const saveAgentModelVariantForSession = useSelectionStore((state) => state.saveAgentModelVariantForSession);
    const getAgentModelVariantForSession = useSelectionStore((state) => state.getAgentModelVariantForSession);

    const contextHydrated = useContextStore((state) => state.hasHydrated);

    const sessionSavedAgentName = useSelectionStore((state) =>
        currentSessionId ? state.sessionAgentSelections.get(currentSessionId) ?? null : null
    );

    const stickySessionAgentRef = React.useRef<string | null>(null);
    React.useEffect(() => {
        if (!currentSessionId) {
            stickySessionAgentRef.current = null;
            return;
        }
        if (sessionSavedAgentName) {
            stickySessionAgentRef.current = sessionSavedAgentName;
        }
    }, [currentSessionId, sessionSavedAgentName]);

    const stickySessionAgentName = currentSessionId ? stickySessionAgentRef.current : null;

    // Prefer per-session selection over global config to avoid flicker during server-driven mode switches.
    const standardUIAgentName = currentSessionId
        ? (sessionSavedAgentName || stickySessionAgentName || currentAgentName)
        : currentAgentName;
    const uiAgentName = selectionAdapter ? selectionAdapter.selection.agent ?? undefined : standardUIAgentName;

    const toggleFavoriteModel = useUIStore((state) => state.toggleFavoriteModel);
    const reorderFavoriteModel = useUIStore((state) => state.reorderFavoriteModel);
    const providerOrder = useUIStore((state) => state.providerOrder);
    const setProviderOrder = useUIStore((state) => state.setProviderOrder);
    const isFavoriteModel = useUIStore((state) => state.isFavoriteModel);
    const addRecentModel = useUIStore((state) => state.addRecentModel);
    const addRecentAgent = useUIStore((state) => state.addRecentAgent);
    const addRecentEffort = useUIStore((state) => state.addRecentEffort);
    const isModelSelectorOpen = useUIStore((state) => state.isModelSelectorOpen);
    const setModelSelectorOpen = useUIStore((state) => state.setModelSelectorOpen);
    const isAgentSelectorOpen = useUIStore((state) => state.isAgentSelectorOpen);
    const setAgentSelectorOpen = useUIStore((state) => state.setAgentSelectorOpen);
    const isModelSelectorInstant = useUIStore((state) => state.isModelSelectorInstant);
    const isAgentSelectorInstant = useUIStore((state) => state.isAgentSelectorInstant);
    const setSettingsDialogOpen = useUIStore((state) => state.setSettingsDialogOpen);
    const setSettingsPage = useUIStore((state) => state.setSettingsPage);
    const hiddenModels = useUIStore((state) => state.hiddenModels);
    const cycleAgentShortcutOverride = useUIStore((state) => state.shortcutOverrides.cycle_agent);
    const cycleAgentShortcut = React.useMemo(() => (
        getEffectiveShortcutCombo('cycle_agent', cycleAgentShortcutOverride ? { cycle_agent: cycleAgentShortcutOverride } : undefined)
    ), [cycleAgentShortcutOverride]);

    // Agent selector open state lives in useUIStore so Ctrl+X → A (and other
    // global shortcuts) can open it the same way Ctrl+Shift+M opens models.
    const { favoriteModelsList, recentModelsList } = useModelLists();

    const { isMobile: deviceIsMobile } = useDeviceInfo();
    // The composer decides whether it renders the mobile layout from the UI
    // store (the Capacitor shell forces it true even on tablets/iPad, where
    // useDeviceInfo classifies the wide screen as non-mobile). The bottom-sheet
    // panels must follow the SAME source: with the device flag alone, tapping
    // the model/agent chip on an iPad set the panel state while the sheet
    // itself rendered null.
    const uiIsMobile = useUIStore((state) => state.isMobile);
    const isMobile = deviceIsMobile || uiIsMobile;
    const isDesktop = React.useMemo(() => isDesktopShell(), []);
    const isVSCodeRuntime = useIsVSCodeRuntime();
    // Only use mobile panels on actual mobile devices, VSCode uses desktop dropdowns
    const isCompact = isMobile;
    const [localMobilePanel, setLocalMobilePanel] = React.useState<MobileControlsPanel>(null);
    const usingExternalMobilePanel = mobilePanel !== undefined && typeof onMobilePanelChange === 'function';
    const activeMobilePanel = usingExternalMobilePanel ? mobilePanel : localMobilePanel;
    const setActiveMobilePanel = usingExternalMobilePanel ? onMobilePanelChange : setLocalMobilePanel;
    const [mobileTooltipOpen, setMobileTooltipOpen] = React.useState<'model' | 'agent' | null>(null);
    const manualVariantSelectionRef = React.useRef(false);
    const closeMobilePanel = React.useCallback(() => setActiveMobilePanel(null), [setActiveMobilePanel]);
    const closeMobileTooltip = React.useCallback(() => setMobileTooltipOpen(null), []);
    const longPressTimerRef = React.useRef<NodeJS.Timeout | undefined>(undefined);
    // Use global state for model selector (allows Ctrl+M shortcut)
    const agentMenuOpen = isModelSelectorOpen;
    const setAgentMenuOpen = setModelSelectorOpen;
    const openAddProviderSettings = React.useCallback(() => {
        setSelectedProvider(ADD_PROVIDER_ID);
        setSettingsPage('providers');
        setSettingsDialogOpen(true);
        setAgentMenuOpen(false);
        closeMobilePanel();
    }, [setSelectedProvider, setSettingsPage, setSettingsDialogOpen, setAgentMenuOpen, closeMobilePanel]);
    const [desktopModelQuery, setDesktopModelQuery] = React.useState('');
    const [modelTooltipOpen, setModelTooltipOpen] = React.useState(false);
    const suppressModelTooltipUntilRef = React.useRef(0);
    const keyboardOwnsModelSelectionRef = React.useRef(false);
    const lastModelPointerPositionRef = React.useRef<{ x: number; y: number } | null>(null);
    const activeModelPickerEntryRef = React.useRef<ModelPickerEntry | undefined>(undefined);
    const [pendingThinkingVariants, setPendingThinkingVariants] = React.useState<Map<string, string | undefined>>(new Map());
    const [adjustedThinkingModels, setAdjustedThinkingModels] = React.useState<Set<string>>(new Set());
    const [modelPickerRenderVersion, setModelPickerRenderVersion] = React.useState(0);
    // React.Activity keeps cached session views mounted, so this instance ref avoids
    // targeting another session's textarea. Base UI Menu returns focus to the trigger after close. Our custom
    // ModelPickerList closes via controlled open (not Menu.Item), so the default
    // lands on the model/agent chip and the composer never receives the caret.
    // finalFocus={resolveComposerFinalFocus} hands focus to the composer during
    // unmount; onOpenChangeComplete runs a deferred backup once FloatingFocusManager
    // is fully gone (a bare microtask is too early and loses the race in WebKit).
    const restoreComposerFocus = React.useCallback(() => {
        const focusComposer = () => {
            const state = useUIStore.getState();
            if (!state.isModelSelectorOpen && !state.isAgentSelectorOpen) {
                focusComposerTextarea(composerTextareaRef);
            }
        };
        window.setTimeout(() => {
            requestAnimationFrame(() => {
                focusComposer();
                // Retry on the next frame after the popup unmounts in WebKit.
                requestAnimationFrame(focusComposer);
            });
        }, 0);
    }, [composerTextareaRef]);

    const handleSelectorCloseComplete = React.useCallback((selector: 'model' | 'agent') => {
        const state = useUIStore.getState();
        const reopened = selector === 'model' ? state.isModelSelectorOpen : state.isAgentSelectorOpen;
        if (reopened) {
            return;
        }

        useUIStore.setState(selector === 'model'
            ? { isModelSelectorInstant: false }
            : { isAgentSelectorInstant: false });

        if (useUIStore.getState().isMobile) {
            return;
        }

        restoreComposerFocus();
    }, [restoreComposerFocus]);

    // Base UI Menu returns focus to the trigger by default; hand it the composer
    // instead so Esc/Enter leave the caret back in the chat input.
    const resolveComposerFinalFocus = React.useCallback((): HTMLElement | null | false => {
        const state = useUIStore.getState();
        if (state.isModelSelectorOpen || state.isAgentSelectorOpen) {
            return false;
        }
        return resolveComposerTextarea(composerTextareaRef);
    }, [composerTextareaRef]);

    // Handle model selector close behavior (separate from agent selector)
    const prevModelSelectorOpenRef = React.useRef(isModelSelectorOpen);
    React.useEffect(() => {
        const wasOpen = prevModelSelectorOpenRef.current;
        prevModelSelectorOpenRef.current = isModelSelectorOpen;

        if (!isModelSelectorOpen) {
            setDesktopModelQuery('');
            keyboardOwnsModelSelectionRef.current = false;
            lastModelPointerPositionRef.current = null;
            setPendingThinkingVariants(new Map());
            setAdjustedThinkingModels(new Set());

            if (wasOpen && !isCompact) {
                setModelTooltipOpen(false);
                suppressModelTooltipUntilRef.current = performance.now() + 200;
            }
        }
    }, [isModelSelectorOpen, isCompact]);

    // Handle agent selector close behavior
    const [agentSearchQuery, setAgentSearchQuery] = React.useState('');
    React.useEffect(() => {
        if (!isAgentSelectorOpen) {
            setAgentSearchQuery('');
        }
    }, [isAgentSelectorOpen]);

    const selectableDesktopAgents = React.useMemo(() => {
        return agents.filter((agent) => isPrimaryMode(agent.mode));
    }, [agents]);

    const sortedAndFilteredAgents = React.useMemo(() => {
        const sorted = [...selectableDesktopAgents].sort((a, b) => a.name.localeCompare(b.name));
        if (!agentSearchQuery.trim()) {
            return sorted;
        }
        return sorted.filter((agent) =>
            fuzzyMatch(agent.name, agentSearchQuery) ||
            (agent.description && fuzzyMatch(agent.description, agentSearchQuery))
        );
    }, [selectableDesktopAgents, agentSearchQuery]);

    const defaultAgentName = React.useMemo(() => {
        if (settingsDefaultAgent) {
            const found = selectableDesktopAgents.find(a => a.name === settingsDefaultAgent);
            if (found) return found.name;
        }
        const buildAgent = selectableDesktopAgents.find(a => a.name === 'build');
        if (buildAgent) return buildAgent.name;
        return selectableDesktopAgents[0]?.name;
    }, [settingsDefaultAgent, selectableDesktopAgents]);

    const currentAgent = React.useMemo(() => {
        if (uiAgentName) {
            return agents.find((agent) => agent.name === uiAgentName);
        }
        return getCurrentAgent?.();
    }, [agents, getCurrentAgent, uiAgentName]);

    const sizeVariant: 'mobile' | 'vscode' | 'default' = isMobile ? 'mobile' : isVSCodeRuntime ? 'vscode' : 'default';
    const controlIconSize = sizeVariant === 'mobile' ? 'size-5' : sizeVariant === 'vscode' ? 'size-4' : 'size-4';
    const controlTextSize = isCompact ? 'typography-micro' : 'typography-meta';
    const inlineGapClass = sizeVariant === 'mobile' ? 'gap-x-1' : sizeVariant === 'vscode' ? 'gap-x-2' : 'gap-x-3';
    // Icon-only agent trigger: same square hit-target as composer + / focus / shield buttons.
    // Icon-only agent trigger: same square hit-target as composer + / focus / shield buttons.
    const agentIconButtonClass = sizeVariant === 'mobile' ? 'h-8 w-8' : sizeVariant === 'vscode' ? 'h-5 w-5' : 'h-6 w-6';
    const agentAvatarSize = sizeVariant === 'mobile' ? 18 : sizeVariant === 'vscode' ? 14 : 16;
    const showAgentCycleLabel = useAgentCycleLabelReveal(uiAgentName);

    const currentProvider = selectionAdapter
        ? providers.find((provider) => provider.id === currentProviderId)
        : getCurrentProvider();
    const models = Array.isArray(currentProvider?.models) ? currentProvider.models : [];

    const currentModelForMetadata = currentModelId
        ? models.find((model: ProviderModel) => model.id === currentModelId)
        : undefined;
    const currentMetadata = currentProviderId && currentModelId && currentModelForMetadata
        ? mergeModelMetadataWithLiveModel(currentProviderId, currentModelForMetadata, getModelMetadata(currentProviderId, currentModelId))
        : currentProviderId && currentModelId
            ? getModelMetadata(currentProviderId, currentModelId)
            : undefined;
    const localizeMetaLabel = React.useCallback((label: string) => {
        if (label === 'Tool calling') return t('chat.modelControls.capability.toolCalling');
        if (label === 'Reasoning') return t('chat.modelControls.capability.reasoning');
        if (label === 'Text') return t('chat.modelControls.modality.text');
        if (label === 'Image') return t('chat.modelControls.modality.image');
        if (label === 'Video') return t('chat.modelControls.modality.video');
        if (label === 'Audio') return t('chat.modelControls.modality.audio');
        if (label === 'PDF') return t('chat.modelControls.modality.pdf');
        return label;
    }, [t]);

    const currentCapabilityIcons = React.useMemo(
        () => getCapabilityIcons(currentMetadata).map((icon) => ({ ...icon, label: localizeMetaLabel(icon.label) })),
        [currentMetadata, localizeMetaLabel],
    );
    const inputModalityIcons = React.useMemo(
        () => getModalityIcons(currentMetadata, 'input').map((icon) => ({ ...icon, label: localizeMetaLabel(icon.label) })),
        [currentMetadata, localizeMetaLabel],
    );
    const outputModalityIcons = React.useMemo(
        () => getModalityIcons(currentMetadata, 'output').map((icon) => ({ ...icon, label: localizeMetaLabel(icon.label) })),
        [currentMetadata, localizeMetaLabel],
    );

    // Compute from the selected model each render to avoid stale variants
    // in draft/session transitions. Prefer an explicit surface catalog list;
    // otherwise derive keys from the active provider/model entry (primary
    // adapters often omit catalog.variants and only ship providers/store data).
    const availableVariants = React.useMemo(() => {
        if (selectionCatalog?.variantsReady === false) {
            return [];
        }
        if (selectionCatalog?.variants) {
            return [...selectionCatalog.variants];
        }
        if (currentProviderId && currentModelId) {
            const provider = providers.find((entry) => entry.id === currentProviderId);
            const model = provider?.models?.find((entry) => entry.id === currentModelId) as { variants?: unknown } | undefined;
            return resolveModelVariantKeys(model);
        }
        return selectionAdapter ? [] : getCurrentModelVariants();
    }, [currentModelId, currentProviderId, getCurrentModelVariants, providers, selectionAdapter, selectionCatalog?.variants, selectionCatalog?.variantsReady]);
    const hasVariants = availableVariants.length > 0;

    const costRows = [
        { label: 'Input', value: formatCost(currentMetadata?.cost?.input) },
        { label: 'Output', value: formatCost(currentMetadata?.cost?.output) },
        { label: 'Cache read', value: formatCost(currentMetadata?.cost?.cache_read) },
        { label: 'Cache write', value: formatCost(currentMetadata?.cost?.cache_write) },
    ];

    const limitRows = [
        { label: 'Context', value: formatTokens(currentMetadata?.limit?.context) },
        { label: 'Output', value: formatTokens(currentMetadata?.limit?.output) },
    ];

    const prevAgentNameRef = React.useRef<string | undefined>(undefined);
    const explicitAgentSwitchRef = React.useRef<string | null>(null);
    const latestLoadedUserChoiceRestoreRef = React.useRef<string | null>(null);

    const currentSessionDirectory = currentSessionId ? getDirectoryForSession(currentSessionId) : undefined;
    const hasRenderableCurrentSessionSnapshot = useDirectorySync(
        React.useCallback(
            (state) => (currentSessionId ? getSessionMaterializationStatus(state, currentSessionId).renderable : false),
            [currentSessionId],
        ),
        currentSessionDirectory ?? undefined,
    );
    const currentSessionMessagesFromSync = useSessionMessages(currentSessionId ?? '', currentSessionDirectory ?? undefined);
    const latestLoadedUserChoice = React.useMemo(() => {
        for (let i = currentSessionMessagesFromSync.length - 1; i >= 0; i -= 1) {
            const message = currentSessionMessagesFromSync[i] as typeof currentSessionMessagesFromSync[number] & {
                model?: { providerID?: string; modelID?: string; variant?: string };
                variant?: string;
                mode?: string;
            };
            if (message.role !== 'user') {
                continue;
            }

            const providerID = typeof message.model?.providerID === 'string' && message.model.providerID.trim().length > 0
                ? message.model.providerID
                : undefined;
            const modelID = typeof message.model?.modelID === 'string' && message.model.modelID.trim().length > 0
                ? message.model.modelID
                : undefined;
            const agent = typeof message.agent === 'string' && message.agent.trim().length > 0
                ? message.agent
                : (typeof message.mode === 'string' && message.mode.trim().length > 0 ? message.mode : undefined);
            // OpenCode 1.4.0 moved variant from top-level to model.variant.
            // Prefer the new location, fall back to the legacy one for older servers.
            const variantCandidate = message.model?.variant ?? message.variant;
            const variant = typeof variantCandidate === 'string' && variantCandidate.trim().length > 0
                ? variantCandidate
                : undefined;

            return { id: message.id, agent, providerID, modelID, variant };
        }
        return null;
    }, [currentSessionMessagesFromSync]);

    const tryApplyModelSelection = React.useCallback(
        (providerId: string, modelId: string, agentName?: string): ModelApplyResult => {
            if (!providerId || !modelId) {
                return 'model-missing';
            }

            const provider = providers.find(p => p.id === providerId);
            if (!provider) {
                return 'provider-missing';
            }

            const providerModels = Array.isArray(provider.models) ? provider.models : [];
            const modelExists = providerModels.find((m: ProviderModel) => m.id === modelId);
            if (!modelExists) {
                return 'model-missing';
            }

            const providerMatches = currentProviderId === providerId;
            const modelMatches = currentModelId === modelId;
            if (providerMatches && modelMatches) {
                return 'applied';
            }

            setProvider(providerId);
            setModel(modelId);

            if (currentSessionId) {
                saveSessionModelSelection(currentSessionId, providerId, modelId);
                if (agentName) {
                    saveAgentModelForSession(currentSessionId, agentName, providerId, modelId);
                }
            }

            return 'applied';
        },
        [providers, currentProviderId, currentModelId, setProvider, setModel, currentSessionId, saveAgentModelForSession, saveSessionModelSelection],
    );

    const getModelVariantOptions = React.useCallback((providerId: string, modelId: string) => {
        if (selectionAdapter) {
            const fromCatalog = resolveChatInputSelectionVariantOptions(
                selectionAdapter.selection,
                selectionAdapter.catalog,
                providerId,
                modelId,
            );
            if (
                fromCatalog.length > 0
                || selectionAdapter.catalog?.variants
                || selectionAdapter.catalog?.variantsReady === false
                || selectionAdapter.selection.providerID !== providerId
                || selectionAdapter.selection.modelID !== modelId
            ) {
                return fromCatalog;
            }
            // Primary adapters may omit catalog.variants; fall back to the
            // provider list already resolved for this control (store or surface).
            const provider = providers.find((entry) => entry.id === providerId);
            const model = provider?.models?.find((entry) => entry.id === modelId) as { variants?: unknown } | undefined;
            return resolveModelVariantKeys(model);
        }
        const provider = providers.find((entry) => entry.id === providerId);
        const model = provider?.models?.find((entry) => entry.id === modelId) as { variants?: unknown } | undefined;
        return resolveModelVariantKeys(model);
    }, [currentModelId, currentProviderId, providers, selectionAdapter, selectionCatalog?.variants, selectionCatalog?.variantsReady]);

    const resolveModelVariantSelection = React.useCallback((providerId: string, modelId: string) => {
        if (selectionAdapter) {
            const variantOptions = resolveChatInputSelectionVariantOptions(selectionAdapter.selection, selectionAdapter.catalog, providerId, modelId);
            const selectedVariant = selectionAdapter.selection.variant;
            return selectedVariant && variantOptions.includes(selectedVariant) ? selectedVariant : undefined;
        }
        const variantOptions = getModelVariantOptions(providerId, modelId);
        if (variantOptions.length === 0) {
            return undefined;
        }

        const effectiveAgentName = uiAgentName || currentAgentName;
        if (currentSessionId && effectiveAgentName) {
            const savedVariant = getAgentModelVariantForSession(currentSessionId, effectiveAgentName, providerId, modelId);
            if (savedVariant && variantOptions.includes(savedVariant)) {
                return savedVariant;
            }
        }

        if (currentProviderId === providerId && currentModelId === modelId && currentVariant && variantOptions.includes(currentVariant)) {
            return currentVariant;
        }

        if (!currentSessionId && settingsDefaultVariant && variantOptions.includes(settingsDefaultVariant)) {
            return settingsDefaultVariant;
        }

        return undefined;
    }, [
        currentAgentName,
        currentModelId,
        currentProviderId,
        currentSessionId,
        currentVariant,
        getAgentModelVariantForSession,
        getModelVariantOptions,
        selectionAdapter,
        settingsDefaultVariant,
        uiAgentName,
    ]);

    const resolveLiveAgentName = React.useCallback(() => {
        if (selectionAdapter) {
            return selectionAdapter.selection.agent ?? undefined;
        }
        const liveConfigAgentName = useConfigStore.getState().currentAgentName;
        if (currentSessionId) {
            return useSelectionStore.getState().getSessionAgentSelection(currentSessionId)
                || stickySessionAgentRef.current
                || liveConfigAgentName
                || currentAgentName;
        }
        return liveConfigAgentName || currentAgentName;
    }, [currentAgentName, currentSessionId, selectionAdapter]);

    const commitVariantSelectionForModel = React.useCallback((providerId: string, modelId: string, variant: string | undefined, agentNameOverride?: string | null) => {
        if (selectionAdapter) {
            void selectionAdapter.onChange({
                ...selectionAdapter.selection,
                providerID: providerId,
                modelID: modelId,
                variant,
            }).catch(() => undefined);
            return;
        }
        const variantOptions = getModelVariantOptions(providerId, modelId);
        if (variantOptions.length === 0) {
            manualVariantSelectionRef.current = false;
            setCurrentVariant(undefined);
            return;
        }

        manualVariantSelectionRef.current = true;
        setCurrentVariant(variant);
        addRecentEffort(providerId, modelId, variant);

        const effectiveAgentName = agentNameOverride ?? resolveLiveAgentName();
        if (currentSessionId && effectiveAgentName) {
            saveAgentModelVariantForSession(currentSessionId, effectiveAgentName, providerId, modelId, variant);
        }
    }, [
        addRecentEffort,
        currentSessionId,
        getModelVariantOptions,
        resolveLiveAgentName,
        saveAgentModelVariantForSession,
        selectionAdapter,
        setCurrentVariant,
    ]);

    const applyModelSelectionWithVariant = React.useCallback((providerId: string, modelId: string, variant: string | undefined, agentNameOverride?: string | null) => {
        const effectiveAgentName = agentNameOverride ?? resolveLiveAgentName() ?? undefined;
        const result = tryApplyModelSelection(providerId, modelId, effectiveAgentName);
        if (result !== 'applied') {
            return result;
        }

        addRecentModel(providerId, modelId);
        commitVariantSelectionForModel(providerId, modelId, variant, effectiveAgentName);
        return 'applied';
    }, [addRecentModel, commitVariantSelectionForModel, resolveLiveAgentName, tryApplyModelSelection]);

    React.useEffect(() => {
        if (selectionAdapter) return;
        if (!currentSessionId) {
            latestLoadedUserChoiceRestoreRef.current = null;
            return;
        }

        if (!contextHydrated || providers.length === 0 || !hasRenderableCurrentSessionSnapshot || !latestLoadedUserChoice?.providerID || !latestLoadedUserChoice.modelID) {
            return;
        }

        const restoreKey = [
            currentSessionId,
            latestLoadedUserChoice.id,
            latestLoadedUserChoice.agent ?? '',
            latestLoadedUserChoice.providerID,
            latestLoadedUserChoice.modelID,
            latestLoadedUserChoice.variant ?? '',
        ].join('|');

        if (latestLoadedUserChoiceRestoreRef.current === restoreKey) {
            return;
        }

        if (latestLoadedUserChoice.agent && currentAgentName !== latestLoadedUserChoice.agent) {
            setAgent(latestLoadedUserChoice.agent);
        }

        const historicalVariant = latestLoadedUserChoice.variant
            && getModelVariantOptions(latestLoadedUserChoice.providerID, latestLoadedUserChoice.modelID).includes(latestLoadedUserChoice.variant)
            ? latestLoadedUserChoice.variant
            : undefined;
        const applyResult = applyModelSelectionWithVariant(
            latestLoadedUserChoice.providerID,
            latestLoadedUserChoice.modelID,
            historicalVariant,
            latestLoadedUserChoice.agent || currentAgentName || undefined,
        );
        if (applyResult !== 'applied') {
            return;
        }

        if (latestLoadedUserChoice.agent) {
            saveSessionAgentSelection(currentSessionId, latestLoadedUserChoice.agent);
            saveAgentModelVariantForSession(
                currentSessionId,
                latestLoadedUserChoice.agent,
                latestLoadedUserChoice.providerID,
                latestLoadedUserChoice.modelID,
                historicalVariant,
            );
        }
        saveSessionModelSelection(currentSessionId, latestLoadedUserChoice.providerID, latestLoadedUserChoice.modelID);
        latestLoadedUserChoiceRestoreRef.current = restoreKey;

    }, [
        selectionAdapter,
        currentSessionId,
        currentAgentName,
        contextHydrated,
        providers,
        hasRenderableCurrentSessionSnapshot,
        latestLoadedUserChoice,
        setAgent,
        applyModelSelectionWithVariant,
        getModelVariantOptions,
        saveSessionAgentSelection,
        saveAgentModelVariantForSession,
        saveSessionModelSelection,
    ]);

    React.useEffect(() => {
        if (selectionAdapter) return;
        if (!currentSessionId) {
            latestLoadedUserChoiceRestoreRef.current = null;
            return;
        }

        if (!contextHydrated || providers.length === 0 || agents.length === 0) {
            return;
        }

        const applySavedSelections = (): 'resolved' | 'waiting' | 'continue' => {
            const savedSessionModel = getSessionModelSelection(currentSessionId);
            const savedAgentName = currentSessionId
                ? useSelectionStore.getState().getSessionAgentSelection(currentSessionId)
                : null;
            if (savedAgentName) {
                if (currentAgentName !== savedAgentName) {
                    setAgent(savedAgentName);
                }

                const savedModel = getAgentModelForSession(currentSessionId, savedAgentName);
                if (savedModel) {
                    const result = tryApplyModelSelection(savedModel.providerId, savedModel.modelId, savedAgentName);
                    if (result === 'applied') {
                        return 'resolved';
                    }
                    if (result === 'provider-missing') {
                        return 'waiting';
                    }
                }
            }

            if (savedSessionModel) {
                const result = tryApplyModelSelection(savedSessionModel.providerId, savedSessionModel.modelId, savedAgentName || currentAgentName || undefined);
                if (result === 'applied') {
                    return 'resolved';
                }
                if (result === 'provider-missing') {
                    return 'waiting';
                }
            }

            for (const agent of agents) {
                const selection = getAgentModelForSession(currentSessionId, agent.name);
                if (!selection) {
                    continue;
                }

                if (currentAgentName !== agent.name) {
                    setAgent(agent.name);
                }

                const existingSelection = useSelectionStore.getState().getSessionAgentSelection(currentSessionId) || stickySessionAgentRef.current;
                if (!existingSelection) {
                    saveSessionAgentSelection(currentSessionId, agent.name);
                }
                const result = tryApplyModelSelection(selection.providerId, selection.modelId, agent.name);
                if (result === 'applied') {
                    return 'resolved';
                }
                if (result === 'provider-missing') {
                    return 'waiting';
                }
            }

            return 'continue';
        };

        const applyFallbackAgent = () => {
            if (agents.length === 0) {
                return;
            }

            const existingSelection = currentSessionId
                ? (useSelectionStore.getState().getSessionAgentSelection(currentSessionId) || stickySessionAgentRef.current)
                : null;

            // If we already have a valid agent selected (often from server-injected mode switch),
            // don't override it with a fallback.
            const preferred =
                (currentSessionId
                    ? (useSelectionStore.getState().getSessionAgentSelection(currentSessionId) || stickySessionAgentRef.current)
                    : null) ||
                currentAgentName;
            if (preferred && agents.some((agent) => agent.name === preferred)) {
                if (currentAgentName !== preferred) {
                    setAgent(preferred);
                }
                return;
            }

            const fallbackAgent = agents.find(agent => agent.name === 'build') || primaryAgents[0] || agents[0];
            if (!fallbackAgent) {
                return;
            }

            if (!existingSelection) {
                saveSessionAgentSelection(currentSessionId, fallbackAgent.name);
            }

            if (currentAgentName !== fallbackAgent.name) {
                setAgent(fallbackAgent.name);
            }

            if (fallbackAgent.model?.providerID && fallbackAgent.model?.modelID) {
                tryApplyModelSelection(fallbackAgent.model.providerID, fallbackAgent.model.modelID, fallbackAgent.name);
            }
        };

        const savedOutcome = applySavedSelections();
        if (savedOutcome === 'resolved' || savedOutcome === 'waiting') {
            return;
        }

        if (!hasRenderableCurrentSessionSnapshot) {
            if (!sync.isLoading(currentSessionId)) {
                void sync.ensureSessionRenderable(currentSessionId);
            }
            return;
        }

        if (latestLoadedUserChoice) {
            return;
        }

        applyFallbackAgent();
    }, [
        selectionAdapter,
        currentSessionId,
        hasRenderableCurrentSessionSnapshot,
        latestLoadedUserChoice,
        agents,
        primaryAgents,
        currentAgentName,
        getSessionModelSelection,
        getAgentModelForSession,
        setAgent,
        tryApplyModelSelection,
        saveSessionAgentSelection,
        contextHydrated,
        providers,
        sync,
    ]);

    React.useEffect(() => {
        if (selectionAdapter) return;
        if (!contextHydrated) {
            return;
        }
        const abortController = new AbortController();

        const handleAgentSwitch = async () => {
            try {
                if (currentAgentName !== prevAgentNameRef.current) {
                    prevAgentNameRef.current = currentAgentName;

                    if (currentAgentName && currentSessionId) {
                        const shouldPreferAgentModel = explicitAgentSwitchRef.current === currentAgentName;
                        explicitAgentSwitchRef.current = null;

                        await new Promise<void>((resolve) => {
                            const timer = setTimeout(resolve, 50);
                            abortController.signal.addEventListener('abort', () => {
                                clearTimeout(timer);
                                resolve();
                            });
                        });

                        if (abortController.signal.aborted) {
                            return;
                        }

                        // Prefer session memory, then last user manual pick for this agent,
                        // then the agent's configured pin. OpenCode agent defaults must not
                        // clobber a model the user previously chose for this agent.
                        const persistedChoice = getAgentModelForSession(currentSessionId, currentAgentName);
                        if (persistedChoice) {
                            const result = tryApplyModelSelection(
                                persistedChoice.providerId,
                                persistedChoice.modelId,
                                currentAgentName,
                            );
                            if (result === 'applied' || result === 'provider-missing') {
                                return;
                            }
                        }

                        const rememberedChoice = useConfigStore.getState().getAgentModelSelection(currentAgentName);
                        if (rememberedChoice) {
                            const result = tryApplyModelSelection(
                                rememberedChoice.providerId,
                                rememberedChoice.modelId,
                                currentAgentName,
                            );
                            if (result === 'applied' || result === 'provider-missing') {
                                if (result === 'applied') {
                                    saveSessionModelSelection(
                                        currentSessionId,
                                        rememberedChoice.providerId,
                                        rememberedChoice.modelId,
                                    );
                                    saveAgentModelForSession(
                                        currentSessionId,
                                        currentAgentName,
                                        rememberedChoice.providerId,
                                        rememberedChoice.modelId,
                                    );
                                    if (rememberedChoice.variant !== undefined) {
                                        saveAgentModelVariantForSession(
                                            currentSessionId,
                                            currentAgentName,
                                            rememberedChoice.providerId,
                                            rememberedChoice.modelId,
                                            rememberedChoice.variant,
                                        );
                                        setCurrentVariant(rememberedChoice.variant);
                                    }
                                }
                                return;
                            }
                        }

                        const selectedAgent = shouldPreferAgentModel
                            ? agents.find((agent) => agent.name === currentAgentName)
                            : undefined;
                        if (selectedAgent?.model?.providerID && selectedAgent.model.modelID) {
                            const result = tryApplyModelSelection(
                                selectedAgent.model.providerID,
                                selectedAgent.model.modelID,
                                currentAgentName,
                            );
                            if (result === 'applied' || result === 'provider-missing') {
                                if (result === 'applied') {
                                    saveSessionModelSelection(
                                        currentSessionId,
                                        selectedAgent.model.providerID,
                                        selectedAgent.model.modelID,
                                    );
                                    saveAgentModelForSession(
                                        currentSessionId,
                                        currentAgentName,
                                        selectedAgent.model.providerID,
                                        selectedAgent.model.modelID,
                                    );
                                }
                                return;
                            }
                        }
                    }
                }
            } catch (error) {
                console.error('[ModelControls] Agent change error:', error);
            }
        };

        handleAgentSwitch();

        return () => {
            abortController.abort();
        };
    }, [
        selectionAdapter,
        agents,
        currentAgentName,
        currentSessionId,
        getAgentModelForSession,
        saveAgentModelForSession,
        saveAgentModelVariantForSession,
        saveSessionModelSelection,
        setCurrentVariant,
        tryApplyModelSelection,
        contextHydrated,
    ]);

    React.useEffect(() => {
        if (selectionAdapter) return;
        if (!contextHydrated || !currentAgentName) {
            manualVariantSelectionRef.current = false;
            setCurrentVariant(undefined);
            return;
        }

        if (!currentProviderId || !currentModelId) {
            manualVariantSelectionRef.current = false;
            setCurrentVariant(undefined);
            return;
        }

        if (availableVariants.length === 0) {
            manualVariantSelectionRef.current = false;
            setCurrentVariant(undefined);
            return;
        }

        if (currentVariant && !availableVariants.includes(currentVariant)) {
            setCurrentVariant(undefined);
            return;
        }

        // Draft state (no session yet): seed from settings default, but don't override
        // user selection while drafting.
        if (!currentSessionId) {
            if (!currentVariant && !manualVariantSelectionRef.current) {
                const desired = settingsDefaultVariant && availableVariants.includes(settingsDefaultVariant)
                    ? settingsDefaultVariant
                    : undefined;
                setCurrentVariant(desired);
            }
            return;
        }

        const savedVariant = getAgentModelVariantForSession(
            currentSessionId,
            currentAgentName,
            currentProviderId,
            currentModelId,
        );

        const resolvedSaved = savedVariant && availableVariants.includes(savedVariant)
            ? savedVariant
            : settingsDefaultVariant && availableVariants.includes(settingsDefaultVariant)
                ? settingsDefaultVariant
                : undefined;

        setCurrentVariant(resolvedSaved);
        manualVariantSelectionRef.current = false;
    }, [
        selectionAdapter,
        availableVariants,
        contextHydrated,
        currentSessionId,
        currentAgentName,
        currentProviderId,
        currentModelId,
        currentVariant,
        getAgentModelVariantForSession,
        setCurrentVariant,
        settingsDefaultVariant,
    ]);

    React.useEffect(() => {
        manualVariantSelectionRef.current = false;
    }, [currentProviderId, currentModelId]);

    const handleVariantSelect = React.useCallback((variant: string | undefined) => {
        if (selectionAdapter) {
            if (!currentProviderId || !currentModelId) {
                return;
            }
            void selectionAdapter.onChange({
                providerID: currentProviderId,
                modelID: currentModelId,
                agent: selectionAdapter.selection.agent,
                variant,
            }).catch(() => undefined);
            return;
        }
        if (currentProviderId && currentModelId) {
            commitVariantSelectionForModel(currentProviderId, currentModelId, variant);
            const agentName = resolveLiveAgentName();
            if (agentName) {
                useConfigStore.getState().saveAgentModelSelection(
                    agentName,
                    currentProviderId,
                    currentModelId,
                    variant,
                );
            }
        }
    }, [commitVariantSelectionForModel, currentModelId, currentProviderId, resolveLiveAgentName, selectionAdapter]);

    const handleAgentChange = React.useCallback((agentName: string, options?: { closeModelSelector?: boolean }) => {
        if (selectionAdapter) {
            const nextSelection = resolveAgentModelSelection(selectionAdapter.selection, agentName, agents, providers);
            const retainsModel = nextSelection.providerID === selectionAdapter.selection.providerID
                && nextSelection.modelID === selectionAdapter.selection.modelID;
            if (isCompact) closeMobilePanel();
            void selectionAdapter.onChange({
                ...nextSelection,
                variant: retainsModel ? selectionAdapter.selection.variant : undefined,
            }).then(() => {
                addRecentAgent(agentName);
                if (options?.closeModelSelector ?? true) setAgentMenuOpen(false);
            }).catch(() => undefined);
            return;
        }
        try {
            explicitAgentSwitchRef.current = agentName;
            setAgent(agentName);
            addRecentAgent(agentName);
            if (options?.closeModelSelector ?? true) {
                setAgentMenuOpen(false);
            }

            if (currentSessionId) {
                saveSessionAgentSelection(currentSessionId, agentName);
            }
            if (isCompact) {
                closeMobilePanel();
            }
        } catch (error) {
            console.error('[ModelControls] Handle agent change error:', error);
        }
    }, [
        addRecentAgent,
        agents,
        closeMobilePanel,
        currentSessionId,
        isCompact,
        providers,
        saveSessionAgentSelection,
        selectionAdapter,
        setAgent,
        setAgentMenuOpen,
    ]);

    const handleCycleAgentFromModelPicker = React.useCallback((direction: 1 | -1) => {
        const nextAgentName = getCycledPrimaryAgentName(agents, currentAgentName, direction);
        if (!nextAgentName) {
            return;
        }
        handleAgentChange(nextAgentName, { closeModelSelector: false });
    }, [agents, currentAgentName, handleAgentChange]);

    const getCycleAgentDirectionFromEvent = React.useCallback((event: KeyboardEvent | React.KeyboardEvent): 1 | -1 | null => {
        const cycleAgentBackwardShortcut = cycleAgentShortcut && !cycleAgentShortcut.includes('shift')
            ? normalizeCombo(`shift+${cycleAgentShortcut}`)
            : '';

        if (cycleAgentBackwardShortcut && eventMatchesShortcut(event, cycleAgentBackwardShortcut)) {
            return -1;
        }

        if (eventMatchesShortcut(event, cycleAgentShortcut)) {
            return 1;
        }

        return null;
    }, [cycleAgentShortcut]);

    const handleAgentCycleShortcut = React.useCallback((event: React.KeyboardEvent) => {
        const cycleAgentDirection = getCycleAgentDirectionFromEvent(event);
        if (!cycleAgentDirection) {
            return;
        }

        event.preventDefault();
        event.stopPropagation();
        handleCycleAgentFromModelPicker(cycleAgentDirection);
    }, [getCycleAgentDirectionFromEvent, handleCycleAgentFromModelPicker]);

    const persistAgentModelPreference = React.useCallback((
        agentName: string | undefined | null,
        providerId: string,
        modelId: string,
        variant?: string,
    ) => {
        if (!agentName || !providerId || !modelId) {
            return;
        }
        useConfigStore.getState().saveAgentModelSelection(agentName, providerId, modelId, variant);
    }, []);

    const handleProviderAndModelChange = (
        providerId: string,
        modelId: string,
        options?: { applyVariant?: boolean; variant?: string | undefined; agentName?: string | null },
    ) => {
        if (selectionAdapter) {
            if (isCompact) closeMobilePanel();
            void selectionAdapter.onChange({
                providerID: providerId,
                modelID: modelId,
                agent: options?.agentName ?? selectionAdapter.selection.agent,
                variant: options?.applyVariant ? options.variant : undefined,
            }).then(() => {
                addRecentModel(providerId, modelId);
                setAgentMenuOpen(false);
            }).catch(() => undefined);
            return;
        }
        try {
            const effectiveAgentName = options?.agentName ?? resolveLiveAgentName() ?? undefined;
            const result = options?.applyVariant
                ? applyModelSelectionWithVariant(providerId, modelId, options.variant, effectiveAgentName)
                : tryApplyModelSelection(providerId, modelId, effectiveAgentName);
            if (result !== 'applied') {
                if (result === 'provider-missing') {
                    console.error('[ModelControls] Provider not available for selection:', providerId);
                } else if (result === 'model-missing') {
                    console.error('[ModelControls] Model not available for selection:', { providerId, modelId });
                }
                return;
            }
            persistAgentModelPreference(
                effectiveAgentName,
                providerId,
                modelId,
                options?.applyVariant ? options.variant : useConfigStore.getState().currentVariant,
            );
            if (!options?.applyVariant) {
                // Add to recent models on successful selection.
                addRecentModel(providerId, modelId);
            }
            setAgentMenuOpen(false);
            if (isCompact) {
                closeMobilePanel();
            }
        } catch (error) {
            console.error('[ModelControls] Handle model change error:', error);
        }
    };

    const getModelDisplayName = (model: ProviderModel | undefined, fallbackModelId?: string) => {
        return getSharedModelDisplayName(model, fallbackModelId, { maxLength: 40 });
    };

    const getProviderDisplayName = () => {
        const provider = providers.find(p => p.id === currentProviderId);
        return provider?.name || currentProviderId;
    };

    const getCurrentModelDisplayName = () => {
        if (!currentModelId) return t('chat.modelControls.selectModel');
        const currentModel = models.find((m: ProviderModel) => m.id === currentModelId);
        return getModelDisplayName(currentModel, currentModelId) || t('chat.modelControls.selectModel');
    };

    const currentModelDisplayName = getCurrentModelDisplayName();
    const modelLabelRef = React.useRef<HTMLSpanElement>(null);
    const isModelLabelTruncated = useIsTextTruncated(modelLabelRef, [currentModelDisplayName, isCompact]);

    const getAgentDisplayName = () => {
        if (!uiAgentName) {
            const buildAgent = primaryAgents.find(agent => agent.name === 'build');
            const defaultAgent = buildAgent || primaryAgents[0];
            return defaultAgent ? capitalizeAgentName(defaultAgent.name) : 'Select Agent';
        }
        const agent = agents.find(a => a.name === uiAgentName);
        return agent ? capitalizeAgentName(agent.name) : capitalizeAgentName(uiAgentName);
    };

    const capitalizeAgentName = (name: string) => {
        return name.charAt(0).toUpperCase() + name.slice(1);
    };

    const handleLongPressStart = React.useCallback((type: 'model' | 'agent') => {
        if (longPressTimerRef.current) {
            clearTimeout(longPressTimerRef.current);
        }
        longPressTimerRef.current = setTimeout(() => {
            setMobileTooltipOpen(type);
        }, 500);
    }, []);

    const handleLongPressEnd = React.useCallback(() => {
        if (longPressTimerRef.current) {
            clearTimeout(longPressTimerRef.current);
        }
    }, []);

    React.useEffect(() => {
        return () => {
            if (longPressTimerRef.current) {
                clearTimeout(longPressTimerRef.current);
            }
        };
    }, []);

    const renderMobileModelTooltip = () => {
        if (!isCompact || mobileTooltipOpen !== 'model') return null;

        return (
            <MobileOverlayPanel
                open={true}
                onClose={closeMobileTooltip}
                title={currentMetadata?.name || getCurrentModelDisplayName()}
            >
                <div className="flex flex-col gap-1.5">
                    {}
                    <div className="rounded-xl border border-border/40 bg-sidebar/30 px-2 py-1.5">
                            <div className="typography-micro text-muted-foreground mb-0.5">{t('chat.modelControls.provider')}</div>
                        <div className="typography-meta text-foreground font-medium">{getProviderDisplayName()}</div>
                    </div>

                    {}
                    {currentCapabilityIcons.length > 0 && (
                        <div className="rounded-xl border border-border/40 bg-sidebar/30 px-2 py-1.5">
                            <div className="typography-micro text-muted-foreground mb-1">{t('chat.modelControls.capabilities')}</div>
                            <div className="flex flex-wrap gap-1.5">
                                {currentCapabilityIcons.map(({ key, icon, label }) => (
                                    <div key={key} className="flex items-center gap-1.5">
                                        <IconBadge key={`cap-${key}`} iconName={icon} label={label} />
                                        <span className="typography-meta text-foreground">{label}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {}
                    {(inputModalityIcons.length > 0 || outputModalityIcons.length > 0) && (
                        <div className="rounded-xl border border-border/40 bg-sidebar/30 px-2 py-1.5">
                            <div className="typography-micro text-muted-foreground mb-1">{t('chat.modelControls.modalities')}</div>
                            <div className="flex flex-col gap-1">
                                {inputModalityIcons.length > 0 && (
                                    <div className="flex items-center gap-2">
                                        <span className="typography-meta text-muted-foreground/80 w-12">{t('chat.modelControls.input')}</span>
                                        <div className="flex gap-1">
                                            {inputModalityIcons.map(({ key, icon, label }) => <IconBadge key={`input-${key}`} iconName={icon} label={`${label} input`} />)}
                                        </div>
                                    </div>
                                )}
                                {outputModalityIcons.length > 0 && (
                                    <div className="flex items-center gap-2">
                                        <span className="typography-meta text-muted-foreground/80 w-12">{t('chat.modelControls.output')}</span>
                                        <div className="flex gap-1">
                                            {outputModalityIcons.map(({ key, icon, label }) => <IconBadge key={`output-${key}`} iconName={icon} label={`${label} output`} />)}
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>
                    )}

                    {}
                    <div className="rounded-xl border border-border/40 bg-sidebar/30 px-2 py-1.5">
                        <div className="typography-micro text-muted-foreground mb-1">{t('chat.modelControls.limits')}</div>
                        <div className="flex flex-col gap-0.5">
                            <div className="flex items-center justify-between">
                                <span className="typography-meta text-muted-foreground/80">{t('chat.modelControls.context')}</span>
                                <span className="typography-meta font-medium text-foreground">{formatTokens(currentMetadata?.limit?.context)}</span>
                            </div>
                            <div className="flex items-center justify-between">
                                <span className="typography-meta text-muted-foreground/80">{t('chat.modelControls.output')}</span>
                                <span className="typography-meta font-medium text-foreground">{formatTokens(currentMetadata?.limit?.output)}</span>
                            </div>
                        </div>
                    </div>

                    {}
                    <div className="rounded-xl border border-border/40 bg-sidebar/30 px-2 py-1.5">
                        <div className="typography-micro text-muted-foreground mb-1">{t('chat.modelControls.metadata')}</div>
                        <div className="flex flex-col gap-0.5">
                            <div className="flex items-center justify-between">
                                <span className="typography-meta text-muted-foreground/80">{t('chat.modelControls.knowledge')}</span>
                                <span className="typography-meta font-medium text-foreground">{formatKnowledge(currentMetadata?.knowledge)}</span>
                            </div>
                            <div className="flex items-center justify-between">
                                <span className="typography-meta text-muted-foreground/80">{t('chat.modelControls.release')}</span>
                                <span className="typography-meta font-medium text-foreground">{formatDate(currentMetadata?.release_date)}</span>
                            </div>
                        </div>
                    </div>
                </div>
            </MobileOverlayPanel>
        );
    };

    const renderMobileAgentTooltip = () => {
        if (!isCompact || mobileTooltipOpen !== 'agent' || !currentAgent) return null;

        const hasCustomPrompt = Boolean(currentAgent.prompt && currentAgent.prompt.trim().length > 0);
        const hasModelConfig = currentAgent.model?.providerID && currentAgent.model?.modelID;
        const hasTemperatureOrTopP = currentAgent.temperature !== undefined || currentAgent.topP !== undefined;

        const summarizePermission = (permissionName: string): { mode: EditPermissionMode; label: string } => {
            const rules = asPermissionRuleset(currentAgent.permission) ?? [];
            const hasCustom = rules.some((rule) => rule.permission === permissionName && rule.pattern !== '*');
            const action = resolveWildcardPermissionAction(rules, permissionName) ?? 'ask';

            if (hasCustom) {
                return { mode: 'ask', label: t('chat.modelControls.permissionLabel.custom') };
            }

            if (action === 'allow') return { mode: 'allow', label: t('chat.modelControls.permissionLabel.allow') };
            if (action === 'deny') return { mode: 'deny', label: t('chat.modelControls.permissionLabel.deny') };
            return { mode: 'ask', label: t('chat.modelControls.permissionLabel.ask') };
        };

        const editPermissionSummary = summarizePermission('edit');
        const bashPermissionSummary = summarizePermission('bash');
        const webfetchPermissionSummary = summarizePermission('webfetch');

        return (
            <MobileOverlayPanel
                open={true}
                onClose={closeMobileTooltip}
                title={capitalizeAgentName(currentAgent.name)}
            >
                <div className="flex flex-col gap-1.5">
                    {}
                    {currentAgent.description && (
                        <div className="rounded-xl border border-border/40 bg-sidebar/30 px-2 py-1.5">
                            <div className="typography-meta text-foreground">{currentAgent.description}</div>
                        </div>
                    )}

                    {}
                    <div className="rounded-xl border border-border/40 bg-sidebar/30 px-2 py-1.5">
                        <div className="typography-micro text-muted-foreground mb-0.5">{t('chat.modelControls.mode')}</div>
                        <div className="typography-meta text-foreground font-medium">
                            {currentAgent.mode === 'primary'
                                ? t('chat.modelControls.modeValue.primary')
                                : currentAgent.mode === 'subagent'
                                    ? t('chat.modelControls.modeValue.subagent')
                                    : currentAgent.mode === 'all'
                                        ? t('chat.modelControls.modeValue.all')
                                        : t('chat.modelControls.modeValue.none')}
                        </div>
                    </div>

                    {}
                    {(hasModelConfig || hasTemperatureOrTopP) && (
                        <div className="rounded-xl border border-border/40 bg-sidebar/30 px-2 py-1.5">
                            <div className="typography-micro text-muted-foreground mb-1">{t('chat.modelControls.model')}</div>
                            {hasModelConfig && (
                                <div className="typography-meta text-foreground font-medium mb-1">
                                    {currentAgent.model!.providerID} / {currentAgent.model!.modelID}
                                </div>
                            )}
                            {hasTemperatureOrTopP && (
                                <div className="flex flex-col gap-0.5">
                                    {currentAgent.temperature !== undefined && (
                                        <div className="flex items-center justify-between">
                                            <span className="typography-meta text-muted-foreground/80">{t('chat.modelControls.temperature')}</span>
                                            <span className="typography-meta font-medium text-foreground">{currentAgent.temperature}</span>
                                        </div>
                                    )}
                                    {currentAgent.topP !== undefined && (
                                        <div className="flex items-center justify-between">
                                            <span className="typography-meta text-muted-foreground/80">{t('chat.modelControls.topP')}</span>
                                            <span className="typography-meta font-medium text-foreground">{currentAgent.topP}</span>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    )}

                    {}
                    <div className="rounded-xl border border-border/40 bg-sidebar/30 px-2 py-1.5">
                        <div className="typography-micro text-muted-foreground mb-1">{t('chat.modelControls.permissions')}</div>
                        <div className="flex flex-col gap-1">
                            <div className="flex items-center justify-between">
                                <span className="typography-meta text-muted-foreground/80">{t('chat.modelControls.edit')}</span>
                                <div className="flex items-center gap-1.5">
                                    <EditModeIcon mode={editPermissionSummary.mode} className="size-3.5" />
                                    <span className="typography-meta font-medium text-foreground">
                                        {editPermissionSummary.label}
                                    </span>
                                </div>
                            </div>
                            <div className="flex items-center justify-between">
                                <span className="typography-meta text-muted-foreground/80">{t('chat.modelControls.bash')}</span>
                                <div className="flex items-center gap-1.5">
                                    <EditModeIcon mode={bashPermissionSummary.mode} className="size-3.5" />
                                    <span className="typography-meta font-medium text-foreground">
                                        {bashPermissionSummary.label}
                                    </span>
                                </div>
                            </div>
                            <div className="flex items-center justify-between">
                                <span className="typography-meta text-muted-foreground/80">{t('chat.modelControls.webFetch')}</span>
                                <div className="flex items-center gap-1.5">
                                    <EditModeIcon mode={webfetchPermissionSummary.mode} className="size-3.5" />
                                    <span className="typography-meta font-medium text-foreground">
                                        {webfetchPermissionSummary.label}
                                    </span>
                                </div>
                            </div>
                        </div>
                    </div>

                    {}
                    {hasCustomPrompt && (
                        <div className="rounded-xl border border-border/40 bg-sidebar/30 px-2 py-1.5">
                            <div className="flex items-center justify-between">
                                <span className="typography-meta text-muted-foreground/80">{t('chat.modelControls.customPrompt')}</span>
                                <Icon name="checkbox-circle" className="size-4 text-foreground" />
                            </div>
                        </div>
                    )}
                </div>
            </MobileOverlayPanel>
        );
    };

    const renderSharedMobileModelPanel = () => {
        if (!isCompact) return null;

        const handleSelect = (providerId: string, modelId: string, variant: string | undefined) => {
            if (selectionAdapter) {
                closeMobilePanel();
                void selectionAdapter.onChange({
                    providerID: providerId,
                    modelID: modelId,
                    agent: selectionAdapter.selection.agent,
                    variant,
                }).then(() => {
                    addRecentModel(providerId, modelId);
                    requestAnimationFrame(() => focusComposerTextarea(composerTextareaRef));
                }).catch(() => undefined);
                return;
            }
            const result = applyModelSelectionWithVariant(providerId, modelId, variant);
            if (result !== 'applied') {
                if (result === 'provider-missing') {
                    console.error('[ModelControls] Provider not available for selection:', providerId);
                } else if (result === 'model-missing') {
                    console.error('[ModelControls] Model not available for selection:', { providerId, modelId });
                }
                return;
            }

            persistAgentModelPreference(resolveLiveAgentName(), providerId, modelId, variant);
            closeMobilePanel();
            requestAnimationFrame(() => focusComposerTextarea(composerTextareaRef));
        };

        return (
            <MobileModelPickerPanel
                open={activeMobilePanel === 'model' || activeMobilePanel === 'variant'}
                view={activeMobilePanel === 'variant' ? 'variant' : 'model'}
                onViewChange={(view) => setActiveMobilePanel(view)}
                onClose={closeMobilePanel}
                selectedProviderID={currentProviderId || ''}
                selectedModelID={currentModelId || ''}
                resolveSelectedVariant={resolveModelVariantSelection}
                onSelect={handleSelect}
                providers={providers as ModelPickerProvider[]}
                favoriteModels={favoriteModelsList}
                recentModels={recentModelsList}
                modelsMetadata={modelsMetadata}
                hiddenModels={hiddenModels}
                providerOrder={providerOrder}
                isFavorite={isFavoriteModel}
                onToggleFavorite={toggleFavoriteModel}
                getMetadata={getModelMetadata}
            />
        );
    };

    const renderMobileAgentPanel = () => {
        if (!isCompact) return null;
 
        return (
            <MobileOverlayPanel
                open={activeMobilePanel === 'agent'}
                onClose={closeMobilePanel}
                title={t('chat.modelControls.selectAgent')}
                contentMaxHeightClassName="max-h-[min(52dvh,360px)]"
            >
                <div className="flex flex-col gap-2">
                    {selectableDesktopAgents.map((agent) => {
                        const isSelected = agent.name === uiAgentName;
                        const agentColor = getAgentColor(agent.name);
                        return (
                            <button
                                key={agent.name}
                                type="button"
                                className={cn(
                                    'flex w-full flex-col gap-1.5 rounded-xl border px-3 py-2.5 text-left',
                                    'focus:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                                    'touch-manipulation cursor-pointer transition-colors',
                                    'active:bg-interactive-hover',
                                    isSelected 
                                        ? 'border-primary/50 bg-interactive-selection/20' 
                                        : 'border-border/40 hover:bg-interactive-hover/50'
                                )}
                                onClick={() => handleAgentChange(agent.name)}
                            >
                                <div className="flex items-center gap-2">
                                    <AgentAvatar name={agent.name} size={18} />
                                    <span
                                        className="typography-ui-label font-semibold"
                                        style={isSelected ? { color: `var(${agentColor.var})` } : undefined}
                                    >
                                        {capitalizeAgentName(agent.name)}
                                    </span>
                                    {isSelected && (
                                        <Icon name="check" className="size-4 text-primary ml-auto flex-shrink-0" />
                                    )}
                                </div>
                                {agent.description && (
                                    <span className="typography-micro text-muted-foreground min-w-0 max-w-full pl-[1.625rem] break-words">
                                        {agent.description}
                                    </span>
                                )}
                            </button>
                        );
                    })}
                </div>
            </MobileOverlayPanel>
        );
    };

    const renderModelTooltipContent = () => (
        <TooltipContent align="start" sideOffset={8} className="max-w-[320px]">
            {currentMetadata ? (
                <div className="flex min-w-[240px] flex-col gap-3">
                    <div className="flex flex-col gap-0.5">
                        <span className="typography-micro font-semibold text-foreground">
                            {currentMetadata.name || getCurrentModelDisplayName()}
                        </span>
                        <span className="typography-meta text-muted-foreground">{getProviderDisplayName()}</span>
                    </div>
                    <div className="flex flex-col gap-1.5">
                        <span className="typography-meta font-semibold uppercase tracking-wide text-muted-foreground/90">{t('chat.modelControls.capabilities')}</span>
                        <div className="flex flex-wrap items-center gap-1.5">
                            {currentCapabilityIcons.length > 0 ? (
                                currentCapabilityIcons.map(({ key, icon, label }) =>
                                    <IconBadge key={`cap-${key}`} iconName={icon} label={label} />
                                )
                            ) : (
                                <span className="typography-meta text-muted-foreground">{t('chat.modelControls.modeValue.none')}</span>
                            )}
                        </div>
                    </div>
                    <div className="flex flex-col gap-1.5">
                        <span className="typography-meta font-semibold uppercase tracking-wide text-muted-foreground/90">{t('chat.modelControls.modalities')}</span>
                        <div className="flex flex-col gap-1">
                            <div className="flex items-center justify-between gap-3">
                                <span className="typography-meta font-medium text-muted-foreground/80">{t('chat.modelControls.input')}</span>
                                <div className="flex items-center gap-1.5">
                                    {inputModalityIcons.length > 0
                                        ? inputModalityIcons.map(({ key, icon, label }) =>
                                              <IconBadge key={`input-${key}`} iconName={icon} label={`${label} input`} />
                                          )
                                        : <span className="typography-meta text-muted-foreground">-</span>}
                                </div>
                            </div>
                            <div className="flex items-center justify-between gap-3">
                                <span className="typography-meta font-medium text-muted-foreground/80">{t('chat.modelControls.output')}</span>
                                <div className="flex items-center gap-1.5">
                                    {outputModalityIcons.length > 0
                                        ? outputModalityIcons.map(({ key, icon, label }) =>
                                              <IconBadge key={`output-${key}`} iconName={icon} label={`${label} output`} />
                                          )
                                        : <span className="typography-meta text-muted-foreground">-</span>}
                                </div>
                            </div>
                        </div>
                    </div>
                    <div className="flex flex-col gap-1.5">
                        <span className="typography-meta font-semibold uppercase tracking-wide text-muted-foreground/90">{t('chat.modelControls.costPerMillion')}</span>
                        {costRows.map((row) => (
                            <div key={row.label} className="flex items-center justify-between gap-3">
                                <span className="typography-meta font-medium text-muted-foreground/80">{row.label}</span>
                                <span className="typography-meta font-medium text-foreground">{row.value}</span>
                            </div>
                        ))}
                    </div>
                    <div className="flex flex-col gap-1.5">
                        <span className="typography-meta font-semibold uppercase tracking-wide text-muted-foreground/90">{t('chat.modelControls.limits')}</span>
                        {limitRows.map((row) => (
                            <div key={row.label} className="flex items-center justify-between gap-3">
                                <span className="typography-meta font-medium text-muted-foreground/80">{row.label}</span>
                                <span className="typography-meta font-medium text-foreground">{row.value}</span>
                            </div>
                        ))}
                    </div>
                    <div className="flex flex-col gap-1.5">
                        <span className="typography-meta font-semibold uppercase tracking-wide text-muted-foreground/90">{t('chat.modelControls.metadata')}</span>
                        <div className="flex items-center justify-between gap-3">
                            <span className="typography-meta font-medium text-muted-foreground/80">{t('chat.modelControls.knowledge')}</span>
                            <span className="typography-meta font-medium text-foreground">{formatKnowledge(currentMetadata.knowledge)}</span>
                        </div>
                        <div className="flex items-center justify-between gap-3">
                            <span className="typography-meta font-medium text-muted-foreground/80">{t('chat.modelControls.release')}</span>
                            <span className="typography-meta font-medium text-foreground">{formatDate(currentMetadata.release_date)}</span>
                        </div>
                    </div>
                </div>
            ) : (
                <div className="min-w-[200px] typography-meta text-muted-foreground">{t('chat.modelControls.metadataUnavailable')}</div>
            )}
        </TooltipContent>
    );

    const renderModelSelector = () => {
        const handleThinkingVariantKey = (e: React.KeyboardEvent, selectedItem: ModelPickerEntry) => {
            keyboardOwnsModelSelectionRef.current = true;
            if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return false;

            const { providerID, modelID } = selectedItem;
            const variantKeys = getModelVariantOptions(providerID, modelID);
            if (variantKeys.length === 0) return false;

            e.preventDefault();
            e.stopPropagation();

            const mapKey = buildModelRefKey(providerID, modelID);
            const hasPendingVariant = pendingThinkingVariants.has(mapKey);
            const currentPending = pendingThinkingVariants.get(mapKey);
            const activeModelVariant = hasPendingVariant ? currentPending : (currentProviderId === providerID && currentModelId === modelID ? currentVariant : undefined);

            const variantsWithDefault: Array<string | undefined> = [undefined, ...variantKeys];
            const currentVariantIndex = variantsWithDefault.indexOf(activeModelVariant);
            const safeCurrentIndex = currentVariantIndex >= 0 ? currentVariantIndex : 0;
            const direction = e.key === 'ArrowRight' ? 1 : -1;
            const nextVariantIndex = (safeCurrentIndex + direction + variantsWithDefault.length) % variantsWithDefault.length;
            const nextVariant = variantsWithDefault[nextVariantIndex];

            setPendingThinkingVariants((prev) => {
                const next = new Map(prev);
                next.set(mapKey, nextVariant);
                return next;
            });
            setAdjustedThinkingModels((prev) => {
                const next = new Set(prev);
                next.add(mapKey);
                return next;
            });
            setModelPickerRenderVersion((version) => version + 1);
            return true;
        };

        const handleModelPickerKeyDown = (e: React.KeyboardEvent, selectedItem: ModelPickerEntry | undefined) => {
            const cycleAgentDirection = getCycleAgentDirectionFromEvent(e);
            if (cycleAgentDirection) {
                e.preventDefault();
                handleCycleAgentFromModelPicker(cycleAgentDirection);
                return;
            }

            if (selectedItem) handleThinkingVariantKey(e, selectedItem);
        };

        const handleSharedModelSelect = (entry: ModelPickerEntry) => {
            const mapKey = buildModelRefKey(entry.providerID, entry.modelID);
            const pendingVariant = pendingThinkingVariants.get(mapKey);
            const wasAdjusted = adjustedThinkingModels.has(mapKey);
            const effectiveAgentName = resolveLiveAgentName();

            handleProviderAndModelChange(entry.providerID, entry.modelID, wasAdjusted
                ? { applyVariant: true, variant: pendingVariant, agentName: effectiveAgentName }
                : { agentName: effectiveAgentName });
        };

        const handleModelShortcutKeyDownCapture = (e: React.KeyboardEvent) => {
            const cycleAgentDirection = getCycleAgentDirectionFromEvent(e);
            if (!cycleAgentDirection) {
                return;
            }

            e.preventDefault();
            e.stopPropagation();
            keyboardOwnsModelSelectionRef.current = true;
            handleCycleAgentFromModelPicker(cycleAgentDirection);
        };

        const handleModelMenuOpenChange = (nextOpen: boolean) => {
            setModelTooltipOpen(false);
            if (!nextOpen) {
                suppressModelTooltipUntilRef.current = performance.now() + 200;
            }
            setAgentMenuOpen(nextOpen);
        };

        const handleModelTooltipOpenChange = (nextOpen: boolean) => {
            if (nextOpen && (agentMenuOpen || performance.now() < suppressModelTooltipUntilRef.current)) {
                return;
            }
            setModelTooltipOpen(nextOpen);
        };

        const modelPickerLabels = {
            searchPlaceholder: t('chat.modelControls.searchModels'),
            noResults: t('chat.modelControls.noModelsFound'),
            favorites: t('chat.modelControls.favorites'),
            recent: t('chat.modelControls.recent'),
            keyboardHint: t('chat.modelControls.keyboardHintNavigate'),
            favorite: t('chat.modelControls.favoriteAria'),
            unfavorite: t('chat.modelControls.unfavoriteAria'),
            capabilities: t('chat.modelControls.capabilities'),
            capabilityToolCalling: t('chat.modelControls.capability.toolCalling'),
            capabilityReasoning: t('chat.modelControls.capability.reasoning'),
            input: t('chat.modelControls.input'),
            output: t('chat.modelControls.output'),
            costPerMillion: t('chat.modelControls.costPerMillion'),
        };

        const renderThinkingSlot = (entry: ModelPickerEntry, { isHighlighted, isSelected }: { isHighlighted: boolean; isSelected: boolean }) => {
            const hasThinkingVariants = getModelVariantOptions(entry.providerID, entry.modelID).length > 0;
            const mapKey = buildModelRefKey(entry.providerID, entry.modelID);
            const wasAdjusted = adjustedThinkingModels.has(mapKey);
            if (!hasThinkingVariants || (!isHighlighted && !isSelected)) return null;

            const hasPendingVariant = pendingThinkingVariants.has(mapKey);
            const pendingVariant = pendingThinkingVariants.get(mapKey);
            const effectiveVariant = hasPendingVariant ? pendingVariant : (isSelected ? currentVariant : undefined);
            const displayLabel = effectiveVariant
                ? effectiveVariant.charAt(0).toUpperCase() + effectiveVariant.slice(1)
                : 'Default';

            return (
                <span className={cn('typography-micro whitespace-nowrap', wasAdjusted ? 'text-foreground' : 'text-muted-foreground')}>
                    Thinking: {displayLabel}
                </span>
            );
        };

        return (
            <Tooltip open={agentMenuOpen ? false : modelTooltipOpen} onOpenChange={handleModelTooltipOpenChange} delayDuration={600}>
                {!isCompact ? (
                    <DropdownMenu
                        open={isModelControlReady && agentMenuOpen}
                        onOpenChange={isModelControlReady ? handleModelMenuOpenChange : undefined}
                        onOpenChangeComplete={(open) => {
                            if (!open) handleSelectorCloseComplete('model');
                        }}
                    >
                        <TooltipTrigger asChild>
                            <DropdownMenuTrigger asChild>
                                <div
                                    className={cn(
                                        'model-controls__model-trigger cursor-pointer min-w-0',
                                        COMPOSER_TRIGGER_CHROME_CLASS,
                                    )}
                                >
                                    {!isModelControlReady ? (
                                        <>
                                            <Icon name="loader-4" className={cn(controlIconSize, 'animate-spin text-muted-foreground flex-shrink-0')} />
                                            <span className={cn(
                                                'model-controls__model-label',
                                                controlTextSize,
                                                'font-medium whitespace-nowrap text-muted-foreground min-w-0'
                                            )}>
                                                {readinessLabel}
                                            </span>
                                        </>
                                    ) : currentProviderId ? (
                                        <>
                                            <ModelLogo
                                                modelId={currentModelId}
                                                providerId={currentProviderId}
                                                className={cn(controlIconSize, 'flex-shrink-0')}
                                            />
                                            <Icon name="pencil-ai" className={cn(controlIconSize, 'text-primary/60 hidden')} />
                                        </>
                                    ) : (
                                        <Icon name="pencil-ai" className={cn(controlIconSize, 'text-muted-foreground')} />
                                    )}
                                    {isModelControlReady && (
                                        <span
                                            ref={modelLabelRef}
                                            key={`${currentProviderId}-${currentModelId}`}
                                            className={cn(
                                                'model-controls__model-label overflow-hidden',
                                                controlTextSize,
                                                'font-medium whitespace-nowrap text-foreground min-w-0',
                                                'max-w-[260px]'
                                            )}
                                        >
                                            <span className={cn('marquee-text', isModelLabelTruncated && 'marquee-text--active')}>
                                                {currentModelDisplayName}
                                            </span>
                                        </span>
                                    )}
                                </div>
                            </DropdownMenuTrigger>
                        </TooltipTrigger>
                        <DropdownMenuContent
                            className={cn(
                                'w-[min(380px,calc(100vw-2rem))] p-0 flex flex-col',
                                isModelSelectorInstant && INSTANT_DROPDOWN_CLASS,
                            )}
                            align="end"
                            alignOffset={-40}
                            onKeyDownCapture={handleModelShortcutKeyDownCapture}
                            finalFocus={resolveComposerFinalFocus}
                        >
                            <div className="p-1 border-b border-border/40">
                                <button
                                    type="button"
                                    onClick={openAddProviderSettings}
                                    className="typography-meta group flex w-full items-center gap-1 rounded-md px-2 py-1.5 cursor-pointer hover:bg-interactive-hover/50"
                                >
                                    <span className="flex size-4 items-center justify-center text-muted-foreground">
                                        <Icon name="add" className="size-4 -mr-0.5" />
                                    </span>
                                    <span className="font-medium text-foreground">{t('chat.modelControls.addNewProvider')}</span>
                                </button>
                            </div>
                            <ModelPickerList
                                providers={providers as ModelPickerProvider[]}
                                favoriteModels={favoriteModelsList}
                                recentModels={recentModelsList}
                                modelsMetadata={useConfigStore.getState().modelsMetadata}
                                searchQuery={desktopModelQuery}
                                onSearchQueryChange={setDesktopModelQuery}
                                onSelect={handleSharedModelSelect}
                                labels={modelPickerLabels}
                                selectedModel={currentProviderId && currentModelId ? { providerID: currentProviderId, modelID: currentModelId } : null}
                                hiddenModels={hiddenModels}
                                onActiveKeyDown={handleModelPickerKeyDown}
                                onActiveEntryChange={(entry) => { activeModelPickerEntryRef.current = entry; }}
                                onVariantKey={handleThinkingVariantKey}
                                isFavorite={(entry) => isFavoriteModel(entry.providerID, entry.modelID)}
                                onToggleFavorite={(entry) => toggleFavoriteModel(entry.providerID, entry.modelID)}
                                renderRowEnd={renderThinkingSlot}
                                renderVersion={modelPickerRenderVersion}
                                onReorderFavorite={(active, over) => reorderFavoriteModel(
                                    active.providerID,
                                    active.modelID,
                                    over.providerID,
                                    over.modelID,
                                )}
                                reorderFavoriteAriaLabel={t('chat.modelControls.reorderFavoriteAria')}
                                reorderFavoriteTitle={t('chat.modelControls.reorderFavoriteTitle')}
                                providerOrder={providerOrder}
                                onReorderProvider={setProviderOrder}
                                reorderProviderTitle={t('chat.modelControls.reorderProviderTitle')}
                                footerContent={(activeEntry) => {
                                    const activeHasThinkingVariants = activeEntry
                                        ? getModelVariantOptions(activeEntry.providerID, activeEntry.modelID).length > 0
                                        : false;

                                    return (
                                        <div className="flex items-center gap-x-2 whitespace-nowrap overflow-hidden">
                                            <span>{t('chat.modelControls.keyboardHintNavigate')}</span>
                                            <span>{t('chat.modelControls.keyboardHintSwitchAgent', { shortcut: 'Tab' })}</span>
                                            {activeHasThinkingVariants ? <span>{t('chat.modelControls.keyboardHintThinking')}</span> : null}
                                        </div>
                                    );
                                }}
                                tooltipsEnabled={agentMenuOpen}
                                onEscape={() => setAgentMenuOpen(false)}
                            />
                        </DropdownMenuContent>
                    </DropdownMenu>
                ) : (
                    <button
                        type="button"
                        onClick={isModelControlReady ? () => setActiveMobilePanel('model') : undefined}
                        onTouchStart={isModelControlReady ? () => handleLongPressStart('model') : undefined}
                        onTouchEnd={isModelControlReady ? handleLongPressEnd : undefined}
                        onTouchCancel={isModelControlReady ? handleLongPressEnd : undefined}
                        disabled={!isModelControlReady}
                        className={cn(
                            'model-controls__model-trigger min-w-0 focus:outline-none',
                            isModelControlReady ? cn('cursor-pointer', COMPOSER_TRIGGER_CHROME_CLASS) : 'opacity-60 cursor-not-allowed',
                        )}
                    >
                        {!isModelControlReady ? (
                            <>
                                <Icon name="loader-4" className={cn(controlIconSize, 'animate-spin text-muted-foreground flex-shrink-0')} />
                                <span className="typography-micro font-medium text-muted-foreground min-w-0">
                                    {readinessLabel}
                                </span>
                            </>
                        ) : (
                            <>
                                {currentProviderId || currentModelId ? (
                                    <ModelLogo
                                        modelId={currentModelId}
                                        providerId={currentProviderId}
                                        className={cn(controlIconSize, 'flex-shrink-0')}
                                    />
                                ) : (
                                    <Icon name="pencil-ai" className={cn(controlIconSize, 'text-muted-foreground')} />
                                )}
                                <span
                                    ref={modelLabelRef}
                                    className={cn(
                                        'model-controls__model-label typography-micro font-medium overflow-hidden min-w-0',
                                        isMobile ? 'max-w-[120px]' : 'max-w-[220px]',
                                    )}
                                >
                                    <span className={cn('marquee-text', isModelLabelTruncated && 'marquee-text--active')}>
                                        {currentModelDisplayName}
                                    </span>
                                </span>
                            </>
                        )}
                    </button>
                )}
                {renderModelTooltipContent()}
            </Tooltip>
        );
    };

    const renderAgentTooltipContent = () => {
        if (!currentAgent) {
            return (
                <TooltipContent align="start" sideOffset={8} className="max-w-[320px]">
                    <div className="min-w-[200px] typography-meta text-muted-foreground">{t('chat.modelControls.noAgentSelected')}</div>
                </TooltipContent>
            );
        }

        const hasCustomPrompt = Boolean(currentAgent.prompt && currentAgent.prompt.trim().length > 0);
        const hasModelConfig = currentAgent.model?.providerID && currentAgent.model?.modelID;
        const hasTemperatureOrTopP = currentAgent.temperature !== undefined || currentAgent.topP !== undefined;

        const summarizePermission = (permissionName: string): { mode: EditPermissionMode; label: string } => {
            const rules = asPermissionRuleset(currentAgent.permission) ?? [];
            const hasCustom = rules.some((rule) => rule.permission === permissionName && rule.pattern !== '*');
            const action = resolveWildcardPermissionAction(rules, permissionName) ?? 'ask';

            if (hasCustom) {
                                return { mode: 'ask', label: t('chat.modelControls.permissionLabel.custom') };
                            }

            if (action === 'allow') return { mode: 'allow', label: t('chat.modelControls.permissionLabel.allow') };
            if (action === 'deny') return { mode: 'deny', label: t('chat.modelControls.permissionLabel.deny') };
            return { mode: 'ask', label: t('chat.modelControls.permissionLabel.ask') };
        };

        const editPermissionSummary = summarizePermission('edit');
        const bashPermissionSummary = summarizePermission('bash');
        const webfetchPermissionSummary = summarizePermission('webfetch');

        return (
            <TooltipContent align="start" sideOffset={8} className="max-w-[280px]">
                <div className="flex min-w-[200px] flex-col gap-2.5">
                    <div className="flex flex-col gap-0.5">
                        <span className="typography-micro font-semibold text-foreground">
                            {capitalizeAgentName(currentAgent.name)}
                        </span>
                        {currentAgent.description && (
                            <span className="typography-meta text-muted-foreground">{currentAgent.description}</span>
                        )}
                    </div>

                    <div className="flex flex-col gap-1">
                        <span className="typography-meta font-semibold uppercase tracking-wide text-muted-foreground/90">{t('chat.modelControls.mode')}</span>
                        <span className="typography-meta text-foreground">
                            {currentAgent.mode === 'primary'
                                ? t('chat.modelControls.modeValue.primary')
                                : currentAgent.mode === 'subagent'
                                    ? t('chat.modelControls.modeValue.subagent')
                                    : currentAgent.mode === 'all'
                                        ? t('chat.modelControls.modeValue.all')
                                        : t('chat.modelControls.modeValue.none')}
                        </span>
                    </div>

                    {(hasModelConfig || hasTemperatureOrTopP) && (
                        <div className="flex flex-col gap-1">
                            <span className="typography-meta font-semibold uppercase tracking-wide text-muted-foreground/90">{t('chat.modelControls.model')}</span>
                            {hasModelConfig ? (
                                <span className="typography-meta text-foreground">
                                    {currentAgent.model!.providerID} / {currentAgent.model!.modelID}
                                </span>
                            ) : (
                                <span className="typography-meta text-muted-foreground">{t('chat.modelControls.modeValue.none')}</span>
                            )}
                            {hasTemperatureOrTopP && (
                                <div className="flex flex-col gap-0.5 mt-0.5">
                                    {currentAgent.temperature !== undefined && (
                                        <div className="flex items-center justify-between gap-3">
                                            <span className="typography-meta text-muted-foreground/80">{t('chat.modelControls.temperature')}</span>
                                            <span className="typography-meta font-medium text-foreground">{currentAgent.temperature}</span>
                                        </div>
                                    )}
                                    {currentAgent.topP !== undefined && (
                                        <div className="flex items-center justify-between gap-3">
                                            <span className="typography-meta text-muted-foreground/80">{t('chat.modelControls.topP')}</span>
                                            <span className="typography-meta font-medium text-foreground">{currentAgent.topP}</span>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    )}

                    <div className="flex flex-col gap-1">
                        <span className="typography-meta font-semibold uppercase tracking-wide text-muted-foreground/90">{t('chat.modelControls.permissions')}</span>
                        <div className="flex items-center gap-3">
                            <span className="typography-meta text-muted-foreground/80 w-16">{t('chat.modelControls.edit')}</span>
                            <div className="flex items-center gap-1.5">
                                <EditModeIcon mode={editPermissionSummary.mode} className="size-3.5" />
                                <span className="typography-meta font-medium text-foreground w-12">
                                    {editPermissionSummary.label}
                                </span>
                            </div>
                        </div>
                        <div className="flex items-center gap-3">
                            <span className="typography-meta text-muted-foreground/80 w-16">{t('chat.modelControls.bash')}</span>
                            <div className="flex items-center gap-1.5">
                                <EditModeIcon mode={bashPermissionSummary.mode} className="size-3.5" />
                                <span className="typography-meta font-medium text-foreground w-12">
                                    {bashPermissionSummary.label}
                                </span>
                            </div>
                        </div>
                        <div className="flex items-center gap-3">
                            <span className="typography-meta text-muted-foreground/80 w-16">{t('chat.modelControls.webFetch')}</span>
                            <div className="flex items-center gap-1.5">
                                <EditModeIcon mode={webfetchPermissionSummary.mode} className="size-3.5" />
                                <span className="typography-meta font-medium text-foreground w-12">
                                    {webfetchPermissionSummary.label}
                                </span>
                            </div>
                        </div>
                    </div>

                    {hasCustomPrompt && (
                        <div className="flex items-center justify-between gap-3">
                            <span className="typography-meta text-muted-foreground/80">{t('chat.modelControls.customPrompt')}</span>
                            <Icon name="checkbox-circle" className="size-4 text-foreground" />
                        </div>
                    )}
                </div>
            </TooltipContent>
        );
    };

    const renderVariantSelector = () => {
        if (!isModelControlReady || !hasVariants) {
            return null;
        }

        const displayVariant = currentVariant ?? t('chat.modelControls.default');
        const isDefault = !currentVariant;
        const colorClass = isDefault ? 'text-muted-foreground' : 'text-[color:var(--status-info)]';

        if (isCompact) {
            return (
                <button
                    type="button"
                    onClick={() => setActiveMobilePanel('variant')}
                    className={cn(
                        'model-controls__variant-trigger transition-opacity min-w-0 focus:outline-none',
                        'cursor-pointer',
                        COMPOSER_TRIGGER_CHROME_CLASS,
                    )}
                >
                    <Icon name="brain-ai-3" className={cn(controlIconSize, 'flex-shrink-0', colorClass)} />
                    <span className={cn(
                        'model-controls__variant-label',
                        controlTextSize,
                        'font-medium truncate min-w-0',
                        isMobile && 'max-w-[60px]',
                        colorClass
                    )}>
                        {displayVariant}
                    </span>
                </button>
            );
        }

        return (
            <Tooltip delayDuration={600}>
                <DropdownMenu>
                    <TooltipTrigger asChild>
                        <DropdownMenuTrigger asChild>
                            <div
                                className={cn(
                                    'model-controls__variant-trigger transition-colors cursor-pointer min-w-0',
                                    COMPOSER_TRIGGER_CHROME_CLASS,
                                )}
                            >
                                <Icon name="brain-ai-3" className={cn(controlIconSize, 'flex-shrink-0', colorClass)} />
                                <span
                                    className={cn(
                                        'model-controls__variant-label',
                                        controlTextSize,
                                        'font-medium min-w-0 truncate',
                                        isDesktop ? 'max-w-[180px]' : undefined,
                                        colorClass,
                                    )}
                                >
                                    {displayVariant}
                                </span>
                            </div>
                        </DropdownMenuTrigger>
                    </TooltipTrigger>
                    <DropdownMenuContent align="end" alignOffset={-40} className="w-[min(180px,calc(100vw-2rem))]">
                        <DropdownMenuLabel className="typography-ui-header font-semibold text-foreground">{t('chat.modelControls.thinking')}</DropdownMenuLabel>
                        <DropdownMenuItem className="typography-meta" onSelect={() => handleVariantSelect(undefined)}>
                            <div className="flex items-center justify-between gap-2 w-full min-w-0">
                                <span className="typography-meta font-medium text-foreground truncate min-w-0">{t('chat.modelControls.default')}</span>
                                {isDefault && <Icon name="check" className="size-4 text-primary flex-shrink-0" />}
                            </div>
                        </DropdownMenuItem>
                        {availableVariants.length > 0 && <DropdownMenuSeparator />}
                        {availableVariants.map((variant) => {
                            const selected = currentVariant === variant;
                            const label = variant.charAt(0).toUpperCase() + variant.slice(1);
                            return (
                                <DropdownMenuItem
                                    key={variant}
                                    className="typography-meta"
                                    onSelect={() => handleVariantSelect(variant)}
                                >
                                    <div className="flex items-center justify-between gap-2 w-full min-w-0">
                                        <span className="typography-meta font-medium text-foreground truncate min-w-0">{label}</span>
                                        {selected && <Icon name="check" className="size-4 text-primary flex-shrink-0" />}
                                    </div>
                                </DropdownMenuItem>
                            );
                        })}
                    </DropdownMenuContent>
                </DropdownMenu>
                <TooltipContent side="top">
                    <p className="typography-meta">Thinking: {displayVariant}</p>
                </TooltipContent>
            </Tooltip>
        );
    };

    const renderAgentSelector = () => {
        const agentDisplayName = getAgentDisplayName();
        const agentTriggerColor = uiAgentName ? getAgentColor(uiAgentName) : null;

        if (!isCompact) {
            return (
                <div className="flex items-center gap-2 min-w-0">
                    <Tooltip delayDuration={600}>
                        <DropdownMenu
                            open={isAgentControlReady && isAgentSelectorOpen}
                            onOpenChange={isAgentControlReady ? (open) => setAgentSelectorOpen(open) : undefined}
                            onOpenChangeComplete={(open) => {
                                if (!open) handleSelectorCloseComplete('agent');
                            }}
                        >
                            <TooltipTrigger asChild>
                                <DropdownMenuTrigger asChild>
                                    <div
                                        className={cn(
                                            // Stable chrome: width grows only from the label grid (no chip↔square swap).
                                            'inline-flex cursor-pointer items-center flex-shrink-0 min-w-0',
                                            COMPOSER_ICON_HOVER_CLASS,
                                        )}
                                    >
                                        {!isAgentControlReady ? (
                                            <span className={cn('inline-flex items-center justify-center', agentIconButtonClass)}>
                                                <Icon name="loader-4"
                                                    className={cn(
                                                        controlIconSize,
                                                        'flex-shrink-0 animate-spin text-muted-foreground'
                                                    )}
                                                />
                                            </span>
                                        ) : (
                                            <AgentCycleLabel
                                                name={uiAgentName}
                                                label={agentDisplayName}
                                                revealed={showAgentCycleLabel}
                                                avatarSize={agentAvatarSize}
                                                slotClassName={agentIconButtonClass}
                                                colorVar={agentTriggerColor?.var}
                                            />
                                        )}
                                    </div>
                                </DropdownMenuTrigger>
                            </TooltipTrigger>
                            <DropdownMenuContent
                                align={relocateAgent ? 'start' : 'end'}
                                alignOffset={relocateAgent ? 0 : -40}
                                className={cn(
                                    'w-[min(280px,calc(100vw-2rem))] p-0 flex flex-col',
                                    isAgentSelectorInstant && INSTANT_DROPDOWN_CLASS,
                                )}
                                onKeyDownCapture={handleAgentCycleShortcut}
                                finalFocus={resolveComposerFinalFocus}
                            >
                                <div className="p-1.5 pb-1">
                                    <div className="relative">
                                        <Icon name="search" className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
                                        <Input
                                            type="text"
                                            placeholder={t('chat.modelControls.searchAgents')}
                                            value={agentSearchQuery}
                                            onChange={(e) => setAgentSearchQuery(e.target.value)}
                                            onKeyDown={(e) => {
                                                if (e.key === 'Escape') {
                                                    e.preventDefault();
                                                    e.stopPropagation();
                                                    setAgentSelectorOpen(false);
                                                    return;
                                                }
                                                e.stopPropagation();
                                            }}
                                            className="pl-8 h-8 typography-meta"
                                        />
                                    </div>
                                </div>
                                <ScrollableOverlay outerClassName="max-h-[min(400px,calc(100dvh-12rem))] flex-1">
                                    <div className="p-1">
                                        {!agentSearchQuery.trim() && defaultAgentName && (
                                            <>
                                                <DropdownMenuItem
                                                    className="typography-meta"
                                                    onSelect={() => handleAgentChange(defaultAgentName)}
                                                >
                                                    <div className="flex items-center gap-1.5">
                                                        <Icon name="arrow-go-back" className="size-3.5 text-muted-foreground" />
                                                        <span className="font-medium">{t('chat.modelControls.resetToDefault')}</span>
                                                    </div>
                                                </DropdownMenuItem>
                                                <DropdownMenuSeparator />
                                            </>
                                        )}
                                        {sortedAndFilteredAgents.length === 0 ? (
                                            <div className="px-2 py-4 text-center typography-meta text-muted-foreground">
                                                No agents found
                                            </div>
                                        ) : (
                                            sortedAndFilteredAgents.map((agent) => (
                                                <DropdownMenuItem
                                                    key={agent.name}
                                                    className="typography-meta"
                                                    onSelect={() => handleAgentChange(agent.name)}
                                                >
                                                    <div className="flex w-full min-w-0 flex-col gap-0.5">
                                                        <div className="flex items-center gap-1.5">
                                                            <AgentAvatar name={agent.name} size={14} />
                                                            <span className="font-medium">{capitalizeAgentName(agent.name)}</span>
                                                        </div>
                                                        {agent.description && (
                                                            <span className="typography-micro text-muted-foreground min-w-0 max-w-full ml-5 break-words">
                                                                {agent.description}
                                                            </span>
                                                        )}
                                                    </div>
                                                </DropdownMenuItem>
                                            ))
                                        )}
                                    </div>
                                </ScrollableOverlay>
                                <div className="flex items-center gap-1.5 border-t border-border/40 px-2 py-1.5 typography-micro text-muted-foreground">
                                    <Kbd className="h-4 min-w-4 rounded-[3px] px-1 text-[10px] font-medium tracking-tight shadow-none">Tab</Kbd>
                                    <span>{t('chat.modelControls.keyboardHintSwitchAgentLabel')}</span>
                                </div>
                            </DropdownMenuContent>
                        </DropdownMenu>
                        {renderAgentTooltipContent()}
                    </Tooltip>
                </div>
            );
        }

        return (
            <button
                type="button"
                onClick={isAgentControlReady ? () => setActiveMobilePanel('agent') : undefined}
                onTouchStart={isAgentControlReady ? () => handleLongPressStart('agent') : undefined}
                onTouchEnd={isAgentControlReady ? handleLongPressEnd : undefined}
                onTouchCancel={isAgentControlReady ? handleLongPressEnd : undefined}
                disabled={!isAgentControlReady}
                className={cn(
                    'model-controls__agent-trigger inline-flex items-center flex-shrink-0 min-w-0 focus:outline-none',
                    COMPOSER_ICON_HOVER_CLASS,
                    isAgentControlReady ? 'cursor-pointer' : 'opacity-60 cursor-not-allowed',
                )}
            >
                {!isAgentControlReady ? (
                    <span className={cn('inline-flex items-center justify-center', agentIconButtonClass)}>
                        <Icon name="loader-4"
                            className={cn(
                                controlIconSize,
                                'flex-shrink-0 animate-spin text-muted-foreground'
                            )}
                        />
                    </span>
                ) : (
                    <AgentCycleLabel
                        name={uiAgentName}
                        label={agentDisplayName}
                        revealed={showAgentCycleLabel}
                        avatarSize={agentAvatarSize}
                        slotClassName={agentIconButtonClass}
                        colorVar={agentTriggerColor?.var}
                    />
                )}
            </button>
        );
    };

    const inlineClassName = cn(
        '@container/model-controls flex items-center min-w-0',
        // Only force full-width + truncation behaviors on true mobile layouts.
        // VS Code also uses "compact" mode, but should keep its right-aligned inline sizing.
        isMobile && 'w-full',
        className,
    );

    const relocateDesktopAgent = Boolean(relocateAgent && !isCompact);
    const shouldPortalAgent = Boolean(relocateDesktopAgent && agentPortalContainer);
    const agentSelector = renderAgentSelector();

    return (
        <>
            {shouldPortalAgent ? createPortal(agentSelector, agentPortalContainer!) : null}
            <div className={inlineClassName}>
                <div
                    className={cn(
                        'flex items-center min-w-0 flex-1 justify-end',
                        inlineGapClass,
                        isMobile && 'overflow-hidden'
                    )}
                >
                    {relocateDesktopAgent ? null : agentSelector}
                    {renderVariantSelector()}
                    {renderModelSelector()}
                </div>
            </div>

            {renderSharedMobileModelPanel()}
            {renderMobileAgentPanel()}
            {renderMobileModelTooltip()}
            {renderMobileAgentTooltip()}
        </>
    );

};
