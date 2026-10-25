// Compatibility entrypoint for existing image consumers. Byte ownership is shared
// with file previews, downloads and transfers in runtime-file-resource.
export { acquireRuntimeImage, clearRuntimeImageCacheLeases } from './runtime-file-resource';
export type { RuntimeImageIntent } from './runtime-file-resource';
