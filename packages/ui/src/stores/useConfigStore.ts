import { create } from "zustand";
import type { StoreApi, UseBoundStore } from "zustand";
import { devtools, persist } from "zustand/middleware";
import type { Agent, Config } from "@opencode-ai/sdk/v2";
import { opencodeClient } from "@/lib/opencode/client";
import { scopeMatches, subscribeToConfigChanges } from "@/lib/configSync";
import type { ModelMetadata } from "@/types";
import { createDeferredSafeJSONStorage } from "./utils/safeStorage";
import { filterVisibleAgents } from "./useAgentsStore";
import { isPrimaryMode } from "@/components/chat/mobileControlsUtils";
import { useSessionUIStore } from "@/sync/session-ui-store";
import { useSelectionStore } from "@/sync/selection-store";
import { updateDesktopSettings } from "@/lib/persistence";
import { useDirectoryStore } from "@/stores/useDirectoryStore";
import { useProjectsStore } from "@/stores/useProjectsStore";
import { resolveProjectForSessionDirectory } from "@/lib/projectResolution";
import { streamDebugEnabled } from "@/stores/utils/streamDebug";
import { parseModelIdentifier } from "@/lib/modelIdentifier";
import { rememberResponseStyleSettings } from "@/lib/responseStyle";
import { markStartupTrace, measureStartupTrace } from "@/lib/startupTrace";
import { normalizePath } from "@/lib/pathNormalization";
import { getSyncConfig, subscribeToSyncConfigChanges } from "@/sync/sync-refs";
import { ensureProviderCatalogQuery, ensureRawAgentsQuery, invalidateProviderCatalogQuery, refreshProviderCatalogQuery, refreshRawAgentsQuery, seedProviderCatalogQuery } from "@/queries/configCatalogQueries";
import { getRuntimeGeneration, getRuntimeTransportIdentity } from "@/lib/runtime-switch";
import { parseProviderCatalog } from "@/lib/configCatalogParser";
import type { ConfigCatalogModel, ConfigCatalogProvider } from "@/types/configCatalog";
import { ensureSettingsBootstrapQuery, readSettingsBootstrapSnapshot } from "@/queries/settingsBootstrapQueries";

const FALLBACK_PROVIDER_ID = "opencode";
const FALLBACK_MODEL_ID = "big-pickle";
// Sentinel selectedProviderId used by the providers UI while the "Add provider"
// form is open. It is intentionally not a real provider id and must not be
// persisted as a stable provider selection.
const ADD_PROVIDER_SENTINEL = "__add_provider__";
const GIT_UTILITY_PROVIDER_ID = "zen";
const GIT_UTILITY_PREFERRED_MODEL_ID = "big-pickle";

interface OpenChamberDefaults {
    defaultModel?: string;
    defaultVariant?: string;
    defaultAgent?: string;
    autoCreateWorktree?: boolean;
    gitmojiEnabled?: boolean;
    defaultFileViewerPreview?: boolean;
    zenModel?: string;
    messageStreamTransport?: 'auto' | 'ws' | 'sse';
    sttProvider?: 'local' | 'openai-compatible';
    sttServerUrl?: string;
    sttModel?: string;
    sttLocalModel?: string;
    sttLanguage?: string;
}

const fetchOpenChamberDefaults = async (
    transport: string,
    fallback: OpenChamberDefaults,
): Promise<OpenChamberDefaults> => {
    markStartupTrace('config.defaults:start');
    const started = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const finish = (source: string, result: OpenChamberDefaults) => {
        const ended = typeof performance !== 'undefined' ? performance.now() : Date.now();
        markStartupTrace('config.defaults:end', {
            source,
            durationMs: Math.round(ended - started),
            hasDefaultModel: Boolean(result.defaultModel),
            hasDefaultAgent: Boolean(result.defaultAgent),
        });
        return result;
    };
    try {
        const data = await ensureSettingsBootstrapQuery(transport);
        rememberResponseStyleSettings({
            enabled: data?.responseStyleEnabled,
            preset: data?.responseStylePreset,
            customInstructions: data?.responseStyleCustomInstructions,
        }, transport);

        return finish('settings-bootstrap-query', data);
    } catch (error) {
        markStartupTrace('config.defaults:error', { error: error instanceof Error ? error.message : String(error) });
        const retained = readSettingsBootstrapSnapshot(transport);
        if (retained) {
            rememberResponseStyleSettings({
                enabled: retained.responseStyleEnabled,
                preset: retained.responseStylePreset,
                customInstructions: retained.responseStyleCustomInstructions,
            }, transport);
        }
        return finish(retained ? 'retained-settings-bootstrap' : 'retained-store-settings', retained ?? fallback);
    }
};

const parseModelString = (modelString: string): { providerId: string; modelId: string } | null => {
    return parseModelIdentifier(modelString);
};

type ProviderModel = ConfigCatalogModel;
type ProviderWithModelList = Omit<ConfigCatalogProvider, "models"> & { models: ProviderModel[] };

type GitModelSelection = { providerId: string; modelId: string };
type ProviderModelSelection = { providerId: string; modelId: string; variant?: string } | null;

const sanitizePersistedSelectedProviderId = (providerId: string | undefined): string => (
    providerId === ADD_PROVIDER_SENTINEL ? "" : (providerId ?? "")
);

const preserveAddProviderSelection = (currentSelectedProviderId: string | undefined, nextProviderId: string): string => (
    currentSelectedProviderId === ADD_PROVIDER_SENTINEL ? ADD_PROVIDER_SENTINEL : nextProviderId
);

