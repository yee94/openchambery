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
  if (!agentName) {
    return;
  }

  memory.saveAgentModelForSession(sessionId, agentName, selection.providerID, selection.modelID);
  if (selection.variant !== undefined) {
    memory.saveAgentModelVariantForSession(
      sessionId,
      agentName,
      selection.providerID,
      selection.modelID,
      selection.variant,
    );
  }
};
