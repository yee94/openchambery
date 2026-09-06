/**
 * Send / stop / queue hooks for Lynx chat.
 * When a connect runtime exists, calls official OpenCode routes.
 * Without a runtime, returns explicit failures — never fake-success.
 */
import {
  abortSession,
  promptAsync,
  type LynxSessionApiDeps,
} from './sessionApi';

export type LynxComposerModel = {
  providerID: string;
  modelID: string;
  agent?: string;
  variant?: string;
};

export type LynxQueuedPrompt = {
  id: string;
  text: string;
  createdAt: number;
};

export type LynxComposerActionResult =
  | { status: 'ok'; messageId?: string; aborted?: true; queuedId?: string }
  | { status: 'failed'; error: string; reason: 'no-runtime' | 'http' | 'invalid' | 'busy-steer-required' };

export type LynxComposerActions = {
  send: (text: string, options?: { messageId?: string; delivery?: 'steer' }) => Promise<LynxComposerActionResult>;
  stop: () => Promise<LynxComposerActionResult>;
  queue: (text: string) => Promise<LynxComposerActionResult>;
  flushQueue: () => Promise<LynxComposerActionResult>;
  getQueue: () => readonly LynxQueuedPrompt[];
};

export type CreateLynxComposerActionsInput = {
  sessionId: string;
  directory?: string | null;
  model: LynxComposerModel;
  /** Null / undefined = not connected — actions fail honestly. */
  sessionApi: LynxSessionApiDeps | null;
  /** When true, follow-ups go to the local queue instead of prompt_async. */
  sessionIsWorking?: () => boolean;
  followUpBehavior?: 'steer' | 'queue';
  now?: () => number;
  createId?: () => string;
};

export function createLynxComposerActions(
  input: CreateLynxComposerActionsInput,
): LynxComposerActions {
  const queue: LynxQueuedPrompt[] = [];
  const now = input.now ?? (() => Date.now());
  const createId = input.createId ?? (() => `queue_${now().toString(36)}`);
  const followUpBehavior = input.followUpBehavior ?? 'queue';

  const requireApi = (): LynxSessionApiDeps | LynxComposerActionResult => {
    if (!input.sessionApi) {
      return {
        status: 'failed',
        error: 'No connect runtime — send/stop/queue cannot call OpenCode APIs',
        reason: 'no-runtime',
      };
    }
    return input.sessionApi;
  };

  return {
    getQueue: () => queue.slice(),

    send: async (text, options) => {
      const trimmed = text.trim();
      if (!trimmed) {
        return { status: 'failed', error: 'empty prompt', reason: 'invalid' };
      }
      const api = requireApi();
      if ('status' in api) return api;

      const working = input.sessionIsWorking?.() ?? false;
      if (working && followUpBehavior === 'queue' && options?.delivery !== 'steer') {
        return {
          status: 'failed',
          error: 'session busy — use queue() or delivery:steer',
          reason: 'busy-steer-required',
        };
      }

      const result = await promptAsync(api, {
        sessionId: input.sessionId,
        directory: input.directory,
        text: trimmed,
        providerID: input.model.providerID,
        modelID: input.model.modelID,
        agent: input.model.agent,
        variant: input.model.variant,
        messageId: options?.messageId,
        delivery: options?.delivery,
      });
      if (result.status === 'ok') return { status: 'ok', messageId: result.messageId };
      return { status: 'failed', error: result.error, reason: 'http' };
    },

    stop: async () => {
      const api = requireApi();
      if ('status' in api) return api;
      const result = await abortSession(api, {
        sessionId: input.sessionId,
        directory: input.directory,
      });
      if (result.status === 'ok') return { status: 'ok', aborted: true };
      return { status: 'failed', error: result.error, reason: 'http' };
    },

    queue: async (text) => {
      const trimmed = text.trim();
      if (!trimmed) {
        return { status: 'failed', error: 'empty prompt', reason: 'invalid' };
      }
      // Queue is local until flush hits prompt_async. Still require a runtime
      // so we never pretend a disconnected client can deliver later.
      const api = requireApi();
      if ('status' in api) return api;
      const item: LynxQueuedPrompt = {
        id: createId(),
        text: trimmed,
        createdAt: now(),
      };
      queue.push(item);
      return { status: 'ok', queuedId: item.id };
    },

    flushQueue: async () => {
      const api = requireApi();
      if ('status' in api) return api;
      if (queue.length === 0) {
        return { status: 'failed', error: 'queue empty', reason: 'invalid' };
      }
      if (input.sessionIsWorking?.()) {
        return {
          status: 'failed',
          error: 'session still working — wait or stop before flush',
          reason: 'busy-steer-required',
        };
      }
      const next = queue[0]!;
      const result = await promptAsync(api, {
        sessionId: input.sessionId,
        directory: input.directory,
        text: next.text,
        providerID: input.model.providerID,
        modelID: input.model.modelID,
        agent: input.model.agent,
        variant: input.model.variant,
      });
      if (result.status !== 'ok') {
        return { status: 'failed', error: result.error, reason: 'http' };
      }
      queue.shift();
      return { status: 'ok', messageId: result.messageId };
    },
  };
}
