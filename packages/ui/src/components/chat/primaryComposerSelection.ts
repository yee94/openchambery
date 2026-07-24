export type PrimaryComposerSelectionPatch = {
  providerID?: string;
  modelID?: string;
  agent?: string;
  variant?: string;
};

export type PrimaryComposerSelectionConfig = {
  currentAgentName?: string;
  setAgent: (agentName: string | undefined) => void;
  setProvider: (providerId: string) => void;
  setModel: (modelId: string) => void;
  setCurrentVariant: (variant: string | undefined) => void;
  saveAgentModelSelection: (
    agentName: string,
    providerId: string,
    modelId: string,
    variant?: string,
  ) => void;
};

export type PrimaryComposerSelectionMemory = {
  saveSessionModelSelection: (sessionId: string, providerId: string, modelId: string) => void;
  saveSessionAgentSelection?: (sessionId: string, agentName: string) => void;
  saveAgentModelForSession: (
    sessionId: string,
    agentName: string,
    providerId: string,
    modelId: string,
  ) => void;
  saveAgentModelVariantForSession: (
    sessionId: string,
    agentName: string,
    providerId: string,
    modelId: string,
    variant: string | undefined,
  ) => void;
  getSessionModelSelection?: (sessionId: string) => { providerId: string; modelId: string } | null;
  getSessionAgentSelection?: (sessionId: string) => string | null;
  getAgentModelForSession?: (
    sessionId: string,
    agentName: string,
  ) => { providerId: string; modelId: string } | null;
  getAgentModelVariantForSession?: (
    sessionId: string,
    agentName: string,
    providerId: string,
    modelId: string,
  ) => string | undefined;
};

export type PrimaryComposerLatestUserChoice = {
  id?: string;
  agent?: string;
  providerID?: string;
  modelID?: string;
  variant?: string;
};

export type PrimaryComposerCatalog = {
  providers: ReadonlyArray<{
    id: string;
    models?: ReadonlyArray<{ id: string; variants?: unknown }>;
  }>;
  agents: ReadonlyArray<{ name: string }>;
};

export type ResolvedPrimaryComposerSessionSelection = {
  agent?: string;
  providerID: string;
  modelID: string;
  /** Explicit variant to apply; `undefined` clears any previous variant. */
  variant: string | undefined;
  source: 'history' | 'session-memory';
  messageId?: string;
};

/**
 * Apply a primary composer selection patch.
 *
 * setAgent re-applies the agent-scoped model cascade (session memory →
 * remembered pick → defaults). Calling it after an explicit model pick would
 * immediately overwrite the user's choice, so only run it when the agent
 * itself changes, and always apply provider/model/variant after.
 */
export const applyPrimaryComposerSelectionChange = (
  selection: PrimaryComposerSelectionPatch,
  config: PrimaryComposerSelectionConfig,
  options?: {
    sessionId?: string | null;
    memory?: PrimaryComposerSelectionMemory;
  },
): void => {
  const nextAgent = selection.agent;
  if (nextAgent && nextAgent !== config.currentAgentName) {
    config.setAgent(nextAgent);
  }

  if (selection.providerID) {
    config.setProvider(selection.providerID);
  }
  if (selection.modelID) {
    config.setModel(selection.modelID);
  }
  config.setCurrentVariant(selection.variant);

  const agentName = nextAgent ?? config.currentAgentName;
  if (agentName && selection.providerID && selection.modelID) {
    config.saveAgentModelSelection(
      agentName,
      selection.providerID,
      selection.modelID,
      selection.variant,
    );
  }

  const sessionId = options?.sessionId;
  const memory = options?.memory;
  if (!sessionId || !memory || !selection.providerID || !selection.modelID) {
    return;
  }

  memory.saveSessionModelSelection(sessionId, selection.providerID, selection.modelID);
  if (agentName && memory.saveSessionAgentSelection) {
    memory.saveSessionAgentSelection(sessionId, agentName);
  }
  if (!agentName) {
    return;
  }

  memory.saveAgentModelForSession(sessionId, agentName, selection.providerID, selection.modelID);
  memory.saveAgentModelVariantForSession(
    sessionId,
    agentName,
    selection.providerID,
    selection.modelID,
    selection.variant,
  );
};

const catalogHasProviderModel = (
  catalog: PrimaryComposerCatalog,
  providerID: string,
  modelID: string,
): boolean => {
  const provider = catalog.providers.find((entry) => entry.id === providerID);
  if (!provider) {
    return false;
  }
  const models = Array.isArray(provider.models) ? provider.models : [];
  return models.some((model) => model.id === modelID);
};

