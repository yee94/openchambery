import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';

import { getAgentColor } from '@/lib/agentColors';
import { getAgentIdenticonMatrix } from '@/lib/agentIdenticon';
import { getClientPlatform, isCapacitorApp } from '@/lib/platform';

export const NATIVE_IOS_COMPOSER_CLASS = 'oc-native-ios-composer';
export const NATIVE_IOS_COMPOSER_HEIGHT_VAR = '--oc-native-composer-height';
export const NATIVE_IOS_COMPOSER_ACCESSORY_VAR = '--oc-native-composer-accessory';
export const NATIVE_COMPOSER_FILE_MAX_BYTES = 32 * 1024 * 1024;
const NATIVE_IOS_COMPOSER_PLUGIN = 'OpenChamberComposer';
const NATIVE_IOS_COMPOSER_COLOR_FALLBACK = '#22c55e';
const NATIVE_MODEL_ICON_PX = 32;

export type NativeIosComposerAppearance = 'dark' | 'light';

export type NativeIosComposerAttachmentPreview = {
  id: string;
  filename: string;
  mime: string;
  thumbnailBase64: string;
  removeAria: string;
};

export type NativeIosComposerCitationRange = {
  start: number;
  end: number;
};

export type NativeIosComposerState = {
  text: string;
  placeholder: string;
  modelLabel: string;
  modelVariantLabel: string;
  modelIcon: string;
  canSend: boolean;
  canAbort: boolean;
  attachmentCount: number;
  attachmentPreviews: NativeIosComposerAttachmentPreview[];
  citationRanges: NativeIosComposerCitationRange[];
  appearance: NativeIosComposerAppearance;
  attachAria: string;
  attachTitle: string;
  attachPhotosLabel: string;
  attachFilesLabel: string;
  attachCancelLabel: string;
  sendAria: string;
  queueAria: string;
  stopAria: string;
  modelAria: string;
  agentAria: string;
  agentLabel: string;
  agentColor: string;
  agentIdenticon: number[];
  suppressed: boolean;
  showScrollToBottom: boolean;
  scrollAria: string;
};

export type NativeIosComposerPlugin = {
  present: (state: NativeIosComposerState) => Promise<void>;
  update: (state: Partial<NativeIosComposerState> & { forceText?: boolean }) => Promise<void>;
  /** Visual hide only. The overlay stays installed (singleton). */
  hide: () => Promise<void>;
  dismiss: () => Promise<void>;
  setSuppressed: (options: { suppressed: boolean }) => Promise<void>;
  focus: () => Promise<void>;
  blur: () => Promise<void>;
  addListener: (
    event: NativeIosComposerEventName,
    listener: (payload: NativeIosComposerEventPayload) => void,
  ) => Promise<PluginListenerHandle>;
};

export type NativeIosComposerEventName =
  | 'textChanged'
  | 'send'
  | 'abort'
  | 'attach'
  | 'filesPicked'
  | 'removeAttachment'
  | 'openModel'
  | 'cycleAgent'
  | 'openAgent'
  | 'heightChanged'
  | 'expandedChanged'
  | 'scrollToBottom';

export type NativeIosComposerEventPayload = {
  text?: string;
  height?: number;
  expanded?: boolean;
  composing?: boolean;
  id?: string;
  files?: unknown;
  skipped?: unknown;
};

const OpenChamberComposer = registerPlugin<NativeIosComposerPlugin>(NATIVE_IOS_COMPOSER_PLUGIN);

export type NativeIosComposerAvailabilityInput = {
  isCapacitor: boolean;
  platform: string;
  pluginAvailable: boolean;
  isMobile: boolean;
};

export const evaluateNativeIosComposerAvailability = (
  input: NativeIosComposerAvailabilityInput,
): boolean => input.isCapacitor && input.platform === 'ios' && input.pluginAvailable && input.isMobile;

/** True only on Capacitor iPhone/iPad when the native composer plugin is registered. */
export function canUseNativeIosComposer(isMobile: boolean): boolean {
  if (typeof window === 'undefined') return false;
  return evaluateNativeIosComposerAvailability({
    isCapacitor: isCapacitorApp(),
    platform: getClientPlatform(),
    pluginAvailable: Capacitor.isPluginAvailable(NATIVE_IOS_COMPOSER_PLUGIN),
    isMobile,
  });
}

export const nativeIosComposerAppearanceFromRoot = (root: { classList: { contains: (name: string) => boolean } }): NativeIosComposerAppearance => (
  root.classList.contains('dark') ? 'dark' : 'light'
);

export const parseNativeComposerHeight = (payload: NativeIosComposerEventPayload | null | undefined): number => {
  const height = payload?.height;
  if (typeof height !== 'number' || !Number.isFinite(height) || height < 0) return 0;
  return height;
};

