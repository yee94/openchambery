export const MAX_ASSISTANT_DELIVERY_PARTS = 129;
export const MAX_ASSISTANT_DELIVERY_FILE_PARTS = 64;

const MAX_TEXT_LENGTH = 200_000;
const MAX_STRING_LENGTH = 512;
const MAX_FILE_URL_LENGTH = 70 * 1024 * 1024;
const MAX_DELIVERY_PAYLOAD_LENGTH = 70 * 1024 * 1024;
const plainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

export const validAssistantDeliveryParts = (parts, { allowAttachmentRefs = false } = {}) => Array.isArray(parts)
  && parts.length > 0
  && parts.length <= MAX_ASSISTANT_DELIVERY_PARTS
  && parts.filter((part) => part?.type === 'file').length <= MAX_ASSISTANT_DELIVERY_FILE_PARTS
  && Buffer.byteLength(JSON.stringify(parts), 'utf8') <= MAX_DELIVERY_PAYLOAD_LENGTH
  && parts.every((part) => {
    if (!plainObject(part)) return false;
    if (part.type === 'text') {
      return Object.keys(part).every((key) => key === 'type' || key === 'text' || key === 'synthetic')
        && typeof part.text === 'string'
        && part.text.length <= MAX_TEXT_LENGTH
        && (part.synthetic === undefined || typeof part.synthetic === 'boolean');
    }
    return part.type === 'file' && typeof part.mime === 'string' && part.mime.length > 0 && part.mime.length <= MAX_STRING_LENGTH && ((allowAttachmentRefs && Object.keys(part).every((key) => key === 'type' || key === 'mime' || key === 'attachmentID') && typeof part.attachmentID === 'string' && part.attachmentID.length > 0 && part.attachmentID.length <= MAX_STRING_LENGTH) || (Object.keys(part).every((key) => key === 'type' || key === 'mime' || key === 'url') && typeof part.url === 'string' && part.url.length > 0 && part.url.length <= MAX_FILE_URL_LENGTH));
  });