const catalogHasAgent = (catalog: PrimaryComposerCatalog, agentName: string): boolean =>
  catalog.agents.some((agent) => agent.name === agentName);

const catalogHasVariant = (
  catalog: PrimaryComposerCatalog,
  providerID: string,
  modelID: string,
  variant: string | undefined,
): boolean => {
  if (!variant) {
    return true;
  }
  const provider = catalog.providers.find((entry) => entry.id === providerID);
  const model = provider?.models?.find((entry) => entry.id === modelID) as
    | { variants?: unknown }
    | undefined;
  const variants = model?.variants;
  if (!variants) {
    return false;
  }
  if (Array.isArray(variants)) {
    return variants.includes(variant);
  }
  if (typeof variants === 'object') {
    return Object.prototype.hasOwnProperty.call(variants, variant);
  }
  return false;
};

/**
 * Resolve the session selection to restore into the primary composer.
 *
 * History (latest user message) is the cross-client authoritative baseline.
 * Same-client selection-store memory is the fallback when messages are not
 * ready or the history choice fails catalog validation.
 */
export const resolvePrimaryComposerSessionSelection = (options: {
  sessionId: string;
  latestUserChoice?: PrimaryComposerLatestUserChoice | null;
  catalog: PrimaryComposerCatalog;
  memory?: Pick<
    PrimaryComposerSelectionMemory,
    | 'getSessionModelSelection'
    | 'getSessionAgentSelection'
    | 'getAgentModelForSession'
    | 'getAgentModelVariantForSession'
  >;
  /** Current config agent used only when history omits agent and memory has none. */
  fallbackAgentName?: string;
}): ResolvedPrimaryComposerSessionSelection | null => {
  const { sessionId, latestUserChoice, catalog, memory, fallbackAgentName } = options;

  if (
    latestUserChoice?.providerID
    && latestUserChoice.modelID
    && catalogHasProviderModel(catalog, latestUserChoice.providerID, latestUserChoice.modelID)
  ) {
    const historyAgent =
      latestUserChoice.agent && catalogHasAgent(catalog, latestUserChoice.agent)
        ? latestUserChoice.agent
        : (memory?.getSessionAgentSelection?.(sessionId)
          && catalogHasAgent(catalog, memory.getSessionAgentSelection(sessionId)!)
          ? memory.getSessionAgentSelection(sessionId)!
          : (fallbackAgentName && catalogHasAgent(catalog, fallbackAgentName)
            ? fallbackAgentName
            : undefined));

    const variant =
      latestUserChoice.variant
      && catalogHasVariant(
        catalog,
        latestUserChoice.providerID,
        latestUserChoice.modelID,
        latestUserChoice.variant,
      )
        ? latestUserChoice.variant
        : undefined;

    return {
      agent: historyAgent,
      providerID: latestUserChoice.providerID,
      modelID: latestUserChoice.modelID,
      variant,
      source: 'history',
      messageId: latestUserChoice.id,
    };
  }

  if (!memory) {
    return null;
  }

  const savedAgentName = memory.getSessionAgentSelection?.(sessionId) ?? null;
  const agentName =
    savedAgentName && catalogHasAgent(catalog, savedAgentName)
      ? savedAgentName
      : (fallbackAgentName && catalogHasAgent(catalog, fallbackAgentName)
        ? fallbackAgentName
        : undefined);

  if (agentName) {
    const agentModel = memory.getAgentModelForSession?.(sessionId, agentName);
    if (
      agentModel
      && catalogHasProviderModel(catalog, agentModel.providerId, agentModel.modelId)
    ) {
      const savedVariant = memory.getAgentModelVariantForSession?.(
        sessionId,
        agentName,
        agentModel.providerId,
        agentModel.modelId,
      );
      const variant =
        savedVariant
        && catalogHasVariant(catalog, agentModel.providerId, agentModel.modelId, savedVariant)
          ? savedVariant
          : undefined;
      return {
        agent: agentName,
        providerID: agentModel.providerId,
        modelID: agentModel.modelId,
        variant,
        source: 'session-memory',
      };
    }
  }

  const sessionModel = memory.getSessionModelSelection?.(sessionId);
  if (
    sessionModel
    && catalogHasProviderModel(catalog, sessionModel.providerId, sessionModel.modelId)
  ) {
    const savedVariant =
      agentName
        ? memory.getAgentModelVariantForSession?.(
          sessionId,
          agentName,
          sessionModel.providerId,
          sessionModel.modelId,
        )
        : undefined;
    const variant =
      savedVariant
      && catalogHasVariant(catalog, sessionModel.providerId, sessionModel.modelId, savedVariant)
        ? savedVariant
        : undefined;
    return {
      agent: agentName,
      providerID: sessionModel.providerId,
      modelID: sessionModel.modelId,
      variant,
      source: 'session-memory',
    };
  }

  return null;
};