const normalizeOptionalString = (value: unknown): string | undefined => {
    if (typeof value !== "string") {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
};

const sanitizeProviderList = (value: unknown): ProviderWithModelList[] => {
    if (!Array.isArray(value)) return [];
    const providers = value.map((provider) => {
        if (!isRecord(provider)) return provider;
        const models = Array.isArray(provider.models)
            ? Object.fromEntries(provider.models.map((model, index) => [String(index), model]))
            : provider.models;
        return { ...provider, models };
    });
    try {
        return parseProviderCatalog({ schemaVersion: 1, providers, default: {}, partial: false }).providers.map((provider) => ({
            id: provider.id,
            name: provider.name,
            models: Object.values(provider.models),
        }));
    } catch {
        return [];
    }
};

const sanitizeDefaultProviders = (value: unknown): Record<string, string> => {
    try {
        return parseProviderCatalog({ schemaVersion: 1, providers: [], default: value, partial: false }).default;
    } catch {
        return {};
    }
};

const hasProviderModel = (
    providers: ProviderWithModelList[],
    providerId: string,
    modelId: string
): boolean => {
    const provider = providers.find((item) => item.id === providerId);
    if (!provider) {
        return false;
    }
    return provider.models.some((model) => model.id === modelId);
};

const resolveProviderModelSelection = ({
    providers,
    currentProviderId,
    currentModelId,
    currentVariant,
    settingsDefaultModel,
    settingsDefaultVariant,
}: {
    providers: ProviderWithModelList[];
    currentProviderId?: string;
    currentModelId?: string;
    currentVariant?: string;
    settingsDefaultModel?: string;
    settingsDefaultVariant?: string;
}): ProviderModelSelection => {
    const resolveVariant = (providerId: string, modelId: string, variant?: string): string | undefined => {
        if (!variant) {
            return undefined;
        }

        const model = providers
            .find((provider) => provider.id === providerId)
            ?.models.find((entry) => entry.id === modelId) as { variants?: Record<string, unknown> } | undefined;

        return model?.variants && Object.prototype.hasOwnProperty.call(model.variants, variant)
            ? variant
            : undefined;
    };

    if (currentProviderId && currentModelId && hasProviderModel(providers, currentProviderId, currentModelId)) {
        return {
            providerId: currentProviderId,
            modelId: currentModelId,
            variant: resolveVariant(currentProviderId, currentModelId, currentVariant),
        };
    }

    if (settingsDefaultModel) {
        const parsed = parseModelString(settingsDefaultModel);
        if (parsed && hasProviderModel(providers, parsed.providerId, parsed.modelId)) {
            return {
                providerId: parsed.providerId,
                modelId: parsed.modelId,
                variant: resolveVariant(parsed.providerId, parsed.modelId, settingsDefaultVariant),
            };
        }
    }

    if (hasProviderModel(providers, FALLBACK_PROVIDER_ID, FALLBACK_MODEL_ID)) {
        return { providerId: FALLBACK_PROVIDER_ID, modelId: FALLBACK_MODEL_ID };
    }

    const firstProvider = providers[0];
    const firstModel = firstProvider?.models[0];
    if (firstProvider && firstModel) {
        return { providerId: firstProvider.id, modelId: firstModel.id };
    }

    return null;
};

type AgentModelSelection = {
    providerId: string;
    modelId: string;
    variant?: string;
};

/** Last explicit user pick as one unit (agent + model + variant). Not a per-agent map. */
type LastUserSelection = {
    agentName: string;
    providerId: string;
    modelId: string;
    variant?: string;
};

type DefaultAgentModelSelection = {
    agentName: string | undefined;
    providerId?: string;
    modelId?: string;
    variant?: string;
};

// Shared default-selection cascade used both at startup (loadAgents) and when opening a
// fresh draft (applyDefaultModelAgentSelection), so the two paths stay identical.
//
//   Unit pick (agent+model+variant together — shortest remembered path):
//     Project lastUserSelection → global lastUserSelection
//   Then fallback when neither layer has a valid remembered unit:
//     Agent: settings.defaultAgent → opencode default_agent → build → first primary → first
//     Model: project.defaultModel → settings.defaultModel
//            → resolved agent's pinned model+variant → opencode config.model
//            → opencode/big-pickle → first
//
// We only remember the user's last explicit pick as one unit per Project (plus one global
// fallback), not "which model agent B used last". Existing-session restore reads chat
// history / session memory and never updates lastUserSelection or globalLastUserSelection.
const resolveDefaultAgentModelSelection = ({
    agents,
    providers,
    projectDefaultModel,
    settingsDefaultAgent,
    settingsDefaultModel,
    settingsDefaultVariant,
    opencodeDefaultAgent,
    opencodeDefaultModel,
    projectLastUserSelection,
    globalLastUserSelection,
}: {
    agents: Agent[];
    providers: ProviderWithModelList[];
    projectDefaultModel?: string;
    settingsDefaultAgent?: string;
    settingsDefaultModel?: string;
    settingsDefaultVariant?: string;
    opencodeDefaultAgent?: string;
    opencodeDefaultModel?: string;
    projectLastUserSelection?: LastUserSelection;
    globalLastUserSelection?: LastUserSelection;
}): DefaultAgentModelSelection => {
    if (agents.length === 0) {
        return { agentName: undefined };
    }

    const resolveVariant = (providerId: string, modelId: string, variant?: string): string | undefined => {
        if (!variant) {
            return undefined;
        }
        const model = providers
            .find((provider) => provider.id === providerId)
            ?.models.find((entry) => entry.id === modelId) as { variants?: Record<string, unknown> } | undefined;
        return model?.variants && Object.prototype.hasOwnProperty.call(model.variants, variant)
            ? variant
            : undefined;
    };

    const tryUnitSelection = (selection?: LastUserSelection): DefaultAgentModelSelection | null => {
        if (!selection) {
            return null;
        }
        const candidate = agents.find((agent) => agent.name === selection.agentName);
        if (!candidate || !isPrimaryMode(candidate.mode) || candidate.hidden === true) {
            return null;
        }
        if (!hasProviderModel(providers, selection.providerId, selection.modelId)) {
            return null;
        }
        return {
            agentName: candidate.name,
            providerId: selection.providerId,
            modelId: selection.modelId,
            variant: resolveVariant(selection.providerId, selection.modelId, selection.variant),
        };
    };

    // Project last pick wins; missing/invalid project memory falls back to global last pick.
    const fromProject = tryUnitSelection(projectLastUserSelection);
    if (fromProject) {
        return fromProject;
    }
    const fromGlobal = tryUnitSelection(globalLastUserSelection);
    if (fromGlobal) {
        return fromGlobal;
    }

    // --- Agent cascade (no remembered unit pick) ---
    const primaryAgents = agents.filter((agent) => isPrimaryMode(agent.mode));

    let resolvedAgent: Agent | undefined;
    if (settingsDefaultAgent) {
        resolvedAgent = agents.find((agent) => agent.name === settingsDefaultAgent);
    }
    if (!resolvedAgent && opencodeDefaultAgent) {
        const candidate = agents.find((agent) => agent.name === opencodeDefaultAgent);
        // OpenCode requires the default agent to be a visible primary agent.
        if (candidate && isPrimaryMode(candidate.mode) && candidate.hidden !== true) {
            resolvedAgent = candidate;
        }
    }
    if (!resolvedAgent) {
        resolvedAgent = primaryAgents.find((agent) => agent.name === "build") || primaryAgents[0] || agents[0];
    }
    if (!resolvedAgent) {
        return { agentName: undefined };
    }

    // --- Model cascade ---
    let providerId: string | undefined;
    let modelId: string | undefined;
    let variant: string | undefined;

    const effectiveDefaultModel = projectDefaultModel || settingsDefaultModel;

    if (effectiveDefaultModel) {
        const parsed = parseModelString(effectiveDefaultModel);
        if (parsed && hasProviderModel(providers, parsed.providerId, parsed.modelId)) {
            providerId = parsed.providerId;
            modelId = parsed.modelId;
            variant = resolveVariant(providerId, modelId, projectDefaultModel ? undefined : settingsDefaultVariant);
        }
    }

    if (!providerId
        && resolvedAgent.model?.providerID
        && resolvedAgent.model?.modelID
        && hasProviderModel(providers, resolvedAgent.model.providerID, resolvedAgent.model.modelID)) {
        providerId = resolvedAgent.model.providerID;
        modelId = resolvedAgent.model.modelID;
        variant = resolveVariant(providerId, modelId, resolvedAgent.variant);
    }

    // OpenCode's global default model — used when neither our settings nor the agent pin a model.
    if (!providerId && opencodeDefaultModel) {
        const parsed = parseModelString(opencodeDefaultModel);
        if (parsed && hasProviderModel(providers, parsed.providerId, parsed.modelId)) {
            providerId = parsed.providerId;
            modelId = parsed.modelId;
        }
    }

    if (!providerId) {
        if (hasProviderModel(providers, FALLBACK_PROVIDER_ID, FALLBACK_MODEL_ID)) {
            providerId = FALLBACK_PROVIDER_ID;
            modelId = FALLBACK_MODEL_ID;
        } else {
            const firstProvider = providers[0];
            const firstModel = firstProvider?.models[0];
            if (firstProvider && firstModel) {
                providerId = firstProvider.id;
                modelId = firstModel.id;
            }
        }
    }

    return { agentName: resolvedAgent.name, providerId, modelId, variant };
};

const resolveGitGenerationModelSelection = ({
    providers,
    settingsZenModel,
}: {
    providers: ProviderWithModelList[];
    settingsZenModel?: string;
}): GitModelSelection | null => {
    const zenModel = normalizeOptionalString(settingsZenModel);

    if (!Array.isArray(providers) || providers.length === 0) {
        if (zenModel) {
            return { providerId: GIT_UTILITY_PROVIDER_ID, modelId: zenModel };
        }
        return null;
    }

    if (zenModel && hasProviderModel(providers, GIT_UTILITY_PROVIDER_ID, zenModel)) {
        return { providerId: GIT_UTILITY_PROVIDER_ID, modelId: zenModel };
    }

    if (hasProviderModel(providers, GIT_UTILITY_PROVIDER_ID, GIT_UTILITY_PREFERRED_MODEL_ID)) {
        return { providerId: GIT_UTILITY_PROVIDER_ID, modelId: GIT_UTILITY_PREFERRED_MODEL_ID };
    }

    const zenProvider = providers.find((provider) => provider.id === GIT_UTILITY_PROVIDER_ID);
    if (zenProvider?.models.length) {
        const randomIndex = Math.floor(Math.random() * zenProvider.models.length);
        const randomModelId = normalizeOptionalString(zenProvider.models[randomIndex]?.id);
        if (randomModelId) {
            return { providerId: GIT_UTILITY_PROVIDER_ID, modelId: randomModelId };
        }
    }

    return null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null;

const mapModalities = (cap: Record<string, boolean> | undefined): string[] => {
    if (!cap) return [];
    const result: string[] = [];
    if (cap.text) result.push('text');
    if (cap.audio) result.push('audio');
    if (cap.image) result.push('image');
    if (cap.video) result.push('video');
    if (cap.pdf) result.push('pdf');
    return result;
};

const deriveModelMetadata = (providerId: string, model: ProviderModel): ModelMetadata => ({
    id: model.id,
    providerId,
    name: model.name,
    tool_call: model.capabilities?.toolcall,
    reasoning: model.capabilities?.reasoning,
    temperature: model.capabilities?.temperature,
    attachment: model.capabilities?.attachment,
    modalities: model.capabilities ? {
        input: mapModalities(model.capabilities.input),
        output: mapModalities(model.capabilities.output),
    } : undefined,
    cost: model.cost ? {
        input: model.cost.input,
        output: model.cost.output,
        cache_read: model.cost.cache?.read,
        cache_write: model.cost.cache?.write,
    } : undefined,
    limit: model.limit,
    release_date: model.release_date,
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const CONNECTION_PROBE_TIMEOUT_MS = 800;

const probeOpenCodeHealth = async (timeoutMs = CONNECTION_PROBE_TIMEOUT_MS): Promise<boolean> => {
    return Promise.race([
        opencodeClient.checkHealth().catch(() => false),
        sleep(Math.max(1, timeoutMs)).then(() => false),
    ]);
};

const DIRECTORY_KEY_GLOBAL = "__global__";

const toDirectoryKey = (directory: string | null | undefined): string => {
    const trimmed = typeof directory === 'string' ? directory.trim() : '';
    return trimmed.length > 0 ? trimmed : DIRECTORY_KEY_GLOBAL;
};

const fromDirectoryKey = (key: string): string | null => (key === DIRECTORY_KEY_GLOBAL ? null : key);

const resolveInitialDirectoryKey = (): string => {
    if (typeof window === 'undefined') {
        return DIRECTORY_KEY_GLOBAL;
    }

    const directory = opencodeClient.getDirectory() ?? useDirectoryStore.getState().currentDirectory;
    return toConfigDirectoryKey(directory);
};

// Persisted worktree→project mapping. The runtime worktree map
// (availableWorktreesByProject) is populated by async git discovery and isn't
// ready when initializeApp runs on startup — so without this, a worktree's first
// config load can't resolve to its project and duplicates the project's load.
// We cache resolved mappings to localStorage so subsequent launches resolve the
// project synchronously at init time. worktree→project is effectively immutable,
// so a cached entry is safe to trust.
const WORKTREE_PROJECT_MAP_KEY = 'oc.worktreeProjectMap';
let _worktreeProjectMap: Record<string, string> | null = null;
const getWorktreeProjectMap = (): Record<string, string> => {
    if (_worktreeProjectMap === null) {
        try {
            const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(WORKTREE_PROJECT_MAP_KEY) : null;
            _worktreeProjectMap = raw ? (JSON.parse(raw) as Record<string, string>) : {};
        } catch {
            _worktreeProjectMap = {};
        }
    }
    return _worktreeProjectMap;
};
const rememberWorktreeProject = (worktree: string, project: string): void => {
    if (!worktree || !project || worktree === project) return;
    const map = getWorktreeProjectMap();
    if (map[worktree] === project) return;
    map[worktree] = project;
    try {
        localStorage.setItem(WORKTREE_PROJECT_MAP_KEY, JSON.stringify(map));
    } catch {
        // localStorage quota exceeded — ignore; live resolution still works.
    }
};

const normalizeConfigPath = (value: string | null | undefined): string | null => {
    const result = normalizePath(value);
    if (result === null) return null;
    return result || '/';
};

const getKnownProjectDirectories = (): string[] => {
    try {
        return useProjectsStore.getState().projects
            .map((project) => normalizeConfigPath(project.path))
            .filter((path): path is string => Boolean(path));
    } catch {
        return [];
    }
};

const getFallbackProjectDirectory = (): string | null => {
    try {
        const { projects, activeProjectId } = useProjectsStore.getState();
        const active = activeProjectId
            ? projects.find((project) => project.id === activeProjectId)
            : null;
        return normalizeConfigPath(active?.path ?? projects[0]?.path ?? null);
    } catch {
        return null;
    }
};

/**
 * Map a directory to its CONFIG scope. Providers/agents/defaults are defined at
 * the PROJECT level (opencode.json), so a worktree must inherit its parent
 * project's config instead of maintaining — and re-fetching — its own
 * per-worktree snapshot. Returns the owning project's path when the directory is
 * a known worktree, else the directory unchanged.
 */
const resolveConfigDirectory = (directory: string | null | undefined): string | null => {
    const dir = normalizeConfigPath(directory);
    const projects = getKnownProjectDirectories();
    if (!dir) return null;
    if (projects.includes(dir)) return dir;

    // 1. Persisted mapping — resolves synchronously when the async worktree
    //    discovery has not populated the runtime map yet.
    const cached = normalizeConfigPath(getWorktreeProjectMap()[dir]);
    if (cached) return cached;
    // 2. Live resolution via projects + discovered worktree map; cache the hit.
    try {
        const project = resolveProjectForSessionDirectory(
            useProjectsStore.getState().projects,
            useSessionUIStore.getState().availableWorktreesByProject,
            dir,
        );
        const projectPath = normalizeConfigPath(project?.path ?? null);
        if (projectPath && projectPath !== dir) {
            rememberWorktreeProject(dir, projectPath);
            return projectPath;
        }
    } catch {
        return null;
    }
    return null;
};

const toConfigDirectoryKey = (directory: string | null | undefined): string =>
    toDirectoryKey(resolveConfigDirectory(directory));

export const getConfigDirectoryKey = (directory: string | null | undefined): string => toConfigDirectoryKey(directory);

const PROJECT_CONFIG_PREWARM_DELAY_MS = 1_000;
const PERSISTED_CONFIG_CATALOG_BYTE_BUDGET = 1_250_000;
const PERSISTED_AGENT_MODEL_SELECTION_LIMIT = 100;
const PERSISTED_SELECTION_STRING_LIMIT = 256;
const PERSISTED_SELECTION_DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);
// eslint-disable-next-line no-control-regex
const PERSISTED_SELECTION_CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/u;
const persistedCatalogTextEncoder = new TextEncoder();

interface DirectoryScopedConfig {

    providers: ProviderWithModelList[];
    agents: Agent[];
    currentProviderId: string;
    currentModelId: string;
    currentVariant?: string | undefined;
    currentAgentName: string | undefined;
    selectedProviderId: string;
    /**
     * Legacy per-agent model map. Kept for hydrate migration only — new writes go to
     * lastUserSelection. Do not use for new-draft cascade.
     */
    agentModelSelections: { [agentName: string]: AgentModelSelection };
    /** Legacy agent-only inherit. Prefer lastUserSelection.agentName. */
    lastSelectedAgentName?: string;
    /** Last explicit user pick for this Project (agent+model+variant as one unit). */
    lastUserSelection?: LastUserSelection;
    defaultProviders: { [key: string]: string };
    providerCatalogPartial?: boolean;
    opencodeDefaultAgent?: string;
    opencodeDefaultModel?: string;
    selectionSource?: "auto" | "manual";
}

/**
 * Lift persisted selection for the active directory into the picker fields.
 * Provider catalog is global: prefer an already-hydrated top-level list, then
 * the active directory's startup snapshot (persist vehicle only).
 */
const hydrateActiveDirectorySnapshot = <T extends Partial<ConfigStore>>(merged: T): T => {
    const directoryScoped = merged.directoryScoped;
    const activeKey = merged.activeDirectoryKey;
    if (!directoryScoped || !activeKey) return merged;
    const snapshot = directoryScoped[activeKey];
    if (!snapshot) return merged;

    const next: Partial<ConfigStore> = { ...merged };
    const globalProviders = (merged.providers && merged.providers.length > 0)
        ? merged.providers
        : snapshot.providers;
    next.providers = globalProviders;
    next.agents = [];
    next.defaultProviders = (merged.defaultProviders && Object.keys(merged.defaultProviders).length > 0)
        ? merged.defaultProviders
        : snapshot.defaultProviders;
    next.currentProviderId = snapshot.currentProviderId;
    next.currentModelId = snapshot.currentModelId;
    next.currentVariant = snapshot.currentVariant;
    next.currentAgentName = snapshot.currentAgentName;
    next.selectedProviderId = snapshot.selectedProviderId;
    next.agentModelSelections = snapshot.agentModelSelections;
    next.lastSelectedAgentName = snapshot.lastSelectedAgentName;
    next.lastUserSelection = snapshot.lastUserSelection;
    next.opencodeDefaultAgent = snapshot.opencodeDefaultAgent;
    next.opencodeDefaultModel = snapshot.opencodeDefaultModel;
    next.selectionSource = snapshot.selectionSource ?? "auto";
    if (globalProviders.length > 0 && snapshot.providerCatalogPartial !== true) {
        seedProviderCatalogQuery(null, {
            providers: globalProviders,
            defaultProviders: next.defaultProviders ?? {},
            providerCatalogPartial: false,
        });
    }
    return next as T;
};

const sanitizeSelectionIdentifier = (value: unknown, requireTrimmed = false): string | undefined => {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    if (
        trimmed.length === 0
        || trimmed.length > PERSISTED_SELECTION_STRING_LIMIT
        || (requireTrimmed && trimmed !== value)
        || PERSISTED_SELECTION_CONTROL_CHARACTERS.test(trimmed)
        || PERSISTED_SELECTION_DANGEROUS_KEYS.has(trimmed)
    ) return undefined;
    return trimmed;
};

const sanitizeAgentModelSelections = (value: unknown): { [agentName: string]: AgentModelSelection } => {
    if (!isRecord(value)) return {};
    const entries: Array<[string, AgentModelSelection]> = [];
    for (const [agentName, rawSelection] of Object.entries(value)) {
        if (entries.length >= PERSISTED_AGENT_MODEL_SELECTION_LIMIT || !isRecord(rawSelection)) continue;
        const safeAgentName = sanitizeSelectionIdentifier(agentName, true);
        const providerId = sanitizeSelectionIdentifier(rawSelection.providerId);
        const modelId = sanitizeSelectionIdentifier(rawSelection.modelId);
        const variant = sanitizeSelectionIdentifier(rawSelection.variant);
        if (!safeAgentName || !providerId || !modelId || (rawSelection.variant !== undefined && !variant)) continue;
        entries.push([safeAgentName, { providerId, modelId, ...(variant ? { variant } : {}) }]);
    }
    return Object.fromEntries(entries);
};

const sanitizeLastUserSelection = (value: unknown): LastUserSelection | undefined => {
    if (!isRecord(value)) return undefined;
    const agentName = sanitizeSelectionIdentifier(value.agentName, true);
    const providerId = sanitizeSelectionIdentifier(value.providerId);
    const modelId = sanitizeSelectionIdentifier(value.modelId);
    const variant = sanitizeSelectionIdentifier(value.variant);
    if (!agentName || !providerId || !modelId || (value.variant !== undefined && !variant)) return undefined;
    return { agentName, providerId, modelId, ...(variant ? { variant } : {}) };
};

/** Build a unit pick from legacy lastSelectedAgentName + agentModelSelections[agent]. */
const deriveLastUserSelectionFromLegacy = (
    lastSelectedAgentName: string | undefined,
    agentModelSelections: { [agentName: string]: AgentModelSelection },
): LastUserSelection | undefined => {
    if (!lastSelectedAgentName) return undefined;
    const saved = agentModelSelections[lastSelectedAgentName];
    if (!saved) return undefined;
    return {
        agentName: lastSelectedAgentName,
        providerId: saved.providerId,
        modelId: saved.modelId,
        ...(saved.variant ? { variant: saved.variant } : {}),
    };
};

const resolvePersistedLastUserSelection = (
    rawLastUserSelection: unknown,
    lastSelectedAgentName: string | undefined,
    agentModelSelections: { [agentName: string]: AgentModelSelection },
): LastUserSelection | undefined => (
    sanitizeLastUserSelection(rawLastUserSelection)
    ?? deriveLastUserSelectionFromLegacy(lastSelectedAgentName, agentModelSelections)
);

const createEmptyDirectoryScopedConfig = (
    providers: ProviderWithModelList[] = [],
    agents: Agent[] = [],
): DirectoryScopedConfig => ({
    providers,
    agents,
    currentProviderId: "",
    currentModelId: "",
    currentVariant: undefined,
    currentAgentName: undefined,
    selectedProviderId: "",
    agentModelSelections: {},
    lastSelectedAgentName: undefined,
    lastUserSelection: undefined,
    defaultProviders: {},
    providerCatalogPartial: false,
    opencodeDefaultAgent: undefined,
    opencodeDefaultModel: undefined,
    selectionSource: "auto",
});

/** Keep Project/global last picks across transport switches; catalogs stay transport-scoped. */
const preserveDirectorySelectionMemory = (
    directoryScoped: Record<string, DirectoryScopedConfig>,
): Record<string, DirectoryScopedConfig> => {
    const preserved: Record<string, DirectoryScopedConfig> = {};
    for (const [directoryKey, snapshot] of Object.entries(directoryScoped)) {
        const lastUserSelection = snapshot.lastUserSelection
            ?? deriveLastUserSelectionFromLegacy(snapshot.lastSelectedAgentName, snapshot.agentModelSelections);
        if (!lastUserSelection && !snapshot.lastSelectedAgentName) continue;
        preserved[directoryKey] = {
            ...createEmptyDirectoryScopedConfig(),
            agentModelSelections: {},
            lastSelectedAgentName: lastUserSelection?.agentName ?? snapshot.lastSelectedAgentName,
            lastUserSelection,
            selectionSource: snapshot.selectionSource === "manual" ? "manual" : "auto",
        };
    }
    return preserved;
};

const sanitizePersistedCatalogState = (persistedState: unknown): Partial<ConfigStore> => {
    if (!isRecord(persistedState)) return {};
    const transportIdentity = normalizeOptionalString(persistedState.catalogTransportIdentity);
    const preferences: Partial<ConfigStore> = {};
    const optionalStrings = ['activeDirectoryKey', 'settingsDefaultModel', 'settingsDefaultVariant', 'settingsDefaultAgent', 'settingsZenModel'] as const;
    for (const key of optionalStrings) {
        const safeValue = normalizeOptionalString(persistedState[key]);
        if (safeValue !== undefined) preferences[key] = safeValue;
    }
    const booleans = ['settingsAutoCreateWorktree', 'settingsGitmojiEnabled', 'settingsDefaultFileViewerPreview'] as const;
    for (const key of booleans) if (typeof persistedState[key] === 'boolean') preferences[key] = persistedState[key];
    if (persistedState.settingsMessageStreamTransport === 'auto' || persistedState.settingsMessageStreamTransport === 'ws' || persistedState.settingsMessageStreamTransport === 'sse') {
        preferences.settingsMessageStreamTransport = persistedState.settingsMessageStreamTransport;
    }
    for (const key of ['speechRate', 'speechPitch', 'speechVolume'] as const) {
        if (typeof persistedState[key] === 'number' && Number.isFinite(persistedState[key])) preferences[key] = persistedState[key];
    }

    const directoryScoped: Record<string, DirectoryScopedConfig> = {};
    if (isRecord(persistedState.directoryScoped)) {
        for (const [directoryKey, rawSnapshot] of Object.entries(persistedState.directoryScoped)) {
            if (!isRecord(rawSnapshot)) continue;
            const providerCatalogPartial = rawSnapshot.providerCatalogPartial === true;
            const providers = providerCatalogPartial ? [] : sanitizeProviderList(rawSnapshot.providers);
            const defaultProviders = providerCatalogPartial ? {} : sanitizeDefaultProviders(rawSnapshot.defaultProviders);
            const agentModelSelections = sanitizeAgentModelSelections(rawSnapshot.agentModelSelections);
            const lastSelectedAgentName = sanitizeSelectionIdentifier(rawSnapshot.lastSelectedAgentName, true);
            const lastUserSelection = resolvePersistedLastUserSelection(
                rawSnapshot.lastUserSelection,
                lastSelectedAgentName,
                agentModelSelections,
            );
            directoryScoped[directoryKey] = {
                ...createEmptyDirectoryScopedConfig(),
                providers,
                agents: [],
                currentProviderId: normalizeOptionalString(rawSnapshot.currentProviderId) ?? '',
                currentModelId: normalizeOptionalString(rawSnapshot.currentModelId) ?? '',
                currentVariant: normalizeOptionalString(rawSnapshot.currentVariant),
                currentAgentName: normalizeOptionalString(rawSnapshot.currentAgentName),
                selectedProviderId: sanitizePersistedSelectedProviderId(normalizeOptionalString(rawSnapshot.selectedProviderId)),
                // Legacy map retained only so older clients/data can re-derive; new cascade ignores it.
                agentModelSelections,
                lastSelectedAgentName: lastUserSelection?.agentName ?? lastSelectedAgentName,
                lastUserSelection,
                defaultProviders,
                providerCatalogPartial,
                opencodeDefaultAgent: normalizeOptionalString(rawSnapshot.opencodeDefaultAgent),
                opencodeDefaultModel: normalizeOptionalString(rawSnapshot.opencodeDefaultModel),
                selectionSource: rawSnapshot.selectionSource === 'manual' ? 'manual' : 'auto',
            };
        }
    }

    const legacyTopLevelSelections = sanitizeAgentModelSelections(persistedState.agentModelSelections);
    const legacyTopLevelAgent = sanitizeSelectionIdentifier(persistedState.lastSelectedAgentName, true);
    const globalLastUserSelection = resolvePersistedLastUserSelection(
        persistedState.globalLastUserSelection,
        legacyTopLevelAgent,
        legacyTopLevelSelections,
    ) ?? (() => {
        // If global was never written, seed from the active Project snapshot (shortest prior path).
        const activeKey = normalizeOptionalString(persistedState.activeDirectoryKey);
        return activeKey ? directoryScoped[activeKey]?.lastUserSelection : undefined;
    })();

    const currentTransport = getRuntimeTransportIdentity();
    if (transportIdentity !== currentTransport) {
        // Transport fingerprint changed: drop catalogs, keep Project/global last picks so
        // refresh / reconnect does not erase the user's remembered agent+model unit.
        const preservedDirectoryScoped = preserveDirectorySelectionMemory(directoryScoped);
        const activeKey = normalizeOptionalString(persistedState.activeDirectoryKey);
        const activeSelection = activeKey ? preservedDirectoryScoped[activeKey]?.lastUserSelection : undefined;
        return {
            ...preferences,
            catalogTransportIdentity: currentTransport,
            directoryScoped: preservedDirectoryScoped,
            providers: [],
            agents: [],
            defaultProviders: {},
            currentProviderId: '',
            currentModelId: '',
            currentVariant: undefined,
            currentAgentName: undefined,
            selectedProviderId: '',
            agentModelSelections: {},
            lastSelectedAgentName: activeSelection?.agentName ?? globalLastUserSelection?.agentName,
            lastUserSelection: activeSelection,
            globalLastUserSelection,
            providerConfigLoadingByDirectory: {},
            agentConfigLoadingByDirectory: {},
        };
    }

    return {
        ...preferences,
        catalogTransportIdentity: transportIdentity,
        directoryScoped,
        providers: [],
        agents: [],
        defaultProviders: {},
        currentProviderId: normalizeOptionalString(persistedState.currentProviderId) ?? '',
        currentModelId: normalizeOptionalString(persistedState.currentModelId) ?? '',
        currentVariant: normalizeOptionalString(persistedState.currentVariant),
        currentAgentName: normalizeOptionalString(persistedState.currentAgentName),
        selectedProviderId: sanitizePersistedSelectedProviderId(normalizeOptionalString(persistedState.selectedProviderId)),
        agentModelSelections: legacyTopLevelSelections,
        lastSelectedAgentName: globalLastUserSelection?.agentName ?? legacyTopLevelAgent,
        lastUserSelection: (() => {
            const activeKey = normalizeOptionalString(persistedState.activeDirectoryKey);
            return activeKey ? directoryScoped[activeKey]?.lastUserSelection : undefined;
        })(),
        globalLastUserSelection,
    };
};

const hasValidVariant = (
    providers: ProviderWithModelList[],
    providerId: string,
    modelId: string,
    variant: string | undefined,
): boolean => {
    if (!variant) return true;
    const model = providers
        .find((provider) => provider.id === providerId)
        ?.models.find((entry) => entry.id === modelId) as { variants?: Record<string, unknown> } | undefined;
    return !!model?.variants && Object.prototype.hasOwnProperty.call(model.variants, variant);
};

const resolveSelectionWithManualGuard = ({
    agents,
    providers,
    currentAgentName,
    currentProviderId,
    currentModelId,
    currentVariant,
    selectionSource,
    resolvedAgentName,
    resolvedProviderId,
    resolvedModelId,
    resolvedVariant,
}: {
    agents: Agent[];
    providers: ProviderWithModelList[];
    currentAgentName: string | undefined;
    currentProviderId: string;
    currentModelId: string;
    currentVariant: string | undefined;
    selectionSource: "auto" | "manual";
    resolvedAgentName: string | undefined;
    resolvedProviderId: string | undefined;
    resolvedModelId: string | undefined;
    resolvedVariant: string | undefined;
}) => {
    const manualAgentName = currentAgentName && agents.some((agent) => agent.name === currentAgentName)
        ? currentAgentName
        : undefined;
    const manualModelValid = !!currentProviderId
        && !!currentModelId
        && hasProviderModel(providers, currentProviderId, currentModelId)
        && hasValidVariant(providers, currentProviderId, currentModelId, currentVariant);
    const preserveManual = selectionSource === "manual" && (!!manualAgentName || manualModelValid);

    return {
        agentName: preserveManual ? (manualAgentName ?? resolvedAgentName) : resolvedAgentName,
        providerId: preserveManual && manualModelValid ? currentProviderId : resolvedProviderId,
        modelId: preserveManual && manualModelValid ? currentModelId : resolvedModelId,
        variant: preserveManual && manualModelValid ? currentVariant : resolvedVariant,
        selectionSource: preserveManual ? "manual" as const : "auto" as const,
    };
};

interface ConfigStore {

    activeDirectoryKey: string;
    catalogTransportIdentity: string;
    directoryScoped: Record<string, DirectoryScopedConfig>;
    providerConfigLoadingByDirectory: Record<string, boolean>;
    agentConfigLoadingByDirectory: Record<string, boolean>;

    providers: ProviderWithModelList[];
    agents: Agent[];
    currentProviderId: string;
    currentModelId: string;
    currentVariant: string | undefined;
    currentAgentName: string | undefined;
    selectedProviderId: string;
    /**
     * Legacy per-agent model map (hydrate migration only). New drafts use lastUserSelection.
     */
    agentModelSelections: { [agentName: string]: AgentModelSelection };
    /** Legacy agent-only inherit; prefer lastUserSelection.agentName. */
    lastSelectedAgentName: string | undefined;
    /** Active Project's last explicit user pick (agent+model+variant unit). */
    lastUserSelection: LastUserSelection | undefined;
    /** Cross-project fallback when the active Project has no lastUserSelection. */
    globalLastUserSelection: LastUserSelection | undefined;
    defaultProviders: { [key: string]: string };
    selectionSource: "auto" | "manual";
    isConnected: boolean;
    hasEverConnected: boolean;
    connectionPhase: "connecting" | "connected" | "reconnecting";
    lastDisconnectReason: string | null;
    isInitialized: boolean;
    // OpenChamber settings-based defaults (take precedence over agent preferences)
    settingsDefaultModel: string | undefined; // format: "provider/model"
    settingsDefaultVariant: string | undefined;
    settingsDefaultAgent: string | undefined;
    // OpenCode server's own `default_agent` config field (name of a primary agent), used as a
    // fallback when our own settingsDefaultAgent is unset. Sourced from sync config.
    opencodeDefaultAgent: string | undefined;
    // OpenCode server's own global `model` config field ("provider/model"), used as a fallback
    // when neither our settingsDefaultModel nor the resolved agent pins a model.
    opencodeDefaultModel: string | undefined;
    settingsAutoCreateWorktree: boolean;
    settingsGitmojiEnabled: boolean;
    settingsDefaultFileViewerPreview: boolean;
    settingsZenModel: string | undefined;
    settingsMessageStreamTransport: 'auto' | 'ws' | 'sse';
    // Voice provider preference ('browser', 'openai', 'openai-compatible', or 'say' for macOS)
    voiceProvider: 'browser' | 'local' | 'openai' | 'openai-compatible' | 'say';
    setVoiceProvider: (provider: 'browser' | 'local' | 'openai' | 'openai-compatible' | 'say') => void;
    // TTS settings
    speechRate: number;
    speechPitch: number;
    speechVolume: number;
    sayVoice: string;
    browserVoice: string;
    localTtsVoiceId: number;
    openaiVoice: string;
    openaiApiKey: string;
    openaiCompatibleUrl: string;
    openaiCompatibleApiKey: string;
    openaiCompatibleVoice: string;
    openaiCompatibleTtsModel: string;
    // STT (dictation) settings
    dictationEnabled: boolean;
    sttProvider: 'local' | 'openai-compatible';
    sttServerUrl: string;
    sttApiKey: string;
    sttModel: string;
    sttLocalModel: string;
    sttLanguage: string;
    showMessageTTSButtons: boolean;
    ttsInputMode: 'sanitized' | 'raw' | 'summarized';
    // Summarization settings
    summarizeMessageTTS: boolean;
    summarizeVoiceConversation: boolean;
    summarizeCharacterThreshold: number;
    summarizeMaxLength: number;
    setSpeechRate: (rate: number) => void;
    setSpeechPitch: (pitch: number) => void;
    setSpeechVolume: (volume: number) => void;
    setSayVoice: (voice: string) => void;
    setBrowserVoice: (voice: string) => void;
    setLocalTtsVoiceId: (voiceId: number) => void;
    setOpenaiVoice: (voice: string) => void;
    setOpenaiApiKey: (apiKey: string) => void;
    setOpenaiCompatibleUrl: (url: string) => void;
    setOpenaiCompatibleApiKey: (apiKey: string) => void;
    setOpenaiCompatibleVoice: (voice: string) => void;
    setOpenaiCompatibleTtsModel: (model: string) => void;
    setDictationEnabled: (enabled: boolean) => void;
    setSttProvider: (provider: 'local' | 'openai-compatible') => void;
    setSttServerUrl: (url: string) => void;
    setSttApiKey: (apiKey: string) => void;
    setSttModel: (model: string) => void;
    setSttLocalModel: (model: string) => void;
    setSttLanguage: (lang: string) => void;
    setShowMessageTTSButtons: (show: boolean) => void;
    setTtsInputMode: (mode: 'sanitized' | 'raw' | 'summarized') => void;
    setSummarizeMessageTTS: (enabled: boolean) => void;
    setSummarizeVoiceConversation: (enabled: boolean) => void;
    setSummarizeCharacterThreshold: (threshold: number) => void;
    setSummarizeMaxLength: (maxLength: number) => void;

    activateDirectory: (directory: string | null | undefined, options?: { refreshProviders?: boolean; source?: string }) => Promise<void>;

    loadProviders: (options?: { directory?: string | null; source?: string; forceRefresh?: boolean }) => Promise<void>;
    loadAgents: (options?: { directory?: string | null; source?: string; forceRefresh?: boolean }) => Promise<boolean>;
    /**
     * Cold-start recovery for catalogs that are still empty after a successful
     * but temporarily empty network response was cached with staleTime: Infinity.
     * Force-refreshes only missing Provider/Agent catalogs for the active directory.
     */
    refreshMissingCatalogs: (options?: { source?: string }) => Promise<void>;
    invalidateProviderCache: (directory?: string | null) => void;
    setProvider: (providerId: string) => void;
    setModel: (modelId: string) => void;
    setCurrentVariant: (variant: string | undefined) => void;
    cycleCurrentVariant: () => void;
    getCurrentModelVariants: () => string[];
    setAgent: (agentName: string | undefined) => void;
    applyDefaultModelAgentSelection: (options?: { projectDefaultModel?: string }) => void;
    applyOpenCodeConfigDefaults: (directory?: string | null, source?: string, config?: Config) => void;
    setSelectedProvider: (providerId: string) => void;
    setSettingsDefaultModel: (model: string | undefined) => void;
    setSettingsDefaultVariant: (variant: string | undefined) => void;
    setSettingsDefaultAgent: (agent: string | undefined) => void;
    setSettingsAutoCreateWorktree: (enabled: boolean) => void;
    setSettingsGitmojiEnabled: (enabled: boolean) => void;
    setSettingsDefaultFileViewerPreview: (enabled: boolean) => void;
    setSettingsZenModel: (model: string | undefined) => void;
    setSettingsMessageStreamTransport: (transport: 'auto' | 'ws' | 'sse') => void;
    getResolvedGitGenerationModel: () => { providerId: string; modelId: string } | null;
    saveAgentModelSelection: (agentName: string, providerId: string, modelId: string, variant?: string) => void;
    getAgentModelSelection: (agentName: string) => AgentModelSelection | null;
    probeConnection: (options?: { timeoutMs?: number }) => Promise<boolean>;
    checkConnection: () => Promise<boolean>;
    initializeApp: () => Promise<void>;
    prewarmProjectConfigs: (initialDirectory?: string | null) => Promise<void>;
    getCurrentProvider: () => ProviderWithModelList | undefined;
    getCurrentModel: () => ProviderModel | undefined;
    getCurrentAgent: () => Agent | undefined;
    getModelMetadata: (providerId: string, modelId: string) => ModelMetadata | undefined;
    // Returns only visible agents (excludes hidden internal agents like title, compaction, summary)
    getVisibleAgents: () => Agent[];
}

declare global {
    interface Window {
        __zustand_config_store__?: UseBoundStore<StoreApi<ConfigStore>>;
    }
}

let _initializeAppInFlight: Promise<void> | null = null;
let _refreshMissingCatalogsInFlight: Promise<void> | null = null;
let _providerLoadEpochByDirectory: Record<string, number> = {};
let _agentLoadEpochByDirectory: Record<string, number> = {};

export const useConfigStore = create<ConfigStore>()(
    devtools(
        persist(
            (set, get) => ({

                activeDirectoryKey: resolveInitialDirectoryKey(),
                catalogTransportIdentity: getRuntimeTransportIdentity(),
                directoryScoped: {},
                providerConfigLoadingByDirectory: {},
                agentConfigLoadingByDirectory: {},

                providers: [],
                agents: [],
                currentProviderId: "",
                currentModelId: "",
                currentVariant: undefined,
                currentAgentName: undefined,
                selectedProviderId: "",
                agentModelSelections: {},
                lastSelectedAgentName: undefined,
                lastUserSelection: undefined,
                globalLastUserSelection: undefined,
                defaultProviders: {},
                selectionSource: "auto",
                isConnected: false,
                hasEverConnected: false,
                connectionPhase: "connecting",
                lastDisconnectReason: null,
                isInitialized: false,
                settingsDefaultModel: undefined,
                settingsDefaultVariant: undefined,
                settingsDefaultAgent: undefined,
                opencodeDefaultAgent: undefined,
                opencodeDefaultModel: undefined,
                settingsAutoCreateWorktree: false,
                settingsGitmojiEnabled: false,
                settingsDefaultFileViewerPreview: false,
                settingsZenModel: undefined,
                settingsMessageStreamTransport: 'auto',
                // Voice provider preference - load from localStorage or default to 'browser'
                voiceProvider: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('voiceProvider');
                        if (saved === 'openai' || saved === 'browser' || saved === 'local' || saved === 'say' || saved === 'openai-compatible') return saved;
                    }
                    return 'browser';
                })(),
                // TTS settings - load from localStorage with defaults
                speechRate: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('speechRate');
                        if (saved) {
                            const parsed = parseFloat(saved);
                            if (!isNaN(parsed) && parsed >= 0.5 && parsed <= 2) return parsed;
                        }
                    }
                    return 1;
                })(),
                speechPitch: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('speechPitch');
                        if (saved) {
                            const parsed = parseFloat(saved);
                            if (!isNaN(parsed) && parsed >= 0.5 && parsed <= 2) return parsed;
                        }
                    }
                    return 1;
                })(),
                speechVolume: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('speechVolume');
                        if (saved) {
                            const parsed = parseFloat(saved);
                            if (!isNaN(parsed) && parsed >= 0 && parsed <= 1) return parsed;
                        }
                    }
                    return 1;
                })(),
                // macOS Say voice - load from localStorage or default to 'Samantha'
                sayVoice: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('sayVoice');
                        if (saved) return saved;
                    }
                    return 'Samantha';
                })(),
                // Local (Kokoro) TTS speaker id - load from localStorage or default to 0
                localTtsVoiceId: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('localTtsVoiceId');
                        if (saved !== null) {
                            const parsed = Number.parseInt(saved, 10);
                            if (Number.isInteger(parsed) && parsed >= 0) return parsed;
                        }
                    }
                    return 0;
                })(),
                // Browser voice - load from localStorage or default to empty (auto-select)
                browserVoice: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('browserVoice');
                        if (saved) return saved;
                    }
                    return '';
                })(),
                // OpenAI voice - load from localStorage or default to 'nova'
                openaiVoice: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('openaiVoice');
                        if (saved) return saved;
                    }
                    return 'nova';
                })(),
                // OpenAI API key for TTS - load from localStorage or default to empty
                openaiApiKey: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('openaiApiKey');
                        if (saved) return saved;
                    }
                    return '';
                })(),
                // OpenAI-compatible custom server URL
                openaiCompatibleUrl: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('openaiCompatibleUrl');
                        if (saved) return saved;
                    }
                    return '';
                })(),
                // OpenAI-compatible custom server API key
                openaiCompatibleApiKey: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('openaiCompatibleApiKey');
                        if (saved) return saved;
                    }
                    return '';
                })(),
                // OpenAI-compatible custom server voice
                openaiCompatibleVoice: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('openaiCompatibleVoice');
                        if (saved) return saved;
                    }
                    return 'af_sky';
                })(),
                // OpenAI-compatible custom server TTS model
                openaiCompatibleTtsModel: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('openaiCompatibleTtsModel');
                        if (saved && saved !== 'speaches-ai/Kokoro-82M-v1.0-ONNX') return saved;
                    }
                    return 'kokoro';
                })(),
                // Voice input (dictation) master toggle - default enabled
                dictationEnabled: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('dictationEnabled');
                        if (saved === 'false') return false;
                    }
                    return true;
                })(),
                // STT provider: 'local' (server-side sherpa-onnx) or 'openai-compatible'
                sttProvider: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('sttProvider');
                        if (saved === 'local' || saved === 'openai-compatible') return saved;
                        // Migrate legacy providers: 'server' used an OpenAI-compatible
                        // endpoint; 'browser' and 'wasm' map to the local default.
                        if (saved === 'server') return 'openai-compatible' as const;
                    }
                    return 'local' as const;
                })(),
                sttServerUrl: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('sttServerUrl');
                        if (saved) return saved;
                    }
                    return 'http://localhost:8001/v1';
                })(),
                sttApiKey: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('sttApiKey');
                        if (saved) return saved;
                    }
                    return '';
                })(),
                sttModel: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('sttModel');
                        if (saved) return saved;
                    }
                    return 'deepdml/faster-whisper-large-v3-turbo-ct2';
                })(),
                sttLocalModel: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('sttLocalModel');
                        if (saved) return saved;
                    }
                    return 'parakeet-tdt-0.6b-v2-int8';
                })(),
                sttLanguage: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('sttLanguage');
                        if (saved !== null) return saved;
                    }
                    return '';
                })(),
                // Show TTS buttons on messages - disabled by default until user enables it
                showMessageTTSButtons: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('showMessageTTSButtons');
                        if (saved === 'true') return true;
                    }
                    return false;
                })(),
                ttsInputMode: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('ttsInputMode');
                        if (saved === 'raw') return 'raw' as const;
                        if (saved === 'summarized') return 'summarized' as const;
                    }
                    return 'sanitized' as const;
                })(),
                // Summarization settings
                summarizeMessageTTS: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('summarizeMessageTTS');
                        if (saved === 'true') return true;
                    }
                    return false;
                })(),
                summarizeVoiceConversation: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('summarizeVoiceConversation');
                        if (saved === 'true') return true;
                    }
                    return false;
                })(),
                summarizeCharacterThreshold: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('summarizeCharacterThreshold');
                        if (saved) {
                            const parsed = parseInt(saved, 10);
                            if (!isNaN(parsed) && parsed >= 50 && parsed <= 2000) return parsed;
                        }
                    }
                    return 200;
                })(),
                summarizeMaxLength: (() => {
                    if (typeof window !== 'undefined') {
                        const saved = localStorage.getItem('summarizeMaxLength');
                        if (saved) {
                            const parsed = parseInt(saved, 10);
                            if (!isNaN(parsed) && parsed >= 50 && parsed <= 2000) return parsed;
                        }
                    }
                    return 500;
                })(),
                activateDirectory: async (directory, options) => {
                    // Resolve the worktree to its owning project up-front so the
                    // active key + snapshot key always match and stay project-scoped.
                    // Everything below operates on this key unchanged; the OpenCode
                    // working directory (opencodeClient.getDirectory()) is separate.
                    const configDirectory = resolveConfigDirectory(directory);
                    if (!configDirectory) {
                        markStartupTrace('activateDirectory:skippedUnknownDirectory', { directory });
                        return;
                    }
                    const directoryKey = toDirectoryKey(configDirectory);
                    let snapshotHadProviders = false;
                    let snapshotHadAgents = false;
                    let hadInMemoryDirectoryAgents = false;

                    set((state) => {
                        const snapshot = state.directoryScoped[directoryKey];
                        const globalProviders = state.providers.length > 0
                            ? state.providers
                            : (snapshot?.providers ?? []);
                        const globalDefaults = Object.keys(state.defaultProviders).length > 0
                            ? state.defaultProviders
                            : (snapshot?.defaultProviders ?? {});
                        const globalAgents = state.agents.length > 0
                            ? state.agents
                            : (snapshot?.agents ?? []);
                        snapshotHadProviders = globalProviders.length > 0;
                        snapshotHadAgents = globalAgents.length > 0;
                        hadInMemoryDirectoryAgents = Boolean(snapshot?.agents.length);
                        const shouldLoadProviders = state.isConnected && !snapshotHadProviders;
                        const shouldLoadAgents = state.isConnected && !snapshotHadAgents;
                        if (snapshot) {
                            return {
                                activeDirectoryKey: directoryKey,
                                providers: globalProviders,
                                defaultProviders: globalDefaults,
                                agents: snapshot.agents.length > 0 ? snapshot.agents : globalAgents,
                                currentProviderId: snapshot.currentProviderId,
                                currentModelId: snapshot.currentModelId,
                                currentVariant: snapshot.currentVariant,
                                currentAgentName: snapshot.currentAgentName,
                                selectedProviderId: snapshot.selectedProviderId,
                                agentModelSelections: snapshot.agentModelSelections,
                                lastSelectedAgentName: snapshot.lastSelectedAgentName,
                                lastUserSelection: snapshot.lastUserSelection,
                                // globalLastUserSelection is cross-project — never cleared on activate.
                                opencodeDefaultAgent: snapshot.opencodeDefaultAgent,
                                opencodeDefaultModel: snapshot.opencodeDefaultModel,
                                selectionSource: snapshot.selectionSource ?? "auto",
                                providerConfigLoadingByDirectory: {
                                    ...state.providerConfigLoadingByDirectory,
                                    [directoryKey]: shouldLoadProviders,
                                },
                                agentConfigLoadingByDirectory: {
                                    ...state.agentConfigLoadingByDirectory,
                                    [directoryKey]: shouldLoadAgents,
                                },
                            };
                        }

                        return {
                            activeDirectoryKey: directoryKey,
                            providers: globalProviders,
                            defaultProviders: globalDefaults,
                            agents: globalAgents,
                            currentProviderId: "",
                            currentModelId: "",
                            currentAgentName: undefined,
                            selectedProviderId: "",
                            agentModelSelections: {},
                            lastSelectedAgentName: undefined,
                            lastUserSelection: undefined,
                            // Keep globalLastUserSelection so a Project with no memory can fall back.
                            opencodeDefaultAgent: undefined,
                            opencodeDefaultModel: undefined,
                            selectionSource: "auto",
                            providerConfigLoadingByDirectory: {
                                ...state.providerConfigLoadingByDirectory,
                                [directoryKey]: shouldLoadProviders,
                            },
                            agentConfigLoadingByDirectory: {
                                ...state.agentConfigLoadingByDirectory,
                                [directoryKey]: shouldLoadAgents,
                            },
                        };
                    });

                    // New / persisted-empty directories inherit immediately from the
                    // already-loaded global catalogs. Do not wait on a project fetch.
                    if (snapshotHadAgents && snapshotHadProviders && !hadInMemoryDirectoryAgents) {
                        get().applyDefaultModelAgentSelection();
                    }

                    if (!get().isConnected) {
                        return;
                    }

                    // Provider and Agent catalogs are global. Reuse them across projects;
                    // only fetch when we have nothing to show. Explicit refreshProviders
                    // still refetches (config-change / initializeApp), but a new draft
                    // must not block on a second catalog round-trip.
                    if (!snapshotHadProviders || options?.refreshProviders) {
                        await get().loadProviders({ directory: fromDirectoryKey(directoryKey), source: options?.source ?? 'activateDirectory', forceRefresh: options?.refreshProviders });
                    }

                    if (!snapshotHadAgents) {
                        await get().loadAgents({ directory: fromDirectoryKey(directoryKey), source: 'activateDirectory' });
                    }
                },

                invalidateProviderCache: (_directory) => {
                    const transport = getRuntimeTransportIdentity();
                    void invalidateProviderCatalogQuery(null, transport);
                },

                loadProviders: async (options) => {
                    const requestedDirectory = options?.directory ?? fromDirectoryKey(get().activeDirectoryKey);
                    // Catalog is global. The directory is only an OpenCode request hint
                    // and the key for lastUserSelection; it must not partition the cache.
                    const configDirectory = resolveConfigDirectory(requestedDirectory);
                    if (!configDirectory) {
                        markStartupTrace('loadProviders:skippedUnknownDirectory', { requestedDirectory, source: options?.source ?? 'unknown' });
                        return;
                    }
                    const effectiveDirectory = configDirectory ?? opencodeClient.getDirectory() ?? null;
                    const directoryKey = toDirectoryKey(configDirectory);
                    const source = options?.source ?? 'unknown';
                    const transport = getRuntimeTransportIdentity();
                    const generation = getRuntimeGeneration();
                    const isCurrent = () => getRuntimeGeneration() === generation
                        && getRuntimeTransportIdentity() === transport
                        && get().catalogTransportIdentity === transport
                        && resolveConfigDirectory(requestedDirectory) === configDirectory;
                    const loadEpoch = (_providerLoadEpochByDirectory[directoryKey] ?? 0) + 1;
                    _providerLoadEpochByDirectory[directoryKey] = loadEpoch;
                    markStartupTrace('loadProviders:called', { directoryKey, source, requestedDirectory, effectiveDirectory });

                    const currentProviderSnapshot = get().directoryScoped[directoryKey];
                    // Catalog is global; a Project snapshot is only a persist vehicle.
                    const hasProviderData = get().providers.length > 0
                        || Boolean(currentProviderSnapshot?.providers.length);
                    if (!hasProviderData) {
                        set((state) => ({
                            providerConfigLoadingByDirectory: {
                                ...state.providerConfigLoadingByDirectory,
                                [directoryKey]: true,
                            },
                        }));
                    }

                    const promise = (async () => {
                    const loaderStarted = typeof performance !== 'undefined' ? performance.now() : Date.now();
                    markStartupTrace('loadProviders:start', { directoryKey, source, requestedDirectory, effectiveDirectory });
                    const existingSnapshot = get().directoryScoped[directoryKey];
                    const previousProviders = get().providers.length > 0
                        ? get().providers
                        : existingSnapshot?.providers ?? [];
                    const previousDefaults = Object.keys(get().defaultProviders).length > 0
                        ? get().defaultProviders
                        : existingSnapshot?.defaultProviders ?? {};
                    try {
                            const apiResult = await measureStartupTrace(
                                'loadProviders:api',
                                () => options?.forceRefresh
                                    ? refreshProviderCatalogQuery(fromDirectoryKey(directoryKey), transport)
                                    : ensureProviderCatalogQuery(fromDirectoryKey(directoryKey), transport),
                                { directoryKey, source, requestedDirectory, effectiveDirectory },
                            );
                            const processedProviders = sanitizeProviderList(apiResult.providers);
                            const defaults = sanitizeDefaultProviders(apiResult.default);

                            if (!isCurrent()) {
                                return;
                            }
                            if (apiResult.partial && previousProviders.length > 0) return;

                            set((state) => {
                                if (!isCurrent() || state.catalogTransportIdentity !== transport) return state;
                                const baseSnapshot: DirectoryScopedConfig = state.directoryScoped[directoryKey] ?? {
                                    providers: [],
                                    agents: [],
                                    currentProviderId: "",
                                    currentModelId: "",
                                    currentAgentName: undefined,
                                    selectedProviderId: "",
                                    agentModelSelections: {},
                                    defaultProviders: {},
                                };

                                const currentProviderId = state.activeDirectoryKey === directoryKey
                                    ? state.currentProviderId
                                    : baseSnapshot.currentProviderId;
                                const currentModelId = state.activeDirectoryKey === directoryKey
                                    ? state.currentModelId
                                    : baseSnapshot.currentModelId;
                                const currentVariant = state.activeDirectoryKey === directoryKey
                                    ? state.currentVariant
                                    : baseSnapshot.currentVariant;
                                const resolvedModel = resolveProviderModelSelection({
                                    providers: processedProviders,
                                    currentProviderId,
                                    currentModelId,
                                    currentVariant,
                                    settingsDefaultModel: state.settingsDefaultModel,
                                    settingsDefaultVariant: state.settingsDefaultVariant,
                                });
                                const currentSelectedProviderId = state.activeDirectoryKey === directoryKey
                                    ? state.selectedProviderId
                                    : baseSnapshot.selectedProviderId;
                                // Preserve the add-provider sentinel so a background refresh does not
                                // navigate the user out of the in-progress add-provider form (issue #1765).
                                const selectedProviderId = currentSelectedProviderId === ADD_PROVIDER_SENTINEL
                                    || processedProviders.some((provider) => provider.id === currentSelectedProviderId)
                                    ? currentSelectedProviderId
                                    : (resolvedModel?.providerId ?? processedProviders[0]?.id ?? "");

                                const nextSnapshot: DirectoryScopedConfig = {
                                    ...baseSnapshot,
                                    providers: processedProviders,
                                    defaultProviders: defaults,
                                    providerCatalogPartial: apiResult.partial,
                                    currentProviderId: resolvedModel?.providerId ?? "",
                                    currentModelId: resolvedModel?.modelId ?? "",
                                    currentVariant: resolvedModel?.variant,
                                    selectedProviderId,
                                };

                                const nextState: Partial<ConfigStore> = {
                                    providers: processedProviders,
                                    defaultProviders: defaults,
                                    directoryScoped: {
                                        ...state.directoryScoped,
                                        [directoryKey]: nextSnapshot,
                                    },
                                };

                                if (state.activeDirectoryKey === directoryKey) {
                                    nextState.currentProviderId = nextSnapshot.currentProviderId;
                                    nextState.currentModelId = nextSnapshot.currentModelId;
                                    nextState.currentVariant = nextSnapshot.currentVariant;
                                    nextState.selectedProviderId = selectedProviderId;
                                }

                                return nextState;
                            });

                            if (!isCurrent()) return;
                            const loaderEnded = typeof performance !== 'undefined' ? performance.now() : Date.now();
                            markStartupTrace('loadProviders:end', {
                                directoryKey,
                                source,
                                requestedDirectory,
                                effectiveDirectory,
                                durationMs: Math.round(loaderEnded - loaderStarted),
                                providers: processedProviders.length,
                                models: processedProviders.reduce((count, provider) => count + provider.models.length, 0),
                            });
                            return;
                    } catch (error) {
                    if (!isCurrent()) return;
                    console.error("Failed to load providers:", error);
                    markStartupTrace('loadProviders:error', {
                        directoryKey,
                        source,
                        requestedDirectory,
                        effectiveDirectory,
                        error: error instanceof Error ? error.message : String(error),
                    });
                    }

                    if (!isCurrent()) return;
                    set((state) => {
                        if (!isCurrent() || state.catalogTransportIdentity !== transport) return state;
                        const baseSnapshot: DirectoryScopedConfig = state.directoryScoped[directoryKey] ?? {
                            providers: [],
                            agents: [],
                            currentProviderId: "",
                            currentModelId: "",
                            currentAgentName: undefined,
                            selectedProviderId: "",
                            agentModelSelections: {},
                            defaultProviders: {},
                        };

                        const nextSnapshot: DirectoryScopedConfig = {
                            ...baseSnapshot,
                            providers: previousProviders,
                            defaultProviders: previousDefaults,
                        };

                        const nextState: Partial<ConfigStore> = {
                            providers: previousProviders,
                            defaultProviders: previousDefaults,
                            directoryScoped: {
                                ...state.directoryScoped,
                                [directoryKey]: nextSnapshot,
                            },
                        };

                        if (state.activeDirectoryKey === directoryKey) {

                            if (!state.currentProviderId && !state.currentModelId && state.settingsDefaultModel) {
                                const parsed = parseModelString(state.settingsDefaultModel);
                                if (parsed) {
                                    const settingsProvider = previousProviders.find((p) => p.id === parsed.providerId);
                                    if (settingsProvider?.models.some((m) => m.id === parsed.modelId)) {
                                        const model = settingsProvider.models.find((m) => m.id === parsed.modelId);
                                        const currentVariant = state.settingsDefaultVariant && (model as { variants?: Record<string, unknown> } | undefined)?.variants?.[state.settingsDefaultVariant]
                                            ? state.settingsDefaultVariant
                                            : undefined;

                                        nextState.currentProviderId = parsed.providerId;
                                        nextState.currentModelId = parsed.modelId;
                                        nextState.currentVariant = currentVariant;
                                        nextState.selectedProviderId = parsed.providerId;

                                        nextSnapshot.currentProviderId = parsed.providerId;
                                        nextSnapshot.currentModelId = parsed.modelId;
                                        nextSnapshot.currentVariant = currentVariant;
                                        nextSnapshot.selectedProviderId = parsed.providerId;
                                    }
                                }
                            }
                        }

                        return nextState;
                    });
                    })().finally(() => {
                        if (_providerLoadEpochByDirectory[directoryKey] !== loadEpoch) return;
                        set((state) => ({
                            providerConfigLoadingByDirectory: {
                                ...state.providerConfigLoadingByDirectory,
                                [directoryKey]: false,
                            },
                        }));
                    });

                    return promise;
                },

                // Not `async`: must return the same Promise reference for single-flight callers.
                refreshMissingCatalogs: (options) => {
                    if (_refreshMissingCatalogsInFlight) {
                        return _refreshMissingCatalogsInFlight;
                    }

                    const source = options?.source ?? 'refreshMissingCatalogs';
                    const run = (async () => {
                        // Read the authoritative store snapshot first so recovery only
                        // force-refreshes catalogs that are still empty after a successful
                        // empty warm load (staleTime: Infinity otherwise keeps that empty result).
                        if (get().providers.length === 0) {
                            await get().loadProviders({ source, forceRefresh: true });
                        }
                        // Re-read after providers: agent selection cascade depends on the
                        // latest provider snapshot, and agents may have been filled meanwhile.
                        if (get().agents.length === 0) {
                            await get().loadAgents({ source, forceRefresh: true });
                        }
                    })().finally(() => {
                        _refreshMissingCatalogsInFlight = null;
                    });

                    _refreshMissingCatalogsInFlight = run;
                    return run;
                },

                setProvider: (providerId: string) => {
                    const { providers } = get();
                    const provider = providers.find((p) => p.id === providerId);
 
                    if (!provider) {
                        return;
                    }
 
                    const firstModel = provider.models[0];
                    const newModelId = firstModel?.id || "";
 
                    set((state) => {
                        const directoryKey = state.activeDirectoryKey;
                        const baseSnapshot: DirectoryScopedConfig = state.directoryScoped[directoryKey] ?? {
                            providers: state.providers,
                            agents: state.agents,
                            currentProviderId: state.currentProviderId,
                            currentModelId: state.currentModelId,
                            currentVariant: state.currentVariant,
                            currentAgentName: state.currentAgentName,
                            selectedProviderId: state.selectedProviderId,
                            agentModelSelections: state.agentModelSelections,
                            defaultProviders: state.defaultProviders,
                        };

                        const nextSnapshot: DirectoryScopedConfig = {
                            ...baseSnapshot,
                            currentProviderId: providerId,
                            currentModelId: newModelId,
                            selectedProviderId: providerId,
                            selectionSource: "manual",
                        };

                        return {
                            currentProviderId: providerId,
                            currentModelId: newModelId,
                            selectedProviderId: providerId,
                            selectionSource: "manual",
                            directoryScoped: {
                                ...state.directoryScoped,
                                [directoryKey]: nextSnapshot,
                            },
                        };
                    });
                },

                setModel: (modelId: string) => {
                    set((state) => {
                        const directoryKey = state.activeDirectoryKey;
                        const baseSnapshot: DirectoryScopedConfig = state.directoryScoped[directoryKey] ?? {
                            providers: state.providers,
                            agents: state.agents,
                            currentProviderId: state.currentProviderId,
                            currentModelId: state.currentModelId,
                            currentVariant: state.currentVariant,
                            currentAgentName: state.currentAgentName,
                            selectedProviderId: state.selectedProviderId,
                            agentModelSelections: state.agentModelSelections,
                            defaultProviders: state.defaultProviders,
                        };
 
                        const nextSnapshot: DirectoryScopedConfig = {
                            ...baseSnapshot,
                            currentModelId: modelId,
                            selectionSource: "manual",
                        };
 
                        return {
                            currentModelId: modelId,
                            selectionSource: "manual",
                            directoryScoped: {
                                ...state.directoryScoped,
                                [directoryKey]: nextSnapshot,
                            },
                        };
                    });
                },

                setCurrentVariant: (variant: string | undefined) => {
                    set((state) => {
                        if (state.currentVariant === variant) {
                            return state;
                        }

                        const directoryKey = state.activeDirectoryKey;
                        const baseSnapshot: DirectoryScopedConfig = state.directoryScoped[directoryKey] ?? {
                            providers: state.providers,
                            agents: state.agents,
                            currentProviderId: state.currentProviderId,
                            currentModelId: state.currentModelId,
                            currentVariant: state.currentVariant,
                            currentAgentName: state.currentAgentName,
                            selectedProviderId: state.selectedProviderId,
                            agentModelSelections: state.agentModelSelections,
                            defaultProviders: state.defaultProviders,
                        };

                        const nextSnapshot: DirectoryScopedConfig = {
                            ...baseSnapshot,
                            currentVariant: variant,
                            selectionSource: "manual",
                        };

                        return {
                            currentVariant: variant,
                            selectionSource: "manual",
                            directoryScoped: {
                                ...state.directoryScoped,
                                [directoryKey]: nextSnapshot,
                            },
                        };
                    });
                },

                getCurrentModelVariants: () => {
                    const model = get().getCurrentModel();
                    const variants = (model as { variants?: Record<string, unknown> } | undefined)?.variants;
                    if (!variants) {
                        return [];
                    }
                    return Object.keys(variants);
                },

                cycleCurrentVariant: () => {
                    const variantKeys = get().getCurrentModelVariants();
                    if (variantKeys.length === 0) {
                        return;
                    }

                    const current = get().currentVariant;
                    if (!current) {
                        get().setCurrentVariant(variantKeys[0]);
                        return;
                    }

                    const index = variantKeys.indexOf(current);
                    if (index === -1 || index === variantKeys.length - 1) {
                        get().setCurrentVariant(undefined);
                        return;
                    }

                    get().setCurrentVariant(variantKeys[index + 1]);
                },
 
                setSelectedProvider: (providerId: string) => {
                    set((state) => {
                        const directoryKey = state.activeDirectoryKey;
                        const baseSnapshot: DirectoryScopedConfig = state.directoryScoped[directoryKey] ?? {
                            providers: state.providers,
                            agents: state.agents,
                            currentProviderId: state.currentProviderId,
                            currentModelId: state.currentModelId,
                            currentAgentName: state.currentAgentName,
                            selectedProviderId: state.selectedProviderId,
                            agentModelSelections: state.agentModelSelections,
                            defaultProviders: state.defaultProviders,
                        };

                        const nextSnapshot: DirectoryScopedConfig = {
                            ...baseSnapshot,
                            selectedProviderId: providerId,
                            selectionSource: "manual",
                        };

                        return {
                            selectedProviderId: providerId,
                            selectionSource: "manual",
                            directoryScoped: {
                                ...state.directoryScoped,
                                [directoryKey]: nextSnapshot,
                            },
                        };
                    });
                },

                // Explicit user pick: remember as one Project unit + update the global fallback.
                // Does not maintain a per-agent model map — only the latest (agent, model, variant).
                saveAgentModelSelection: (agentName: string, providerId: string, modelId: string, variant?: string) => {
                    if (!agentName || !providerId || !modelId) {
                        return;
                    }

                    set((state) => {
                        const directoryKey = state.activeDirectoryKey;
                        const nextSelection: LastUserSelection = {
                            agentName,
                            providerId,
                            modelId,
                            ...(variant ? { variant } : {}),
                        };
                        const previous = state.lastUserSelection;
                        const sameUnit =
                            previous?.agentName === nextSelection.agentName
                            && previous?.providerId === nextSelection.providerId
                            && previous?.modelId === nextSelection.modelId
                            && previous?.variant === nextSelection.variant;
                        const sameGlobal =
                            state.globalLastUserSelection?.agentName === nextSelection.agentName
                            && state.globalLastUserSelection?.providerId === nextSelection.providerId
                            && state.globalLastUserSelection?.modelId === nextSelection.modelId
                            && state.globalLastUserSelection?.variant === nextSelection.variant;
                        if (sameUnit && sameGlobal) {
                            return state;
                        }

                        const baseSnapshot: DirectoryScopedConfig = state.directoryScoped[directoryKey] ?? {
                            providers: state.providers,
                            agents: state.agents,
                            currentProviderId: state.currentProviderId,
                            currentModelId: state.currentModelId,
                            currentAgentName: state.currentAgentName,
                            selectedProviderId: state.selectedProviderId,
                            agentModelSelections: state.agentModelSelections,
                            lastSelectedAgentName: state.lastSelectedAgentName,
                            lastUserSelection: state.lastUserSelection,
                            defaultProviders: state.defaultProviders,
                        };

                        const nextSnapshot: DirectoryScopedConfig = {
                            ...baseSnapshot,
                            // Stop writing the legacy per-agent map; cascade reads lastUserSelection.
                            agentModelSelections: {},
                            lastSelectedAgentName: agentName,
                            lastUserSelection: nextSelection,
                            selectionSource: "manual",
                        };

                        return {
                            agentModelSelections: {},
                            lastSelectedAgentName: agentName,
                            lastUserSelection: nextSelection,
                            globalLastUserSelection: nextSelection,
                            selectionSource: "manual",
                            directoryScoped: {
                                ...state.directoryScoped,
                                [directoryKey]: nextSnapshot,
                            },
                        };
                    });
                },

                getAgentModelSelection: (agentName: string) => {
                    // Compatibility shim: only returns a model when the Project's last unit
                    // pick matches this agent. No per-agent memory.
                    const { lastUserSelection } = get();
                    if (!lastUserSelection || lastUserSelection.agentName !== agentName) {
                        return null;
                    }
                    return {
                        providerId: lastUserSelection.providerId,
                        modelId: lastUserSelection.modelId,
                        ...(lastUserSelection.variant ? { variant: lastUserSelection.variant } : {}),
                    };
                },

                loadAgents: async (options) => {
                    const requestedDirectory = options?.directory ?? fromDirectoryKey(get().activeDirectoryKey);
                    // Composer Agent catalog is global per transport. Directory is an
                    // OpenCode instance hint and the lastUserSelection key, not a cache partition.
                    const configDirectory = resolveConfigDirectory(requestedDirectory);
                    if (!configDirectory) {
                        markStartupTrace('loadAgents:skippedUnknownDirectory', { requestedDirectory, source: options?.source ?? 'unknown' });
                        return false;
                    }
                    const effectiveDirectory = configDirectory ?? opencodeClient.getDirectory() ?? null;
                    const directoryKey = toDirectoryKey(configDirectory);
                    const source = options?.source ?? 'unknown';
                    const transport = getRuntimeTransportIdentity();
                    const generation = getRuntimeGeneration();
                    const isCurrent = () => getRuntimeGeneration() === generation
                        && getRuntimeTransportIdentity() === transport
                        && get().catalogTransportIdentity === transport
                        && resolveConfigDirectory(requestedDirectory) === configDirectory;
                    const loadEpoch = (_agentLoadEpochByDirectory[directoryKey] ?? 0) + 1;
                    _agentLoadEpochByDirectory[directoryKey] = loadEpoch;
                    markStartupTrace('loadAgents:called', { directoryKey, source, requestedDirectory, effectiveDirectory });

                    const currentAgentSnapshot = get().directoryScoped[directoryKey];
                    const hasAgentData = get().agents.length > 0
                        || Boolean(currentAgentSnapshot?.agents.length);
                    if (!hasAgentData) {
                        set((state) => ({
                            agentConfigLoadingByDirectory: {
                                ...state.agentConfigLoadingByDirectory,
                                [directoryKey]: true,
                            },
                        }));
                    }

                    const promise = (async (): Promise<boolean> => {
                    const loaderStarted = typeof performance !== 'undefined' ? performance.now() : Date.now();
                    markStartupTrace('loadAgents:start', { directoryKey, source, requestedDirectory, effectiveDirectory });
                    const existingSnapshot = get().directoryScoped[directoryKey];
                    const previousAgents = get().agents.length > 0
                        ? get().agents
                        : existingSnapshot?.agents ?? [];
                    try {
                            // Fetch agents and OpenChamber settings in parallel. OpenCode config
                            // comes from sync state if it is already available; it must not block
                            // the agent refresh path.
                            const configDirectoryPath = fromDirectoryKey(directoryKey);
                            const initialSyncedOpencodeConfig = getSyncConfig(requestedDirectory ?? undefined)
                                ?? getSyncConfig(configDirectoryPath ?? undefined);
                            if (initialSyncedOpencodeConfig) {
                                markStartupTrace('loadAgents:syncConfigHit', { directoryKey, source });
                            }
                            const [agents, openChamberDefaults] = await Promise.all([
                                measureStartupTrace(
                                    'loadAgents:api',
                                    () => options?.forceRefresh
                                        ? refreshRawAgentsQuery(configDirectoryPath, transport)
                                        : ensureRawAgentsQuery(configDirectoryPath, transport),
                                    { directoryKey, source, requestedDirectory, effectiveDirectory },
                                ),
                                fetchOpenChamberDefaults(transport, {
                                    defaultModel: get().settingsDefaultModel,
                                    defaultVariant: get().settingsDefaultVariant,
                                    defaultAgent: get().settingsDefaultAgent,
                                    autoCreateWorktree: get().settingsAutoCreateWorktree,
                                    gitmojiEnabled: get().settingsGitmojiEnabled,
                                    defaultFileViewerPreview: get().settingsDefaultFileViewerPreview,
                                    zenModel: get().settingsZenModel,
                                    messageStreamTransport: get().settingsMessageStreamTransport,
                                    sttProvider: get().sttProvider,
                                    sttServerUrl: get().sttServerUrl,
                                    sttModel: get().sttModel,
                                    sttLocalModel: get().sttLocalModel,
                                    sttLanguage: get().sttLanguage,
                                }),
                            ]);

                            const safeAgents = Array.isArray(agents) ? agents : [];

                            if (!isCurrent()) {
                                return false;
                            }

                            const latestSyncedOpencodeConfig = getSyncConfig(requestedDirectory ?? undefined)
                                ?? getSyncConfig(configDirectoryPath ?? undefined);
                            const hasLatestSyncedOpencodeConfig = latestSyncedOpencodeConfig !== undefined;
                            const latestSyncedOpencodeDefaultAgent = hasLatestSyncedOpencodeConfig
                                ? normalizeOptionalString(latestSyncedOpencodeConfig.default_agent)
                                : undefined;
                            const latestSyncedOpencodeDefaultModel = hasLatestSyncedOpencodeConfig
                                ? normalizeOptionalString(latestSyncedOpencodeConfig.model)
                                : undefined;

                            const providers = get().activeDirectoryKey === directoryKey
                                ? get().providers
                                : (get().directoryScoped[directoryKey]?.providers ?? []);

                            const existingZenModel = normalizeOptionalString(get().settingsZenModel);

                            const defaultZenModel = normalizeOptionalString(openChamberDefaults.zenModel);

                            const resolvedExistingGitSelection = resolveGitGenerationModelSelection({
                                providers,
                                settingsZenModel: existingZenModel,
                            });

                            const resolvedDefaultGitSelection = resolveGitGenerationModelSelection({
                                providers,
                                settingsZenModel: defaultZenModel,
                            });

                            const resolvedGitSelection = resolvedExistingGitSelection || resolvedDefaultGitSelection;
                            const resolvedGitModelId = resolvedGitSelection?.modelId;
                            const resolvedZenModel = resolvedGitModelId || defaultZenModel || existingZenModel;

                            set((state) => {
                                if (!isCurrent() || state.catalogTransportIdentity !== transport) return state;
                                const baseSnapshot: DirectoryScopedConfig = state.directoryScoped[directoryKey] ?? {
                                    providers,
                                    agents: previousAgents,
                                    currentProviderId: "",
                                    currentModelId: "",
                                    currentAgentName: undefined,
                                    selectedProviderId: "",
                                    agentModelSelections: {},
                                    defaultProviders: {},
                                };
                                const opencodeDefaultAgent = hasLatestSyncedOpencodeConfig
                                    ? latestSyncedOpencodeDefaultAgent
                                    : baseSnapshot.opencodeDefaultAgent ?? (state.activeDirectoryKey === directoryKey ? state.opencodeDefaultAgent : undefined);
                                const opencodeDefaultModel = hasLatestSyncedOpencodeConfig
                                    ? latestSyncedOpencodeDefaultModel
                                    : baseSnapshot.opencodeDefaultModel ?? (state.activeDirectoryKey === directoryKey ? state.opencodeDefaultModel : undefined);

                                const nextSnapshot: DirectoryScopedConfig = {
                                    ...baseSnapshot,
                                    providers,
                                    agents: safeAgents,
                                    opencodeDefaultAgent,
                                    opencodeDefaultModel,
                                };

                                const nextState: Partial<ConfigStore> = {
                                    settingsDefaultModel: openChamberDefaults.defaultModel,
                                    settingsDefaultVariant: openChamberDefaults.defaultVariant,
                                    settingsDefaultAgent: openChamberDefaults.defaultAgent,
                                    settingsAutoCreateWorktree: openChamberDefaults.autoCreateWorktree ?? false,
                                    settingsGitmojiEnabled: openChamberDefaults.gitmojiEnabled ?? false,
                                    settingsDefaultFileViewerPreview: openChamberDefaults.defaultFileViewerPreview ?? false,
                                    settingsZenModel: resolvedZenModel,
                                    settingsMessageStreamTransport: openChamberDefaults.messageStreamTransport ?? state.settingsMessageStreamTransport ?? 'auto',
                                    sttProvider: openChamberDefaults.sttProvider ?? state.sttProvider,
                                    sttServerUrl: openChamberDefaults.sttServerUrl ?? state.sttServerUrl,
                                    sttModel: openChamberDefaults.sttModel ?? state.sttModel,
                                    sttLocalModel: openChamberDefaults.sttLocalModel ?? state.sttLocalModel,
                                    sttLanguage: openChamberDefaults.sttLanguage ?? state.sttLanguage,
                                    directoryScoped: {
                                        ...state.directoryScoped,
                                        [directoryKey]: nextSnapshot,
                                    },
                                };

                                if (state.activeDirectoryKey === directoryKey) {
                                    nextState.agents = safeAgents;
                                    nextState.opencodeDefaultAgent = opencodeDefaultAgent;
                                    nextState.opencodeDefaultModel = opencodeDefaultModel;
                                }

                                return nextState;
                            });

                            const latestConfigState = get();
                            const latestSnapshot = latestConfigState.directoryScoped[directoryKey];
                            const opencodeDefaultAgent = latestSnapshot?.opencodeDefaultAgent
                                ?? (latestConfigState.activeDirectoryKey === directoryKey ? latestConfigState.opencodeDefaultAgent : undefined);
                            const opencodeDefaultModel = latestSnapshot?.opencodeDefaultModel
                                ?? (latestConfigState.activeDirectoryKey === directoryKey ? latestConfigState.opencodeDefaultModel : undefined);

                            const shouldPersistResolvedZenModel =
                                !!resolvedZenModel &&
                                resolvedZenModel !== defaultZenModel;

                            if (isCurrent() && shouldPersistResolvedZenModel && resolvedZenModel) {
                                updateDesktopSettings({
                                    zenModel: resolvedZenModel,
                                    gitProviderId: '',
                                    gitModelId: '',
                                }).catch(() => {
                                    // Ignore errors - best effort cleanup
                                });
                            }

                            if (safeAgents.length === 0) {
                                // A later project overlay must not blank the already-loaded
                                // global catalog unless this is an explicit force-refresh.
                                if (previousAgents.length > 0 && !options?.forceRefresh) {
                                    if (!isCurrent()) return false;
                                    const loaderEnded = typeof performance !== 'undefined' ? performance.now() : Date.now();
                                    markStartupTrace('loadAgents:end', {
                                        directoryKey,
                                        source,
                                        requestedDirectory,
                                        effectiveDirectory,
                                        durationMs: Math.round(loaderEnded - loaderStarted),
                                        agents: previousAgents.length,
                                        retainedPrevious: true,
                                    });
                                    return true;
                                }
                                set((state) => {
                                    if (!isCurrent() || state.catalogTransportIdentity !== transport) return state;
                                    const baseSnapshot: DirectoryScopedConfig = state.directoryScoped[directoryKey] ?? {
                                        providers,
                                        agents: [],
                            currentProviderId: "",
                            currentModelId: "",
                            currentVariant: undefined,
                            currentAgentName: undefined,
                                        selectedProviderId: "",
                                        agentModelSelections: {},
                                        defaultProviders: {},
                                    };

                                    const nextSnapshot: DirectoryScopedConfig = {
                                        ...baseSnapshot,
                                        providers,
                                        agents: [],
                                        currentAgentName: undefined,
                                    };

                                    const nextState: Partial<ConfigStore> = {
                                        directoryScoped: {
                                            ...state.directoryScoped,
                                            [directoryKey]: nextSnapshot,
                                        },
                                    };

                                    if (state.activeDirectoryKey === directoryKey) {
                                        nextState.currentAgentName = undefined;
                                    }

                                    return nextState;
                                });

                                if (!isCurrent()) return false;
                                const loaderEnded = typeof performance !== 'undefined' ? performance.now() : Date.now();
                                markStartupTrace('loadAgents:end', {
                                    directoryKey,
                                    source,
                                    requestedDirectory,
                                    effectiveDirectory,
                                    durationMs: Math.round(loaderEnded - loaderStarted),
                                    agents: safeAgents.length,
                                });
                                return true;
                            }

                            // Helper to validate model exists in providers
                            const validateModel = (providerId: string, modelId: string): boolean => {
                                const provider = providers.find((p) => p.id === providerId);
                                if (!provider) return false;
                                return provider.models.some((m) => m.id === modelId);
                            };

                            // Detect invalid OpenChamber settings so we can clear them from storage.
                            // This is independent of resolution: even though the cascade below falls
                            // back gracefully, stale settings pointing at removed agents/models/variants
                            // should be cleaned up.
                            const invalidSettings: { defaultModel?: string; defaultVariant?: string; defaultAgent?: string } = {};
                            if (openChamberDefaults.defaultAgent && !safeAgents.some((agent) => agent.name === openChamberDefaults.defaultAgent)) {
                                invalidSettings.defaultAgent = '';
                            }
                            if (openChamberDefaults.defaultModel) {
                                const parsed = parseModelString(openChamberDefaults.defaultModel);
                                if (!parsed || !validateModel(parsed.providerId, parsed.modelId)) {
                                    invalidSettings.defaultModel = '';
                                } else if (openChamberDefaults.defaultVariant) {
                                    const provider = providers.find((p) => p.id === parsed.providerId);
                                    const model = provider?.models.find((m) => m.id === parsed.modelId) as { variants?: Record<string, unknown> } | undefined;
                                    const variants = model?.variants;
                                    if (!(variants && Object.prototype.hasOwnProperty.call(variants, openChamberDefaults.defaultVariant))) {
                                        invalidSettings.defaultVariant = '';
                                    }
                                }
                            }

                            // Resolve agent + model via the shared cascade:
                            //   Project lastUserSelection → global lastUserSelection
                            //   → settings/opencode defaults → build/first → model defaults/pins
                            const stateForResolve = get();
                            const directoryLastUserSelection = stateForResolve.directoryScoped[directoryKey]?.lastUserSelection
                                ?? (stateForResolve.activeDirectoryKey === directoryKey ? stateForResolve.lastUserSelection : undefined);
                            const resolvedDefault = resolveDefaultAgentModelSelection({
                                agents: safeAgents,
                                providers,
                                settingsDefaultAgent: openChamberDefaults.defaultAgent,
                                settingsDefaultModel: openChamberDefaults.defaultModel,
                                settingsDefaultVariant: openChamberDefaults.defaultVariant,
                                opencodeDefaultAgent,
                                opencodeDefaultModel,
                                projectLastUserSelection: directoryLastUserSelection,
                                globalLastUserSelection: stateForResolve.globalLastUserSelection,
                            });
                            const resolvedAgentName = resolvedDefault.agentName ?? safeAgents[0].name;
                            const resolvedProviderId = resolvedDefault.providerId;
                            const resolvedModelId = resolvedDefault.modelId;
                            const resolvedVariant = resolvedDefault.variant;

                            set((state) => {
                                if (!isCurrent() || state.catalogTransportIdentity !== transport) return state;
                                const baseSnapshot: DirectoryScopedConfig = state.directoryScoped[directoryKey] ?? {
                                    providers,
                                    agents: safeAgents,
                                    currentProviderId: "",
                                    currentModelId: "",
                                    currentAgentName: undefined,
                                    selectedProviderId: "",
                                    agentModelSelections: {},
                                    defaultProviders: {},
                                };
                                const isActive = state.activeDirectoryKey === directoryKey;
                                const currentAgentName = isActive ? state.currentAgentName : baseSnapshot.currentAgentName;
                                const currentProviderId = isActive ? state.currentProviderId : baseSnapshot.currentProviderId;
                                const currentModelId = isActive ? state.currentModelId : baseSnapshot.currentModelId;
                                const currentVariant = isActive ? state.currentVariant : baseSnapshot.currentVariant;
                                const selectionSource = isActive ? state.selectionSource : (baseSnapshot.selectionSource ?? "auto");
                                const nextSelection = resolveSelectionWithManualGuard({
                                    agents: safeAgents,
                                    providers,
                                    currentAgentName,
                                    currentProviderId,
                                    currentModelId,
                                    currentVariant,
                                    selectionSource,
                                    resolvedAgentName,
                                    resolvedProviderId,
                                    resolvedModelId,
                                    resolvedVariant,
                                });

                                const nextSnapshot: DirectoryScopedConfig = {
                                    ...baseSnapshot,
                                    providers,
                                    agents: safeAgents,
                                    currentAgentName: nextSelection.agentName,
                                    currentProviderId: nextSelection.providerId ?? baseSnapshot.currentProviderId,
                                    currentModelId: nextSelection.modelId ?? baseSnapshot.currentModelId,
                                    currentVariant: nextSelection.variant,
                                    opencodeDefaultAgent,
                                    opencodeDefaultModel,
                                    selectionSource: nextSelection.selectionSource,
                                };

                                const nextState: Partial<ConfigStore> = {
                                    directoryScoped: {
                                        ...state.directoryScoped,
                                        [directoryKey]: nextSnapshot,
                                    },
                                };

                                if (isActive) {
                                    nextState.currentAgentName = nextSelection.agentName;
                                    nextState.opencodeDefaultAgent = opencodeDefaultAgent;
                                    nextState.opencodeDefaultModel = opencodeDefaultModel;
                                    if (nextSelection.providerId && nextSelection.modelId) {
                                        nextState.currentProviderId = nextSelection.providerId;
                                        nextState.currentModelId = nextSelection.modelId;
                                        nextState.currentVariant = nextSelection.variant;
                                    }
                                    nextState.selectionSource = nextSelection.selectionSource;
                                }

                                return nextState;
                            });

                            // Clear invalid settings from storage (best-effort cleanup)
                            if (isCurrent() && Object.keys(invalidSettings).length > 0) {
                                // Also clear from store state
                                 set({
                                     settingsDefaultModel: invalidSettings.defaultModel !== undefined ? undefined : get().settingsDefaultModel,
                                     settingsDefaultVariant: invalidSettings.defaultVariant !== undefined ? undefined : get().settingsDefaultVariant,
                                     settingsDefaultAgent: invalidSettings.defaultAgent !== undefined ? undefined : get().settingsDefaultAgent,
                                 });
                                updateDesktopSettings(invalidSettings).catch(() => {
                                    // Ignore errors - best effort cleanup
                                });
                            }

                            if (!isCurrent()) return false;
                            const loaderEnded = typeof performance !== 'undefined' ? performance.now() : Date.now();
                            markStartupTrace('loadAgents:end', {
                                directoryKey,
                                source,
                                requestedDirectory,
                                effectiveDirectory,
                                durationMs: Math.round(loaderEnded - loaderStarted),
                                agents: safeAgents.length,
                            });
                            return true;
                    } catch (error) {
                    if (!isCurrent()) return false;
                    console.error("Failed to load agents:", error);
                    markStartupTrace('loadAgents:error', {
                        directoryKey,
                        source,
                        requestedDirectory,
                        effectiveDirectory,
                        error: error instanceof Error ? error.message : String(error),
                    });

                    if (!isCurrent()) return false;
                    set((state) => {
                        if (!isCurrent() || state.catalogTransportIdentity !== transport) return state;
                        const providers = state.activeDirectoryKey === directoryKey
                            ? state.providers
                            : (state.directoryScoped[directoryKey]?.providers ?? []);

                        const baseSnapshot: DirectoryScopedConfig = state.directoryScoped[directoryKey] ?? {
                            providers,
                            agents: [],
                            currentProviderId: "",
                            currentModelId: "",
                            currentAgentName: undefined,
                            selectedProviderId: "",
                            agentModelSelections: {},
                            defaultProviders: {},
                        };

                        const nextSnapshot: DirectoryScopedConfig = {
                            ...baseSnapshot,
                            providers,
                            agents: previousAgents,
                        };

                        const nextState: Partial<ConfigStore> = {
                            directoryScoped: {
                                ...state.directoryScoped,
                                [directoryKey]: nextSnapshot,
                            },
                        };

                        if (state.activeDirectoryKey === directoryKey) {
                            nextState.agents = previousAgents;
                        }

                        return nextState;
                    });

                    return false;
                    }
                    })().finally(() => {
                        if (_agentLoadEpochByDirectory[directoryKey] !== loadEpoch) return;
                        set((state) => ({
                            agentConfigLoadingByDirectory: {
                                ...state.agentConfigLoadingByDirectory,
                                [directoryKey]: false,
                            },
                        }));
                    });

                    return promise;
                },

                setAgent: (agentName: string | undefined) => {
                    const {
                        agents,
                        providers,
                        settingsDefaultModel,
                        settingsDefaultVariant,
                        currentProviderId,
                        currentModelId,
                    } = get();

                    set((state) => {
                        const directoryKey = state.activeDirectoryKey;
                        const baseSnapshot: DirectoryScopedConfig = state.directoryScoped[directoryKey] ?? {
                            providers: state.providers,
                            agents: state.agents,
                            currentProviderId: state.currentProviderId,
                            currentModelId: state.currentModelId,
                            currentAgentName: state.currentAgentName,
                            selectedProviderId: state.selectedProviderId,
                            agentModelSelections: state.agentModelSelections,
                            defaultProviders: state.defaultProviders,
                        };

                        const nextSnapshot: DirectoryScopedConfig = {
                            ...baseSnapshot,
                            currentAgentName: agentName,
                            selectionSource: "manual",
                        };

                        return {
                            currentAgentName: agentName,
                            selectionSource: "manual",
                            directoryScoped: {
                                ...state.directoryScoped,
                                [directoryKey]: nextSnapshot,
                            },
                        };
                    });

                    if (agentName) {
                        const { currentSessionId } = useSessionUIStore.getState();
                        const selState = useSelectionStore.getState();

                        if (currentSessionId) {
                            selState.saveSessionAgentSelection(currentSessionId, agentName);
                        }

                        if (currentSessionId && useSessionUIStore.getState().isOpenChamberCreatedSession(currentSessionId)) {
                            const existingAgentModel = selState.getAgentModelForSession(currentSessionId, agentName);
                            if (!existingAgentModel) {
                                useSessionUIStore.getState().initializeNewOpenChamberSession(currentSessionId, agents);
                            }
                        }
                    }

                    if (agentName) {
                        const { currentSessionId } = useSessionUIStore.getState();

                        const applyResolvedModelSelection = (providerId: string, modelId: string, variant?: string) => {
                            set((state) => {
                                const directoryKey = state.activeDirectoryKey;
                                const baseSnapshot: DirectoryScopedConfig = state.directoryScoped[directoryKey] ?? {
                                    providers: state.providers,
                                    agents: state.agents,
                                    currentProviderId: state.currentProviderId,
                                    currentModelId: state.currentModelId,
                                    currentVariant: state.currentVariant,
                                    currentAgentName: state.currentAgentName,
                                    selectedProviderId: state.selectedProviderId,
                                    agentModelSelections: state.agentModelSelections,
                                    defaultProviders: state.defaultProviders,
                                };

                                const nextSnapshot: DirectoryScopedConfig = {
                                    ...baseSnapshot,
                                    currentProviderId: providerId,
                                    currentModelId: modelId,
                                    currentVariant: variant,
                                    selectedProviderId: preserveAddProviderSelection(state.selectedProviderId, providerId),
                                    selectionSource: "manual",
                                };

                                return {
                                    currentProviderId: providerId,
                                    currentModelId: modelId,
                                    currentVariant: variant,
                                    selectedProviderId: preserveAddProviderSelection(state.selectedProviderId, providerId),
                                    selectionSource: "manual",
                                    directoryScoped: {
                                        ...state.directoryScoped,
                                        [directoryKey]: nextSnapshot,
                                    },
                                };
                            });
                        };

                        const agent = agents.find((candidate) => candidate.name === agentName);

                        const resolveVariantForModel = (
                            providerId: string,
                            modelId: string,
                            preferredVariants: Array<string | undefined> = [],
                        ): string | undefined => {
                            const model = providers
                                .find((provider) => provider.id === providerId)
                                ?.models.find((candidate) => candidate.id === modelId) as { variants?: Record<string, unknown> } | undefined;
                            const variants = model?.variants;
                            if (!variants) return undefined;

                            const savedVariant = currentSessionId
                                ? useSelectionStore.getState().getAgentModelVariantForSession(
                                    currentSessionId,
                                    agentName,
                                    providerId,
                                    modelId,
                                )
                                : undefined;

                            for (const candidate of [savedVariant, ...preferredVariants, settingsDefaultVariant]) {
                                if (candidate && Object.prototype.hasOwnProperty.call(variants, candidate)) {
                                    return candidate;
                                }
                            }

                            return undefined;
                        };

                        // Existing session memory for this agent (same conversation continuity).
                        if (currentSessionId) {
                            const existingAgentModel = useSelectionStore.getState().getAgentModelForSession(currentSessionId, agentName);
                            if (existingAgentModel && hasProviderModel(providers, existingAgentModel.providerId, existingAgentModel.modelId)) {
                                const resolvedVariant = resolveVariantForModel(
                                    existingAgentModel.providerId,
                                    existingAgentModel.modelId,
                                    [agent?.variant],
                                );
                                if (
                                    currentProviderId !== existingAgentModel.providerId
                                    || currentModelId !== existingAgentModel.modelId
                                    || get().currentVariant !== resolvedVariant
                                ) {
                                    applyResolvedModelSelection(existingAgentModel.providerId, existingAgentModel.modelId, resolvedVariant);
                                }
                                return;
                            }
                        }

                        // No per-agent Project model map: switching agent mid-draft falls through
                        // to settings/agent pin (or keeps the current model when those are absent).
                        // New-draft unit memory is applied via applyDefaultModelAgentSelection.

                        // Settings / project default model.
                        if (settingsDefaultModel) {
                            const parsed = parseModelString(settingsDefaultModel);
                            if (parsed) {
                                const settingsProvider = providers.find((p) => p.id === parsed.providerId);
                                if (settingsProvider?.models.some((m) => m.id === parsed.modelId)) {
                                    applyResolvedModelSelection(
                                        parsed.providerId,
                                        parsed.modelId,
                                        resolveVariantForModel(parsed.providerId, parsed.modelId, [agent?.variant]),
                                    );
                                    return;
                                }
                            }
                        }

                        // Agent config pin (may include OpenCode-provided defaults).
                        const agentModelSelection = agent?.model;
                        if (agentModelSelection?.providerID && agentModelSelection?.modelID) {
                            const { providerID, modelID } = agentModelSelection;
                            const agentProvider = providers.find((provider) => provider.id === providerID);
                            const agentModel = agentProvider?.models.find((model) => model.id === modelID);

                            if (agentModel) {
                                applyResolvedModelSelection(
                                    providerID,
                                    modelID,
                                    resolveVariantForModel(providerID, modelID, [agent?.variant]),
                                );
                                return;
                            }
                        }

                        // Otherwise keep the current valid model selection unchanged.
                    }
                },

                // Re-applies the same priority cascade used at app startup (see loadAgents):
                //   Project lastUserSelection → global lastUserSelection
                //   → settings/opencode defaults → build/first → model defaults/pins
                // Used when entering a fresh draft session so model/agent reset to remembered
                // unit picks (or defaults), instead of sticking to the previously open session.
                applyDefaultModelAgentSelection: (options) => {
                    const {
                        agents,
                        providers,
                        settingsDefaultModel,
                        settingsDefaultVariant,
                        settingsDefaultAgent,
                        opencodeDefaultAgent,
                        opencodeDefaultModel,
                        lastUserSelection,
                        globalLastUserSelection,
                    } = get();

                    if (agents.length === 0 || providers.length === 0) {
                        return;
                    }

                    const {
                        agentName: resolvedAgentName,
                        providerId: resolvedProviderId,
                        modelId: resolvedModelId,
                        variant: resolvedVariant,
                    } = resolveDefaultAgentModelSelection({
                        agents,
                        providers,
                        projectDefaultModel: options?.projectDefaultModel,
                        settingsDefaultAgent,
                        settingsDefaultModel,
                        settingsDefaultVariant,
                        opencodeDefaultAgent,
                        opencodeDefaultModel,
                        projectLastUserSelection: lastUserSelection,
                        globalLastUserSelection,
                    });

                    if (!resolvedAgentName) {
                        return;
                    }

                    set((state) => {
                        const directoryKey = state.activeDirectoryKey;
                        const baseSnapshot: DirectoryScopedConfig = state.directoryScoped[directoryKey] ?? {
                            providers: state.providers,
                            agents: state.agents,
                            currentProviderId: state.currentProviderId,
                            currentModelId: state.currentModelId,
                            currentVariant: state.currentVariant,
                            currentAgentName: state.currentAgentName,
                            selectedProviderId: state.selectedProviderId,
                            agentModelSelections: state.agentModelSelections,
                            defaultProviders: state.defaultProviders,
                        };

                        const nextSnapshot: DirectoryScopedConfig = {
                            ...baseSnapshot,
                            currentAgentName: resolvedAgentName,
                            ...(resolvedProviderId && resolvedModelId
                                ? {
                                    currentProviderId: resolvedProviderId,
                                    currentModelId: resolvedModelId,
                                    currentVariant: resolvedVariant,
                                    selectedProviderId: preserveAddProviderSelection(state.selectedProviderId, resolvedProviderId),
                                }
                                : {}),
                            selectionSource: "auto",
                        };

                        const nextState: Partial<ConfigStore> = {
                            currentAgentName: resolvedAgentName,
                            selectionSource: "auto",
                            directoryScoped: {
                                ...state.directoryScoped,
                                [directoryKey]: nextSnapshot,
                            },
                        };

                        if (resolvedProviderId && resolvedModelId) {
                            nextState.currentProviderId = resolvedProviderId;
                            nextState.currentModelId = resolvedModelId;
                            nextState.currentVariant = resolvedVariant;
                            nextState.selectedProviderId = preserveAddProviderSelection(state.selectedProviderId, resolvedProviderId);
                        }

                        return nextState;
                    });
                },

                applyOpenCodeConfigDefaults: (directory, source = "syncConfig", config) => {
                    const eventDirectory = directory ?? fromDirectoryKey(get().activeDirectoryKey);
                    const directoryKey = toConfigDirectoryKey(eventDirectory);
                    const configDirectory = fromDirectoryKey(directoryKey);
                    const syncedConfig = config
                        ?? getSyncConfig(eventDirectory ?? undefined)
                        ?? getSyncConfig(configDirectory ?? undefined);
                    if (!syncedConfig) {
                        return;
                    }

                    const opencodeDefaultAgent = normalizeOptionalString(syncedConfig.default_agent);
                    const opencodeDefaultModel = normalizeOptionalString(syncedConfig.model);

                    set((state) => {
                        const snapshot = state.directoryScoped[directoryKey];
                        const isActive = state.activeDirectoryKey === directoryKey;
                        const providers = isActive ? state.providers : (snapshot?.providers ?? []);
                        const agents = isActive ? state.agents : (snapshot?.agents ?? []);
                        const baseSnapshot: DirectoryScopedConfig = snapshot ?? createEmptyDirectoryScopedConfig(providers, agents);
                        const defaultsChanged = baseSnapshot.opencodeDefaultAgent !== opencodeDefaultAgent
                            || baseSnapshot.opencodeDefaultModel !== opencodeDefaultModel
                            || (isActive && (
                                state.opencodeDefaultAgent !== opencodeDefaultAgent
                                || state.opencodeDefaultModel !== opencodeDefaultModel
                            ));
                        const defaultsSnapshot: DirectoryScopedConfig = {
                            ...baseSnapshot,
                            providers,
                            agents,
                            opencodeDefaultAgent,
                            opencodeDefaultModel,
                        };
                        const nextState: Partial<ConfigStore> = {
                            directoryScoped: {
                                ...state.directoryScoped,
                                [directoryKey]: defaultsSnapshot,
                            },
                        };

                        if (isActive) {
                            nextState.opencodeDefaultAgent = opencodeDefaultAgent;
                            nextState.opencodeDefaultModel = opencodeDefaultModel;
                        }

                        const selectionSource = isActive ? state.selectionSource : (snapshot?.selectionSource ?? "auto");

                        if (providers.length === 0 || agents.length === 0) {
                            if (!defaultsChanged) {
                                return state;
                            }
                            return nextState;
                        }

                        const directoryLastUserSelection = isActive
                            ? state.lastUserSelection
                            : snapshot?.lastUserSelection;
                        const resolved = resolveDefaultAgentModelSelection({
                            agents,
                            providers,
                            settingsDefaultAgent: state.settingsDefaultAgent,
                            settingsDefaultModel: state.settingsDefaultModel,
                            settingsDefaultVariant: state.settingsDefaultVariant,
                            opencodeDefaultAgent,
                            opencodeDefaultModel,
                            projectLastUserSelection: directoryLastUserSelection,
                            globalLastUserSelection: state.globalLastUserSelection,
                        });

                        if (!resolved.agentName) {
                            if (!defaultsChanged) {
                                return state;
                            }
                            return nextState;
                        }

                        const currentAgentName = isActive ? state.currentAgentName : baseSnapshot.currentAgentName;
                        const currentProviderId = isActive ? state.currentProviderId : baseSnapshot.currentProviderId;
                        const currentModelId = isActive ? state.currentModelId : baseSnapshot.currentModelId;
                        const currentVariant = isActive ? state.currentVariant : baseSnapshot.currentVariant;
                        const currentSelectedProviderId = isActive ? state.selectedProviderId : baseSnapshot.selectedProviderId;
                        const nextSelection = resolveSelectionWithManualGuard({
                            agents,
                            providers,
                            currentAgentName,
                            currentProviderId,
                            currentModelId,
                            currentVariant,
                            selectionSource,
                            resolvedAgentName: resolved.agentName,
                            resolvedProviderId: resolved.providerId,
                            resolvedModelId: resolved.modelId,
                            resolvedVariant: resolved.variant,
                        });

                        const nextSnapshot: DirectoryScopedConfig = {
                            ...defaultsSnapshot,
                            providers,
                            agents,
                            currentAgentName: nextSelection.agentName,
                            ...(nextSelection.providerId && nextSelection.modelId
                                ? {
                                    currentProviderId: nextSelection.providerId,
                                    currentModelId: nextSelection.modelId,
                                    currentVariant: nextSelection.variant,
                                    selectedProviderId: preserveAddProviderSelection(currentSelectedProviderId, nextSelection.providerId),
                                }
                                : {}),
                            selectionSource: nextSelection.selectionSource,
                        };

                        const selectionChanged = baseSnapshot.currentAgentName !== nextSnapshot.currentAgentName
                            || baseSnapshot.currentProviderId !== nextSnapshot.currentProviderId
                            || baseSnapshot.currentModelId !== nextSnapshot.currentModelId
                            || baseSnapshot.currentVariant !== nextSnapshot.currentVariant
                            || baseSnapshot.selectedProviderId !== nextSnapshot.selectedProviderId
                            || (baseSnapshot.selectionSource ?? "auto") !== nextSnapshot.selectionSource
                            || (isActive && (
                                state.currentAgentName !== nextSelection.agentName
                                || state.selectionSource !== nextSelection.selectionSource
                                || (nextSelection.providerId !== undefined && nextSelection.modelId !== undefined && (
                                    state.currentProviderId !== nextSelection.providerId
                                    || state.currentModelId !== nextSelection.modelId
                                    || state.currentVariant !== nextSelection.variant
                                    || state.selectedProviderId !== preserveAddProviderSelection(currentSelectedProviderId, nextSelection.providerId)
                                ))
                            ));

                        if (!defaultsChanged && !selectionChanged) {
                            return state;
                        }

                        nextState.directoryScoped = {
                            ...state.directoryScoped,
                            [directoryKey]: nextSnapshot,
                        };

                        if (isActive) {
                            nextState.currentAgentName = nextSelection.agentName;
                            nextState.selectionSource = nextSelection.selectionSource;
                            if (nextSelection.providerId && nextSelection.modelId) {
                                nextState.currentProviderId = nextSelection.providerId;
                                nextState.currentModelId = nextSelection.modelId;
                                nextState.currentVariant = nextSelection.variant;
                                nextState.selectedProviderId = preserveAddProviderSelection(currentSelectedProviderId, nextSelection.providerId);
                            }
                        }

                        markStartupTrace('loadAgents:opencodeConfigDefaultsApplied', { directoryKey, eventDirectory, source });
                        return nextState;
                    });
                },

                 setSettingsDefaultModel: (model: string | undefined) => {
                     set({ settingsDefaultModel: model });
                 },

                 setSettingsDefaultVariant: (variant: string | undefined) => {
                     set({ settingsDefaultVariant: variant });
                 },
 
                 setSettingsDefaultAgent: (agent: string | undefined) => {
                     set({ settingsDefaultAgent: agent });
                 },

                setSettingsAutoCreateWorktree: (enabled: boolean) => {
                    set({ settingsAutoCreateWorktree: enabled });
                },

                setSettingsGitmojiEnabled: (enabled: boolean) => {
                    set({ settingsGitmojiEnabled: enabled });
                },

                setSettingsDefaultFileViewerPreview: (enabled: boolean) => {
                    set({ settingsDefaultFileViewerPreview: enabled });
                },

                setSettingsZenModel: (model: string | undefined) => {
                    set({ settingsZenModel: model });
                },

                setSettingsMessageStreamTransport: (transport: 'auto' | 'ws' | 'sse') => {
                    set({ settingsMessageStreamTransport: transport });
                },

                getResolvedGitGenerationModel: () => {
                    const state = get();
                    return resolveGitGenerationModelSelection({
                        providers: state.providers,
                        settingsZenModel: state.settingsZenModel,
                    });
                },

                setVoiceProvider: (provider: 'browser' | 'local' | 'openai' | 'openai-compatible' | 'say') => {
                    set({ voiceProvider: provider });
                    if (typeof window !== 'undefined') {
                        localStorage.setItem('voiceProvider', provider);
                    }
                },

                setSpeechRate: (rate: number) => {
                    const clampedRate = Math.max(0.5, Math.min(2, rate));
                    set({ speechRate: clampedRate });
                    if (typeof window !== 'undefined') {
                        localStorage.setItem('speechRate', String(clampedRate));
                    }
                },

                setSpeechPitch: (pitch: number) => {
                    const clampedPitch = Math.max(0.5, Math.min(2, pitch));
                    set({ speechPitch: clampedPitch });
                    if (typeof window !== 'undefined') {
                        localStorage.setItem('speechPitch', String(clampedPitch));
                    }
                },

                setSpeechVolume: (volume: number) => {
                    const clampedVolume = Math.max(0, Math.min(1, volume));
                    set({ speechVolume: clampedVolume });
                    if (typeof window !== 'undefined') {
                        localStorage.setItem('speechVolume', String(clampedVolume));
                    }
                },

                setSayVoice: (voice: string) => {
                    set({ sayVoice: voice });
                    if (typeof window !== 'undefined') {
                        localStorage.setItem('sayVoice', voice);
                    }
                },

                setLocalTtsVoiceId: (voiceId: number) => {
                    set({ localTtsVoiceId: voiceId });
                    if (typeof window !== 'undefined') {
                        localStorage.setItem('localTtsVoiceId', String(voiceId));
                    }
                },

                setBrowserVoice: (voice: string) => {
                    set({ browserVoice: voice });
                    if (typeof window !== 'undefined') {
                        localStorage.setItem('browserVoice', voice);
                    }
                },

                setOpenaiVoice: (voice: string) => {
                    set({ openaiVoice: voice });
                    if (typeof window !== 'undefined') {
                        localStorage.setItem('openaiVoice', voice);
                    }
                },

                setOpenaiApiKey: (apiKey: string) => {
                    set({ openaiApiKey: apiKey });
                    if (typeof window !== 'undefined') {
                        localStorage.setItem('openaiApiKey', apiKey);
                    }
                },

                setOpenaiCompatibleUrl: (url: string) => {
                    set({ openaiCompatibleUrl: url });
                    if (typeof window !== 'undefined') {
                        localStorage.setItem('openaiCompatibleUrl', url);
                    }
                },

                setOpenaiCompatibleApiKey: (apiKey: string) => {
                    set({ openaiCompatibleApiKey: apiKey });
                    if (typeof window !== 'undefined') {
                        localStorage.setItem('openaiCompatibleApiKey', apiKey);
                    }
                },

                setOpenaiCompatibleVoice: (voice: string) => {
                    set({ openaiCompatibleVoice: voice });
                    if (typeof window !== 'undefined') {
                        localStorage.setItem('openaiCompatibleVoice', voice);
                    }
                },

                setOpenaiCompatibleTtsModel: (model: string) => {
                    set({ openaiCompatibleTtsModel: model });
                    if (typeof window !== 'undefined') {
                        localStorage.setItem('openaiCompatibleTtsModel', model);
                    }
                },

                setDictationEnabled: (enabled: boolean) => {
                    set({ dictationEnabled: enabled });
                    if (typeof window !== 'undefined') {
                        localStorage.setItem('dictationEnabled', String(enabled));
                    }
                    updateDesktopSettings({ dictationEnabled: enabled }).catch(() => {});
                },

                setSttProvider: (provider: 'local' | 'openai-compatible') => {
                    set({ sttProvider: provider });
                    if (typeof window !== 'undefined') {
                        localStorage.setItem('sttProvider', provider);
                    }
                    updateDesktopSettings({ sttProvider: provider }).catch(() => {});
                },

                setSttServerUrl: (url: string) => {
                    set({ sttServerUrl: url });
                    if (typeof window !== 'undefined') {
                        localStorage.setItem('sttServerUrl', url);
                    }
                    updateDesktopSettings({ sttServerUrl: url }).catch(() => {});
                },

                setSttApiKey: (apiKey: string) => {
                    set({ sttApiKey: apiKey });
                    if (typeof window !== 'undefined') {
                        localStorage.setItem('sttApiKey', apiKey);
                    }
                },

                setSttModel: (model: string) => {
                    set({ sttModel: model });
                    if (typeof window !== 'undefined') {
                        localStorage.setItem('sttModel', model);
                    }
                    updateDesktopSettings({ sttModel: model }).catch(() => {});
                },

                setSttLocalModel: (model: string) => {
                    set({ sttLocalModel: model });
                    if (typeof window !== 'undefined') {
                        localStorage.setItem('sttLocalModel', model);
                    }
                    updateDesktopSettings({ sttLocalModel: model }).catch(() => {});
                },

                setSttLanguage: (lang: string) => {
                    set({ sttLanguage: lang });
                    if (typeof window !== 'undefined') {
                        localStorage.setItem('sttLanguage', lang);
                    }
                    updateDesktopSettings({ sttLanguage: lang }).catch(() => {});
                },

                setShowMessageTTSButtons: (show: boolean) => {
                    set({ showMessageTTSButtons: show });
                    if (typeof window !== 'undefined') {
                        localStorage.setItem('showMessageTTSButtons', String(show));
                    }
                },

                setTtsInputMode: (mode: 'sanitized' | 'raw' | 'summarized') => {
                    set({ ttsInputMode: mode });
                    if (typeof window !== 'undefined') {
                        localStorage.setItem('ttsInputMode', mode);
                    }
                },

                setSummarizeMessageTTS: (enabled: boolean) => {
                    set({ summarizeMessageTTS: enabled });
                    if (typeof window !== 'undefined') {
                        localStorage.setItem('summarizeMessageTTS', String(enabled));
                    }
                },

                setSummarizeVoiceConversation: (enabled: boolean) => {
                    set({ summarizeVoiceConversation: enabled });
                    if (typeof window !== 'undefined') {
                        localStorage.setItem('summarizeVoiceConversation', String(enabled));
                    }
                },

                setSummarizeCharacterThreshold: (threshold: number) => {
                    const clamped = Math.max(50, Math.min(2000, threshold));
                    set({ summarizeCharacterThreshold: clamped });
                    if (typeof window !== 'undefined') {
                        localStorage.setItem('summarizeCharacterThreshold', String(clamped));
                    }
                },

                setSummarizeMaxLength: (maxLength: number) => {
                    const clamped = Math.max(50, Math.min(2000, maxLength));
                    set({ summarizeMaxLength: clamped });
                    if (typeof window !== 'undefined') {
                        localStorage.setItem('summarizeMaxLength', String(clamped));
                    }
                },

                probeConnection: async (options?: { timeoutMs?: number }) => {
                    const isHealthy = await probeOpenCodeHealth(options?.timeoutMs);
                    if (isHealthy) {
                        set({ isConnected: true, hasEverConnected: true, connectionPhase: "connected" });
                        return true;
                    }

                    const state = get();
                    if (state.isConnected) {
                        return true;
                    }

                    set({
                        isConnected: false,
                        connectionPhase: state.hasEverConnected ? "reconnecting" : "connecting",
                        lastDisconnectReason: 'health_probe_unhealthy',
                    });
                    return false;
                },

                checkConnection: async () => {
                    markStartupTrace('checkConnection:start');
                    const maxAttempts = 5;
                    let attempt = 0;
                    let lastError: unknown = null;

                    while (attempt < maxAttempts) {
                        try {
                            markStartupTrace('checkConnection:attempt', { attempt: attempt + 1 });
                            const isHealthy = await measureStartupTrace(
                                'checkConnection:health',
                                () => opencodeClient.checkHealth(),
                                { attempt: attempt + 1 },
                            );
                            if (!isHealthy && attempt < maxAttempts - 1) {
                                const hasEverConnected = get().hasEverConnected;
                                set({
                                    isConnected: false,
                                    connectionPhase: hasEverConnected ? "reconnecting" : "connecting",
                                    lastDisconnectReason: 'health_check_unhealthy',
                                });
                                attempt += 1;
                                await sleep(400 * attempt);
                                continue;
                            }

                            const hasEverConnected = get().hasEverConnected;
                            set(isHealthy
                                ? { isConnected: true, hasEverConnected: true, connectionPhase: "connected" }
                                : {
                                    isConnected: false,
                                    connectionPhase: hasEverConnected ? "reconnecting" : "connecting",
                                    lastDisconnectReason: 'health_check_unhealthy',
                                });
                            markStartupTrace('checkConnection:end', { healthy: isHealthy, attempts: attempt + 1 });
                            return isHealthy;
                        } catch (error) {
                            lastError = error;
                            attempt += 1;
                            const delay = 400 * attempt;
                            await sleep(delay);
                        }
                    }

                    if (lastError) {
                        console.warn("[ConfigStore] Failed to reach OpenCode after retrying:", lastError);
                    }
                    set({
                        isConnected: false,
                        connectionPhase: get().hasEverConnected ? "reconnecting" : "connecting",
                        lastDisconnectReason: 'health_check_failed',
                    });
                    markStartupTrace('checkConnection:end', { healthy: false, attempts: maxAttempts });
                    return false;
                },

                initializeApp: async () => {
                    if (_initializeAppInFlight) {
                        markStartupTrace('initializeApp:deduped');
                        return _initializeAppInFlight;
                    }

                    const run = (async () => {
                        const initStarted = typeof performance !== 'undefined' ? performance.now() : Date.now();
                        markStartupTrace('initializeApp:start');
                        try {
                            const debug = streamDebugEnabled();
                            if (debug) console.log("Starting app initialization...");

                            const isConnected = await get().checkConnection();
                            if (debug) console.log("Connection check result:", isConnected);

                            if (!isConnected) {
                                if (debug) console.log("Server not connected");
                                // checkConnection already set lastDisconnectReason; do not overwrite.
                                set({
                                    isConnected: false,
                                    connectionPhase: get().hasEverConnected ? "reconnecting" : "connecting",
                                });
                                return;
                            }

                            if (debug) console.log("Initializing app...");
                            markStartupTrace('initApp:skipped', { reason: 'checkConnection already verified health' });

                            // Stale-while-revalidate: do NOT invalidate the hydrated
                            // provider snapshot here. The pickers keep showing the
                            // last-known providers/agents while loadProviders/loadAgents
                            // below fetch fresh data and overwrite on success. Clearing
                            // first would blank the UI for the duration of the fetch.

                            // Config (providers/agents/defaults) lives at the PROJECT level. If the
                            // app starts on a worktree directory, load config under the owning
                            // project's key so the initial draft — which activates the project — finds
                            // a ready snapshot instead of triggering a second provider/agent load.
                            const initialDirectory = opencodeClient.getDirectory()
                                ?? useDirectoryStore.getState().currentDirectory
                                ?? fromDirectoryKey(get().activeDirectoryKey);
                            const resolvedProject = resolveProjectForSessionDirectory(
                                useProjectsStore.getState().projects,
                                useSessionUIStore.getState().availableWorktreesByProject,
                                initialDirectory ?? null,
                            );
                            const resolvedInitialDirectory = resolveConfigDirectory(resolvedProject?.path ?? initialDirectory ?? null);
                            const configDirectory = resolvedInitialDirectory ?? getFallbackProjectDirectory();
                            if (!configDirectory) {
                                markStartupTrace('initializeApp:noProjectConfigDirectory');
                                set({ isInitialized: true, isConnected: true, hasEverConnected: true, connectionPhase: "connected" });
                                return;
                            }
                            if (!resolvedInitialDirectory && initialDirectory !== configDirectory) {
                                markStartupTrace('initializeApp:normalizedUnknownDirectoryToProject', {
                                    initialDirectory,
                                    configDirectory,
                                });
                                opencodeClient.setDirectory(configDirectory);
                                useDirectoryStore.getState().setDirectory(configDirectory, { showOverlay: false });
                            }
                            const configDirectoryKey = toDirectoryKey(configDirectory);
                            if (get().activeDirectoryKey !== configDirectoryKey) {
                                set({ activeDirectoryKey: configDirectoryKey });
                            }

                            if (debug) console.log("Loading providers and agents...");
                            await Promise.all([
                                get().loadProviders({ directory: configDirectory, source: 'initializeApp', forceRefresh: true }),
                                get().loadAgents({ directory: configDirectory, source: 'initializeApp' }),
                            ]);

                            set({ isInitialized: true, isConnected: true, hasEverConnected: true, connectionPhase: "connected" });
                            const initEnded = typeof performance !== 'undefined' ? performance.now() : Date.now();
                            markStartupTrace('initializeApp:end', {
                                durationMs: Math.round(initEnded - initStarted),
                                providers: get().providers.length,
                                agents: get().agents.length,
                            });
                            if (debug) console.log("App initialized successfully");
                        } catch (error) {
                            console.error("Failed to initialize app:", error);
                            set({
                                isInitialized: false,
                                isConnected: false,
                                connectionPhase: get().hasEverConnected ? "reconnecting" : "connecting",
                                lastDisconnectReason: 'init_error',
                            });
                            markStartupTrace('initializeApp:error', { error: error instanceof Error ? error.message : String(error) });
                        }
                    })().finally(() => {
                        _initializeAppInFlight = null;
                    });

                    _initializeAppInFlight = run;
                    return run;
                },

                prewarmProjectConfigs: async (initialDirectory?: string | null) => {
                    if (!get().isConnected) {
                        return;
                    }

                    const initialKey = toConfigDirectoryKey(initialDirectory ?? fromDirectoryKey(get().activeDirectoryKey));
                    const projectDirectories = useProjectsStore.getState().projects
                        .map((project) => project.path)
                        .filter((path): path is string => typeof path === 'string' && path.trim().length > 0);
                    const seen = new Set<string>([initialKey]);
                    const queuedDirectories: string[] = [];

                    for (const directory of projectDirectories) {
                        const directoryKey = toConfigDirectoryKey(directory);
                        if (seen.has(directoryKey)) {
                            continue;
                        }
                        seen.add(directoryKey);

                        const snapshot = get().directoryScoped[directoryKey];
                        if ((snapshot?.providers.length || get().providers.length > 0) && (snapshot?.agents.length || get().agents.length > 0)) {
                            continue;
                        }
                        const scopedDirectory = fromDirectoryKey(directoryKey);
                        if (scopedDirectory) {
                            queuedDirectories.push(scopedDirectory);
                        }
                    }

                    for (const directory of queuedDirectories) {
                        await sleep(PROJECT_CONFIG_PREWARM_DELAY_MS);
                        if (!get().isConnected) {
                            return;
                        }
                        const directoryKey = toConfigDirectoryKey(directory);
                        const snapshot = get().directoryScoped[directoryKey];
                        const tasks: Promise<unknown>[] = [];
                        if (!snapshot?.providers.length && get().providers.length === 0) {
                            tasks.push(get().loadProviders({ directory, source: 'projectConfigPrewarm' }));
                        }
                        if (!snapshot?.agents.length && get().agents.length === 0) {
                            tasks.push(get().loadAgents({ directory, source: 'projectConfigPrewarm' }));
                        }
                        if (tasks.length > 0) {
                            await Promise.allSettled(tasks);
                        }
                    }
                },

                getCurrentProvider: () => {
                    const { providers, currentProviderId } = get();
                    return providers.find((p) => p.id === currentProviderId);
                },

                getCurrentModel: () => {
                    const provider = get().getCurrentProvider();
                    const { currentModelId } = get();
                    if (!provider) {
                        return undefined;
                    }
                    return provider.models.find((model) => model.id === currentModelId);
                },

                getCurrentAgent: () => {
                    const { agents, currentAgentName } = get();
                    if (!currentAgentName) return undefined;
                    return agents.find((a) => a.name === currentAgentName);
                },
                getModelMetadata: (providerId: string, modelId: string) => {
                    if (!providerId || !modelId) {
                        return undefined;
                    }
                    const provider = get().providers.find((p) => p.id === providerId);
                    if (!provider) {
                        return undefined;
                    }
                    const model = provider.models.find((m) => m.id === modelId);
                    if (!model) {
                        return undefined;
                    }
                    return deriveModelMetadata(providerId, model);
                },
                getVisibleAgents: () => {
                    const { agents } = get();
                    return filterVisibleAgents(agents);
                },
            }),
            {
                name: "config-store",
                version: 4,
                storage: createDeferredSafeJSONStorage(),
                migrate: (persistedState) => sanitizePersistedCatalogState(persistedState),
                merge: (persistedState, currentState) =>
                    hydrateActiveDirectorySnapshot({
                        ...currentState,
                        ...sanitizePersistedCatalogState(persistedState),
                    }),
                partialize: (state) => {
                    const activeSnapshot = state.directoryScoped[state.activeDirectoryKey];
                    const globalCatalog = state.providers.length > 0
                        ? {
                            providers: sanitizeProviderList(state.providers),
                            defaultProviders: sanitizeDefaultProviders(state.defaultProviders),
                            providerCatalogPartial: false,
                        }
                        : activeSnapshot && activeSnapshot.providerCatalogPartial !== true
                            ? {
                                providers: sanitizeProviderList(activeSnapshot.providers),
                                defaultProviders: sanitizeDefaultProviders(activeSnapshot.defaultProviders),
                                providerCatalogPartial: false,
                            }
                            : { providers: [], defaultProviders: {}, providerCatalogPartial: activeSnapshot?.providerCatalogPartial === true };
                    const activeCatalog = globalCatalog;
                    const serializeDirectorySnapshot = (
                        directoryKey: string,
                        snapshot: DirectoryScopedConfig | undefined,
                    ) => {
                        const lastUserSelection = sanitizeLastUserSelection(snapshot?.lastUserSelection)
                            ?? deriveLastUserSelectionFromLegacy(
                                sanitizeSelectionIdentifier(snapshot?.lastSelectedAgentName, true),
                                sanitizeAgentModelSelections(snapshot?.agentModelSelections),
                            )
                            ?? (directoryKey === state.activeDirectoryKey
                                ? sanitizeLastUserSelection(state.lastUserSelection)
                                : undefined);
                        return {
                            ...(directoryKey === state.activeDirectoryKey
                                ? activeCatalog
                                : { providers: [], defaultProviders: {}, providerCatalogPartial: snapshot?.providerCatalogPartial === true }),
                            agents: [],
                            currentProviderId: snapshot?.currentProviderId ?? (directoryKey === state.activeDirectoryKey ? state.currentProviderId : ''),
                            currentModelId: snapshot?.currentModelId ?? (directoryKey === state.activeDirectoryKey ? state.currentModelId : ''),
                            currentVariant: snapshot?.currentVariant ?? (directoryKey === state.activeDirectoryKey ? state.currentVariant : undefined),
                            currentAgentName: snapshot?.currentAgentName ?? (directoryKey === state.activeDirectoryKey ? state.currentAgentName : undefined),
                            selectedProviderId: sanitizePersistedSelectedProviderId(
                                snapshot?.selectedProviderId ?? (directoryKey === state.activeDirectoryKey ? state.selectedProviderId : ''),
                            ),
                            agentModelSelections: {},
                            lastSelectedAgentName: lastUserSelection?.agentName
                                ?? sanitizeSelectionIdentifier(snapshot?.lastSelectedAgentName, true),
                            lastUserSelection,
                            opencodeDefaultAgent: snapshot?.opencodeDefaultAgent,
                            opencodeDefaultModel: snapshot?.opencodeDefaultModel,
                            selectionSource: snapshot?.selectionSource ?? (directoryKey === state.activeDirectoryKey ? state.selectionSource : undefined),
                        };
                    };
                    const directoryScoped = Object.fromEntries(
                        Object.entries(state.directoryScoped).map(([directoryKey, snapshot]) => [
                            directoryKey,
                            serializeDirectorySnapshot(directoryKey, snapshot),
                        ]),
                    );
                    if (state.activeDirectoryKey && !directoryScoped[state.activeDirectoryKey]) {
                        directoryScoped[state.activeDirectoryKey] = serializeDirectorySnapshot(
                            state.activeDirectoryKey,
                            undefined,
                        );
                    }
                    const activeCatalogSerialized = JSON.stringify(activeCatalog);
                    if (persistedCatalogTextEncoder.encode(activeCatalogSerialized).byteLength > PERSISTED_CONFIG_CATALOG_BYTE_BUDGET) {
                        const active = directoryScoped[state.activeDirectoryKey] as Record<string, unknown> | undefined;
                        if (active) {
                            active.providers = [];
                            active.defaultProviders = {};
                            active.providerCatalogPartial = true;
                        }
                    }
                    const globalLastUserSelection = sanitizeLastUserSelection(state.globalLastUserSelection)
                        ?? sanitizeLastUserSelection(state.lastUserSelection);
                    return {
                        activeDirectoryKey: state.activeDirectoryKey,
                        catalogTransportIdentity: getRuntimeTransportIdentity(),
                        directoryScoped,
                        currentProviderId: state.currentProviderId,
                        currentModelId: state.currentModelId,
                        currentVariant: state.currentVariant,
                        currentAgentName: state.currentAgentName,
                        selectedProviderId: sanitizePersistedSelectedProviderId(state.selectedProviderId),
                        agentModelSelections: {},
                        lastSelectedAgentName: globalLastUserSelection?.agentName
                            ?? sanitizeSelectionIdentifier(state.lastSelectedAgentName, true),
                        lastUserSelection: sanitizeLastUserSelection(state.lastUserSelection) ?? globalLastUserSelection,
                        globalLastUserSelection,
                        settingsDefaultModel: state.settingsDefaultModel,
                        settingsDefaultVariant: state.settingsDefaultVariant,
                        settingsDefaultAgent: state.settingsDefaultAgent,
                        settingsAutoCreateWorktree: state.settingsAutoCreateWorktree,
                        settingsGitmojiEnabled: state.settingsGitmojiEnabled,
                        settingsDefaultFileViewerPreview: state.settingsDefaultFileViewerPreview,
                        settingsZenModel: state.settingsZenModel,
                        settingsMessageStreamTransport: state.settingsMessageStreamTransport,
                        speechRate: state.speechRate,
                        speechPitch: state.speechPitch,
                        speechVolume: state.speechVolume,
                    };
                },
             },
         ),
    ),
);

