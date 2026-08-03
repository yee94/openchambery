import { describe, expect, it } from 'bun:test';
import { createSessionGoalRuntime } from './runtime.js';

// A session whose last assistant message is an orphaned incomplete turn: the
// app was force-killed mid-generation, so opencode left a message with no
// time.completed AND no error, while the session is actually idle. Before the
// quiescence fix this was misclassified as "busy" and the tick bailed forever,
// stranding a restarted active goal on "evaluating".
const orphanIncompleteAssistant = {
  info: { id: 'msg-orphan', role: 'assistant', time: { created: 100 }, providerID: 'p', modelID: 'm' },
  parts: [],
};

const buildSession = (status = 'active') => ({
  id: 'ses-goal',
  directory: '/repo',
  metadata: {
    openchamber: {
      goal: {
        id: 'goal-1',
        status,
        objective: 'finish the feature',
        objectiveFile: false,
        statusReason: status === 'active' ? 'resumed' : '',
        turnsUsed: 0,
        tokensUsed: 0,
        tokensBaseline: 0,
        tokensCommitted: 0,
        lastAccountedMessageID: '',
        blockedStreak: 0,
        auditFailStreak: 0,
        createdAt: 0,
        updatedAt: Date.now(),
      },
    },
  },
});

// Build a mock fetch that answers the endpoints the goal tick needs. `messages`
// is the message list returned for the session; `liveStatus` is the type
// returned by /session/status for the session.
const makeFetch = ({ messages, liveStatus }) => {
  const calls = { promptAsync: 0, patchSession: 0 };
  const session = buildSession();
  return {
    calls,
    fetch: async (input, init = {}) => {
      const url = String(input);
      const path = url.split('?')[0];
      if (path.endsWith('/session/status')) {
        return new Response(JSON.stringify({ 'ses-goal': { type: liveStatus } }), { status: 200 });
      }
      if (path.endsWith('/session/ses-goal/message')) {
        return new Response(JSON.stringify(messages), { status: 200 });
      }
      if (path.endsWith('/session/ses-goal')) {
        if (init.method === 'PATCH') {
          calls.patchSession += 1;
          return new Response(JSON.stringify(session), { status: 200 });
        }
        return new Response(JSON.stringify(session), { status: 200 });
      }
      if (path.endsWith('/prompt_async')) {
        calls.promptAsync += 1;
        return new Response(JSON.stringify({}), { status: 200 });
      }
      return new Response(JSON.stringify(session), { status: 200 });
    },
  };
};

const makeRuntime = () =>
  createSessionGoalRuntime({
    buildOpenCodeUrl: (pathname) => `http://opencode${pathname}`,
    getOpenCodeAuthHeaders: () => ({}),
    getSmallModelService: async () => ({
      generateSmallModelText: async () => ({ text: '{"verdict":"continue","note":"in progress"}' }),
    }),
    idleQuietMs: 1_000_000, // avoid incidental re-arms in the test
    kickoffQuietMs: 1,
    maxAutoTurns: 20,
  });

// Override the module-level fetch used by openCodeFetch via globalThis.
const withFetch = async (fetchImpl, fn) => {
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
};

describe('session-goal runtime — restart-orphan quiescence', () => {
  it('resumes past an orphaned incomplete assistant message when the session is idle', async () => {
    const { fetch, calls } = makeFetch({
      messages: [
        { info: { id: 'msg-user', role: 'user' }, parts: [] },
        orphanIncompleteAssistant,
      ],
      liveStatus: 'idle',
    });

    await withFetch(fetch, async () => {
      const runtime = makeRuntime();
      runtime.processPayload({
        type: 'session.updated',
        properties: {
          sessionID: 'ses-goal',
          directory: '/repo',
          info: buildSession(),
        },
      });
      // The resumed kickoff timer (RESUME_KICKOFF_MS = 250ms) must fire before
      // the tick runs — wait past it.
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(calls.promptAsync).toBeGreaterThan(0);
      runtime.stop();
    });
  });

  it('still bails on an orphaned incomplete message when the session is genuinely busy', async () => {
    const { fetch, calls } = makeFetch({
      messages: [
        { info: { id: 'msg-user', role: 'user' }, parts: [] },
        orphanIncompleteAssistant,
      ],
      liveStatus: 'busy',
    });

    await withFetch(fetch, async () => {
      const runtime = makeRuntime();
      runtime.processPayload({
        type: 'session.updated',
        properties: {
          sessionID: 'ses-goal',
          directory: '/repo',
          info: buildSession(),
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(calls.promptAsync).toBe(0);
      runtime.stop();
    });
  });

  it('resumes normally when the tail assistant is complete (no regression)', async () => {
    const { fetch, calls } = makeFetch({
      messages: [
        { info: { id: 'msg-user', role: 'user' }, parts: [] },
        { info: { id: 'msg-done', role: 'assistant', time: { completed: 200 }, providerID: 'p', modelID: 'm' }, parts: [] },
      ],
      liveStatus: 'idle',
    });

    await withFetch(fetch, async () => {
      const runtime = makeRuntime();
      runtime.processPayload({
        type: 'session.updated',
        properties: {
          sessionID: 'ses-goal',
          directory: '/repo',
          info: buildSession(),
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(calls.promptAsync).toBeGreaterThan(0);
      runtime.stop();
    });
  });
});
