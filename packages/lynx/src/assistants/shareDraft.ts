/**
 * Cap mobileShareDraftHandoff / NativeShareDraft spirit for Lynx.
 * Android generic share drafts carry a Partial target until the full-page
 * recipient picker assigns exact instance+assistant — never silent-default.
 */
import type { LynxAssistantCapability, LynxAssistantDTO } from './types';

export type LynxShareDraftAttachment = {
  stagedPath: string;
  originalName: string;
  mime: string;
  byteSize: number;
};

export type LynxShareDraftTarget = {
  serverInstanceID: string;
  assistantID: string;
  name: string;
  avatarSeed: string;
  serverLabel: string;
  connectionKey: string;
};

export type LynxShareDraft = {
  version: 1;
  draftID: string;
  text?: string;
  attachments: LynxShareDraftAttachment[];
  source: 'android-share';
  createdAt: number;
  expiresAt: number;
} & Partial<LynxShareDraftTarget>;

export type AssignedLynxShareDraft = LynxShareDraft & LynxShareDraftTarget;

export type LynxShareCatalogEntry = {
  serverInstanceID: string;
  assistantID: string;
  name: string;
  avatarSeed: string;
  serverLabel: string;
  connectionKey: string;
  enabled: boolean;
  /** Cap sorts by this; Lynx never invents a silent default (always false here). */
  isDefaultShareTarget: boolean;
};

export const isAssignedLynxShareDraft = (
  draft: LynxShareDraft,
): draft is AssignedLynxShareDraft => Boolean(
  draft.serverInstanceID
    && draft.assistantID
    && draft.name
    && draft.avatarSeed
    && draft.serverLabel
    && draft.connectionKey,
);

/** Assign exact instance+assistant from catalog — never silent default. */
export const assignLynxShareDraftRecipient = (
  draft: LynxShareDraft,
  entry: LynxShareCatalogEntry,
): AssignedLynxShareDraft => ({
  ...draft,
  serverInstanceID: entry.serverInstanceID,
  assistantID: entry.assistantID,
  name: entry.name,
  avatarSeed: entry.avatarSeed,
  serverLabel: entry.serverLabel,
  connectionKey: entry.connectionKey,
});

export const sortLynxShareRecipientEntries = (
  entries: LynxShareCatalogEntry[],
): LynxShareCatalogEntry[] => [...entries]
  .filter((entry) => entry.enabled)
  .sort((left, right) => (
    Number(right.isDefaultShareTarget) - Number(left.isDefaultShareTarget)
    || left.serverLabel.localeCompare(right.serverLabel)
    || left.name.localeCompare(right.name)
  ));

/**
 * Cap MobileShareBridge.refreshNativeAssistantCatalog spirit.
 * Always sets isDefaultShareTarget=false — generic share must pick explicitly.
 */
export const buildLynxShareCatalogEntries = (input: {
  capability: LynxAssistantCapability | null;
  assistants: LynxAssistantDTO[];
  connectionKey: string;
  serverLabel: string;
}): LynxShareCatalogEntry[] => {
  const { capability, assistants, connectionKey, serverLabel } = input;
  if (!capability?.supported || !capability.serverInstanceID || !capability.enabled) {
    return [];
  }
  const serverInstanceID = capability.serverInstanceID;
  return sortLynxShareRecipientEntries(
    assistants
      .filter((assistant) => assistant.enabled)
      .map((assistant) => ({
        serverInstanceID,
        assistantID: assistant.id,
        name: assistant.name,
        avatarSeed: assistant.id,
        serverLabel,
        connectionKey,
        enabled: true,
        isDefaultShareTarget: false,
      })),
  );
};

export const displayNameForLynxShareEntry = (entry: LynxShareCatalogEntry): string => {
  const trimmed = entry.name.trim();
  return trimmed || entry.assistantID;
};

export const avatarGlyphForLynxShareEntry = (entry: LynxShareCatalogEntry): string => {
  const name = displayNameForLynxShareEntry(entry);
  return name.slice(0, 1).toUpperCase() || '?';
};
