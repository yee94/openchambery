export {
  loadAssistantSnapshot,
  loadAssistantCapability,
  ensureAssistantSession,
  createLynxAssistant,
  setLynxAssistantsEnabled,
  deleteLynxAssistant,
  resolveLynxAssistantCreateDefaults,
  markLynxAssistantContactRead,
  markAllLynxAssistantsRead,
} from './api';
export type {
  LynxAssistantDraft,
  LynxAssistantMutationResult,
  LynxAssistantCreateResult,
  LynxAssistantMarkReadResult,
  LynxAssistantMarkAllReadResult,
} from './api';
export {
  parseLynxAssistantDTO,
  parseLynxAssistantSnapshot,
  parseLynxAssistantCapability,
  parseLynxAssistantReadPosition,
  parseLynxAssistantReadResponse,
  LynxAssistantParseError,
} from './parse';
export type {
  LynxAssistantDTO,
  LynxAssistantSnapshot,
  LynxAssistantCapability,
  LynxAssistantMode,
  LynxAssistantLoadResult,
  LynxAssistantReadPosition,
  LynxAssistantReadResponse,
} from './types';
export {
  formatLynxAssistantUnreadBadge,
  selectLynxAssistantUnreadTotal,
  lynxAssistantsEligibleForMarkAll,
  resolveLynxAssistantOpenReadPosition,
  LYNX_ASSISTANT_MARK_ALL_BATCH_SIZE,
} from './unread';
export { LynxAssistantUnreadBadge } from './UnreadBadge';
export { LynxAssistantReadMarker } from './ReadMarker';
export { createLynxShareInbox } from './shareInbox';
export type { LynxShareEnvelope, LynxShareInbox, LynxShareAttachment, LynxShareDispatchResult } from './shareInbox';

export {
  admitLynxAssistantMessage,
  parseLynxMessageAdmission,
} from './admission';
export type {
  LynxMessageAdmission,
  LynxAdmitAssistantMessageResult,
  LynxAdmitAssistantMessageInput,
} from './admission';

export {
  isAssignedLynxShareDraft,
  assignLynxShareDraftRecipient,
  buildLynxShareCatalogEntries,
  sortLynxShareRecipientEntries,
} from './shareDraft';
export type {
  LynxShareDraft,
  AssignedLynxShareDraft,
  LynxShareCatalogEntry,
  LynxShareDraftTarget,
} from './shareDraft';
export { assignedLynxShareDraftToEnvelope } from './shareInbox';
export { LynxShareRecipientPicker } from './ShareRecipientPicker';
export { LynxShareBridge } from './ShareBridge';
