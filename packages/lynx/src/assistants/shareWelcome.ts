/**
 * Cap AssistantShareWelcome spirit for Lynx.
 * Education chrome on top of the share inbox — does not invent share routing.
 */

export const LYNX_ASSISTANT_SHARE_WELCOME_STORAGE_KEY = 'openchamber:assistant-share-welcome:v1';

export type LynxShareWelcomeExampleId = 'chat' | 'article' | 'note';

export const LYNX_SHARE_WELCOME_EXAMPLES: ReadonlyArray<{
  id: LynxShareWelcomeExampleId;
  titleKey: string;
  descriptionKey: string;
}> = [
  {
    id: 'chat',
    titleKey: 'lynx.shareWelcome.example.chat.title',
    descriptionKey: 'lynx.shareWelcome.example.chat.description',
  },
  {
    id: 'article',
    titleKey: 'lynx.shareWelcome.example.article.title',
    descriptionKey: 'lynx.shareWelcome.example.article.description',
  },
  {
    id: 'note',
    titleKey: 'lynx.shareWelcome.example.note.title',
    descriptionKey: 'lynx.shareWelcome.example.note.description',
  },
] as const;

export type LynxShareWelcomeState = {
  dismissed: boolean;
  /** Controlled open from Settings "Learn more" etc. */
  controlledOpen: boolean | null;
};

export const createLynxShareWelcomeState = (
  dismissed = false,
): LynxShareWelcomeState => ({
  dismissed,
  controlledOpen: null,
});

export function resolveLynxShareWelcomeOpen(
  state: LynxShareWelcomeState,
  options?: { enabled?: boolean },
): boolean {
  if (state.controlledOpen !== null) return state.controlledOpen;
  return options?.enabled === true && state.dismissed !== true;
}

export function dismissLynxShareWelcome(
  state: LynxShareWelcomeState,
): LynxShareWelcomeState {
  if (state.controlledOpen !== null) {
    return { ...state, controlledOpen: false };
  }
  return { ...state, dismissed: true, controlledOpen: null };
}

export function openLynxShareWelcome(
  state: LynxShareWelcomeState,
): LynxShareWelcomeState {
  return { ...state, controlledOpen: true };
}

export type LynxShareWelcomeStore = {
  getState: () => LynxShareWelcomeState;
  /** Persist dismissed flag via host kv (Cap localStorage key spirit). */
  hydrateDismissed: (dismissed: boolean) => void;
  isOpen: (enabled?: boolean) => boolean;
  dismiss: () => void;
  open: () => void;
  /** Serialize dismissed for host persistence. */
  shouldPersistDismissed: () => boolean;
};

export function createLynxShareWelcomeStore(
  initialDismissed = false,
): LynxShareWelcomeStore {
  let state = createLynxShareWelcomeState(initialDismissed);
  return {
    getState: () => state,
    hydrateDismissed: (dismissed) => {
      state = { ...state, dismissed };
    },
    isOpen: (enabled = false) => resolveLynxShareWelcomeOpen(state, { enabled }),
    dismiss: () => {
      state = dismissLynxShareWelcome(state);
    },
    open: () => {
      state = openLynxShareWelcome(state);
    },
    shouldPersistDismissed: () => state.dismissed,
  };
}