if (typeof window !== "undefined") {
    window.__zustand_config_store__ = useConfigStore;
}

const refreshKnownProviderDirectories = async (source: string): Promise<void> => {
    await useConfigStore.getState().loadProviders({
        source,
        forceRefresh: true,
    });
};

let unsubscribeConfigStoreChanges: (() => void) | null = null;

if (!unsubscribeConfigStoreChanges) {
    unsubscribeConfigStoreChanges = subscribeToConfigChanges(async (event) => {
            const tasks: Promise<void>[] = [];

        opencodeClient.clearConfigCache();

        if (scopeMatches(event, "agents")) {
            const { loadAgents } = useConfigStore.getState();
            tasks.push(loadAgents({ source: 'configChange:agents', forceRefresh: true }).then(() => {}));
        }

        if (scopeMatches(event, "providers")) {
            tasks.push(refreshKnownProviderDirectories('configChange:providers'));
        }

        if (tasks.length > 0) {
            await Promise.all(tasks);
        }
    });
}

let unsubscribeConfigStoreDirectoryChanges: (() => void) | null = null;

let unsubscribeConfigStoreSyncConfigChanges: (() => void) | null = null;

if (!unsubscribeConfigStoreSyncConfigChanges) {
    unsubscribeConfigStoreSyncConfigChanges = subscribeToSyncConfigChanges((directory, config) => {
        useConfigStore.getState().applyOpenCodeConfigDefaults(directory, 'syncConfig', config);
    });
}

if (typeof window !== "undefined" && !unsubscribeConfigStoreDirectoryChanges) {
    unsubscribeConfigStoreDirectoryChanges = useDirectoryStore.subscribe((state, prevState) => {
        const nextKey = toDirectoryKey(state.currentDirectory);
        const prevKey = toDirectoryKey(prevState.currentDirectory);
        if (nextKey === prevKey) {
            return;
        }

        markStartupTrace('directoryStore:changed', { previous: prevKey, next: nextKey });
        void useConfigStore.getState().activateDirectory(state.currentDirectory);
    });
}
