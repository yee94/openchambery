import { useEffect, useLayoutEffect, useRef } from 'react';
import { useEvent } from '@reactuses/core';

import { findAttachmentCitationRanges } from '@/components/chat/attachmentCitations';
import type { ComposerAutocompleteListRow } from '@/lib/composer-autocomplete';
import { rasterizeSpriteIconPngBase64 } from '@/lib/composer-autocomplete';
import { resolveModelLogoSrc } from '@/hooks/useModelLogo';
import { useIosNativeUiEnabled } from '@/lib/iosNativeUi';
import { attachNativeIosComposerLeaveConceal } from '@/lib/native-ios-composer-leave';
import { nativeIosComposerSession } from '@/lib/native-ios-composer-session';
import {
  applyNativeComposerHeightVar,
  attachmentPreviewSourceSignature,
  buildNativeComposerUpdatePayload,
  canUseNativeIosComposer,
  emptyNativeComposerAutocomplete,
  getNativeIosComposerPlugin,
  nativeComposerAutocompleteEqual,
  buildNativeComposerChipRanges,
  nativeComposerChipSpecsFromHighlights,
  nativeComposerStatesEqual,
  nativeIosComposerAgentColor,
  nativeIosComposerAppearanceFromRoot,
  packNativeIosComposerIdenticon,
  rasterizeAttachmentThumbnailBase64,
  rasterizeLogoPngBase64,
  resolveCssVarToHex,
  resolveNativeComposerTextWrite,
  setNativeComposerDocumentClass,
  shouldIgnoreNativeComposerTextEcho,
  type NativeIosComposerAttachmentPreview,
  type NativeIosComposerAutocomplete,
  type NativeIosComposerChipHighlight,
  type NativeIosComposerState,
} from '@/lib/native-ios-composer';

const nativeSuggestionIconCache = new Map<string, string>();

const autocompleteRowSignature = (
  rows: readonly ComposerAutocompleteListRow[],
  open: boolean,
  highlightedIndex: number,
): string => `${open ? 1 : 0}:${highlightedIndex}:${rows.map((row) => (
  `${row.id}\0${row.title}\0${row.subtitle ?? ''}\0${row.badge ?? ''}\0${row.iconName}`
)).join('|')}`;

const rasterizeAutocompleteRows = async (
  rows: readonly ComposerAutocompleteListRow[],
): Promise<NativeIosComposerAutocomplete['rows']> => {
  const color = resolveCssVarToHex('--surface-foreground');
  return Promise.all(rows.slice(0, 40).map(async (row) => {
    const cacheKey = `${row.iconName}:${color}`;
    let iconBase64 = nativeSuggestionIconCache.get(cacheKey);
    if (iconBase64 === undefined) {
      iconBase64 = (await rasterizeSpriteIconPngBase64(row.iconName, color)) ?? '';
      nativeSuggestionIconCache.set(cacheKey, iconBase64);
    }
    return {
      id: row.id,
      title: row.title,
      subtitle: row.subtitle ?? '',
      badge: row.badge ?? '',
      iconBase64,
    };
  }));
};

export type NativeIosComposerAttachmentSource = {
  id: string;
  filename: string;
  mimeType: string;
  dataUrl?: string;
};

export type UseNativeIosComposerArgs = {
  enabled: boolean;
  isMobile: boolean;
  text: string;
  /** Bumps on JS-authored document replace (edit restore, session switch). */
  textPresetEpoch: number;
  placeholder: string;
  modelLabel: string;
  modelVariantLabel: string;
  modelId?: string | null;
  providerId?: string | null;
  canSend: boolean;
  canAbort: boolean;
  attachmentCount: number;
  suppressed: boolean;
  attachAria: string;
  attachTitle: string;
  attachPhotosLabel: string;
  attachFilesLabel: string;
  attachCancelLabel: string;
  sendAria: string;
  queueAria: string;
  stopAria: string;
  modelAria: string;
  agentName: string;
  agentLabel: string;
  agentAria: string;
  showScrollToBottom: boolean;
  scrollAria: string;
  attachments: readonly NativeIosComposerAttachmentSource[];
  removeAttachmentNamedAria: (name: string) => string;
  onText: (text: string, composing: boolean, selection: { start: number; end: number } | null) => void;
  onSend: (text: string) => void;
  onAbort: () => void;
  onAttach: () => void;
  onFiles: (files: File[], skipped: string[]) => void;
  onRemoveAttachment: (id: string) => void;
  onOpenModel: () => void;
  onCycleAgent: () => void;
  onOpenAgent: () => void;
  onScrollToBottom: () => void;
  onAutocompleteAccept?: (index: number) => void;
  onAutocompleteDismiss?: () => void;
  autocompleteOpen?: boolean;
  autocompleteHighlightedIndex?: number;
  autocompleteRows?: readonly ComposerAutocompleteListRow[];
  /** JS-authored caret to apply with forceText (accept/insert). */
  caret?: number;
  /** Web highlight parts; native paints trigger-icon chips from these. */
  chipHighlights?: readonly NativeIosComposerChipHighlight[] | null;
};

