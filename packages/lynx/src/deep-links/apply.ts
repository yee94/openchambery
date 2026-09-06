/**
 * Apply parsed `openchamber://` intents to Lynx shell navigation.
 * Mirrors Cap `deepLinkNavigation.ts`: stash until connect/handlers ready.
 */
import type { DeepLinkIntent, SessionsFilter, ViewTarget } from './intents';
import { parseDeepLink } from './intents';

export type LynxDeepLinkNavCommand =
  | { type: 'openChat'; sessionId: string; directory?: string | null }
  | { type: 'openDraft'; directory?: string | null; prompt?: string }
  | { type: 'setTab'; tab: 'projects' | 'assistant' | 'scheduled' | 'settings'; filter?: SessionsFilter }
  | { type: 'openSettings'; section?: string }
  | { type: 'openInstances' }
  | { type: 'openSheet'; sheet: 'files' | 'changes' | 'mcp'; path?: string; staged?: boolean }
  | { type: 'connect'; pairing: Extract<DeepLinkIntent, { type: 'connect' }>['pairing'] };

export type LynxDeepLinkHandlers = {
  applyNav: (command: LynxDeepLinkNavCommand) => boolean;
  /** Optional connect redeem path (pairing). */
  applyConnect?: (pairing: Extract<DeepLinkIntent, { type: 'connect' }>['pairing']) => boolean;
};

let handlers: LynxDeepLinkHandlers | null = null;
let connectReady = false;
let pending: DeepLinkIntent | null = null;

const viewToSheet = (target: ViewTarget): 'files' | 'mcp' | null => {
  if (target === 'files') return 'files';
  if (target === 'mcp') return 'mcp';
  return null;
};

const execute = (intent: DeepLinkIntent): boolean => {
  if (!handlers) return false;

  switch (intent.type) {
    case 'connect':
      if (!handlers.applyConnect) return false;
      return handlers.applyConnect(intent.pairing);

    case 'session':
      return handlers.applyNav({
        type: 'openChat',
        sessionId: intent.sessionId,
        directory: intent.directory ?? null,
      });

    case 'new-session':
    case 'open-project':
      return handlers.applyNav({
        type: 'openDraft',
        directory: intent.type === 'open-project' ? intent.directory : intent.directory,
        prompt: intent.type === 'new-session' ? intent.prompt : undefined,
      });

    case 'sessions':
    case 'status':
      return handlers.applyNav({
        type: 'setTab',
        tab: 'projects',
        filter: intent.type === 'sessions' ? intent.filter : undefined,
      });

    case 'settings':
      return handlers.applyNav({
        type: 'openSettings',
        section: intent.section,
      });

    case 'changes':
      return handlers.applyNav({
        type: 'openSheet',
        sheet: 'changes',
        path: intent.path,
        staged: intent.staged,
      });

    case 'view': {
      if (intent.target === 'instances') {
        return handlers.applyNav({ type: 'openInstances' });
      }
      if (intent.target === 'update') {
        return handlers.applyNav({ type: 'openSettings', section: 'about' });
      }
      const sheet = viewToSheet(intent.target);
      if (!sheet) return false;
      return handlers.applyNav({ type: 'openSheet', sheet });
    }
  }
};

const flush = (): void => {
  if (!pending) return;
  // Connect intents can run before full shell; other intents wait for connectReady.
  if (!connectReady && pending.type !== 'connect') return;
  const intent = pending;
  pending = null;
  if (!execute(intent)) {
    pending = intent;
  }
};

export const setLynxDeepLinkConnectReady = (ready: boolean): void => {
  connectReady = ready;
  flush();
};

export const registerLynxDeepLinkHandlers = (next: LynxDeepLinkHandlers | null): void => {
  handlers = next;
  flush();
};

export const applyLynxDeepLinkIntent = (intent: DeepLinkIntent): void => {
  pending = intent;
  flush();
};

export const applyLynxDeepLinkUrl = (raw: string | null | undefined): void => {
  const intent = parseDeepLink(raw);
  if (intent) applyLynxDeepLinkIntent(intent);
};

export const peekLynxPendingDeepLink = (): DeepLinkIntent | null => pending;

/** Test helper — reset module stash. */
export const resetLynxDeepLinkApplyState = (): void => {
  handlers = null;
  connectReady = false;
  pending = null;
};
