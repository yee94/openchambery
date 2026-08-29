import { useEffect, useRef } from 'react';
import { useEvent, useUnmount } from '@reactuses/core';

import {
  applyNativeComposerHeightVar,
  canUseNativeIosComposer,
  getNativeIosComposerPlugin,
  nativeComposerStatesEqual,
  nativeIosComposerAppearanceFromRoot,
  parseNativeComposerHeight,
  setNativeComposerDocumentClass,
  type NativeIosComposerState,
} from '@/lib/native-ios-composer';

export type UseNativeIosComposerArgs = {
  enabled: boolean;
  isMobile: boolean;
  text: string;
  placeholder: string;
  modelLabel: string;
  canSend: boolean;
  canAbort: boolean;
  attachmentCount: number;
  suppressed: boolean;
  attachAria: string;
  sendAria: string;
  stopAria: string;
  modelAria: string;
  onText: (text: string) => void;
  onSend: (text: string) => void;
  onAbort: () => void;
  onAttach: () => void;
  onOpenModel: () => void;
};

/**
 * Drives the Capacitor iOS native composer overlay. Send, attach, and model
 * stay owned by ChatInput; native UI only paints the input chrome.
 */
export function useNativeIosComposer(args: UseNativeIosComposerArgs): boolean {
  const available = args.enabled && canUseNativeIosComposer(args.isMobile);
  const lastStateRef = useRef<NativeIosComposerState | null>(null);
  const nativeTextRef = useRef(args.text);

  const onText = useEvent(args.onText);
  const onSend = useEvent(args.onSend);
  const onAbort = useEvent(args.onAbort);
  const onAttach = useEvent(args.onAttach);
  const onOpenModel = useEvent(args.onOpenModel);

  const readState = (): NativeIosComposerState => ({
    text: args.text,
    placeholder: args.placeholder,
    modelLabel: args.modelLabel,
    canSend: args.canSend,
    canAbort: args.canAbort,
    attachmentCount: args.attachmentCount,
    appearance: typeof document === 'undefined'
      ? 'dark'
      : nativeIosComposerAppearanceFromRoot(document.documentElement),
    attachAria: args.attachAria,
    sendAria: args.sendAria,
    stopAria: args.stopAria,
    modelAria: args.modelAria,
    suppressed: args.suppressed,
  });

  useEffect(() => {
    if (!available || typeof document === 'undefined') return;
    const root = document.documentElement;
    setNativeComposerDocumentClass(root, true);
    const plugin = getNativeIosComposerPlugin();
    const state = readState();
    lastStateRef.current = state;
    nativeTextRef.current = state.text;
    void plugin.present(state);

    let textHandle: { remove: () => Promise<void> } | undefined;
    let sendHandle: { remove: () => Promise<void> } | undefined;
    let abortHandle: { remove: () => Promise<void> } | undefined;
    let attachHandle: { remove: () => Promise<void> } | undefined;
    let modelHandle: { remove: () => Promise<void> } | undefined;
    let heightHandle: { remove: () => Promise<void> } | undefined;

    void plugin.addListener('textChanged', (payload) => {
      const text = typeof payload.text === 'string' ? payload.text : '';
      nativeTextRef.current = text;
      onText(text);
    }).then((handle) => { textHandle = handle; });
    void plugin.addListener('send', (payload) => {
      const text = typeof payload.text === 'string' ? payload.text : nativeTextRef.current;
      nativeTextRef.current = text;
      onSend(text);
    }).then((handle) => { sendHandle = handle; });
    void plugin.addListener('abort', () => { onAbort(); }).then((handle) => { abortHandle = handle; });
    void plugin.addListener('attach', () => { onAttach(); }).then((handle) => { attachHandle = handle; });
    void plugin.addListener('openModel', () => { onOpenModel(); }).then((handle) => { modelHandle = handle; });
    void plugin.addListener('heightChanged', (payload) => {
      applyNativeComposerHeightVar(root, parseNativeComposerHeight(payload));
    }).then((handle) => { heightHandle = handle; });

    return () => {
      void textHandle?.remove();
      void sendHandle?.remove();
      void abortHandle?.remove();
      void attachHandle?.remove();
      void modelHandle?.remove();
      void heightHandle?.remove();
      lastStateRef.current = null;
      setNativeComposerDocumentClass(root, false);
      void plugin.dismiss();
    };
    // present/dismiss is tied to availability, not every keystroke.
  }, [available]);

  useEffect(() => {
    if (!available) return;
    const next = readState();
    const previous = lastStateRef.current;
    if (previous && nativeComposerStatesEqual(previous, next)) return;
    lastStateRef.current = next;
    if (next.text !== nativeTextRef.current) nativeTextRef.current = next.text;
    void getNativeIosComposerPlugin().update(next);
    // readState closes over the latest ChatInput props; listing them is the contract.
  }, [
    available,
    args.text,
    args.placeholder,
    args.modelLabel,
    args.canSend,
    args.canAbort,
    args.attachmentCount,
    args.suppressed,
    args.attachAria,
    args.sendAria,
    args.stopAria,
    args.modelAria,
  ]);

  useUnmount(() => {
    if (typeof document === 'undefined') return;
    setNativeComposerDocumentClass(document.documentElement, false);
  });

  return available;
}
