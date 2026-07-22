import { draftRootAttachmentOccurrenceRefID, isDurableURL, type DraftAttachmentMetadata } from '@/sync/input-draft-types';
import type { RevertedComposerSnapshot } from '@/sync/session-actions';

export const createAssistantRevertDraftSnapshot = async (restoration: RevertedComposerSnapshot, createID: () => string) => {
  const values = new Map<string, Blob>();
  const attachments: DraftAttachmentMetadata[] = [];
  for (const attachment of restoration.attachments) {
    const attachmentID = createID();
    const attachmentRefID = draftRootAttachmentOccurrenceRefID(attachmentID);
    if (isDurableURL(attachment.url)) attachments.push({ attachmentID, attachmentRefID, filename: attachment.filename, mimeType: attachment.mimeType, size: 0, source: 'local', locator: { kind: 'url', url: attachment.url } });
    else {
      const dataURL = String(attachment.url);
      if (!dataURL.startsWith('data:')) throw new Error('assistant-revert-attachment-url');
      const blob = await (await fetch(dataURL)).blob();
      values.set(attachmentRefID, blob);
      attachments.push({ attachmentID, attachmentRefID, filename: attachment.filename, mimeType: attachment.mimeType, size: blob.size, source: 'local', locator: { kind: 'blob', blobID: attachmentID } });
    }
  }
  return { snapshot: { text: restoration.text, composerReferences: [], attachments, syntheticParts: [], mentions: [] }, values };
};
