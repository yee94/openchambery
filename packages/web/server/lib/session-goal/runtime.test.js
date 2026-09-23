import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createSessionMetadataStore } from '../session-metadata/session-metadata-store.js';
import {
  configureServerOpenCodeFetchGate,
} from '../opencode/server-opencode-fetch.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  accountGoalTokenSpend,
  buildContinuationMessageID,
  buildPendingContinuation,
  createSessionGoalRuntime,
  extractExecutionModel,
  messageTokenSpend,
  parsePendingContinuation,
  projectGoalMessages,
  readGoalExecutionGeneration,
  shouldAdvanceGoalExecutionGeneration,
  unwrapSessionMessages,
  withGoalExecutionGeneration,
} from './runtime.js';

// Host SDK writes share the runtime-contract gate. Unit tests have no lifecycle
// contract — allow missing so real switchAgent/switchModel/prompt reach fetch fixtures.
beforeAll(() => {
  configureServerOpenCodeFetchGate(null, { allowMissingContract: true });
});
afterAll(() => {
  configureServerOpenCodeFetchGate(null);
});

/** Resolve installed @opencode/schema SessionMessage next to @opencode/client (no extra dep). */
const loadInstalledSessionMessageSchema = async () => {
  const candidates = [];
  const tryClientLink = (clientLink) => {
    try {
      if (!fs.existsSync(clientLink)) return;
      const clientDir = fs.realpathSync(clientLink);
      candidates.push(path.join(path.dirname(clientDir), 'schema', 'dist', 'session-message.js'));
    } catch {
      // ignore missing link
    }
  };
  // packages/web dependency
  tryClientLink(path.join(process.cwd(), 'node_modules/@opencode/client'));
  tryClientLink(path.join(process.cwd(), 'packages/web/node_modules/@opencode/client'));
  // bun nested install layout
  const bunRoot = path.join(process.cwd(), 'node_modules/.bun');
  if (fs.existsSync(bunRoot)) {
    for (const name of fs.readdirSync(bunRoot)) {
      if (!name.startsWith('@opencode+client@')) continue;
      candidates.push(path.join(
        bunRoot,
        name,
        'node_modules/@opencode/schema/dist/session-message.js',
      ));
    }
  }
  for (const schemaPath of candidates) {
    if (fs.existsSync(schemaPath)) {
      return import(pathToFileURL(schemaPath).href);
    }
  }
  throw new Error('installed @opencode/schema session-message not found beside @opencode/client');
};

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

/** Match both legacy `/session/...` and official v2 `/api/session/...` paths. */
const pathEndsWith = (urlPath, suffix) => {
  const normalized = String(urlPath || '').split('?')[0];
  return normalized.endsWith(suffix) || normalized.endsWith(`/api${suffix}`);
};

const jsonResponse = (body, status = 200) => new Response(
  body === null || body === undefined ? null : JSON.stringify(body),
  { status, headers: { 'Content-Type': 'application/json' } },
);

const emptyResponse = (status = 204) => new Response(null, { status });