/**
 * Apply a resolved session restore into live config + session memory.
 *
 * Never writes project-scoped agent preferences (`saveAgentModelSelection`).
 * Viewing or restoring a historical session must not change Project defaults.
 */
export const applyPrimaryComposerSessionRestore = (
  selection: ResolvedPrimaryComposerSessionSelection,
  config: Omit<PrimaryComposerSelectionConfig, 'saveAgentModelSelection'>,
  options: {
    sessionId: string;
    memory: PrimaryComposerSelectionMemory;
  },
): void => {
  const nextAgent = selection.agent;
  if (nextAgent && nextAgent !== config.currentAgentName) {
    config.setAgent(nextAgent);
  }

  if (selection.providerID) {
    config.setProvider(selection.providerID);
  }
  if (selection.modelID) {
    config.setModel(selection.modelID);
  }
  // Always apply variant — missing/invalid history variant clears the previous one.
  config.setCurrentVariant(selection.variant);

  const { sessionId, memory } = options;
  memory.saveSessionModelSelection(sessionId, selection.providerID, selection.modelID);

  const agentName = nextAgent ?? config.currentAgentName;
  if (agentName && memory.saveSessionAgentSelection) {
    memory.saveSessionAgentSelection(sessionId, agentName);
  }
  if (!agentName) {
    return;
  }

  memory.saveAgentModelForSession(sessionId, agentName, selection.providerID, selection.modelID);
  memory.saveAgentModelVariantForSession(
    sessionId,
    agentName,
    selection.providerID,
    selection.modelID,
    selection.variant,
  );
};

/** Capture send config from a live primary config-store snapshot (post-flush). */
export const capturePrimaryComposerSendConfig = (
  config: {
    currentProviderId?: string;
    currentModelId?: string;
    currentAgentName?: string;
    currentVariant?: string;
  },
  options?: {
    /** Session Project key; when set, activeDirectoryKey must match or capture aborts. */
    expectedConfigKey?: string;
    activeDirectoryKey?: string;
  },
): { providerID: string; modelID: string; agent?: string; variant?: string } | undefined => {
  // Refuse another Project's live catalog when the session scope is known.
  if (
    options?.expectedConfigKey !== undefined
    && options.activeDirectoryKey !== options.expectedConfigKey
  ) {
    return undefined;
  }
  if (!config.currentProviderId || !config.currentModelId) {
    return undefined;
  }
  return {
    providerID: config.currentProviderId,
    modelID: config.currentModelId,
    agent: config.currentAgentName,
    variant: config.currentVariant,
  };
};

/** Extract the latest user message choice from a message list (newest last). */
export const parseLatestUserChoiceFromMessages = (
  messages: ReadonlyArray<{
    id?: string;
    role?: string;
    agent?: string;
    mode?: string;
    model?: { providerID?: string; modelID?: string; variant?: string };
    variant?: string;
  }>,
): PrimaryComposerLatestUserChoice | null => {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== 'user') {
      continue;
    }

    const providerID =
      typeof message.model?.providerID === 'string' && message.model.providerID.trim().length > 0
        ? message.model.providerID
        : undefined;
    const modelID =
      typeof message.model?.modelID === 'string' && message.model.modelID.trim().length > 0
        ? message.model.modelID
        : undefined;
    const agent =
      typeof message.agent === 'string' && message.agent.trim().length > 0
        ? message.agent
        : (typeof message.mode === 'string' && message.mode.trim().length > 0
          ? message.mode
          : undefined);
    // OpenCode 1.4.0 moved variant from top-level to model.variant.
    const variantCandidate = message.model?.variant ?? message.variant;
    const variant =
      typeof variantCandidate === 'string' && variantCandidate.trim().length > 0
        ? variantCandidate
        : undefined;

    return {
      id: typeof message.id === 'string' ? message.id : undefined,
      agent,
      providerID,
      modelID,
      variant,
    };
  }
  return null;
};
