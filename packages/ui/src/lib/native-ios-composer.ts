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

/** Highlight overlay slice that may carry a trigger-icon chip visual. */
export type NativeIosComposerChipHighlight = {
  text: string;
  visual?: {
    trigger: string;
    icon: string;
  };
};

export type NativeIosComposerChipSpec = {
  start: number;
  end: number;
  triggerLength: number;
  iconName: string;
};

/** Paint-only chip: UTF-16 range, trigger well length for whole-token delete, label color. */
export type NativeIosComposerChipRange = {
  start: number;
  end: number;
  triggerLength: number;
  color: string;
};

export type NativeIosComposerSuggestionRow = {
  id: string;
  title: string;
  subtitle: string;
  badge: string;
  iconBase64: string;
};

export type NativeIosComposerAutocomplete = {
  open: boolean;
  highlightedIndex: number;
  rows: NativeIosComposerSuggestionRow[];
};

export const emptyNativeComposerAutocomplete = (): NativeIosComposerAutocomplete => ({
  open: false,
  highlightedIndex: 0,
  rows: [],
});

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
  chipRanges: NativeIosComposerChipRange[];
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
  autocomplete: NativeIosComposerAutocomplete;
};

/** Hidden install payload so homepage can pre-create the glass view. */
export const hiddenNativeIosComposerWarmState = (): NativeIosComposerState => ({
  text: '',
  placeholder: '',
  modelLabel: '',
  modelVariantLabel: '',
  modelIcon: '',
  canSend: false,
  canAbort: false,
  attachmentCount: 0,
  attachmentPreviews: [],
  citationRanges: [],
  chipRanges: [],
  appearance: 'dark',
  attachAria: '',
  attachTitle: '',
  attachPhotosLabel: '',
  attachFilesLabel: '',
  attachCancelLabel: '',
  sendAria: '',
  queueAria: '',
  stopAria: '',
  modelAria: '',
  agentAria: '',
  agentLabel: '',
  agentColor: NATIVE_IOS_COMPOSER_COLOR_FALLBACK,
  agentIdenticon: Array.from({ length: 25 }, () => 0),
  suppressed: true,
  showScrollToBottom: false,
  scrollAria: '',
  autocomplete: emptyNativeComposerAutocomplete(),
});

