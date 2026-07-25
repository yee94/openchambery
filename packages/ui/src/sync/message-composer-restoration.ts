/**
 * Shared Composer restoration for queue edit, revert, and sent-message edit.
 * Thin facade: source builders and CAS live in focused modules.
 */
export type { ComposerRestorationPayload } from './message-composer-restoration-sources'
export {
  buildQueueComposerRestoration,
  buildSentMessageComposerRestoration,
  pathFromFileURLString,
  relativePathUnderDirectory,
} from './message-composer-restoration-sources'
export {
  commitComposerRestoration,
  rollbackComposerRestoration,
} from './message-composer-restoration-cas'
/** Attachment ref resolution owns the DraftKey adapter module. */
export { resolveDraftAttachmentRefID } from './draft-attachment-resource-adapter'