export const applyNativeComposerHeightVar = (root: HTMLElement, height: number): void => {
  if (!(height > 0)) {
    root.style.removeProperty(NATIVE_IOS_COMPOSER_HEIGHT_VAR);
    return;
  }
  root.style.setProperty(NATIVE_IOS_COMPOSER_HEIGHT_VAR, `${Math.round(height)}px`);
};

export const applyNativeComposerAccessoryVar = (root: HTMLElement, height: number): void => {
  if (!(height > 0)) {
    root.style.removeProperty(NATIVE_IOS_COMPOSER_ACCESSORY_VAR);
    return;
  }
  root.style.setProperty(NATIVE_IOS_COMPOSER_ACCESSORY_VAR, `${Math.round(height)}px`);
};

export const setNativeComposerDocumentClass = (root: HTMLElement, active: boolean): void => {
  root.classList.toggle(NATIVE_IOS_COMPOSER_CLASS, active);
  if (!active) {
    root.style.removeProperty(NATIVE_IOS_COMPOSER_HEIGHT_VAR);
    root.style.removeProperty(NATIVE_IOS_COMPOSER_ACCESSORY_VAR);
  }
};

export const packNativeIosComposerIdenticon = (name: string | undefined): number[] => (
  getAgentIdenticonMatrix(name).flat().map((cell) => (cell ? 1 : 0))
);

