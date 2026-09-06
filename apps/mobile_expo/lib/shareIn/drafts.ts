import {
  type ShareCatalogEntry,
  type ShareDraft,
  parseShareDraft,
} from '@/lib/systemShell/share';

export type { ShareDraft };
export { parseShareDraft };

export type AssignedShareDraft = ShareDraft & {
  serverInstanceID: string;
  assistantID: string;
  name: string;
  avatarSeed: string;
  serverLabel: string;
  connectionKey: string;
};

export const isAssignedShareDraft = (draft: ShareDraft): draft is AssignedShareDraft =>
  Boolean(
    draft.serverInstanceID &&
      draft.assistantID &&
      draft.name &&
      draft.avatarSeed &&
      draft.serverLabel &&
      draft.connectionKey,
  );

/** Assign exact instance+assistant from catalog — never silent default. */
export const assignShareDraftRecipient = (
  draft: ShareDraft,
  entry: ShareCatalogEntry,
): AssignedShareDraft => ({
  ...draft,
  serverInstanceID: entry.serverInstanceID,
  assistantID: entry.assistantID,
  name: entry.name,
  avatarSeed: entry.avatarSeed,
  serverLabel: entry.serverLabel,
  connectionKey: entry.connectionKey,
});

export const sortShareRecipientEntries = (entries: ShareCatalogEntry[]): ShareCatalogEntry[] =>
  [...entries]
    .filter((e) => e.enabled)
    .sort(
      (left, right) =>
        Number(right.isDefaultShareTarget) - Number(left.isDefaultShareTarget) ||
        left.serverLabel.localeCompare(right.serverLabel) ||
        left.name.localeCompare(right.name),
    );
