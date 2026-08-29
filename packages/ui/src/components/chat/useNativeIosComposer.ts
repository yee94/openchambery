import { useEffect, useRef } from 'react';
import { useEvent } from '@reactuses/core';

import { resolveModelLogoSrc } from '@/hooks/useModelLogo';
import { attachNativeIosComposerLeaveConceal } from '@/lib/native-ios-composer-leave';
import { nativeIosComposerSession } from '@/lib/native-ios-composer-session';
import { findAttachmentCitationRanges } from '@/components/chat/attachmentCitations';
import {
  applyNativeComposerHeightVar,
  attachmentPreviewSourceSignature,
  canUseNativeIosComposer,
  getNativeIosComposerPlugin,
  nativeComposerStatesEqual,
  nativeIosComposerAgentColor,
  nativeIosComposerAppearanceFromRoot,
  packNativeIosComposerIdenticon,
  rasterizeAttachmentThumbnailBase64,
  rasterizeLogoPngBase64,
  resolveNativeComposerTextWrite,
  type NativeIosComposerAttachmentPreview,
  type NativeIosComposerState,
} from '@/lib/native-ios-composer';

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
  onText: (text: string, composing: boolean) => void;
  onSend: (text: string) => void;
  onAbort: () => void;
  onAttach: () => void;
  onFiles: (files: File[], skipped: string[]) => void;
  onRemoveAttachment: (id: string) => void;
  onOpenModel: () => void;
  onCycleAgent: () => void;
  onOpenAgent: () => void;
  onScrollToBottom: () => void;
};

/**
 * Drives the Capacitor iOS native composer overlay. Send, attach, model, and
 * agent stay owned by ChatInput; native UI only paints the input chrome.
 * File picking is presented natively on the + tap; this hook only receives
 * the resulting File objects.
 */
export function useNativeIosComposer(args: UseNativeIosComposerArgs): boolean {
  const available = args.enabled && canUseNativeIosComposer(args.isMobile);
  const lastStateRef = useRef<NativeIosComposerState | null>(null);
  const nativeTextRef = useRef(args.text);
  const echoingNativeRef = useRef(false);
  const modelIconRef = useRef('');
  const previewRef = useRef<NativeIosComposerAttachmentPreview[]>([]);

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
  const onHeight = useEvent((height: number) => {
    if (typeof document === 'undefined') return;
    applyNativeComposerHeightVar(document.documentElement, height);
  });
  nativeIosComposerSession.bind({
    onText: (text, composing) => {
      nativeTextRef.current = text;
      echoingNativeRef.current = true;
      onText(text, composing);
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
  });

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
    if (!src) {
      modelIconRef.current = '';
      if (lastStateRef.current) lastStateRef.current = { ...lastStateRef.current, modelIcon: '' };
      void getNativeIosComposerPlugin().update({ modelIcon: '' });
      return;
    }
    void rasterizeLogoPngBase64(src).then((base64) => {
      if (cancelled) return;
      const next = base64 ?? '';
      modelIconRef.current = next;
      if (lastStateRef.current) lastStateRef.current = { ...lastStateRef.current, modelIcon: next };
      void getNativeIosComposerPlugin().update({ modelIcon: next });
    });
    return () => { cancelled = true; };
  }, [available, args.modelId, args.providerId]);

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

  useEffect(() => {
    if (!available) return;
    const next = readState();
    const previous = lastStateRef.current;
    if (previous && nativeComposerStatesEqual(previous, next)) {
      echoingNativeRef.current = false;
      return;
    }
    lastStateRef.current = next;
    nativeIosComposerSession.rememberState(next);
    const write = resolveNativeComposerTextWrite({
      nextText: next.text,
      nativeOwnedText: nativeTextRef.current,
      echoingNative: echoingNativeRef.current,
    });
    echoingNativeRef.current = false;
    if (write.omitText) {
      nativeTextRef.current = next.text;
      const { text: _text, ...rest } = next;
      void getNativeIosComposerPlugin().update(rest);
      return;
    }
    nativeTextRef.current = next.text;
    void getNativeIosComposerPlugin().update({ ...next, forceText: write.forceText });
    // readState closes over the latest ChatInput props; listing them is the contract.
  }, [
    available,
    args.text,
    args.placeholder,
    args.modelLabel,
    args.modelVariantLabel,
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
  ]);

  return available;
}
