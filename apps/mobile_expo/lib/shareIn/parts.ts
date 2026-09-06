import type { ShareAttachment, ShareEnvelope } from '@/lib/systemShell/share';

export type AssistantSharePart =
  | { type: 'text'; text: string }
  | { type: 'file'; mime: string; url: string };

const MAX_ATTACHMENTS = 10;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export type ShareAttachmentReader = (attachment: ShareAttachment) => Promise<string>;

/** Prefer expo-file-system; fall back to fetch for file/content URIs. */
export const defaultShareAttachmentReader: ShareAttachmentReader = async (attachment) => {
  const stagedPath = attachment.stagedPath.trim();
  if (!stagedPath) throw new Error('staged_file_unavailable');
  if (/^data:/i.test(stagedPath)) return stagedPath;

  const uri = /^(?:https?:|content:|file:)/i.test(stagedPath) ? stagedPath : `file://${stagedPath}`;

  try {
    const FileSystem = require('expo-file-system') as {
      readAsStringAsync: (
        path: string,
        opts: { encoding: string },
      ) => Promise<string>;
      EncodingType?: { Base64: string };
    };
    const encoding = FileSystem.EncodingType?.Base64 ?? 'base64';
    const base64 = await FileSystem.readAsStringAsync(uri, { encoding });
    return `data:${attachment.mime};base64,${base64}`;
  } catch {
    const response = await fetch(uri);
    if (!response.ok) throw new Error('staged_file_unavailable');
    const blob = await response.blob();
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('staged_file_unavailable'));
      reader.onload = () =>
        typeof reader.result === 'string'
          ? resolve(reader.result)
          : reject(new Error('staged_file_unavailable'));
      reader.readAsDataURL(blob);
    });
  }
};

export const buildShareParts = async (
  envelope: Pick<ShareEnvelope, 'text' | 'attachments'>,
  readAttachment: ShareAttachmentReader = defaultShareAttachmentReader,
): Promise<AssistantSharePart[]> => {
  const parts: AssistantSharePart[] = [];
  if (envelope.text?.trim()) parts.push({ type: 'text', text: envelope.text });
  if (envelope.attachments.length > MAX_ATTACHMENTS) throw new Error('too_many_share_attachments');
  for (const attachment of envelope.attachments) {
    if (!attachment.mime.startsWith('image/')) throw new Error('unsupported_share_attachment');
    if (attachment.byteSize <= 0 || attachment.byteSize > MAX_ATTACHMENT_BYTES) {
      throw new Error('invalid_share_attachment');
    }
    parts.push({ type: 'file', mime: attachment.mime, url: await readAttachment(attachment) });
  }
  if (parts.length === 0) throw new Error('empty_share');
  return parts;
};