export const resolveCssVarToHex = (cssVar: string): string => {
  if (typeof document === 'undefined' || typeof getComputedStyle === 'undefined') {
    return NATIVE_IOS_COMPOSER_COLOR_FALLBACK;
  }
  const raw = getComputedStyle(document.documentElement).getPropertyValue(cssVar).trim();
  const probe = document.createElement('span');
  probe.style.color = raw || `var(${cssVar})`;
  document.documentElement.appendChild(probe);
  const computed = getComputedStyle(probe).color;
  probe.remove();
  const match = /rgba?\(\s*([\d.]+)(?:\s*,\s*|\s+)([\d.]+)(?:\s*,\s*|\s+)([\d.]+)/.exec(computed);
  if (!match) return NATIVE_IOS_COMPOSER_COLOR_FALLBACK;
  const hex = (value: string) => Math.max(0, Math.min(255, Math.round(Number(value)))).toString(16).padStart(2, '0');
  return `#${hex(match[1])}${hex(match[2])}${hex(match[3])}`;
};

export const nativeIosComposerAgentColor = (name: string | undefined): string => (
  resolveCssVarToHex(getAgentColor(name).var)
);

export const nativeComposerStatesEqual = (
  left: NativeIosComposerState,
  right: NativeIosComposerState,
): boolean => (
  left.text === right.text
  && left.placeholder === right.placeholder
  && left.modelLabel === right.modelLabel
  && left.modelVariantLabel === right.modelVariantLabel
  && left.modelIcon === right.modelIcon
  && left.canSend === right.canSend
  && left.canAbort === right.canAbort
  && left.attachmentCount === right.attachmentCount
  && nativeComposerAttachmentPreviewsEqual(left.attachmentPreviews, right.attachmentPreviews)
  && nativeComposerCitationRangesEqual(left.citationRanges, right.citationRanges)
  && left.appearance === right.appearance
  && left.attachAria === right.attachAria
  && left.attachTitle === right.attachTitle
  && left.attachPhotosLabel === right.attachPhotosLabel
  && left.attachFilesLabel === right.attachFilesLabel
  && left.attachCancelLabel === right.attachCancelLabel
  && left.sendAria === right.sendAria
  && left.queueAria === right.queueAria
  && left.stopAria === right.stopAria
  && left.modelAria === right.modelAria
  && left.agentAria === right.agentAria
  && left.agentLabel === right.agentLabel
  && left.agentColor === right.agentColor
  && left.agentIdenticon.join('') === right.agentIdenticon.join('')
  && left.suppressed === right.suppressed
  && left.showScrollToBottom === right.showScrollToBottom
  && left.scrollAria === right.scrollAria
);

export const nativeComposerAttachmentPreviewsEqual = (
  left: readonly NativeIosComposerAttachmentPreview[],
  right: readonly NativeIosComposerAttachmentPreview[],
): boolean => (
  left.length === right.length
  && left.every((item, index) => {
    const other = right[index];
    return Boolean(
      other
      && item.id === other.id
      && item.filename === other.filename
      && item.mime === other.mime
      && item.thumbnailBase64 === other.thumbnailBase64
      && item.removeAria === other.removeAria,
    );
  })
);

export const nativeComposerCitationRangesEqual = (
  left: readonly NativeIosComposerCitationRange[],
  right: readonly NativeIosComposerCitationRange[],
): boolean => (
  left.length === right.length
  && left.every((item, index) => item.start === right[index]?.start && item.end === right[index]?.end)
);

export const attachmentPreviewSourceSignature = (
  files: readonly { id: string; filename: string; mimeType: string; dataUrl?: string }[],
): string => files.map((file) => (
  `${file.id}:${file.filename}:${file.mimeType}:${file.dataUrl?.length ?? 0}`
)).join('|');

export const parseNativeComposerRemoveAttachmentId = (
  payload: NativeIosComposerEventPayload | null | undefined,
): string => {
  const id = payload?.id;
  return typeof id === 'string' && id.trim() ? id : '';
};

export type NativeComposerTextWrite = {
  omitText: boolean;
  forceText: boolean;
};

/** Echoed native keystrokes stay native-owned so IME marked text is not rewritten. */
export const resolveNativeComposerTextWrite = (input: {
  nextText: string;
  nativeOwnedText: string;
  echoingNative: boolean;
}): NativeComposerTextWrite => {
  if (input.echoingNative || input.nextText === input.nativeOwnedText) {
    return { omitText: true, forceText: false };
  }
  return { omitText: false, forceText: true };
};

export const shouldApplyNativeComposerText = (input: {
  incoming: string | null | undefined;
  current: string;
  isComposing: boolean;
  isFirstResponder: boolean;
  forceText: boolean;
}): boolean => {
  if (input.incoming == null) return false;
  if (input.incoming === input.current && !input.forceText) return false;
  if ((input.isComposing || input.isFirstResponder) && !input.forceText) return false;
  return true;
};

export const skippedNamesFromNativeComposerPayload = (
  payload: NativeIosComposerEventPayload | null | undefined,
): string[] => {
  const raw = Array.isArray(payload?.skipped) ? payload.skipped : [];
  const names: string[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const name = (entry as { name?: unknown }).name;
    if (typeof name === 'string' && name.trim()) names.push(name);
  }
  return names;
};

const bytesFromBase64 = (raw: string): Uint8Array | null => {
  try {
    const binary = atob(raw);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
};

export const filesFromNativeComposerPayload = (
  payload: NativeIosComposerEventPayload | null | undefined,
  maxBytes = NATIVE_COMPOSER_FILE_MAX_BYTES,
): File[] => {
  const raw = Array.isArray(payload?.files) ? payload.files : [];
  const files: File[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const item = entry as { name?: unknown; mime?: unknown; dataBase64?: unknown };
    if (typeof item.dataBase64 !== 'string' || item.dataBase64.length === 0) continue;
    const bytes = bytesFromBase64(item.dataBase64);
    if (!bytes || bytes.byteLength === 0 || bytes.byteLength > maxBytes) continue;
    const name = typeof item.name === 'string' && item.name.trim() ? item.name : 'file';
    const mime = typeof item.mime === 'string' && item.mime.trim() ? item.mime : 'application/octet-stream';
    files.push(new File([bytes], name, { type: mime }));
  }
  return files;
};

const NATIVE_ATTACHMENT_THUMB_PX = 80;

/** Downscale an image data URL for the native preview strip. Never log the bytes. */
export const rasterizeAttachmentThumbnailBase64 = (src: string): Promise<string | null> => {
  if (typeof document === 'undefined' || !src || !src.startsWith('data:image/')) {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = NATIVE_ATTACHMENT_THUMB_PX;
        canvas.height = NATIVE_ATTACHMENT_THUMB_PX;
        const context = canvas.getContext('2d');
        if (!context) {
          resolve(null);
          return;
        }
        context.clearRect(0, 0, NATIVE_ATTACHMENT_THUMB_PX, NATIVE_ATTACHMENT_THUMB_PX);
        context.drawImage(image, 0, 0, NATIVE_ATTACHMENT_THUMB_PX, NATIVE_ATTACHMENT_THUMB_PX);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.72);
        const comma = dataUrl.indexOf(',');
        resolve(comma >= 0 ? dataUrl.slice(comma + 1) : null);
      } catch {
        resolve(null);
      }
    };
    image.onerror = () => resolve(null);
    image.src = src;
  });
};

export const rasterizeLogoPngBase64 = (src: string): Promise<string | null> => {
  if (typeof document === 'undefined' || !src) return Promise.resolve(null);
  return new Promise((resolve) => {
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = NATIVE_MODEL_ICON_PX;
        canvas.height = NATIVE_MODEL_ICON_PX;
        const context = canvas.getContext('2d');
        if (!context) {
          resolve(null);
          return;
        }
        context.clearRect(0, 0, NATIVE_MODEL_ICON_PX, NATIVE_MODEL_ICON_PX);
        context.drawImage(image, 0, 0, NATIVE_MODEL_ICON_PX, NATIVE_MODEL_ICON_PX);
        const dataUrl = canvas.toDataURL('image/png');
        const comma = dataUrl.indexOf(',');
        resolve(comma >= 0 ? dataUrl.slice(comma + 1) : null);
      } catch {
        resolve(null);
      }
    };
    image.onerror = () => resolve(null);
    image.src = src;
  });
};

export const getNativeIosComposerPlugin = (): NativeIosComposerPlugin => OpenChamberComposer;
