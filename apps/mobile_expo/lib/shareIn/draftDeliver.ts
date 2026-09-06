import type { AssignedShareDraft } from '@/lib/shareIn/drafts';
import { deliverShareEnvelope, type ShareDeliverDeps } from '@/lib/shareIn/deliver';
import { cancelShareDraft, type ShareEnvelope } from '@/lib/systemShell/share';

/** Turn an assigned Android draft into a share envelope and POST /assistants/{id}/share. */
export const deliverAssignedShareDraft = async (
  draft: AssignedShareDraft,
  deps: ShareDeliverDeps,
): Promise<void> => {
  const envelope: ShareEnvelope = {
    version: 1,
    operationID: draft.draftID,
    serverInstanceID: draft.serverInstanceID,
    assistantID: draft.assistantID,
    text: draft.text,
    attachments: draft.attachments,
    source: 'android-share',
    createdAt: draft.createdAt,
    expiresAt: draft.expiresAt,
  };
  await deliverShareEnvelope(envelope, deps);
  // Best-effort native draft cancel after durable outbox cleanup begins.
  await cancelShareDraft(draft.draftID).catch(() => undefined);
};
