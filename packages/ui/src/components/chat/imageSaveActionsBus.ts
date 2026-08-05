import type { ImageSaveTarget } from './imageSave';

type OpenHandler = (target: ImageSaveTarget) => void;

/** Stack so nested chat surfaces can rebind without clobbering the outer host. */
const openHandlers: OpenHandler[] = [];

/** Bind an image-save actions host. Returns unbind. */
export const bindImageSaveActionsOpen = (handler: OpenHandler): (() => void) => {
  openHandlers.push(handler);
  return () => {
    const index = openHandlers.lastIndexOf(handler);
    if (index >= 0) {
      openHandlers.splice(index, 1);
    }
  };
};

/** Open the shared long-press / context-menu image actions sheet. */
export const openImageSaveActions = (target: ImageSaveTarget): boolean => {
  const handler = openHandlers[openHandlers.length - 1];
  if (!handler) return false;
  const sourceUrl = target.sourceUrl.trim();
  if (!sourceUrl && !target.displayUrl?.trim()) return false;
  handler({
    ...target,
    sourceUrl: sourceUrl || target.displayUrl!.trim(),
  });
  return true;
};