const EMPTY_AUTOCOMPLETE_ROWS: ComposerAutocompleteListRow[] = [];
const noopAutocompleteAccept = (_index: number): void => undefined;
const noopAutocompleteDismiss = (): void => undefined;

/**
 * Drives the Capacitor iOS native composer overlay. Send, attach, model, and
 * agent stay owned by ChatInput; native UI only paints the input chrome.
 * File picking is presented natively on the + tap; this hook only receives
 * the resulting File objects.
 */
export function useNativeIosComposer(args: UseNativeIosComposerArgs): boolean {
  const nativeUiEnabled = useIosNativeUiEnabled();
  const available = nativeUiEnabled && args.enabled && canUseNativeIosComposer(args.isMobile);
  const lastStateRef = useRef<NativeIosComposerState | null>(null);
  const nativeTextRef = useRef(args.text);
  const echoingNativeRef = useRef(false);
  const lastTextPresetEpochRef = useRef(-1);
  const replacedNativeTextRef = useRef<string | null>(null);
  const modelIconRef = useRef('');
  const previewRef = useRef<NativeIosComposerAttachmentPreview[]>([]);
  const autocompleteRef = useRef<NativeIosComposerAutocomplete>(emptyNativeComposerAutocomplete());

  const onText = useEvent(args.onText);
  const onSend = useEvent(args.onSend);
  const onAbort = useEvent(args.onAbort);
  const onAttach = useEvent(args.onAttach);
  const onFiles = useEvent(args.onFiles);
  const onRemoveAttachment = useEvent(args.onRemoveAttachment);
  const onOpenModel = useEvent(args.onOpenModel);
  const onCycleAgent = useEvent(args.onCycleAgent);
  const onOpenAgent = useEvent(args.onOpenAgent);
  const onScrollToBottom = useEvent(args.onScrollToBottom);
  const onAutocompleteAccept = useEvent(args.onAutocompleteAccept ?? noopAutocompleteAccept);
  const onAutocompleteDismiss = useEvent(args.onAutocompleteDismiss ?? noopAutocompleteDismiss);
  const onHeight = useEvent((height: number) => {
    if (typeof document === 'undefined') return;
    applyNativeComposerHeightVar(document.documentElement, height);
  });
  nativeIosComposerSession.bind({
    onText: (text, composing, selection) => {
      if (shouldIgnoreNativeComposerTextEcho({
        incoming: text,
        replacedText: replacedNativeTextRef.current,
      })) {
        return;
      }
      replacedNativeTextRef.current = null;
      nativeTextRef.current = text;
      echoingNativeRef.current = true;
      onText(text, composing, selection);
    },
    onSend: (text) => {
      nativeTextRef.current = text;
      onSend(text);
    },
    onAbort,
    onAttach,
    onFiles,
    onRemoveAttachment,
    onOpenModel,
    onCycleAgent,
    onOpenAgent,
    onHeight,
    onScrollToBottom,
    onAutocompleteAccept: (index) => {
      // Accept is JS-authored. A leftover keystroke echo must not omit the
      // inserted token from the next native update.
      echoingNativeRef.current = false;
      onAutocompleteAccept(index);
    },
    onAutocompleteDismiss,
  });

  const readState = (): NativeIosComposerState => ({
    text: args.text,
    placeholder: args.placeholder,
    modelLabel: args.modelLabel,
    modelVariantLabel: args.modelVariantLabel,
    modelIcon: modelIconRef.current,
    canSend: args.canSend,
    canAbort: args.canAbort,
    attachmentCount: args.attachmentCount,
    attachmentPreviews: previewRef.current,
    citationRanges: findAttachmentCitationRanges(
      args.text,
      args.attachments.map((file) => file.filename),
    ),
    chipRanges: buildNativeComposerChipRanges(
      nativeComposerChipSpecsFromHighlights(args.text, args.chipHighlights),
      resolveCssVarToHex('--primary'),
    ),
    appearance: typeof document === 'undefined'
      ? 'dark'
      : nativeIosComposerAppearanceFromRoot(document.documentElement),
    attachAria: args.attachAria,
    attachTitle: args.attachTitle,
    attachPhotosLabel: args.attachPhotosLabel,
    attachFilesLabel: args.attachFilesLabel,
    attachCancelLabel: args.attachCancelLabel,
    sendAria: args.sendAria,
    queueAria: args.queueAria,
    stopAria: args.stopAria,
    modelAria: args.modelAria,
    agentAria: args.agentAria,
    agentLabel: args.agentLabel,
    agentColor: nativeIosComposerAgentColor(args.agentName || undefined),
    agentIdenticon: packNativeIosComposerIdenticon(args.agentName || undefined),
    suppressed: args.suppressed,
    showScrollToBottom: args.showScrollToBottom,
    scrollAria: args.scrollAria,
    autocomplete: autocompleteRef.current,
  });

  useLayoutEffect(() => {
    if (!available || typeof document === 'undefined') return;
    const root = document.documentElement;
    setNativeComposerDocumentClass(root, true);
    return () => {
      setNativeComposerDocumentClass(root, false);
    };
  }, [available]);

  useEffect(() => {
    if (!available || typeof document === 'undefined') return;
    const root = document.documentElement;
    const state = readState();
    lastStateRef.current = state;
    nativeTextRef.current = state.text;
    nativeIosComposerSession.rememberText(state.text);
    void nativeIosComposerSession.retain(root, state);
    const detachLeave = attachNativeIosComposerLeaveConceal();
    return () => {
      lastStateRef.current = null;
      detachLeave();
      nativeIosComposerSession.release(root);
    };
    // retain/release is tied to availability. Page remounts share one overlay.
  }, [available]);

  useEffect(() => {
    if (!available) return;
    let cancelled = false;
    const src = resolveModelLogoSrc(args.modelId, args.providerId);
    // The overlay is a process singleton. Always republish name + thinking
    // with the icon so a session switch cannot keep the previous chip text.
    const chrome = {
      modelIcon: '',
      modelLabel: args.modelLabel,
      modelVariantLabel: args.modelVariantLabel,
    };
    modelIconRef.current = '';
    if (lastStateRef.current) lastStateRef.current = { ...lastStateRef.current, ...chrome };
    void getNativeIosComposerPlugin().update(chrome);
    if (!src) {
      return;
    }
    void rasterizeLogoPngBase64(src).then((base64) => {
      if (cancelled) return;
      const next = base64 ?? '';
      modelIconRef.current = next;
      const painted = {
        modelIcon: next,
        modelLabel: args.modelLabel,
        modelVariantLabel: args.modelVariantLabel,
      };
      if (lastStateRef.current) lastStateRef.current = { ...lastStateRef.current, ...painted };
      void getNativeIosComposerPlugin().update(painted);
    });
    return () => { cancelled = true; };
  }, [available, args.modelId, args.providerId, args.modelLabel, args.modelVariantLabel]);

  const attachmentSignature = attachmentPreviewSourceSignature(args.attachments);
  useEffect(() => {
    if (!available) return;
    let cancelled = false;
    const sources = args.attachments;
    if (sources.length === 0) {
      previewRef.current = [];
      if (lastStateRef.current) {
        lastStateRef.current = { ...lastStateRef.current, attachmentPreviews: [] };
        nativeIosComposerSession.rememberState(lastStateRef.current);
      }
      void getNativeIosComposerPlugin().update({ attachmentPreviews: [] });
      return;
    }
    void Promise.all(sources.map(async (file) => {
      const thumbnail = file.mimeType.startsWith('image/') && file.dataUrl
        ? await rasterizeAttachmentThumbnailBase64(file.dataUrl)
        : '';
      return {
        id: file.id,
        filename: file.filename,
        mime: file.mimeType,
        thumbnailBase64: thumbnail ?? '',
        removeAria: args.removeAttachmentNamedAria(file.filename),
      } satisfies NativeIosComposerAttachmentPreview;
    })).then((previews) => {
      if (cancelled) return;
      previewRef.current = previews;
      if (lastStateRef.current) {
        lastStateRef.current = { ...lastStateRef.current, attachmentPreviews: previews };
        nativeIosComposerSession.rememberState(lastStateRef.current);
      }
      void getNativeIosComposerPlugin().update({ attachmentPreviews: previews });
    });
    return () => { cancelled = true; };
  }, [available, attachmentSignature]);

  const autocompleteRows = args.autocompleteRows ?? EMPTY_AUTOCOMPLETE_ROWS;
  const autocompleteOpen = args.autocompleteOpen === true;
  const autocompleteHighlightedIndex = args.autocompleteHighlightedIndex ?? 0;
  const suggestionSignature = autocompleteRowSignature(
    autocompleteRows,
    autocompleteOpen,
    autocompleteHighlightedIndex,
  );
  useEffect(() => {
    if (!available) return;
    let cancelled = false;
    const open = autocompleteOpen && autocompleteRows.length > 0;
    if (!open) {
      const next = emptyNativeComposerAutocomplete();
      if (!nativeComposerAutocompleteEqual(autocompleteRef.current, next)) {
        autocompleteRef.current = next;
        if (lastStateRef.current) {
          lastStateRef.current = { ...lastStateRef.current, autocomplete: next };
          nativeIosComposerSession.rememberState(lastStateRef.current);
        }
        void getNativeIosComposerPlugin().update({ autocomplete: next });
      }
      return;
    }
    void rasterizeAutocompleteRows(autocompleteRows).then((rows) => {
      if (cancelled) return;
      const next: NativeIosComposerAutocomplete = {
        open: rows.length > 0,
        highlightedIndex: Math.max(0, Math.min(autocompleteHighlightedIndex, Math.max(rows.length - 1, 0))),
        rows,
      };
      if (nativeComposerAutocompleteEqual(autocompleteRef.current, next)) return;
      autocompleteRef.current = next;
      if (lastStateRef.current) {
        lastStateRef.current = { ...lastStateRef.current, autocomplete: next };
        nativeIosComposerSession.rememberState(lastStateRef.current);
      }
      void getNativeIosComposerPlugin().update({ autocomplete: next });
    });
    return () => { cancelled = true; };
  }, [available, suggestionSignature]);

  const chipRangeSignature = available
    ? nativeComposerChipSpecsFromHighlights(args.text, args.chipHighlights).map((spec) => (
      `${spec.start}:${spec.end}:${spec.triggerLength}`
    )).join('|')
    : '';

  useEffect(() => {
    if (!available) return;
    const next = readState();
    const previous = lastStateRef.current;
    if (previous && nativeComposerStatesEqual(previous, next)) {
      echoingNativeRef.current = false;
      lastTextPresetEpochRef.current = args.textPresetEpoch;
      return;
    }
    lastStateRef.current = next;
    nativeIosComposerSession.rememberState(next);
    const preset = args.textPresetEpoch !== lastTextPresetEpochRef.current;
    lastTextPresetEpochRef.current = args.textPresetEpoch;
    const write = resolveNativeComposerTextWrite({
      nextText: next.text,
      nativeOwnedText: nativeTextRef.current,
      echoingNative: echoingNativeRef.current,
      preset,
    });
    echoingNativeRef.current = false;
    if (!write.omitText && write.forceText) {
      replacedNativeTextRef.current = nativeTextRef.current;
    }
    if (!write.omitText) {
      nativeTextRef.current = next.text;
    }
    const payload = buildNativeComposerUpdatePayload(previous, next, write, {
      caret: args.caret,
    });
    if (!payload) return;
    void getNativeIosComposerPlugin().update(payload);
    // readState closes over the latest ChatInput props; listing them is the contract.
  }, [
    available,
    args.text,
    args.textPresetEpoch,
    args.placeholder,
    args.modelLabel,
    args.modelVariantLabel,
    args.modelId,
    args.providerId,
    args.canSend,
    args.canAbort,
    args.attachmentCount,
    attachmentSignature,
    args.suppressed,
    args.attachAria,
    args.attachTitle,
    args.attachPhotosLabel,
    args.attachFilesLabel,
    args.attachCancelLabel,
    args.sendAria,
    args.queueAria,
    args.stopAria,
    args.modelAria,
    args.agentName,
    args.agentLabel,
    args.agentAria,
    args.showScrollToBottom,
    args.scrollAria,
    chipRangeSignature,
  ]);

  return available;
}
