/**
 * Apply `openchamber://` intents the same way Cap's `deepLinkNavigation` does:
 * pairing v2 redeem can run on the disconnected welcome screen; navigation
 * intents stash until the shell is ready.
 */

import { parseDeepLink } from './deepLinks.ts';
import type { LynxDeepLinkIntent, LynxPairingConnectionPayload, LynxSessionsFilter } from './types.ts';

export type LynxDeepLinkHandlers = {
  openSessions?: (filter?: LynxSessionsFilter) => void;
  openView?: (target: 'files' | 'mcp' | 'instances' | 'update') => void;
  openChanges?: (options?: { path?: string; staged?: boolean }) => void;
  openSettings?: (section?: string) => void;
  openSession?: (sessionId: string, directory?: string) => void;
  openDraft?: (intent: Extract<LynxDeepLinkIntent, { type: 'new-session' }>) => void;
  openProject?: (directory: string) => void;
  openStatus?: () => void;
};

export type LynxApplyDeepLinkResult =
  | { kind: 'ignored' }
  | { kind: 'pairing-queued'; pairing: LynxPairingConnectionPayload }
  | { kind: 'pairing-started'; pairing: LynxPairingConnectionPayload }
  | { kind: 'navigation'; intent: Exclude<LynxDeepLinkIntent, { type: 'connect' }> }
  | { kind: 'stashed'; intent: LynxDeepLinkIntent };

export type LynxDeepLinkInbox = {
  applyUrl: (raw: string | null | undefined) => LynxApplyDeepLinkResult;
  applyIntent: (intent: LynxDeepLinkIntent) => LynxApplyDeepLinkResult;
  setReady: (ready: boolean) => void;
  setPairingHandler: (handler: ((pairing: LynxPairingConnectionPayload) => void) | null) => void;
  setHandlers: (handlers: LynxDeepLinkHandlers) => void;
  peekPending: () => LynxDeepLinkIntent | null;
};

export const createLynxDeepLinkInbox = (): LynxDeepLinkInbox => {
  let ready = false;
  let pending: LynxDeepLinkIntent | null = null;
  let pairingHandler: ((pairing: LynxPairingConnectionPayload) => void) | null = null;
  let handlers: LynxDeepLinkHandlers = {};

  const execute = (intent: LynxDeepLinkIntent): boolean => {
    switch (intent.type) {
      case 'connect':
        if (!pairingHandler) return false;
        pairingHandler(intent.pairing);
        return true;
      case 'session':
        if (!handlers.openSession) return false;
        handlers.openSession(intent.sessionId, intent.directory);
        return true;
      case 'new-session':
        if (!handlers.openDraft) return false;
        handlers.openDraft(intent);
        return true;
      case 'open-project':
        if (!handlers.openProject) return false;
        handlers.openProject(intent.directory);
        return true;
      case 'sessions':
        if (!handlers.openSessions) return false;
        handlers.openSessions(intent.filter);
        return true;
      case 'status':
        if (!handlers.openStatus) return false;
        handlers.openStatus();
        return true;
      case 'settings':
        if (!handlers.openSettings) return false;
        handlers.openSettings(intent.section);
        return true;
      case 'changes':
        if (!handlers.openChanges) return false;
        handlers.openChanges({ path: intent.path, staged: intent.staged });
        return true;
      case 'view':
        if (!handlers.openView) return false;
        handlers.openView(intent.target);
        return true;
    }
  };

  const flush = (): LynxApplyDeepLinkResult | null => {
    if (!pending || (!ready && pending.type !== 'connect')) return null;
    const intent = pending;
    pending = null;
    if (!execute(intent)) {
      pending = intent;
      return { kind: 'stashed', intent };
    }
    if (intent.type === 'connect') return { kind: 'pairing-started', pairing: intent.pairing };
    return { kind: 'navigation', intent };
  };

  const applyIntent = (intent: LynxDeepLinkIntent): LynxApplyDeepLinkResult => {
    pending = intent;
    return flush() ?? (intent.type === 'connect'
      ? { kind: 'pairing-queued', pairing: intent.pairing }
      : { kind: 'stashed', intent });
  };

  return {
    applyUrl: (raw) => {
      const intent = parseDeepLink(raw);
      if (!intent) return { kind: 'ignored' };
      return applyIntent(intent);
    },
    applyIntent,
    setReady: (value) => {
      ready = value;
      flush();
    },
    setPairingHandler: (handler) => {
      pairingHandler = handler;
      flush();
    },
    setHandlers: (next) => {
      handlers = next;
      flush();
    },
    peekPending: () => pending,
  };
};