export type NativeIosComposerPlugin = {
  present: (state: NativeIosComposerState) => Promise<void>;
  update: (state: Partial<NativeIosComposerState> & { forceText?: boolean; caret?: number }) => Promise<void>;
  /** Visual hide only. The overlay stays installed (singleton). */
  hide: () => Promise<void>;
  /** Undo `hide` without rewriting the live UITextView. */
  show: () => Promise<void>;
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
  | 'scrollToBottom'
  | 'autocompleteAccept'
  | 'autocompleteDismiss';

export type NativeIosComposerEventPayload = {
  text?: string;
  height?: number;
  expanded?: boolean;
  composing?: boolean;
  id?: string;
  files?: unknown;
  skipped?: unknown;
  selectionStart?: number;
  selectionEnd?: number;
  index?: number;
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

const cssVarHexCache = new Map<string, string>();
let cssVarHexCacheObserver: MutationObserver | null = null;

export const resolveCssVarToHex = (cssVar: string): string => {
  const cached = cssVarHexCache.get(cssVar);
  if (cached !== undefined) return cached;
  if (typeof document === 'undefined' || typeof getComputedStyle === 'undefined') {
    return NATIVE_IOS_COMPOSER_COLOR_FALLBACK;
  }
  if (!cssVarHexCacheObserver && typeof MutationObserver !== 'undefined') {
    cssVarHexCacheObserver = new MutationObserver(() => {
      cssVarHexCache.clear();
    });
    cssVarHexCacheObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style'],
    });
  }
  const raw = getComputedStyle(document.documentElement).getPropertyValue(cssVar).trim();
  const probe = document.createElement('span');
  probe.style.color = raw || `var(${cssVar})`;
  document.documentElement.appendChild(probe);
  const computed = getComputedStyle(probe).color;
  probe.remove();
  const match = /rgba?\(\s*([\d.]+)(?:\s*,\s*|\s+)([\d.]+)(?:\s*,\s*|\s+)([\d.]+)/.exec(computed);
  if (!match) {
    cssVarHexCache.set(cssVar, NATIVE_IOS_COMPOSER_COLOR_FALLBACK);
    return NATIVE_IOS_COMPOSER_COLOR_FALLBACK;
  }
  const hex = (value: string) => Math.max(0, Math.min(255, Math.round(Number(value)))).toString(16).padStart(2, '0');
  const resolved = `#${hex(match[1])}${hex(match[2])}${hex(match[3])}`;
  cssVarHexCache.set(cssVar, resolved);
  return resolved;
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
  && nativeComposerChipRangesEqual(left.chipRanges, right.chipRanges)
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
  && nativeComposerAutocompleteEqual(left.autocomplete, right.autocomplete)
);

export const nativeComposerAutocompleteEqual = (
  left: NativeIosComposerAutocomplete,
  right: NativeIosComposerAutocomplete,
): boolean => (
  left.open === right.open
  && left.highlightedIndex === right.highlightedIndex
  && left.rows.length === right.rows.length
  && left.rows.every((row, index) => {
    const other = right.rows[index];
    return Boolean(
      other
      && row.id === other.id
      && row.title === other.title
      && row.subtitle === other.subtitle
      && row.badge === other.badge
      && row.iconBase64 === other.iconBase64,
    );
  })
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

export const nativeComposerChipRangesEqual = (
  left: readonly NativeIosComposerChipRange[],
  right: readonly NativeIosComposerChipRange[],
): boolean => (
  left.length === right.length
  && left.every((item, index) => {
    const other = right[index];
    return Boolean(
      other
      && item.start === other.start
      && item.end === other.end
      && item.triggerLength === other.triggerLength
      && item.color === other.color,
    );
  })
);

/** Walk web highlight parts (full-document coverage) into native chip specs. */
export const nativeComposerChipSpecsFromHighlights = (
  text: string,
  parts: readonly NativeIosComposerChipHighlight[] | null | undefined,
): NativeIosComposerChipSpec[] => {
  if (!text || !parts || parts.length === 0) return [];
  const specs: NativeIosComposerChipSpec[] = [];
  let offset = 0;
  for (const part of parts) {
    const start = offset;
    offset += part.text.length;
    const visual = part.visual;
    if (!visual) continue;
    const triggerLength = visual.trigger.length;
    if (triggerLength < 1 || start + triggerLength > offset) continue;
    if (!visual.icon) continue;
    specs.push({
      start,
      end: offset,
      triggerLength,
      iconName: visual.icon,
    });
  }
  return specs;
};

/** Range + color only — native paints label highlight and whole-token delete; no icons. */
export const buildNativeComposerChipRanges = (
  specs: readonly NativeIosComposerChipSpec[],
  color: string,
): NativeIosComposerChipRange[] => specs.map((spec) => ({
  start: spec.start,
  end: spec.end,
  triggerLength: spec.triggerLength,
  color,
}));

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

const toNonNegativeInt = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.floor(value);
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed);
  }
  return null;
};

export const parseNativeComposerSelection = (
  payload: NativeIosComposerEventPayload | null | undefined,
): { start: number; end: number } | null => {
  const start = toNonNegativeInt(payload?.selectionStart);
  if (start === null) return null;
  const end = toNonNegativeInt(payload?.selectionEnd);
  return { start, end: end !== null && end >= start ? end : start };
};

export const parseNativeComposerAcceptIndex = (
  payload: NativeIosComposerEventPayload | null | undefined,
): number => toNonNegativeInt(payload?.index) ?? 0;

/** Clamp a native or web caret so insert/replace uses the live token, not 0. */
export const resolveComposerInsertCaret = (
  documentLength: number,
  caret: number | null | undefined,
): number => {
  const length = Math.max(0, documentLength);
  if (typeof caret !== 'number' || !Number.isFinite(caret)) return length;
  return Math.max(0, Math.min(Math.floor(caret), length));
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
  if (input.nextText === input.nativeOwnedText) {
    return { omitText: true, forceText: false };
  }
  // Web cleared after native send. That empty write is JS-authored even if
  // the send listener still has the echo flag set from staging the draft.
  if (input.nextText.length === 0 && input.nativeOwnedText.length > 0) {
    return { omitText: false, forceText: true };
  }
  if (input.echoingNative) {
    return { omitText: true, forceText: false };
  }
  return { omitText: false, forceText: true };
};