// Build a mock fetch that answers the endpoints the goal tick needs. `messages`
// is the message list returned for the session; `liveStatus` is the type
// returned by /session/status (or mapped from /session/active) for the session.
const makeFetch = ({ messages, liveStatus }) => {
  const calls = { promptAsync: 0, prompt: 0, patchSession: 0 };
  const session = buildSession();
  return {
    calls,
    fetch: async (input, init = {}) => {
      const url = String(input);
      const reqPath = url.split('?')[0];
      if (pathEndsWith(reqPath, '/session/status')) {
        return jsonResponse({ 'ses-goal': { type: liveStatus } });
      }
      if (pathEndsWith(reqPath, '/session/active')) {
        const data = liveStatus === 'busy' || liveStatus === 'retry'
          ? { 'ses-goal': true }
          : {};
        return jsonResponse({ data });
      }
      if (pathEndsWith(reqPath, '/session/ses-goal/message')) {
        // Official v2 SessionMessagesResponse shape.
        return jsonResponse({ data: messages, cursor: {} });
      }
      if (pathEndsWith(reqPath, '/session/ses-goal') && !reqPath.includes('/message')) {
        if (init.method === 'PATCH') {
          calls.patchSession += 1;
          // openCodeFetch (no /api) expects bare session; SDK wraps { data }.
          return jsonResponse(reqPath.includes('/api/') ? { data: session } : session);
        }
        return jsonResponse(reqPath.includes('/api/') ? { data: session } : session);
      }
      if (pathEndsWith(reqPath, '/prompt') || pathEndsWith(reqPath, '/prompt_async')) {
        if (pathEndsWith(reqPath, '/prompt_async')) calls.promptAsync += 1;
        else calls.prompt += 1;
        // v2 session.prompt successStatus 200 with SessionInboxUser body.
        return jsonResponse({
          data: { id: 'inbox_1', type: 'user', sessionID: 'ses-goal', time: { created: 1 }, payload: { text: 'x' }, delivery: 'steer' },
        });
      }
      if (pathEndsWith(reqPath, '/model') || pathEndsWith(reqPath, '/agent')) {
        return emptyResponse(204);
      }
      return jsonResponse(reqPath.includes('/api/') ? { data: session } : session);
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

describe('session-goal pending continuation helpers', () => {
  it('parses and builds durable pendingContinuation admission records', () => {
    expect(parsePendingContinuation(null)).toBeNull();
    expect(parsePendingContinuation({ messageID: 'msg_x' })).toBeNull();
    const built = buildPendingContinuation({
      messageID: 'msg_goalc_g_0_1',
      goalId: 'g',
      generation: 0,
      turnsUsed: 1,
      phase: 'reserved',
      text: 'Continue…',
      providerID: 'p',
      modelID: 'm',
      agent: 'build',
    });
    expect(parsePendingContinuation(built)).toMatchObject({
      messageID: 'msg_goalc_g_0_1',
      phase: 'reserved',
      turnsUsed: 1,
      providerID: 'p',
    });
  });
});

describe('session-goal v2 message projection helpers', () => {
  it('unwraps SessionMessagesResponse, bare arrays, and projects raw SessionMessageInfo', () => {
    expect(unwrapSessionMessages(null)).toBeNull();
    expect(unwrapSessionMessages({ data: [{ id: 'a', type: 'user', text: 'hi', time: { created: 1 } }], cursor: {} }))
      .toEqual([{ id: 'a', type: 'user', text: 'hi', time: { created: 1 } }]);
    const projected = projectGoalMessages({
      data: [
        { id: 'u1', type: 'user', text: 'go', time: { created: 1 } },
        {
          id: 'a1',
          type: 'assistant',
          agent: 'build',
          model: { id: 'm', providerID: 'p', variant: 'fast' },
          time: { created: 2, completed: 3 },
          content: [{ type: 'text', text: 'done' }],
        },
        {
          id: 'c1',
          type: 'compaction',
          status: 'completed',
          reason: 'auto',
          summary: 'summary text',
          recent: '',
          time: { created: 4 },
        },
      ],
      cursor: {},
    }, 'ses-1');
    expect(projected).toHaveLength(3);
    expect(projected[0].info.role).toBe('user');
    expect(projected[1].info.role).toBe('assistant');
    expect(projected[1].parts[0].text).toBe('done');
    expect(projected[2].info.summary).toBe(true);
    expect(extractExecutionModel(projected[1].info)).toEqual({
      providerID: 'p',
      modelID: 'm',
      variant: 'fast',
      agent: 'build',
    });
    expect(buildContinuationMessageID({ goalId: 'goal-1', generation: 2, turnsUsed: 5 }))
      .toBe('msg_goalc_goal-1_2_5');
  });

  it('continuation id satisfies installed SessionMessage.ID (msg_ prefix)', async () => {
    const SessionMessage = await loadInstalledSessionMessageSchema();
    const legal = buildContinuationMessageID({ goalId: 'goal-1', generation: 2, turnsUsed: 5 });
    expect(legal.startsWith('msg_')).toBe(true);
    expect(SessionMessage.ID.make(legal)).toBe(legal);
    // Legacy goalc_ prefix is rejected by the official schema contract.
    expect(() => SessionMessage.ID.make('goalc_goal-1_2_5')).toThrow();
  });
});

describe('session-goal continuation delivery', () => {
  it('dispatches v2 session.prompt with stable continuation id and metadata', async () => {
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
      const reqPath = url.split('?')[0];
      if (pathEndsWith(reqPath, '/session/status')) {
        return jsonResponse({ 'ses-goal': { type: 'idle' } });
      }
      if (pathEndsWith(reqPath, '/session/active')) {
        return jsonResponse({ data: {} });
      }
      if (pathEndsWith(reqPath, '/session/ses-goal/message')) {
        return jsonResponse({ data: messages, cursor: {} });
      }
      if (pathEndsWith(reqPath, '/session/ses-goal') && !reqPath.includes('/message')) {
        if (init.method === 'PATCH' && init.body) {
          const body = JSON.parse(init.body);
          session.metadata = body.metadata;
        }
        return jsonResponse(reqPath.includes('/api/') ? { data: session } : session);
      }
      if (pathEndsWith(reqPath, '/model') || pathEndsWith(reqPath, '/agent')) {
        return emptyResponse(204);
      }
      if (pathEndsWith(reqPath, '/prompt') || pathEndsWith(reqPath, '/prompt_async')) {
        promptBodies.push(JSON.parse(init.body || '{}'));
        return jsonResponse({
          data: { id: 'inbox_1', type: 'user', sessionID: 'ses-goal', time: { created: 1 }, payload: { text: 'x' }, delivery: 'steer' },
        });
      }
      return jsonResponse(reqPath.includes('/api/') ? { data: session } : session);
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
      await runtime.runTick('ses-goal', '/repo');
      expect(promptBodies.length).toBeGreaterThan(0);
      const body = promptBodies[0];
      expect(body.id).toBe(buildContinuationMessageID({ goalId: 'goal-1', generation: 0, turnsUsed: 1 }));
      expect(body.id.startsWith('msg_')).toBe(true);
      const SessionMessage = await loadInstalledSessionMessageSchema();
      expect(SessionMessage.ID.make(body.id)).toBe(body.id);
      expect(String(body.text)).toContain('Continue working toward the active session goal.');
      expect(body.metadata?.openchamber?.goalContinuation).toBe(true);
      // User-boundary prompt: synthetic lives in metadata only (not type: synthetic).
      expect(body.metadata?.openchamber?.synthetic).toBe(true);
      expect(body.type).not.toBe('synthetic');
      expect(runtime.getDispatchedContinuation('ses-goal')).toMatchObject({
        goalId: 'goal-1',
        generation: 0,
        turnsUsed: 1,
        messageID: body.id,
        phase: 'accepted',
      });
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
      await runtime.runTick('ses-goal', '/repo');
      expect(calls.prompt + calls.promptAsync).toBeGreaterThan(0);
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
      await runtime.runTick('ses-goal', '/repo');
      expect(calls.prompt + calls.promptAsync).toBe(0);
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
      await runtime.runTick('ses-goal', '/repo');
      expect(calls.prompt + calls.promptAsync).toBeGreaterThan(0);
      runtime.stop();
    });
  });
});

const questionAskedPayload = (sessionID = 'ses-goal') => ({
  type: 'question.asked',
  properties: {
    id: 'que_1',
    sessionID,
    questions: [{ question: 'Push?', header: 'Push', options: [{ label: 'Yes', description: '' }] }],
  },
});

const flushQuestionPause = () => new Promise((resolve) => setTimeout(resolve, 50));

describe('session-goal runtime — pause for question', () => {
  it('patches an active goal to paused without sending a continuation', async () => {
    const patches = [];
    const calls = { promptAsync: 0, abort: 0 };
    const session = buildSession('active');
    const fetchImpl = async (input, init = {}) => {
      const url = String(input);
      const path = url.split('?')[0];
      if (path.includes('/abort')) {
        calls.abort += 1;
        return new Response(JSON.stringify({}), { status: 200 });
      }
      if (path.endsWith('/prompt_async')) {
        calls.promptAsync += 1;
        return new Response(JSON.stringify({}), { status: 200 });
      }
      if (path.endsWith('/session/ses-goal')) {
        if (init.method === 'PATCH') {
          const body = JSON.parse(init.body || '{}');
          patches.push(body);
          session.metadata = body.metadata;
        }
        return new Response(JSON.stringify(session), { status: 200 });
      }
      return new Response(JSON.stringify(session), { status: 200 });
    };

    await withFetch(fetchImpl, async () => {
      const runtime = makeRuntime();
      runtime.processPayload(questionAskedPayload(), '/repo');
      await flushQuestionPause();
      expect(patches.length).toBe(1);
      expect(patches[0].metadata.openchamber.goal.status).toBe('paused');
      expect(patches[0].metadata.openchamber.goal.statusReason).toBe('paused for question');
      expect(calls.promptAsync).toBe(0);
      expect(calls.abort).toBe(0);
      runtime.stop();
    });
  });

  it('does not PATCH a session that has no goal', async () => {
    let patchCount = 0;
    const session = { id: 'ses-goal', directory: '/repo' };
    const fetchImpl = async (input, init = {}) => {
      const path = String(input).split('?')[0];
      if (path.endsWith('/session/ses-goal') && init.method === 'PATCH') {
        patchCount += 1;
      }
      return new Response(JSON.stringify(session), { status: 200 });
    };

    await withFetch(fetchImpl, async () => {
      const runtime = makeRuntime();
      runtime.processPayload(questionAskedPayload(), '/repo');
      await flushQuestionPause();
      expect(patchCount).toBe(0);
      runtime.stop();
    });
  });

  it('does not change an already paused goal', async () => {
    const patches = [];
    const session = buildSession('paused');
    const fetchImpl = async (input, init = {}) => {
      const path = String(input).split('?')[0];
      if (path.endsWith('/session/ses-goal') && init.method === 'PATCH') {
        patches.push(JSON.parse(init.body || '{}'));
      }
      return new Response(JSON.stringify(session), { status: 200 });
    };

    await withFetch(fetchImpl, async () => {
      const runtime = makeRuntime();
      runtime.processPayload(questionAskedPayload(), '/repo');
      await flushQuestionPause();
      expect(patches.length).toBe(0);
      expect(session.metadata.openchamber.goal.status).toBe('paused');
      runtime.stop();
    });
  });

  it('pauses the parent session goal when a child session asks a question', async () => {
    const patches = [];
    const child = { id: 'ses-child', parentID: 'ses-goal', directory: '/repo' };
    const parent = buildSession('active');
    const fetchImpl = async (input, init = {}) => {
      const path = String(input).split('?')[0];
      if (path.endsWith('/session/ses-child')) {
        return new Response(JSON.stringify(child), { status: 200 });
      }
      if (path.endsWith('/session/ses-goal')) {
        if (init.method === 'PATCH') {
          const body = JSON.parse(init.body || '{}');
          patches.push(body);
          parent.metadata = body.metadata;
        }
        return new Response(JSON.stringify(parent), { status: 200 });
      }
      return new Response(JSON.stringify(parent), { status: 200 });
    };

    await withFetch(fetchImpl, async () => {
      const runtime = makeRuntime();
      runtime.processPayload(questionAskedPayload('ses-child'), '/repo');
      await flushQuestionPause();
      expect(patches.length).toBe(1);
      expect(patches[0].metadata.openchamber.goal.status).toBe('paused');
      expect(patches[0].metadata.openchamber.goal.statusReason).toBe('paused for question');
      runtime.stop();
    });
  });

  it('keeps the goal active when question auto-delegate will handle the ask', async () => {
    const patches = [];
    const session = buildSession('active');
    const fetchImpl = async (input, init = {}) => {
      const path = String(input).split('?')[0];
      if (path.endsWith('/session/ses-goal') && init.method === 'PATCH') {
        patches.push(JSON.parse(init.body || '{}'));
      }
      return new Response(JSON.stringify(session), { status: 200 });
    };

    await withFetch(fetchImpl, async () => {
      const runtime = createSessionGoalRuntime({
        buildOpenCodeUrl: (pathname) => `http://opencode${pathname}`,
        getOpenCodeAuthHeaders: () => ({}),
        getSmallModelService: async () => ({
          generateSmallModelText: async () => ({ text: '{"verdict":"continue","note":"in progress"}' }),
        }),
        idleQuietMs: 1_000_000,
        kickoffQuietMs: 1,
        shouldKeepGoalActiveForQuestion: () => true,
      });
      runtime.processPayload(questionAskedPayload(), '/repo');
      await flushQuestionPause();
      expect(patches.length).toBe(0);
      expect(session.metadata.openchamber.goal.status).toBe('active');
      runtime.stop();
    });
  });

  it('pauses the root owner goal when a grandchild session asks a question', async () => {
    const patches = [];
    const grand = { id: 'ses-grand', parentID: 'ses-child', directory: '/repo/wt' };
    const child = { id: 'ses-child', parentID: 'ses-goal', directory: '/repo/wt' };
    const parent = buildSession('active');
    parent.directory = '/repo';
    const fetchImpl = async (input, init = {}) => {
      const path = String(input).split('?')[0];
      if (path.endsWith('/session/ses-grand')) {
        return new Response(JSON.stringify(grand), { status: 200 });
      }
      if (path.endsWith('/session/ses-child')) {
        return new Response(JSON.stringify(child), { status: 200 });
      }
      if (path.endsWith('/session/ses-goal')) {
        if (init.method === 'PATCH') {
          const body = JSON.parse(init.body || '{}');
          patches.push(body);
          parent.metadata = body.metadata;
        }
        return new Response(JSON.stringify(parent), { status: 200 });
      }
      return new Response(JSON.stringify(parent), { status: 200 });
    };

    await withFetch(fetchImpl, async () => {
      const runtime = makeRuntime();
      runtime.processPayload(questionAskedPayload('ses-grand'), '/repo/wt');
      await flushQuestionPause();
      expect(patches.length).toBe(1);
      expect(patches[0].metadata.openchamber.goal.status).toBe('paused');
      runtime.stop();
    });
  });

  it('notifies onGoalPaused after abort so question timers can reverse-pause', async () => {
    const paused = [];
    const session = buildSession('active');
    const fetchImpl = async (input, init = {}) => {
      const path = String(input).split('?')[0];
      if (path.endsWith('/session/ses-goal') && init.method === 'PATCH') {
        const body = JSON.parse(init.body || '{}');
        session.metadata = body.metadata;
      }
      return new Response(JSON.stringify(session), { status: 200 });
    };

    await withFetch(fetchImpl, async () => {
      const runtime = createSessionGoalRuntime({
        buildOpenCodeUrl: (pathname) => `http://opencode${pathname}`,
        getOpenCodeAuthHeaders: () => ({}),
        getSmallModelService: async () => ({
          generateSmallModelText: async () => ({ text: '{"verdict":"continue","note":"x"}' }),
        }),
        idleQuietMs: 1_000_000,
        kickoffQuietMs: 1,
        onGoalPaused: (sessionId, directory) => {
          paused.push({ sessionId, directory });
        },
      });
      runtime.processPayload({
        type: 'message.updated',
        properties: {
          info: {
            role: 'assistant',
            sessionID: 'ses-goal',
            error: { name: 'MessageAbortedError' },
          },
        },
      }, '/repo');
      await flushQuestionPause();
      expect(session.metadata.openchamber.goal.status).toBe('paused');
      expect(paused).toEqual([{ sessionId: 'ses-goal', directory: '/repo' }]);
      runtime.stop();
    });
  });

  it('notifies onGoalPaused when metadata lands paused before abort (UI race)', async () => {
    const paused = [];
    const session = buildSession('paused');
    session.metadata.openchamber.goal.statusReason = 'paused by user';
    const fetchImpl = async () => new Response(JSON.stringify(session), { status: 200 });

    await withFetch(fetchImpl, async () => {
      const runtime = createSessionGoalRuntime({
        buildOpenCodeUrl: (pathname) => `http://opencode${pathname}`,
        getOpenCodeAuthHeaders: () => ({}),
        getSmallModelService: async () => ({
          generateSmallModelText: async () => ({ text: '{"verdict":"continue","note":"x"}' }),
        }),
        idleQuietMs: 1_000_000,
        kickoffQuietMs: 1,
        onGoalPaused: (sessionId, directory) => {
          paused.push({ sessionId, directory });
        },
      });
      // Abort arrives after UI already wrote paused metadata — must still notify.
      runtime.processPayload({
        type: 'message.updated',
        properties: {
          info: {
            role: 'assistant',
            sessionID: 'ses-goal',
            error: { name: 'MessageAbortedError' },
          },
        },
      }, '/repo');
      await flushQuestionPause();
      expect(paused).toEqual([{ sessionId: 'ses-goal', directory: '/repo' }]);
      runtime.stop();
    });
  });

  it('session.updated paused-by-user notifies onGoalPaused; question pause does not', async () => {
    const paused = [];
    const userPaused = buildSession('paused');
    userPaused.metadata.openchamber.goal.statusReason = 'paused by user';
    const questionPaused = buildSession('paused');
    questionPaused.metadata.openchamber.goal.statusReason = 'paused for question';

    const makeRuntime = (session) => createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => ({
        generateSmallModelText: async () => ({ text: '{"verdict":"continue","note":"x"}' }),
      }),
      idleQuietMs: 1_000_000,
      kickoffQuietMs: 1,
      onGoalPaused: (sessionId, directory) => {
        paused.push({ sessionId, directory, reason: session.metadata.openchamber.goal.statusReason });
      },
    });

    await withFetch(async () => new Response(JSON.stringify(userPaused), { status: 200 }), async () => {
      const runtime = makeRuntime(userPaused);
      runtime.processPayload({
        type: 'session.updated',
        properties: { info: userPaused },
      }, '/repo');
      await flushQuestionPause();
      expect(paused).toEqual([{
        sessionId: 'ses-goal',
        directory: '/repo',
        reason: 'paused by user',
      }]);
      runtime.stop();
    });

    paused.length = 0;
    await withFetch(async () => new Response(JSON.stringify(questionPaused), { status: 200 }), async () => {
      const runtime = makeRuntime(questionPaused);
      runtime.processPayload({
        type: 'session.updated',
        properties: { info: questionPaused },
      }, '/repo');
      await flushQuestionPause();
      // Question-driven pause must preserve auto-delegate timers.
      expect(paused).toEqual([]);
      runtime.stop();
    });
  });
});

