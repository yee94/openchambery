import { describe, expect, it } from 'bun:test';
import { accountGoalTokenSpend, createSessionGoalRuntime, messageTokenSpend } from './runtime.js';

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

describe('session-goal continuation delivery', () => {
  it('marks auto-continuation parts as synthetic so the UI can hide them', async () => {
    const promptBodies = [];
    const messages = [
      { info: { id: 'msg-user', role: 'user' }, parts: [] },
      {
        info: {
          id: 'msg-done',
          role: 'assistant',
          time: { completed: 200 },
          providerID: 'p',
          modelID: 'm',
          tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
        },
        parts: [{ type: 'text', text: 'done: 一二三' }],
      },
    ];
    const session = buildSession();
    session.metadata.openchamber.goal.createdAt = 1;
    const fetchImpl = async (input, init = {}) => {
      const url = String(input);
      const path = url.split('?')[0];
      if (path.endsWith('/session/status')) {
        return new Response(JSON.stringify({ 'ses-goal': { type: 'idle' } }), { status: 200 });
      }
      if (path.endsWith('/session/ses-goal/message')) {
        return new Response(JSON.stringify(messages), { status: 200 });
      }
      if (path.endsWith('/session/ses-goal')) {
        if (init.method === 'PATCH' && init.body) {
          const body = JSON.parse(init.body);
          session.metadata = body.metadata;
        }
        return new Response(JSON.stringify(session), { status: 200 });
      }
      if (path.endsWith('/prompt_async')) {
        promptBodies.push(JSON.parse(init.body || '{}'));
        return new Response(JSON.stringify({}), { status: 200 });
      }
      return new Response(JSON.stringify(session), { status: 200 });
    };

    await withFetch(fetchImpl, async () => {
      const runtime = createSessionGoalRuntime({
        buildOpenCodeUrl: (pathname) => `http://opencode${pathname}`,
        getOpenCodeAuthHeaders: () => ({}),
        getSmallModelService: async () => ({
          generateSmallModelText: async () => ({ text: '{"verdict":"continue","note":"still going"}' }),
        }),
        idleQuietMs: 1_000_000,
        kickoffQuietMs: 1,
        maxAutoTurns: 20,
      });
      runtime.processPayload({
        type: 'session.updated',
        properties: {
          sessionID: 'ses-goal',
          directory: '/repo',
          info: session,
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(promptBodies.length).toBeGreaterThan(0);
      expect(promptBodies[0].parts[0].synthetic).toBe(true);
      expect(String(promptBodies[0].parts[0].text)).toContain('Continue working toward the active session goal.');
      runtime.stop();
    });
  });
});

describe('session-goal token accounting', () => {
  it('sums per-turn spend and ignores cache.read', () => {
    expect(messageTokenSpend({
      tokens: { input: 100, output: 50, reasoning: 10, cache: { read: 9999, write: 20 } },
    })).toBe(180);

    const first = accountGoalTokenSpend({
      goal: { tokensUsed: 0, lastAccountedMessageID: '', createdAt: 1_000 },
      messages: [
        {
          info: {
            id: 'msg-pre',
            role: 'assistant',
            time: { completed: 500 },
            tokens: { input: 1_000, output: 200, reasoning: 0, cache: { read: 0, write: 0 } },
          },
        },
        {
          info: {
            id: 'msg-a',
            role: 'assistant',
            time: { completed: 1_500 },
            tokens: { input: 100, output: 40, reasoning: 5, cache: { read: 800, write: 10 } },
          },
        },
        {
          info: {
            id: 'msg-b',
            role: 'assistant',
            time: { completed: 2_000 },
            tokens: { input: 120, output: 30, reasoning: 0, cache: { read: 900, write: 0 } },
          },
        },
      ],
    });
    // Pre-goal msg-pre skipped; msg-a 155 + msg-b 150.
    expect(first.tokensUsed).toBe(305);
    expect(first.lastAccountedMessageID).toBe('msg-b');

    const second = accountGoalTokenSpend({
      goal: { tokensUsed: first.tokensUsed, lastAccountedMessageID: first.lastAccountedMessageID, createdAt: 1_000 },
      messages: [
        {
          info: {
            id: 'msg-b',
            role: 'assistant',
            time: { completed: 2_000 },
            tokens: { input: 120, output: 30, reasoning: 0, cache: { read: 900, write: 0 } },
          },
        },
        {
          info: {
            id: 'msg-c',
            role: 'assistant',
            time: { completed: 2_500 },
            tokens: { input: 50, output: 25, reasoning: 0, cache: { read: 1_000, write: 5 } },
          },
        },
      ],
    });
    // Only msg-c is new: 80 more.
    expect(second.tokensUsed).toBe(385);
    expect(second.lastAccountedMessageID).toBe('msg-c');
  });

  it('skips summary turns but advances the cursor', () => {
    const result = accountGoalTokenSpend({
      goal: { tokensUsed: 100, lastAccountedMessageID: 'msg-a', createdAt: 1_000 },
      messages: [
        {
          info: {
            id: 'msg-summary',
            role: 'assistant',
            summary: true,
            time: { completed: 2_000 },
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          },
        },
      ],
    });
    expect(result.tokensUsed).toBe(100);
    expect(result.lastAccountedMessageID).toBe('msg-summary');
  });
});

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
