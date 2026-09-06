import { getAssistantPresentation } from '@/lib/assistantPresentation';
import type { AssistantCapability, AssistantDTO } from '@/lib/assistantsApi';
import {
  type ShareCatalogEntry,
  updateShareCatalog,
} from '@/lib/systemShell/share';

export type ShareCatalogPublishInput = {
  serverInstanceID: string;
  connectionKey: string;
  serverLabel: string;
  assistantsEnabled: boolean;
  assistants: AssistantDTO[];
  /** Exact default share target; never invent one silently when unset. */
  defaultAssistantID?: string | null;
};

export const buildShareCatalogEntries = (input: ShareCatalogPublishInput): ShareCatalogEntry[] => {
  const defaultID = input.defaultAssistantID?.trim() || null;
  return input.assistants.map((assistant) => {
    const presentation = getAssistantPresentation(assistant.name);
    return {
      serverInstanceID: input.serverInstanceID,
      assistantID: assistant.id,
      name: presentation.displayName || assistant.name,
      avatarSeed: assistant.id,
      ...(presentation.avatarEmoji ? { avatarEmoji: presentation.avatarEmoji } : {}),
      serverLabel: input.serverLabel,
      connectionKey: input.connectionKey,
      enabled: input.assistantsEnabled && assistant.enabled,
      isDefaultShareTarget: Boolean(defaultID && assistant.id === defaultID),
    };
  });
};

export const publishShareCatalogFromCapability = async (input: {
  capability: AssistantCapability;
  assistants: AssistantDTO[];
  connectionKey: string;
  serverLabel: string;
  defaultAssistantID?: string | null;
}): Promise<void> => {
  if (!input.capability.supported || !input.capability.serverInstanceID) {
    await updateShareCatalog([]);
    return;
  }
  const entries = buildShareCatalogEntries({
    serverInstanceID: input.capability.serverInstanceID,
    connectionKey: input.connectionKey,
    serverLabel: input.serverLabel,
    assistantsEnabled: input.capability.enabled,
    assistants: input.assistants,
    defaultAssistantID: input.defaultAssistantID,
  });
  await updateShareCatalog(entries);
};