describe('session-goal execution generation helpers', () => {
  it('advances generation on pause, resume, and condition changes — not on settle', () => {
    const base = {
      id: 'g1',
      status: 'active',
      executionGeneration: 2,
      tokenBudget: 100,
      objective: 'x',
      objectiveFile: false,
    };
    expect(shouldAdvanceGoalExecutionGeneration(base, { ...base, status: 'paused' })).toBe(true);
    expect(shouldAdvanceGoalExecutionGeneration(
      { ...base, status: 'paused' },
      { ...base, status: 'active' },
    )).toBe(true);
    expect(shouldAdvanceGoalExecutionGeneration(base, { ...base, tokenBudget: 200 })).toBe(true);
    expect(shouldAdvanceGoalExecutionGeneration(base, { ...base, status: 'complete' })).toBe(false);
    expect(readGoalExecutionGeneration({})).toBe(0);
    expect(withGoalExecutionGeneration(base, { ...base, status: 'paused' }).executionGeneration).toBe(3);
  });
});

describe('session-goal runtime — Host metadata store seams', () => {
  it('writes through mutateSessionMetadata and never PATCHes OpenCode metadata when seams are injected', async () => {
    const active = buildSession('active');
    const goal = active.metadata.openchamber.goal;
    const metadata = {
      openchamber: {
        goal: { ...goal, executionGeneration: 0 },
        assist: { recap: 'keep-me' },
      },
    };
    const readSessionMetadata = vi.fn(async () => metadata);
    const mutateSessionMetadata = vi.fn(async (_sessionId, decide) => {
      const decision = decide(metadata);
      if (!decision?.ok) return { committed: false, reason: decision?.reason, metadata };
      metadata.openchamber = {
        ...metadata.openchamber,
        ...(decision.patch.openchamber || {}),
        goal: {
          ...metadata.openchamber.goal,
          ...(decision.patch.openchamber?.goal || {}),
        },
      };
      return { committed: true, metadata };
    });
    const fetchMock = vi.fn(async (input, init = {}) => {
      const url = String(input);
      const reqPath = url.split('?')[0];
      if (init.method === 'PATCH') {
        throw new Error(`OpenCode metadata PATCH must not run when store seams are wired: ${reqPath}`);
      }
      // resolveGoalOwner walks parentID via GET /session/:id
      if (reqPath.endsWith('/session/ses-goal')) {
        return new Response(JSON.stringify({ id: 'ses-goal', directory: '/repo' }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });

    await withFetch(fetchMock, async () => {
      const runtime = createSessionGoalRuntime({
        buildOpenCodeUrl: (pathname) => `http://opencode${pathname}`,
        getOpenCodeAuthHeaders: () => ({}),
        getSmallModelService: async () => {
          throw new Error('small model must not run');
        },
        idleQuietMs: 1_000_000,
        kickoffQuietMs: 1,
        maxAutoTurns: 20,
        readSessionMetadata,
        persistSessionGoal: async () => {
          throw new Error('persistSessionGoal must not run when mutate is wired');
        },
        mutateSessionMetadata,
      });

      await runtime.pauseForQuestion('ses-goal', '/repo');

      expect(readSessionMetadata).toHaveBeenCalledWith('ses-goal');
      expect(mutateSessionMetadata).toHaveBeenCalledTimes(1);
      expect(metadata.openchamber.goal).toMatchObject({
        id: goal.id,
        status: 'paused',
        statusReason: 'paused for question',
        executionGeneration: 1,
      });
      // Neighbouring Host namespaces must survive the goal write.
      expect(metadata.openchamber.assist).toEqual({ recap: 'keep-me' });
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false);
      runtime.stop();
    });
  });
});

describe('session-goal runtime — pause / audit / dispatch boundary', () => {
  const makeTempStore = async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-goal-race-'));
    const store = createSessionMetadataStore({ dataDir });
    await store.load();
    return {
      store,
      dataDir,
      cleanup: () => fs.rmSync(dataDir, { recursive: true, force: true }),
    };
  };

  const idleMessages = [
    { info: { id: 'msg-user', role: 'user' }, parts: [] },
    {
      info: {
        id: 'msg-done',
        role: 'assistant',
        agent: 'build',
        time: { completed: 200 },
        providerID: 'p',
        modelID: 'm',
        tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      parts: [{ type: 'text', text: 'working' }],
    },
  ];

  /**
   * @param {object} [options]
   * @param {Array|object} [options.messages]
   * @param {Set<string>|string[]} [options.knownMessageIDs] exact ids found via message GET / inbox
   * @param {boolean} [options.messageLookupUnavailable] fail != empty for reconcile
   * @param {(body: object) => Response|Promise<Response>} [options.onPrompt]
   */
  const makeOpenCodeFetch = (messagesOrOptions = idleMessages) => {
    const options = Array.isArray(messagesOrOptions) || (messagesOrOptions && messagesOrOptions.data)
      ? { messages: messagesOrOptions }
      : (messagesOrOptions || {});
    const messages = options.messages ?? idleMessages;
    const knownMessageIDs = options.knownMessageIDs instanceof Set
      ? options.knownMessageIDs
      : new Set(options.knownMessageIDs || []);
    const messageLookupUnavailable = options.messageLookupUnavailable === true;
    const onPrompt = typeof options.onPrompt === 'function' ? options.onPrompt : null;

    return async (input, init = {}) => {
      const url = String(input);
      const reqPath = url.split('?')[0];
      if (pathEndsWith(reqPath, '/session/status')) {
        return jsonResponse({ 'ses-goal': { type: 'idle' } });
      }
      if (pathEndsWith(reqPath, '/session/active')) {
        return jsonResponse({ data: {} });
      }
      // Exact message GET before list suffix match.
      const exactMatch = reqPath.match(/\/session\/ses-goal\/message\/([^/?]+)$/);
      if (exactMatch) {
        if (messageLookupUnavailable) {
          return new Response(JSON.stringify({ error: 'upstream' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        const messageID = decodeURIComponent(exactMatch[1]);
        if (knownMessageIDs.has(messageID)) {
          return jsonResponse({ id: messageID, type: 'user', text: 'continuation' });
        }
        return new Response(JSON.stringify({ error: 'not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (pathEndsWith(reqPath, '/session/ses-goal/inbox') || pathEndsWith(reqPath, '/inbox')) {
        if (messageLookupUnavailable) {
          return new Response(JSON.stringify({ error: 'upstream' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return jsonResponse({
          data: [...knownMessageIDs].map((id) => ({ id, type: 'user', sessionID: 'ses-goal' })),
        });
      }
      if (pathEndsWith(reqPath, '/session/ses-goal/message')) {
        // Support both bare array fixtures and official `{ data, cursor }` projection.
        const body = Array.isArray(messages)
          ? { data: messages, cursor: {} }
          : messages;
        return jsonResponse(body);
      }
      if (pathEndsWith(reqPath, '/session/ses-goal')) {
        if (init.method === 'PATCH') {
          throw new Error('OpenCode PATCH must not run with Host store');
        }
        return jsonResponse({ data: { id: 'ses-goal', directory: '/repo' } });
      }
      if (pathEndsWith(reqPath, '/model') || pathEndsWith(reqPath, '/agent')) {
        return emptyResponse(204);
      }
      if (pathEndsWith(reqPath, '/prompt') || pathEndsWith(reqPath, '/prompt_async')) {
        const body = JSON.parse(init.body || '{}');
        if (onPrompt) return onPrompt(body);
        if (body.id) knownMessageIDs.add(body.id);
        return jsonResponse({
          data: { id: 'inbox_1', type: 'user', sessionID: 'ses-goal', time: { created: 1 }, payload: { text: 'x' }, delivery: 'steer' },
        });
      }
      return jsonResponse({});
    };
  };

  it('audit start → user pause → late continue does not dispatch or raise turnsUsed', async () => {
    const { store, cleanup } = await makeTempStore();
    const goal = {
      ...buildSession('active').metadata.openchamber.goal,
      executionGeneration: 0,
      createdAt: 1,
      turnsUsed: 3,
    };
    await store.setSessionMetadata('ses-goal', {
      openchamber: { goal, assist: { recap: 'keep' }, archive: { archivedAt: 9 } },
    }, { allowArchive: true });

    let releaseAudit;
    const auditGate = new Promise((resolve) => { releaseAudit = resolve; });
    const promptBodies = [];

    await withFetch(makeOpenCodeFetch(), async () => {
      const runtime = createSessionGoalRuntime({
        buildOpenCodeUrl: (pathname) => `http://opencode${pathname}`,
        getOpenCodeAuthHeaders: () => ({}),
        getSmallModelService: async () => ({
          generateSmallModelText: async () => {
            await auditGate;
            return { text: '{"verdict":"continue","note":"late"}' };
          },
        }),
        idleQuietMs: 1_000_000,
        kickoffQuietMs: 1,
        maxAutoTurns: 20,
        readSessionMetadata: (id) => store.get(id),
        mutateSessionMetadata: (id, decide) => store.mutateSessionMetadata(id, decide),
        persistSessionGoal: async () => {
          throw new Error('unexpected persistSessionGoal');
        },
      });

      // Intercept prompt via fetch override that already returns ok — count via monkeypatch.
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input, init = {}) => {
        const reqPath = String(input).split('?')[0];
        if (pathEndsWith(reqPath, '/prompt') || pathEndsWith(reqPath, '/prompt_async')) {
          promptBodies.push(JSON.parse(init.body || '{}'));
          return jsonResponse({
            data: { id: 'inbox_1', type: 'user', sessionID: 'ses-goal', time: { created: 1 }, payload: { text: 'x' }, delivery: 'steer' },
          });
        }
        return originalFetch(input, init);
      };

      try {
        const tickPromise = runtime.runTick('ses-goal', '/repo');
        // Let the tick reach the audit gate.
        await new Promise((r) => setTimeout(r, 30));
        expect(runtime.getDispatchEpoch('ses-goal')).toBe(0);

        const paused = await runtime.pauseGoal('ses-goal', '/repo', 'paused by user');
        expect(paused.status).toBe('paused');
        expect(paused.executionGeneration).toBe(1);
        expect(runtime.getDispatchEpoch('ses-goal')).toBeGreaterThan(0);

        // Readers only see committed pause (store already published).
        const mid = await store.get('ses-goal');
        expect(mid.openchamber.goal.status).toBe('paused');
        expect(mid.openchamber.assist).toEqual({ recap: 'keep' });
        expect(mid.openchamber.archive).toEqual({ archivedAt: 9 });

        releaseAudit();
        await tickPromise;

        expect(promptBodies).toEqual([]);
        const finalMeta = await store.get('ses-goal');
        expect(finalMeta.openchamber.goal.status).toBe('paused');
        expect(finalMeta.openchamber.goal.turnsUsed).toBe(3);
        expect(finalMeta.openchamber.goal.executionGeneration).toBe(1);
        expect(finalMeta.openchamber.assist).toEqual({ recap: 'keep' });
        expect(finalMeta.openchamber.archive).toEqual({ archivedAt: 9 });
        runtime.stop();
      } finally {
        globalThis.fetch = originalFetch;
        cleanup();
      }
    });
  });

  it('late audit complete after pause cannot settle the goal', async () => {
    const { store, cleanup } = await makeTempStore();
    const goal = {
      ...buildSession('active').metadata.openchamber.goal,
      executionGeneration: 4,
      createdAt: 1,
      turnsUsed: 1,
    };
    await store.setSessionMetadata('ses-goal', { openchamber: { goal } });

    let releaseAudit;
    const auditGate = new Promise((resolve) => { releaseAudit = resolve; });

    await withFetch(makeOpenCodeFetch(), async () => {
      const runtime = createSessionGoalRuntime({
        buildOpenCodeUrl: (pathname) => `http://opencode${pathname}`,
        getOpenCodeAuthHeaders: () => ({}),
        getSmallModelService: async () => ({
          generateSmallModelText: async () => {
            await auditGate;
            return { text: '{"verdict":"complete","note":"done"}' };
          },
        }),
        idleQuietMs: 1_000_000,
        kickoffQuietMs: 1,
        readSessionMetadata: (id) => store.get(id),
        mutateSessionMetadata: (id, decide) => store.mutateSessionMetadata(id, decide),
      });

      const tickPromise = runtime.runTick('ses-goal', '/repo');
      await new Promise((r) => setTimeout(r, 30));
      await runtime.pauseGoal('ses-goal', '/repo', 'paused by user');
      releaseAudit();
      await tickPromise;

      const finalMeta = await store.get('ses-goal');
      expect(finalMeta.openchamber.goal.status).toBe('paused');
      expect(finalMeta.openchamber.goal.executionGeneration).toBe(5);
      runtime.stop();
      cleanup();
    });
  });

  it('resume advances generation so a prior-period continue cannot commit', async () => {
    const { store, cleanup } = await makeTempStore();
    const goal = {
      ...buildSession('active').metadata.openchamber.goal,
      executionGeneration: 1,
      createdAt: 1,
      turnsUsed: 2,
    };
    await store.setSessionMetadata('ses-goal', { openchamber: { goal } });

    let releaseAudit;
    const auditGate = new Promise((resolve) => { releaseAudit = resolve; });
    const promptBodies = [];

    await withFetch(makeOpenCodeFetch(), async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input, init = {}) => {
        const reqPath = String(input).split('?')[0];
        if (pathEndsWith(reqPath, '/prompt') || pathEndsWith(reqPath, '/prompt_async')) {
          promptBodies.push(1);
          return jsonResponse({
            data: { id: 'inbox_1', type: 'user', sessionID: 'ses-goal', time: { created: 1 }, payload: { text: 'x' }, delivery: 'steer' },
          });
        }
        return originalFetch(input, init);
      };

      try {
        const runtime = createSessionGoalRuntime({
          buildOpenCodeUrl: (pathname) => `http://opencode${pathname}`,
          getOpenCodeAuthHeaders: () => ({}),
          getSmallModelService: async () => ({
            generateSmallModelText: async () => {
              await auditGate;
              return { text: '{"verdict":"continue","note":"old"}' };
            },
          }),
          idleQuietMs: 1_000_000,
          kickoffQuietMs: 1,
          readSessionMetadata: (id) => store.get(id),
          mutateSessionMetadata: (id, decide) => store.mutateSessionMetadata(id, decide),
        });

        const tickPromise = runtime.runTick('ses-goal', '/repo');
        await new Promise((r) => setTimeout(r, 30));
        // Simulate pause then resume while audit is in flight (new generation).
        await runtime.pauseGoal('ses-goal', '/repo', 'paused by user');
        await store.mutateSessionMetadata('ses-goal', (current) => {
          const g = current.openchamber.goal;
          return {
            ok: true,
            patch: {
              openchamber: {
                goal: {
                  ...g,
                  status: 'active',
                  statusReason: 'resumed',
                  executionGeneration: g.executionGeneration + 1,
                },
              },
            },
          };
        });
        // Local epoch was bumped on pause; resume does not lower it.
        releaseAudit();
        await tickPromise;
        expect(promptBodies).toEqual([]);
        const finalMeta = await store.get('ses-goal');
        expect(finalMeta.openchamber.goal.status).toBe('active');
        expect(finalMeta.openchamber.goal.turnsUsed).toBe(2);
        expect(finalMeta.openchamber.goal.executionGeneration).toBe(3);
        runtime.stop();
      } finally {
        globalThis.fetch = originalFetch;
        cleanup();
      }
    });
  });

  it('successful continue commits turnsUsed and records dispatch identity', async () => {
    const { store, cleanup } = await makeTempStore();
    const goal = {
      ...buildSession('active').metadata.openchamber.goal,
      executionGeneration: 0,
      createdAt: 1,
      turnsUsed: 0,
      statusReason: 'resumed',
    };
    await store.setSessionMetadata('ses-goal', { openchamber: { goal } });
    const promptBodies = [];

    await withFetch(makeOpenCodeFetch(), async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input, init = {}) => {
        const reqPath = String(input).split('?')[0];
        if (pathEndsWith(reqPath, '/prompt') || pathEndsWith(reqPath, '/prompt_async')) {
          promptBodies.push(JSON.parse(init.body || '{}'));
          return jsonResponse({
            data: { id: 'inbox_1', type: 'user', sessionID: 'ses-goal', time: { created: 1 }, payload: { text: 'x' }, delivery: 'steer' },
          });
        }
        return originalFetch(input, init);
      };
      try {
        const runtime = createSessionGoalRuntime({
          buildOpenCodeUrl: (pathname) => `http://opencode${pathname}`,
          getOpenCodeAuthHeaders: () => ({}),
          getSmallModelService: async () => ({
            generateSmallModelText: async () => ({ text: '{"verdict":"continue","note":"go"}' }),
          }),
          idleQuietMs: 1_000_000,
          kickoffQuietMs: 1,
          readSessionMetadata: (id) => store.get(id),
          mutateSessionMetadata: (id, decide) => store.mutateSessionMetadata(id, decide),
        });
        await runtime.runTick('ses-goal', '/repo');
        expect(promptBodies.length).toBe(1);
        expect(promptBodies[0].id).toBe(buildContinuationMessageID({
          goalId: goal.id,
          generation: 0,
          turnsUsed: 1,
        }));
        const finalMeta = await store.get('ses-goal');
        expect(finalMeta.openchamber.goal.turnsUsed).toBe(1);
        expect(finalMeta.openchamber.goal.pendingContinuation == null).toBe(true);
        expect(runtime.getDispatchedContinuation('ses-goal')).toMatchObject({
          goalId: goal.id,
          generation: 0,
          turnsUsed: 1,
          messageID: promptBodies[0].id,
          phase: 'accepted',
        });
        runtime.stop();
      } finally {
        globalThis.fetch = originalFetch;
        cleanup();
      }
    });
  });

  it('raw v2 projection payload + duplicate continuation id skips second dispatch', async () => {
    const { store, cleanup } = await makeTempStore();
    const goal = {
      ...buildSession('active').metadata.openchamber.goal,
      executionGeneration: 0,
      createdAt: 1,
      turnsUsed: 0,
      statusReason: 'resumed',
    };
    await store.setSessionMetadata('ses-goal', { openchamber: { goal } });

    // Official raw SessionMessageInfo (no info/parts wrapper).
    const rawProjection = {
      data: [
        { id: 'msg-user', type: 'user', text: 'hi', time: { created: 1 } },
        {
          id: 'msg-done',
          type: 'assistant',
          agent: 'build',
          model: { id: 'm', providerID: 'p' },
          time: { created: 2, completed: 200 },
          content: [{ type: 'text', text: 'working' }],
          tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      ],
      cursor: {},
    };
    const promptBodies = [];
    const knownMessageIDs = new Set();

    await withFetch(makeOpenCodeFetch({ messages: rawProjection, knownMessageIDs }), async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input, init = {}) => {
        const reqPath = String(input).split('?')[0];
        if (pathEndsWith(reqPath, '/prompt') || pathEndsWith(reqPath, '/prompt_async')) {
          const body = JSON.parse(init.body || '{}');
          promptBodies.push(body);
          if (body.id) knownMessageIDs.add(body.id);
          return jsonResponse({
            data: { id: 'inbox_1', type: 'user', sessionID: 'ses-goal', time: { created: 1 }, payload: { text: 'x' }, delivery: 'steer' },
          });
        }
        return originalFetch(input, init);
      };
      try {
        const runtime = createSessionGoalRuntime({
          buildOpenCodeUrl: (pathname) => `http://opencode${pathname}`,
          getOpenCodeAuthHeaders: () => ({}),
          getSmallModelService: async () => ({
            generateSmallModelText: async () => ({ text: '{"verdict":"continue","note":"go"}' }),
          }),
          idleQuietMs: 1_000_000,
          kickoffQuietMs: 1,
          readSessionMetadata: (id) => store.get(id),
          mutateSessionMetadata: (id, decide) => store.mutateSessionMetadata(id, decide),
        });
        await runtime.runTick('ses-goal', '/repo');
        expect(promptBodies.length).toBe(1);
        const firstId = promptBodies[0].id;
        expect(firstId).toBe(buildContinuationMessageID({ goalId: goal.id, generation: 0, turnsUsed: 1 }));
        // Simulate crash after accept: turnsUsed rolled back but upstream still
        // holds the fixed message id — reconcile counts once, no second prompt.
        await store.mutateSessionMetadata('ses-goal', (current) => ({
          ok: true,
          patch: {
            openchamber: {
              goal: { ...current.openchamber.goal, turnsUsed: 0 },
            },
          },
        }));
        await runtime.runTick('ses-goal', '/repo');
        expect(promptBodies.length).toBe(1);
        const finalMeta = await store.get('ses-goal');
        expect(finalMeta.openchamber.goal.turnsUsed).toBe(1);
        expect(finalMeta.openchamber.goal.pendingContinuation == null).toBe(true);
        runtime.stop();
      } finally {
        globalThis.fetch = originalFetch;
        cleanup();
      }
    });
  });

  it('shutdown interrupt blocks auto-continue until authoritative idle', async () => {
    const { store, cleanup } = await makeTempStore();
    const goal = {
      ...buildSession('active').metadata.openchamber.goal,
      executionGeneration: 0,
      createdAt: 1,
      turnsUsed: 0,
      statusReason: 'resumed',
    };
    await store.setSessionMetadata('ses-goal', { openchamber: { goal } });
    const promptBodies = [];

    await withFetch(makeOpenCodeFetch(), async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input, init = {}) => {
        const reqPath = String(input).split('?')[0];
        if (pathEndsWith(reqPath, '/prompt') || pathEndsWith(reqPath, '/prompt_async')) {
          promptBodies.push(JSON.parse(init.body || '{}'));
          return jsonResponse({
            data: { id: 'inbox_1', type: 'user', sessionID: 'ses-goal', time: { created: 1 }, payload: { text: 'x' }, delivery: 'steer' },
          });
        }
        return originalFetch(input, init);
      };
      try {
        const runtime = createSessionGoalRuntime({
          buildOpenCodeUrl: (pathname) => `http://opencode${pathname}`,
          getOpenCodeAuthHeaders: () => ({}),
          getSmallModelService: async () => ({
            generateSmallModelText: async () => ({ text: '{"verdict":"continue","note":"go"}' }),
          }),
          idleQuietMs: 1_000_000,
          kickoffQuietMs: 1,
          readSessionMetadata: (id) => store.get(id),
          mutateSessionMetadata: (id, decide) => store.mutateSessionMetadata(id, decide),
        });
        runtime.processPayload({
          type: 'session.execution.interrupted',
          properties: { sessionID: 'ses-goal', reason: 'shutdown' },
        });
        await runtime.runTick('ses-goal', '/repo');
        expect(promptBodies).toEqual([]);
        // Authoritative idle clears recovery and allows continue.
        runtime.processPayload({
          type: 'session.status',
          properties: { sessionID: 'ses-goal', status: { type: 'idle' }, directory: '/repo' },
        });
        await runtime.runTick('ses-goal', '/repo');
        expect(promptBodies.length).toBe(1);
        runtime.stop();
      } finally {
        globalThis.fetch = originalFetch;
        cleanup();
      }
    });
  });

  it('pause during switchAgent drops before prompt with zero transport identity', async () => {
    const { store, cleanup } = await makeTempStore();
    const goal = {
      ...buildSession('active').metadata.openchamber.goal,
      executionGeneration: 0,
      createdAt: 1,
      turnsUsed: 0,
      statusReason: 'resumed',
    };
    await store.setSessionMetadata('ses-goal', { openchamber: { goal } });

    let releaseAgent;
    const agentGate = new Promise((resolve) => { releaseAgent = resolve; });
    let agentStarted = false;
    const promptBodies = [];

    await withFetch(makeOpenCodeFetch(), async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input, init = {}) => {
        const reqPath = String(input).split('?')[0];
        if (pathEndsWith(reqPath, '/agent')) {
          agentStarted = true;
          await agentGate;
          return emptyResponse(204);
        }
        if (pathEndsWith(reqPath, '/prompt') || pathEndsWith(reqPath, '/prompt_async')) {
          promptBodies.push(JSON.parse(init.body || '{}'));
          return jsonResponse({
            data: { id: 'inbox_1', type: 'user', sessionID: 'ses-goal', time: { created: 1 }, payload: { text: 'x' }, delivery: 'steer' },
          });
        }
        return originalFetch(input, init);
      };

      try {
        const runtime = createSessionGoalRuntime({
          buildOpenCodeUrl: (pathname) => `http://opencode${pathname}`,
          getOpenCodeAuthHeaders: () => ({}),
          getSmallModelService: async () => ({
            generateSmallModelText: async () => ({ text: '{"verdict":"continue","note":"go"}' }),
          }),
          idleQuietMs: 1_000_000,
          kickoffQuietMs: 1,
          readSessionMetadata: (id) => store.get(id),
          mutateSessionMetadata: (id, decide) => store.mutateSessionMetadata(id, decide),
        });

        const tickPromise = runtime.runTick('ses-goal', '/repo');
        const started = Date.now();
        while (!agentStarted) {
          if (Date.now() - started > 2000) throw new Error('switchAgent never started');
          await new Promise((r) => setTimeout(r, 5));
        }
        // Selection in flight: transport must not be claimed yet.
        expect(runtime.getDispatchedContinuation('ses-goal')).toBeNull();

        const paused = await runtime.pauseGoal('ses-goal', '/repo', 'paused by user');
        expect(paused.status).toBe('paused');
        expect(runtime.getDispatchEpoch('ses-goal')).toBeGreaterThan(0);

        releaseAgent();
        await tickPromise;

        expect(promptBodies).toEqual([]);
        expect(runtime.getDispatchedContinuation('ses-goal')).toBeNull();
        const finalMeta = await store.get('ses-goal');
        expect(finalMeta.openchamber.goal.status).toBe('paused');
        // Before selection/prompt: turnsUsed must stay 0 and reserved pending cleared.
        expect(finalMeta.openchamber.goal.turnsUsed).toBe(0);
        expect(finalMeta.openchamber.goal.pendingContinuation == null).toBe(true);
        runtime.stop();
      } finally {
        globalThis.fetch = originalFetch;
        cleanup();
      }
    });
  });

  it('pause during switchModel drops before prompt with zero transport identity', async () => {
    const { store, cleanup } = await makeTempStore();
    const goal = {
      ...buildSession('active').metadata.openchamber.goal,
      executionGeneration: 0,
      createdAt: 1,
      turnsUsed: 0,
      statusReason: 'resumed',
    };
    await store.setSessionMetadata('ses-goal', { openchamber: { goal } });

    let releaseModel;
    const modelGate = new Promise((resolve) => { releaseModel = resolve; });
    let modelStarted = false;
    const promptBodies = [];

    await withFetch(makeOpenCodeFetch(), async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input, init = {}) => {
        const reqPath = String(input).split('?')[0];
        if (pathEndsWith(reqPath, '/model')) {
          modelStarted = true;
          await modelGate;
          return emptyResponse(204);
        }
        if (pathEndsWith(reqPath, '/prompt') || pathEndsWith(reqPath, '/prompt_async')) {
          promptBodies.push(JSON.parse(init.body || '{}'));
          return jsonResponse({
            data: { id: 'inbox_1', type: 'user', sessionID: 'ses-goal', time: { created: 1 }, payload: { text: 'x' }, delivery: 'steer' },
          });
        }
        return originalFetch(input, init);
      };

      try {
        const runtime = createSessionGoalRuntime({
          buildOpenCodeUrl: (pathname) => `http://opencode${pathname}`,
          getOpenCodeAuthHeaders: () => ({}),
          getSmallModelService: async () => ({
            generateSmallModelText: async () => ({ text: '{"verdict":"continue","note":"go"}' }),
          }),
          idleQuietMs: 1_000_000,
          kickoffQuietMs: 1,
          readSessionMetadata: (id) => store.get(id),
          mutateSessionMetadata: (id, decide) => store.mutateSessionMetadata(id, decide),
        });

        const tickPromise = runtime.runTick('ses-goal', '/repo');
        const started = Date.now();
        while (!modelStarted) {
          if (Date.now() - started > 2000) throw new Error('switchModel never started');
          await new Promise((r) => setTimeout(r, 5));
        }
        expect(runtime.getDispatchedContinuation('ses-goal')).toBeNull();

        await runtime.pauseGoal('ses-goal', '/repo', 'paused by user');
        releaseModel();
        await tickPromise;

        expect(promptBodies).toEqual([]);
        expect(runtime.getDispatchedContinuation('ses-goal')).toBeNull();
        runtime.stop();
      } finally {
        globalThis.fetch = originalFetch;
        cleanup();
      }
    });
  });

  it('shutdown during switchAgent drops before prompt without uncertain phase', async () => {
    const { store, cleanup } = await makeTempStore();
    const goal = {
      ...buildSession('active').metadata.openchamber.goal,
      executionGeneration: 0,
      createdAt: 1,
      turnsUsed: 0,
      statusReason: 'resumed',
    };
    await store.setSessionMetadata('ses-goal', { openchamber: { goal } });

    let releaseAgent;
    const agentGate = new Promise((resolve) => { releaseAgent = resolve; });
    let agentStarted = false;
    const promptBodies = [];

    await withFetch(makeOpenCodeFetch(), async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input, init = {}) => {
        const reqPath = String(input).split('?')[0];
        if (pathEndsWith(reqPath, '/agent')) {
          agentStarted = true;
          await agentGate;
          return emptyResponse(204);
        }
        if (pathEndsWith(reqPath, '/prompt') || pathEndsWith(reqPath, '/prompt_async')) {
          promptBodies.push(JSON.parse(init.body || '{}'));
          return jsonResponse({
            data: { id: 'inbox_1', type: 'user', sessionID: 'ses-goal', time: { created: 1 }, payload: { text: 'x' }, delivery: 'steer' },
          });
        }
        return originalFetch(input, init);
      };

      try {
        const runtime = createSessionGoalRuntime({
          buildOpenCodeUrl: (pathname) => `http://opencode${pathname}`,
          getOpenCodeAuthHeaders: () => ({}),
          getSmallModelService: async () => ({
            generateSmallModelText: async () => ({ text: '{"verdict":"continue","note":"go"}' }),
          }),
          idleQuietMs: 1_000_000,
          kickoffQuietMs: 1,
          readSessionMetadata: (id) => store.get(id),
          mutateSessionMetadata: (id, decide) => store.mutateSessionMetadata(id, decide),
        });

        const tickPromise = runtime.runTick('ses-goal', '/repo');
        const started = Date.now();
        while (!agentStarted) {
          if (Date.now() - started > 2000) throw new Error('switchAgent never started');
          await new Promise((r) => setTimeout(r, 5));
        }

        runtime.processPayload({
          type: 'session.execution.interrupted',
          properties: { sessionID: 'ses-goal', reason: 'shutdown' },
        });
        releaseAgent();
        await tickPromise;

        expect(promptBodies).toEqual([]);
        const dispatch = runtime.getDispatchedContinuation('ses-goal');
        expect(dispatch === null || dispatch.phase !== 'uncertain').toBe(true);
        runtime.stop();
      } finally {
        globalThis.fetch = originalFetch;
        cleanup();
      }
    });
  });

  it('switchAgent selection failure is not reported as prompt-uncertain', async () => {
    const { store, cleanup } = await makeTempStore();
    const goal = {
      ...buildSession('active').metadata.openchamber.goal,
      executionGeneration: 0,
      createdAt: 1,
      turnsUsed: 0,
      statusReason: 'resumed',
    };
    await store.setSessionMetadata('ses-goal', { openchamber: { goal } });
    const promptBodies = [];

    await withFetch(makeOpenCodeFetch(), async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input, init = {}) => {
        const reqPath = String(input).split('?')[0];
        if (pathEndsWith(reqPath, '/agent')) {
          return new Response(JSON.stringify({ error: 'agent unavailable' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (pathEndsWith(reqPath, '/prompt') || pathEndsWith(reqPath, '/prompt_async')) {
          promptBodies.push(JSON.parse(init.body || '{}'));
          return jsonResponse({
            data: { id: 'inbox_1', type: 'user', sessionID: 'ses-goal', time: { created: 1 }, payload: { text: 'x' }, delivery: 'steer' },
          });
        }
        return originalFetch(input, init);
      };

      try {
        const runtime = createSessionGoalRuntime({
          buildOpenCodeUrl: (pathname) => `http://opencode${pathname}`,
          getOpenCodeAuthHeaders: () => ({}),
          getSmallModelService: async () => ({
            generateSmallModelText: async () => ({ text: '{"verdict":"continue","note":"go"}' }),
          }),
          idleQuietMs: 1_000_000,
          kickoffQuietMs: 1,
          readSessionMetadata: (id) => store.get(id),
          mutateSessionMetadata: (id, decide) => store.mutateSessionMetadata(id, decide),
        });

        await runtime.runTick('ses-goal', '/repo').catch(() => {});
        expect(promptBodies).toEqual([]);
        const dispatch = runtime.getDispatchedContinuation('ses-goal');
        expect(dispatch === null || dispatch.phase !== 'uncertain').toBe(true);
        runtime.stop();
      } finally {
        globalThis.fetch = originalFetch;
        cleanup();
      }
    });
  });

  it('persist failure during pause keeps prior committed active state', async () => {
    const { store, cleanup } = await makeTempStore();
    const goal = {
      ...buildSession('active').metadata.openchamber.goal,
      executionGeneration: 2,
    };
    await store.setSessionMetadata('ses-goal', { openchamber: { goal } });

    let failNext = false;
    const gated = {
      mutateSessionMetadata: async (id, decide) => {
        if (failNext) {
          failNext = false;
          throw new Error('disk full');
        }
        return store.mutateSessionMetadata(id, decide);
      },
      get: (id) => store.get(id),
    };

    await withFetch(makeOpenCodeFetch(), async () => {
      const runtime = createSessionGoalRuntime({
        buildOpenCodeUrl: (pathname) => `http://opencode${pathname}`,
        getOpenCodeAuthHeaders: () => ({}),
        getSmallModelService: async () => ({
          generateSmallModelText: async () => ({ text: '{"verdict":"continue","note":"x"}' }),
        }),
        idleQuietMs: 1_000_000,
        kickoffQuietMs: 1,
        readSessionMetadata: (id) => gated.get(id),
        mutateSessionMetadata: (id, decide) => gated.mutateSessionMetadata(id, decide),
      });

      failNext = true;
      await expect(runtime.pauseGoal('ses-goal', '/repo', 'paused by user')).rejects.toThrow('disk full');
      // Local epoch still bumped (pause requested) but durable state unchanged.
      const mid = await store.get('ses-goal');
      expect(mid.openchamber.goal.status).toBe('active');
      expect(mid.openchamber.goal.executionGeneration).toBe(2);
      runtime.stop();
      cleanup();
    });
  });

  it('before-selection pause keeps turnsUsed at 0 and clears reserved pending', async () => {
    const { store, cleanup } = await makeTempStore();
    const goal = {
      ...buildSession('active').metadata.openchamber.goal,
      executionGeneration: 0,
      createdAt: 1,
      turnsUsed: 0,
      statusReason: 'resumed',
    };
    await store.setSessionMetadata('ses-goal', { openchamber: { goal } });

    let releaseAgent;
    const agentGate = new Promise((resolve) => { releaseAgent = resolve; });
    let agentStarted = false;
    const promptBodies = [];

    await withFetch(makeOpenCodeFetch(), async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input, init = {}) => {
        const reqPath = String(input).split('?')[0];
        if (pathEndsWith(reqPath, '/agent')) {
          agentStarted = true;
          await agentGate;
          return emptyResponse(204);
        }
        if (pathEndsWith(reqPath, '/prompt') || pathEndsWith(reqPath, '/prompt_async')) {
          promptBodies.push(JSON.parse(init.body || '{}'));
          return jsonResponse({ data: { id: 'inbox_1' } });
        }
        return originalFetch(input, init);
      };
      try {
        const runtime = createSessionGoalRuntime({
          buildOpenCodeUrl: (pathname) => `http://opencode${pathname}`,
          getOpenCodeAuthHeaders: () => ({}),
          getSmallModelService: async () => ({
            generateSmallModelText: async () => ({ text: '{"verdict":"continue","note":"go"}' }),
          }),
          idleQuietMs: 1_000_000,
          kickoffQuietMs: 1,
          readSessionMetadata: (id) => store.get(id),
          mutateSessionMetadata: (id, decide) => store.mutateSessionMetadata(id, decide),
        });
        const tickPromise = runtime.runTick('ses-goal', '/repo');
        const started = Date.now();
        while (!agentStarted) {
          if (Date.now() - started > 2000) throw new Error('switchAgent never started');
          await new Promise((r) => setTimeout(r, 5));
        }
        // Reserved pending should exist before selection completes.
        const mid = await store.get('ses-goal');
        expect(mid.openchamber.goal.turnsUsed).toBe(0);
        expect(parsePendingContinuation(mid.openchamber.goal.pendingContinuation)?.phase).toBe('reserved');

        await runtime.pauseGoal('ses-goal', '/repo', 'paused by user');
        releaseAgent();
        await tickPromise;

        expect(promptBodies).toEqual([]);
        const finalMeta = await store.get('ses-goal');
        expect(finalMeta.openchamber.goal.turnsUsed).toBe(0);
        expect(finalMeta.openchamber.goal.pendingContinuation == null).toBe(true);
        expect(finalMeta.openchamber.goal.status).toBe('paused');
        runtime.stop();
      } finally {
        globalThis.fetch = originalFetch;
        cleanup();
      }
    });
  });

  it('persist failure after accept keeps accepted pending and reboot counts once', async () => {
    const { store, cleanup } = await makeTempStore();
    const messageID = buildContinuationMessageID({ goalId: 'goal-1', generation: 0, turnsUsed: 1 });
    const knownMessageIDs = new Set([messageID]);
    // Durable state after accept + crash before turnsUsed commit.
    await store.setSessionMetadata('ses-goal', {
      openchamber: {
        goal: {
          ...buildSession('active').metadata.openchamber.goal,
          executionGeneration: 0,
          createdAt: 1,
          turnsUsed: 0,
          statusReason: 'resumed',
          pendingContinuation: buildPendingContinuation({
            messageID,
            goalId: 'goal-1',
            generation: 0,
            turnsUsed: 1,
            phase: 'accepted',
            text: 'Continue working toward the active session goal.',
            providerID: 'p',
            modelID: 'm',
            agent: 'build',
          }),
        },
      },
    });
    let promptCount = 0;

    await withFetch(makeOpenCodeFetch({ knownMessageIDs }), async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input, init = {}) => {
        const reqPath = String(input).split('?')[0];
        if (pathEndsWith(reqPath, '/prompt') || pathEndsWith(reqPath, '/prompt_async')) {
          promptCount += 1;
          return jsonResponse({
            data: { id: 'inbox_1', type: 'user', sessionID: 'ses-goal', time: { created: 1 }, payload: { text: 'x' }, delivery: 'steer' },
          });
        }
        return originalFetch(input, init);
      };
      try {
        const meta = await store.get('ses-goal');
        expect(parsePendingContinuation(meta.openchamber.goal.pendingContinuation)?.phase).toBe('accepted');
        expect(meta.openchamber.goal.turnsUsed).toBe(0);

        // Fresh runtime = reboot: reconcile finds message, counts once, no blind new id.
        const runtime = createSessionGoalRuntime({
          buildOpenCodeUrl: (pathname) => `http://opencode${pathname}`,
          getOpenCodeAuthHeaders: () => ({}),
          getSmallModelService: async () => ({
            generateSmallModelText: async () => ({ text: '{"verdict":"continue","note":"go"}' }),
          }),
          idleQuietMs: 1_000_000,
          kickoffQuietMs: 1,
          readSessionMetadata: (id) => store.get(id),
          mutateSessionMetadata: (id, decide) => store.mutateSessionMetadata(id, decide),
        });
        await runtime.runTick('ses-goal', '/repo');
        const after = await store.get('ses-goal');
        expect(after.openchamber.goal.turnsUsed).toBe(1);
        expect(after.openchamber.goal.pendingContinuation == null).toBe(true);
        expect(promptCount).toBe(0);
        runtime.stop();
      } finally {
        globalThis.fetch = originalFetch;
        cleanup();
      }
    });
  });

  it('transport drop after accept pauses with stable identity and reboot reconciles', async () => {
    const { store, cleanup } = await makeTempStore();
    const goal = {
      ...buildSession('active').metadata.openchamber.goal,
      executionGeneration: 0,
      createdAt: 1,
      turnsUsed: 0,
      statusReason: 'resumed',
    };
    await store.setSessionMetadata('ses-goal', { openchamber: { goal } });
    const knownMessageIDs = new Set();
    let promptAttempts = 0;

    await withFetch(makeOpenCodeFetch({ knownMessageIDs }), async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input, init = {}) => {
        const reqPath = String(input).split('?')[0];
        if (pathEndsWith(reqPath, '/prompt') || pathEndsWith(reqPath, '/prompt_async')) {
          promptAttempts += 1;
          const body = JSON.parse(init.body || '{}');
          // Simulate: upstream accepted the id, then transport dropped the response.
          if (body.id) knownMessageIDs.add(body.id);
          throw new Error('socket hang up after accept');
        }
        return originalFetch(input, init);
      };
      try {
        const runtime = createSessionGoalRuntime({
          buildOpenCodeUrl: (pathname) => `http://opencode${pathname}`,
          getOpenCodeAuthHeaders: () => ({}),
          getSmallModelService: async () => ({
            generateSmallModelText: async () => ({ text: '{"verdict":"continue","note":"go"}' }),
          }),
          idleQuietMs: 1_000_000,
          kickoffQuietMs: 1,
          readSessionMetadata: (id) => store.get(id),
          mutateSessionMetadata: (id, decide) => store.mutateSessionMetadata(id, decide),
        });
        await runtime.runTick('ses-goal', '/repo');
        const mid = await store.get('ses-goal');
        expect(mid.openchamber.goal.status).toBe('paused');
        expect(String(mid.openchamber.goal.statusReason)).toMatch(/uncertain|continuation/i);
        const pending = parsePendingContinuation(mid.openchamber.goal.pendingContinuation);
        expect(pending).toBeTruthy();
        expect(pending.messageID).toMatch(/^msg_goalc_/);
        expect(mid.openchamber.goal.turnsUsed).toBe(0);
        expect(promptAttempts).toBe(1);

        // Reboot + resume: reconcile finds the message, counts once, no second prompt.
        runtime.stop();
        await store.mutateSessionMetadata('ses-goal', (current) => ({
          ok: true,
          patch: {
            openchamber: {
              goal: {
                ...current.openchamber.goal,
                status: 'active',
                statusReason: 'resumed',
                executionGeneration: current.openchamber.goal.executionGeneration + 1,
              },
            },
          },
        }));
        // Keep pending with original generation for stale-gen found path.
        const runtime2 = createSessionGoalRuntime({
          buildOpenCodeUrl: (pathname) => `http://opencode${pathname}`,
          getOpenCodeAuthHeaders: () => ({}),
          getSmallModelService: async () => ({
            generateSmallModelText: async () => ({ text: '{"verdict":"continue","note":"go"}' }),
          }),
          idleQuietMs: 1_000_000,
          kickoffQuietMs: 1,
          readSessionMetadata: (id) => store.get(id),
          mutateSessionMetadata: (id, decide) => store.mutateSessionMetadata(id, decide),
        });
        await runtime2.runTick('ses-goal', '/repo');
        const after = await store.get('ses-goal');
        // Found under stale gen → counted once; may continue a new turn after.
        expect(after.openchamber.goal.turnsUsed).toBeGreaterThanOrEqual(1);
        expect(after.openchamber.goal.pendingContinuation == null
          || after.openchamber.goal.turnsUsed >= 1).toBe(true);
        runtime2.stop();
      } finally {
        globalThis.fetch = originalFetch;
        cleanup();
      }
    });
  });

  it('reboot with reserved pending re-dispatches same message id and fixed payload', async () => {
    const { store, cleanup } = await makeTempStore();
    const messageID = buildContinuationMessageID({ goalId: 'goal-1', generation: 0, turnsUsed: 1 });
    const fixedText = 'Continue working toward the active session goal.\nFIXED-PAYLOAD-MARKER';
    const pending = buildPendingContinuation({
      messageID,
      goalId: 'goal-1',
      generation: 0,
      turnsUsed: 1,
      phase: 'reserved',
      text: fixedText,
      providerID: 'p',
      modelID: 'm',
      agent: 'build',
    });
    const goal = {
      ...buildSession('active').metadata.openchamber.goal,
      executionGeneration: 0,
      createdAt: 1,
      turnsUsed: 0,
      statusReason: 'resumed',
      pendingContinuation: pending,
    };
    await store.setSessionMetadata('ses-goal', { openchamber: { goal } });
    const promptBodies = [];
    const knownMessageIDs = new Set();

    await withFetch(makeOpenCodeFetch({ knownMessageIDs }), async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input, init = {}) => {
        const reqPath = String(input).split('?')[0];
        if (pathEndsWith(reqPath, '/prompt') || pathEndsWith(reqPath, '/prompt_async')) {
          const body = JSON.parse(init.body || '{}');
          promptBodies.push(body);
          if (body.id) knownMessageIDs.add(body.id);
          return jsonResponse({
            data: { id: 'inbox_1', type: 'user', sessionID: 'ses-goal', time: { created: 1 }, payload: { text: 'x' }, delivery: 'steer' },
          });
        }
        return originalFetch(input, init);
      };
      try {
        const runtime = createSessionGoalRuntime({
          buildOpenCodeUrl: (pathname) => `http://opencode${pathname}`,
          getOpenCodeAuthHeaders: () => ({}),
          getSmallModelService: async () => ({
            generateSmallModelText: async () => ({ text: '{"verdict":"continue","note":"go"}' }),
          }),
          idleQuietMs: 1_000_000,
          kickoffQuietMs: 1,
          readSessionMetadata: (id) => store.get(id),
          mutateSessionMetadata: (id, decide) => store.mutateSessionMetadata(id, decide),
        });
        await runtime.runTick('ses-goal', '/repo');
        expect(promptBodies.length).toBe(1);
        expect(promptBodies[0].id).toBe(messageID);
        expect(promptBodies[0].text).toBe(fixedText);
        const finalMeta = await store.get('ses-goal');
        expect(finalMeta.openchamber.goal.turnsUsed).toBe(1);
        expect(finalMeta.openchamber.goal.pendingContinuation == null).toBe(true);
        runtime.stop();
      } finally {
        globalThis.fetch = originalFetch;
        cleanup();
      }
    });
  });

  it('pending mutate is invisible to readers until persist succeeds', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-goal-pending-'));
    let unlock;
    const gate = new Promise((resolve) => { unlock = resolve; });
    const fsPromises = {
      ...fs.promises,
      writeFile: async (target, payload, encoding) => {
        await gate;
        return fs.promises.writeFile(target, payload, encoding);
      },
    };
    const store = createSessionMetadataStore({ dataDir, fsPromises });
    // First write without gate
    const warm = createSessionMetadataStore({ dataDir });
    await warm.setSessionMetadata('ses-goal', {
      openchamber: {
        goal: {
          ...buildSession('active').metadata.openchamber.goal,
          executionGeneration: 0,
        },
      },
    });
    await store.load();

    const pending = store.mutateSessionMetadata('ses-goal', () => ({
      ok: true,
      patch: { openchamber: { goal: { status: 'paused', executionGeneration: 1 } } },
    }));
    await expect(store.get('ses-goal')).resolves.toMatchObject({
      openchamber: { goal: { status: 'active', executionGeneration: 0 } },
    });
    unlock();
    await pending;
    await expect(store.get('ses-goal')).resolves.toMatchObject({
      openchamber: { goal: { status: 'paused', executionGeneration: 1 } },
    });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
});
