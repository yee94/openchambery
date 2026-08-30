import type { PluginListenerHandle } from '@capacitor/core';

import {
  filesFromNativeComposerPayload,
  getNativeIosComposerPlugin,
  hiddenNativeIosComposerWarmState,
  parseNativeComposerAcceptIndex,
  parseNativeComposerHeight,
  parseNativeComposerRemoveAttachmentId,
  parseNativeComposerSelection,
  setNativeComposerDocumentClass,
  skippedNamesFromNativeComposerPayload,
  type NativeIosComposerEventPayload,
  type NativeIosComposerPlugin,
  type NativeIosComposerState,
} from './native-ios-composer';

export type NativeIosComposerSessionHandlers = {
  onText: (text: string, composing: boolean, selection: { start: number; end: number } | null) => void;
  onSend: (text: string) => void;
  onAbort: () => void;
  onAttach: () => void;
  onFiles: (files: File[], skipped: string[]) => void;
  onRemoveAttachment: (id: string) => void;
  onOpenModel: () => void;
  onCycleAgent: () => void;
  onOpenAgent: () => void;
  onHeight: (height: number) => void;
  onScrollToBottom: () => void;
  onAutocompleteAccept: (index: number) => void;
  onAutocompleteDismiss: () => void;
};

/**
 * One native overlay for the process. ChatInput may remount on every phone
 * page (projects↔chat, nested push/pop); the UITextView / glass view must not.
 * Homepage `warm` pre-creates the glass while the tab bar is up so entering
 * chat is show/apply, not UIGlassEffect init. Leaving chat calls `conceal`
 * (`hide`) first so the pill is gone before the Projects underlay is fully on
 * screen. `dismiss` waits one macrotask for a same-flush remount; listeners
 * stay attached like the native tab bar so the next enter does not re-bridge.
 */
export const createNativeIosComposerSession = (
  getPlugin: () => NativeIosComposerPlugin = getNativeIosComposerPlugin,
) => {
  let retainCount = 0;
  let hideTimer: ReturnType<typeof setTimeout> | null = null;
  let listeners: PluginListenerHandle[] = [];
  let handlers: NativeIosComposerSessionHandlers | null = null;
  let lastText = '';
  let concealed = false;
  let warmed = false;

  const cancelHide = (): void => {
    if (hideTimer === null) return;
    clearTimeout(hideTimer);
    hideTimer = null;
  };

  const dispatch = <K extends keyof NativeIosComposerSessionHandlers>(
    name: K,
    ...args: Parameters<NativeIosComposerSessionHandlers[K]>
  ): void => {
    const current = handlers;
    if (!current) return;
    (current[name] as (...values: typeof args) => void)(...args);
  };

  const attachListeners = async (): Promise<void> => {
    if (listeners.length > 0) return;
    const plugin = getPlugin();
    const next = await Promise.all([
      plugin.addListener('textChanged', (payload: NativeIosComposerEventPayload) => {
        const text = typeof payload.text === 'string' ? payload.text : '';
        lastText = text;
        dispatch('onText', text, payload.composing === true, parseNativeComposerSelection(payload));
      }),
      plugin.addListener('send', (payload: NativeIosComposerEventPayload) => {
        const text = typeof payload.text === 'string' ? payload.text : lastText;
        lastText = text;
        dispatch('onSend', text);
      }),
      plugin.addListener('abort', () => { dispatch('onAbort'); }),
      plugin.addListener('attach', () => { dispatch('onAttach'); }),
      plugin.addListener('filesPicked', (payload: NativeIosComposerEventPayload) => {
        dispatch(
          'onFiles',
          filesFromNativeComposerPayload(payload),
          skippedNamesFromNativeComposerPayload(payload),
        );
        void getPlugin().focus();
      }),
      plugin.addListener('removeAttachment', (payload: NativeIosComposerEventPayload) => {
        const id = parseNativeComposerRemoveAttachmentId(payload);
        if (id) dispatch('onRemoveAttachment', id);
      }),
      plugin.addListener('openModel', () => { dispatch('onOpenModel'); }),
      plugin.addListener('cycleAgent', () => { dispatch('onCycleAgent'); }),
      plugin.addListener('openAgent', () => { dispatch('onOpenAgent'); }),
      plugin.addListener('heightChanged', (payload: NativeIosComposerEventPayload) => {
        dispatch('onHeight', parseNativeComposerHeight(payload));
      }),
      plugin.addListener('scrollToBottom', () => { dispatch('onScrollToBottom'); }),
      plugin.addListener('autocompleteAccept', (payload: NativeIosComposerEventPayload) => {
        dispatch('onAutocompleteAccept', parseNativeComposerAcceptIndex(payload));
      }),
      plugin.addListener('autocompleteDismiss', () => { dispatch('onAutocompleteDismiss'); }),
    ]);
    if (listeners.length > 0) {
      for (const handle of next) void handle.remove();
      return;
    }
    listeners = next;
  };

  const commitHide = (root: HTMLElement): void => {
    if (retainCount > 0) return;
    handlers = null;
    concealed = false;
    setNativeComposerDocumentClass(root, false);
    void getPlugin().dismiss();
  };

  return {
    bind(next: NativeIosComposerSessionHandlers): void {
      handlers = next;
    },
    rememberText(text: string): void {
      lastText = text;
    },
    rememberState(state: NativeIosComposerState): void {
      lastText = state.text;
    },
    /**
     * Visual hide now. The UITextView / glass view stay installed so a later
     * retain or cancelled back can show them again. Teardown is `release`.
     * Reveal only unhides — it must not present last JS state over live text.
     */
    conceal(): void {
      if (concealed || retainCount === 0) return;
      concealed = true;
      void getPlugin().hide();
    },
    reveal(): void {
      if (!concealed || retainCount === 0) return;
      concealed = false;
      void getPlugin().show();
    },
    /**
     * Install the glass overlay while it is still hidden. Safe on the
     * homepage: does not set the document class or increment retainCount.
     * A later retain present() applies live state and unhides.
     */
    async warm(): Promise<void> {
      if (warmed || retainCount > 0) return;
      warmed = true;
      await getPlugin().present(hiddenNativeIosComposerWarmState());
    },
    async retain(root: HTMLElement, state: NativeIosComposerState): Promise<void> {
      cancelHide();
      retainCount += 1;
      concealed = false;
      warmed = true;
      lastText = state.text;
      setNativeComposerDocumentClass(root, true);
      if (listeners.length === 0) await attachListeners();
      await getPlugin().present(state);
    },
    release(root: HTMLElement): void {
      retainCount = Math.max(0, retainCount - 1);
      if (retainCount > 0) return;
      cancelHide();
      hideTimer = setTimeout(() => {
        hideTimer = null;
        commitHide(root);
      }, 0);
    },
    /** Test / reset only. */
    snapshot(): {
      retainCount: number;
      listenerCount: number;
      hidePending: boolean;
      concealed: boolean;
      warmed: boolean;
    } {
      return {
        retainCount,
        listenerCount: listeners.length,
        hidePending: hideTimer !== null,
        concealed,
        warmed,
      };
    },
  };
};

export type NativeIosComposerSession = ReturnType<typeof createNativeIosComposerSession>;

export const nativeIosComposerSession = createNativeIosComposerSession();