/** Native send only hands the draft to Web. It must not force-write the field. */
export const resolveNativeComposerSendHandoff = (): NativeComposerTextWrite => ({
  omitText: true,
  forceText: false,
});

/** Stage the document now; run Web send/queue after the Capacitor listener returns. */
export const scheduleNativeComposerWebHandoff = (run: () => void): ReturnType<typeof setTimeout> => (
  setTimeout(run, 0)
);

export const handoffNativeComposerSendToWeb = (input: {
  text: string;
  applyDocument: (text: string) => void;
  submit: () => void;
}): void => {
  input.applyDocument(input.text);
  scheduleNativeComposerWebHandoff(input.submit);
};

const scalarEqual = <T>(left: T, right: T): boolean => left === right;

/**
 * Echoed typing must not push text, JPEG thumbs, or the model icon back across
 * the bridge. Chrome-only diffs stay slim so a burst after resume cannot stall
 * the main thread on decode.
 */
export const buildNativeComposerUpdatePayload = (
  previous: NativeIosComposerState | null,
  next: NativeIosComposerState,
  write: NativeComposerTextWrite,
  options?: { caret?: number },
): (Partial<NativeIosComposerState> & { forceText?: boolean; caret?: number }) | null => {
  if (write.omitText && previous && nativeComposerStatesEqual(previous, next)) {
    return null;
  }
  const payload: Partial<NativeIosComposerState> & { forceText?: boolean; caret?: number } = {};
  if (!write.omitText) {
    payload.text = next.text;
    if (write.forceText) payload.forceText = true;
    if (write.forceText && typeof options?.caret === 'number' && Number.isFinite(options.caret)) {
      payload.caret = Math.max(0, Math.floor(options.caret));
    }
  }
  if (!previous) {
    const { text: _text, ...rest } = next;
    Object.assign(payload, rest);
    return payload;
  }
  const assignIfChanged = <K extends keyof NativeIosComposerState>(
    key: K,
    equal: (left: NativeIosComposerState[K], right: NativeIosComposerState[K]) => boolean,
  ): void => {
    if (equal(previous[key], next[key])) return;
    payload[key] = next[key];
  };
  assignIfChanged('placeholder', scalarEqual);
  assignIfChanged('modelLabel', scalarEqual);
  assignIfChanged('modelVariantLabel', scalarEqual);
  assignIfChanged('modelIcon', scalarEqual);
  assignIfChanged('canSend', scalarEqual);
  assignIfChanged('canAbort', scalarEqual);
  assignIfChanged('attachmentCount', scalarEqual);
  assignIfChanged('attachmentPreviews', nativeComposerAttachmentPreviewsEqual);
  assignIfChanged('citationRanges', nativeComposerCitationRangesEqual);
  assignIfChanged('chipRanges', nativeComposerChipRangesEqual);
  assignIfChanged('appearance', scalarEqual);
  assignIfChanged('attachAria', scalarEqual);
  assignIfChanged('attachTitle', scalarEqual);
  assignIfChanged('attachPhotosLabel', scalarEqual);
  assignIfChanged('attachFilesLabel', scalarEqual);
  assignIfChanged('attachCancelLabel', scalarEqual);
  assignIfChanged('sendAria', scalarEqual);
  assignIfChanged('queueAria', scalarEqual);
  assignIfChanged('stopAria', scalarEqual);
  assignIfChanged('modelAria', scalarEqual);
  assignIfChanged('agentAria', scalarEqual);
  assignIfChanged('agentLabel', scalarEqual);
  assignIfChanged('agentColor', scalarEqual);
  assignIfChanged('agentIdenticon', (left, right) => left.join('') === right.join(''));
  assignIfChanged('suppressed', scalarEqual);
  assignIfChanged('showScrollToBottom', scalarEqual);
  assignIfChanged('scrollAria', scalarEqual);
  assignIfChanged('autocomplete', nativeComposerAutocompleteEqual);
  return Object.keys(payload).length === 0 ? null : payload;
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
    files.push(new File([new Uint8Array(bytes)], name, { type: mime }));
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
