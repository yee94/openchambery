import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, test, vi } from 'vitest';
import {
  createQuestionAutoDelegateCore,
  QUESTION_AUTO_DELEGATE_ANSWER,
  QUESTION_AUTO_DELEGATE_DELAY_MS,
  QUESTION_SUBMISSION_CLAIMED_CODE,
} from '../../web/server/lib/question-auto-delegate/core.js';
import {
  __broadcastQuestionAutoDelegateTipForTests,
  __buildUpstreamForTests,
  __readQuestionAutoDelegateEnabledForTests,
  __resetQuestionAutoDelegateObservedDirectoriesForTests,
  __setQuestionAutoDelegateCoreForTests,
  __setQuestionAutoDelegateManagerForTests,
  __setQuestionAutoDelegateSettingsPathForTests,
  addQuestionAutoDelegateTipSink,
  applyQuestionAutoDelegateEnabled,
  getQuestionAutoDelegateCore,
  processQuestionAutoDelegateEvent,
  startQuestionAutoDelegateRuntime,
  stopQuestionAutoDelegateRuntime,
  tryHandleQuestionAutoDelegateProxy,
} from './question-auto-delegate-runtime';
import {
  stopGlobalEventWatcher,
  suspendGlobalEventWatcher,
  __getBoundQuestionAutoDelegateEndpointForTests,
  __normalizeEndpointKeyForTests,
} from './sessionActivityWatcher';
import { handleProxyBridgeMessage } from './bridge-proxy-runtime';
import type { BridgeContext } from './bridge';
import type { OpenCodeManager } from './opencode';
import { formatSettingsResponse } from './settings-visible-runtime';

const flush = async (times = 12) => {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
};

const createFakeTimers = () => {
  const timers: Array<{ fireAt: number; callback: () => void; cleared: boolean }> = [];
  let now = 1_000_000;
  return {
    now: () => now,
    advance: async (ms: number) => {
      now += ms;
      const due = timers
        .filter((timer) => !timer.cleared && timer.fireAt <= now)
        .sort((a, b) => a.fireAt - b.fireAt);
      for (const timer of due) {
        if (timer.cleared) continue;
        timer.cleared = true;
        timer.callback();
        await flush();
      }
    },
    createTimer: (callback: () => void, delayMs: number) => {
      const timer = { fireAt: now + delayMs, callback, cleared: false };
      timers.push(timer);
      return { clear: () => { timer.cleared = true; } };
    },
    pendingCount: () => timers.filter((timer) => !timer.cleared).length,
  };
};

const createTestCore = (overrides: Record<string, unknown> = {}) => {
  const clock = createFakeTimers();
  const posts: Array<{ kind: string; requestID: string; directory?: string; answers?: unknown; body?: unknown }> = [];
  const io = {
    now: clock.now,
    createTimer: clock.createTimer,
    createEpoch: () => 'epoch-vscode-test',
    onChanged: vi.fn(),
    readEnabled: async () => true,
    listDirectories: async () => ['/workspace', '/worktree-a'],
    listQuestions: async () => [],
    getSession: async (sessionID: string, directory?: string | null) => ({
      id: sessionID,
      parentID: sessionID.startsWith('child-') ? 'root-1' : null,
      directory: directory || '/workspace',
    }),
    postReply: async (requestID: string, directory: string | undefined, answers: string[][]) => {
      posts.push({ kind: 'reply', requestID, directory, answers });
      return { ok: true, uncertain: false, status: 200, body: true };
    },
    postReject: async (requestID: string, directory: string | undefined, body: unknown) => {
      posts.push({ kind: 'reject', requestID, directory, body });
      return { ok: true, uncertain: false, status: 200, body: true };
    },
    ...overrides,
  };
  if (!overrides.now) io.now = clock.now;
  if (!overrides.createTimer) io.createTimer = clock.createTimer;

  const core = createQuestionAutoDelegateCore({ io: io as never, delayMs: QUESTION_AUTO_DELEGATE_DELAY_MS });
  // Core boots with settingsStatus=loading / enabled=false until start() or applyEnabled.
  // Host unit tests inject the core without start(); arm settings the same way a
  // successful settings save does so timers schedule on question.asked.
  core.applyEnabled(true);
  return { core, clock, posts, io };
};

const asked = (
  id = 'q1',
  sessionID = 'ses-1',
  directory = '/workspace',
  questionCount = 1,
) => ({
  type: 'question.asked',
  properties: {
    id,
    sessionID,
    directory,
    questions: Array.from({ length: questionCount }, (_, index) => ({
      question: `Q${index}`,
      header: `H${index}`,
      options: [{ label: 'A', description: '' }],
    })),
  },
});

const proxyDeps = {
  tryHandleLocalFsProxy: async () => null,
  buildUnavailableApiResponse: () => ({ status: 503, headers: {}, bodyText: '' }),
  sanitizeForwardHeaders: (input: Record<string, string> | undefined) => input ?? {},
  collectHeaders: (headers: Headers) => {
    const result: Record<string, string> = {};
    headers.forEach((value, key) => {
      result[key] = value;
    });
    return result;
  },
  base64EncodeUtf8: (text: string) => Buffer.from(text, 'utf8').toString('base64'),
};

const proxyCtx = {
  manager: {
    getStatus: () => 'connected',
    getApiUrl: () => 'http://127.0.0.1:3999',
    getOpenCodeAuthHeaders: () => ({}),
    onStatusChange: (cb: (status: string) => void) => {
      cb('connected');
      return { dispose: () => {} };
    },
  },
} as unknown as BridgeContext;

afterEach(() => {
  stopGlobalEventWatcher();
  stopQuestionAutoDelegateRuntime();
  __setQuestionAutoDelegateCoreForTests(null);
  __setQuestionAutoDelegateManagerForTests(null);
  __setQuestionAutoDelegateSettingsPathForTests(null);
  __resetQuestionAutoDelegateObservedDirectoriesForTests();
});

describe('VS Code question auto-delegate host authority', () => {
  test('fires auto-reply after 30s without any webview sink (host singleton)', async () => {
    // Do not call core.start() here: start()'s async reconcile with empty list
    // would external-settle the just-tracked request. Host authority is the
    // injected timer path exercised via processEvent + clock.
    const { core, clock, posts } = createTestCore();
    __setQuestionAutoDelegateCoreForTests(core);
    processQuestionAutoDelegateEvent(asked('q-host', 'ses-host', '/workspace'));
    assert.equal(clock.pendingCount(), 1);
    assert.equal(posts.length, 0);

    await clock.advance(QUESTION_AUTO_DELEGATE_DELAY_MS - 1);
    assert.equal(posts.length, 0);

    await clock.advance(1);
    assert.equal(posts.length, 1);
    assert.equal(posts[0]?.kind, 'reply');
    assert.equal(posts[0]?.requestID, 'q-host');
    assert.deepEqual(posts[0]?.answers, [[QUESTION_AUTO_DELEGATE_ANSWER]]);
    assert.equal(core.snapshot().requests.find((r) => r.requestID === 'q-host')?.state, 'settled');
  });

  test('tracks subagent session questions on their own directory and still auto-replies', async () => {
    const { core, clock, posts } = createTestCore();
    __setQuestionAutoDelegateCoreForTests(core);

    // Parent session lineage + child (subagent) question in a different directory.
    processQuestionAutoDelegateEvent({
      type: 'session.created',
      properties: { info: { id: 'child-1', parentID: 'root-1', directory: '/worktree-a' } },
    }, '/worktree-a');
    processQuestionAutoDelegateEvent(asked('q-child', 'child-1', '/worktree-a', 2));

    assert.equal(core.isBlockingSession('root-1'), true);
    assert.equal(core.isBlockingSession('child-1'), true);

    await clock.advance(QUESTION_AUTO_DELEGATE_DELAY_MS);
    assert.equal(posts.length, 1);
    assert.equal(posts[0]?.requestID, 'q-child');
    assert.equal(posts[0]?.directory, '/worktree-a');
    assert.deepEqual(posts[0]?.answers, [
      [QUESTION_AUTO_DELEGATE_ANSWER],
      [QUESTION_AUTO_DELEGATE_ANSWER],
    ]);
  });

  test('manual reply claim wins over timer (race) and loser gets claimed code', async () => {
    let releaseManual!: () => void;
    const manualGate = new Promise<void>((resolve) => { releaseManual = resolve; });
    const { core, clock, posts } = createTestCore({
      postReply: async (requestID: string, directory: string | undefined, answers: string[][]) => {
        posts.push({ kind: 'reply', requestID, directory, answers });
        if (answers?.[0]?.[0] === 'manual') {
          await manualGate;
        }
        return { ok: true, uncertain: false, status: 200, body: true };
      },
    });
    __setQuestionAutoDelegateCoreForTests(core);
    processQuestionAutoDelegateEvent(asked('q-race', 'ses-race', '/workspace'));
    assert.equal(clock.pendingCount(), 1);

    const manual = core.submit({
      requestID: 'q-race',
      sessionID: 'ses-race',
      directory: '/workspace',
      kind: 'reply',
      authority: 'manual',
      answers: [['manual']],
    });
    // Manual already claimed; timer fire must not double-POST.
    await clock.advance(QUESTION_AUTO_DELEGATE_DELAY_MS);
    await flush();
    assert.equal(posts.length, 1);
    assert.deepEqual(posts[0]?.answers, [['manual']]);

    releaseManual();
    const manualResult = await manual;
    assert.equal(manualResult.outcome, 'submitted');

    // After settle, further submits report settled (not a second upstream POST).
    const second = await core.submit({
      requestID: 'q-race',
      kind: 'reply',
      authority: 'manual',
      answers: [['late']],
    });
    assert.equal(second.outcome, 'settled');
    assert.equal(posts.length, 1);

    // In-flight claim loser still surfaces the claimed code (proxy concurrent path).
    const claimCore = createTestCore();
    __setQuestionAutoDelegateCoreForTests(claimCore.core);
    processQuestionAutoDelegateEvent(asked('q-race-2', 'ses-race-2', '/workspace'));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    claimCore.io.postReply = async (requestID: string, directory: string | undefined, answers: string[][]) => {
      claimCore.posts.push({ kind: 'reply', requestID, directory, answers });
      await gate;
      return { ok: true, uncertain: false, status: 200, body: true };
    };
    const first = claimCore.core.submit({
      requestID: 'q-race-2',
      kind: 'reply',
      authority: 'manual',
      answers: [['a']],
    });
    await flush();
    const loser = await claimCore.core.submit({
      requestID: 'q-race-2',
      kind: 'reply',
      authority: 'auto',
      answers: [['b']],
    });
    assert.equal(loser.outcome, 'claimed');
    assert.equal(loser.code, QUESTION_SUBMISSION_CLAIMED_CODE);
    release();
    await first;
  });

  test('proxy preserves SDK reply body/status and directory query on manual intercept', async () => {
    const { core, posts } = createTestCore({
      postReply: async (requestID: string, directory: string | undefined, answers: string[][]) => {
        posts.push({ kind: 'reply', requestID, directory, answers });
        return { ok: true, uncertain: false, status: 200, body: { ok: true, echoed: answers } };
      },
    });
    __setQuestionAutoDelegateCoreForTests(core);
    processQuestionAutoDelegateEvent(asked('q-proxy', 'ses-proxy', '/repo'));

    const body = Buffer.from(JSON.stringify({
      answers: [['from-ui']],
      sessionID: 'ses-proxy',
      directory: '/repo',
    }), 'utf8').toString('base64');

    const response = await handleProxyBridgeMessage(
      {
        id: 'p1',
        type: 'api:proxy',
        payload: {
          method: 'POST',
          path: '/question/q-proxy/reply?directory=%2Frepo',
          bodyBase64: body,
        },
      },
      proxyCtx,
      proxyDeps,
    );

    assert.equal(response?.success, true);
    const data = response?.data as { status?: number; bodyText?: string };
    assert.equal(data.status, 200);
    assert.deepEqual(JSON.parse(data.bodyText ?? '{}'), { ok: true, echoed: [['from-ui']] });
    assert.equal(posts[0]?.directory, '/repo');
    assert.equal(posts.length, 1);
  });

  test('proxy GET snapshot + pause/delegate routes stay host-local (no OpenCode fetch)', async () => {
    const originalFetch = globalThis.fetch;
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount += 1;
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    try {
      const { core } = createTestCore({
        // Avoid start()/reconcile wiping pending entries mid-test.
        listQuestions: async () => null,
      });
      __setQuestionAutoDelegateCoreForTests(core);
      processQuestionAutoDelegateEvent(asked('q-local', 'ses-local', '/workspace'));

      const snap = await tryHandleQuestionAutoDelegateProxy('GET', '/question-auto-delegate');
      assert.equal(snap?.status, 200);
      const snapBody = JSON.parse(snap?.bodyText ?? '{}') as { enabled?: boolean; delayMs?: number; requests?: unknown[] };
      assert.equal(snapBody.enabled, true);
      assert.equal(snapBody.delayMs, QUESTION_AUTO_DELEGATE_DELAY_MS);
      assert.equal(Array.isArray(snapBody.requests), true);

      const pauseBody = Buffer.from(JSON.stringify({
        sessionID: 'ses-local',
        directory: '/workspace',
        reason: 'interaction',
      }), 'utf8').toString('base64');
      const paused = await tryHandleQuestionAutoDelegateProxy(
        'POST',
        '/question-auto-delegate/requests/q-local/pause',
        undefined,
        pauseBody,
      );
      assert.equal(paused?.status, 200);
      assert.equal(JSON.parse(paused?.bodyText ?? '{}').outcome, 'paused');

      // Re-enable counting then delegate immediately.
      applyQuestionAutoDelegateEnabled(true);
      processQuestionAutoDelegateEvent(asked('q-del', 'ses-local', '/workspace'));
      const delBody = Buffer.from(JSON.stringify({
        sessionID: 'ses-local',
        directory: '/workspace',
      }), 'utf8').toString('base64');
      const delegated = await tryHandleQuestionAutoDelegateProxy(
        'POST',
        '/question-auto-delegate/requests/q-del/delegate',
        undefined,
        delBody,
      );
      assert.equal(delegated?.status, 200);
      assert.equal(JSON.parse(delegated?.bodyText ?? '{}').outcome, 'delegated');
      assert.equal(fetchCount, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('settings visible allowlist includes questionAutoDelegateEnabled', () => {
    const settings = formatSettingsResponse({
      questionAutoDelegateEnabled: false,
      sessionGoalEnabled: true,
    }, { themeVariant: 'dark', lastDirectory: '/workspace' });
    assert.equal(settings.questionAutoDelegateEnabled, false);
    assert.equal(settings.sessionGoalEnabled, true);
  });

  test('applyEnabled only after successful field persist path (false cancels timers)', async () => {
    const { core, clock, posts } = createTestCore();
    __setQuestionAutoDelegateCoreForTests(core);
    processQuestionAutoDelegateEvent(asked('q-off', 'ses-off', '/workspace'));
    assert.equal(clock.pendingCount(), 1);

    applyQuestionAutoDelegateEnabled(false);
    assert.equal(core.snapshot().enabled, false);
    assert.equal(core.snapshot().requests.find((r) => r.requestID === 'q-off')?.state, 'disabled');
    assert.equal(clock.pendingCount(), 0);

    await clock.advance(QUESTION_AUTO_DELEGATE_DELAY_MS + 5);
    assert.equal(posts.length, 0);
  });
});

describe('VS Code question auto-delegate proxy claim fidelity', () => {
  test('concurrent manual reply via proxy returns 409 claimed for loser', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const posts: string[] = [];
    const { core } = createTestCore({
      postReply: async (requestID: string) => {
        posts.push(requestID);
        await gate;
        return { ok: true, uncertain: false, status: 200, body: true };
      },
    });
    __setQuestionAutoDelegateCoreForTests(core);
    processQuestionAutoDelegateEvent(asked('q-claim', 'ses-claim', '/workspace'));

    const body = Buffer.from(JSON.stringify({ answers: [['a']], sessionID: 'ses-claim' }), 'utf8').toString('base64');
    const first = tryHandleQuestionAutoDelegateProxy('POST', '/question/q-claim/reply', undefined, body);
    await flush();
    const second = await tryHandleQuestionAutoDelegateProxy('POST', '/question/q-claim/reply', undefined, body);
    assert.equal(second?.status, 409);
    assert.equal(JSON.parse(second?.bodyText ?? '{}').code, QUESTION_SUBMISSION_CLAIMED_CODE);
    release();
    const firstResult = await first;
    assert.equal(firstResult?.status, 200);
    assert.equal(posts.length, 1);
  });
});

describe('VS Code question auto-delegate tip + disconnect retention', () => {
  test('host tip sinks deliver once to three providers (chat/agent/editor fan-out)', () => {
    const tips: unknown[][] = [[], [], []];
    const unsubs = tips.map((bucket) => addQuestionAutoDelegateTipSink({
      postMessage: (message: unknown) => {
        bucket.push(message);
      },
    }));

    __broadcastQuestionAutoDelegateTipForTests({ epoch: 'epoch-tip', revision: 7 });

    for (const bucket of tips) {
      assert.equal(bucket.length, 1);
      const msg = bucket[0] as { type?: string; properties?: { epoch?: string; revision?: number } };
      assert.equal(msg.type, 'openchamber:question-auto-delegate-changed');
      assert.equal(msg.properties?.epoch, 'epoch-tip');
      assert.equal(msg.properties?.revision, 7);
    }
    // Second tip still fans out once each — no webview-side timer ownership.
    __broadcastQuestionAutoDelegateTipForTests({ epoch: 'epoch-tip', revision: 8 });
    for (const bucket of tips) {
      assert.equal(bucket.length, 2);
    }
    for (const unsub of unsubs) unsub();
  });

  test('empty getApiUrl after wait is notSent (never fetched); bare status0 after fetch stays uncertain', async () => {
    __setQuestionAutoDelegateManagerForTests({
      getApiUrl: () => null,
      getOpenCodeAuthHeaders: () => ({}),
    } as unknown as OpenCodeManager);

    vi.useFakeTimers();
    try {
      const pending = __buildUpstreamForTests('/question/q/reply', {
        method: 'POST',
        body: { answers: [['x']] },
      });
      await vi.advanceTimersByTimeAsync(16_000);
      const result = await pending;
      assert.equal(result.ok, false);
      assert.equal(result.uncertain, false);
      assert.equal(result.notSent, true);
      assert.equal(result.status, 0);
    } finally {
      vi.useRealTimers();
    }
  });

  test('core notSent releases claim to paused; manual succeeds after recovery', async () => {
    let mode: 'offline' | 'online' = 'offline';
    const { core, posts } = createTestCore({
      listQuestions: async () => null,
      postReply: async (requestID: string, directory: string | undefined, answers: string[][]) => {
        if (mode === 'offline') {
          return {
            ok: false,
            uncertain: false,
            notSent: true,
            status: 0,
            body: { error: 'OpenCode API unavailable' },
          };
        }
        posts.push({ kind: 'reply', requestID, directory, answers });
        return { ok: true, uncertain: false, status: 200, body: true };
      },
    });
    __setQuestionAutoDelegateCoreForTests(core);
    processQuestionAutoDelegateEvent(asked('q-notsent', 'ses-notsent', '/workspace'));

    const auto = await core.submit({
      requestID: 'q-notsent',
      sessionID: 'ses-notsent',
      directory: '/workspace',
      kind: 'reply',
      authority: 'auto',
      answers: [[QUESTION_AUTO_DELEGATE_ANSWER]],
    });
    assert.equal(auto.outcome, 'error');
    const afterNotSent = core.snapshot().requests.find((r) => r.requestID === 'q-notsent');
    assert.equal(afterNotSent?.state, 'paused');
    assert.equal(posts.length, 0);

    // Upstream recovers — human retry must be allowed (claim released).
    mode = 'online';
    const manual = await core.submit({
      requestID: 'q-notsent',
      sessionID: 'ses-notsent',
      directory: '/workspace',
      kind: 'reply',
      authority: 'manual',
      answers: [['manual-after-recovery']],
    });
    assert.equal(manual.outcome, 'submitted');
    assert.equal(posts.length, 1);
    assert.deepEqual(posts[0]?.answers, [['manual-after-recovery']]);
    assert.equal(core.snapshot().requests.find((r) => r.requestID === 'q-notsent')?.state, 'settled');
  });

  test('bare status0 without notSent remains uncertain (send may have left process)', async () => {
    const { core, posts } = createTestCore({
      listQuestions: async () => null,
      postReply: async () => ({
        ok: false,
        uncertain: true,
        status: 0,
        body: { error: 'aborted after dispatch' },
      }),
    });
    __setQuestionAutoDelegateCoreForTests(core);
    processQuestionAutoDelegateEvent(asked('q-unc', 'ses-unc', '/workspace'));

    const result = await core.submit({
      requestID: 'q-unc',
      sessionID: 'ses-unc',
      directory: '/workspace',
      kind: 'reply',
      authority: 'auto',
      answers: [[QUESTION_AUTO_DELEGATE_ANSWER]],
    });
    assert.equal(result.outcome, 'uncertain');
    assert.equal(core.snapshot().requests.find((r) => r.requestID === 'q-unc')?.state, 'uncertain');
    assert.equal(posts.length, 0);

    // Claim stays locked — further submit is claimed, not a second POST.
    const retry = await core.submit({
      requestID: 'q-unc',
      kind: 'reply',
      authority: 'manual',
      answers: [['nope']],
    });
    assert.equal(retry.outcome, 'claimed');
  });

  test('same-endpoint suspend keeps pause/claim; stop disposes core', async () => {
    assert.equal(__normalizeEndpointKeyForTests('http://127.0.0.1:4099/'), 'loopback:http:');
    assert.equal(__normalizeEndpointKeyForTests('http://127.0.0.1:5100/'), 'loopback:http:');
    assert.equal(
      __normalizeEndpointKeyForTests('http://example.test:8080/v1'),
      'http://example.test:8080',
    );

    const { core, clock } = createTestCore({
      listQuestions: async () => null,
    });
    __setQuestionAutoDelegateCoreForTests(core);
    processQuestionAutoDelegateEvent(asked('q-pause-keep', 'ses-keep', '/workspace'));
    assert.equal(clock.pendingCount(), 1);

    const pauseBody = Buffer.from(JSON.stringify({
      sessionID: 'ses-keep',
      directory: '/workspace',
      reason: 'user',
    }), 'utf8').toString('base64');
    const paused = await tryHandleQuestionAutoDelegateProxy(
      'POST',
      '/question-auto-delegate/requests/q-pause-keep/pause',
      undefined,
      pauseBody,
    );
    assert.equal(paused?.status, 200);
    assert.equal(core.snapshot().requests.find((r) => r.requestID === 'q-pause-keep')?.state, 'paused');

    const manager = {
      getApiUrl: () => 'http://127.0.0.1:4099',
      getOpenCodeAuthHeaders: () => ({}),
      getWorkingDirectory: () => '/workspace',
    } as unknown as OpenCodeManager;
    startQuestionAutoDelegateRuntime(manager);
    assert.equal(getQuestionAutoDelegateCore(), core);

    // extension onStatusChange(disconnected|error) → suspend only (no core dispose).
    suspendGlobalEventWatcher();
    assert.equal(getQuestionAutoDelegateCore(), core);
    assert.equal(core.snapshot().requests.find((r) => r.requestID === 'q-pause-keep')?.state, 'paused');

    // Same logical upstream after loopback port rotate still reuses core.
    startQuestionAutoDelegateRuntime({
      ...manager,
      getApiUrl: () => 'http://127.0.0.1:5100',
    } as unknown as OpenCodeManager);
    assert.equal(getQuestionAutoDelegateCore(), core);
    assert.equal(core.snapshot().requests.find((r) => r.requestID === 'q-pause-keep')?.state, 'paused');

    // deactivate / full teardown disposes authority.
    stopGlobalEventWatcher();
    assert.equal(getQuestionAutoDelegateCore(), null);
    assert.equal(__getBoundQuestionAutoDelegateEndpointForTests(), null);
  });
});

describe('VS Code question auto-delegate settings read gate', () => {
  const makeTempSettingsDir = (): string =>
    fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-qad-settings-'));

  test('absent settings file defaults enabled true (ENOENT only)', async () => {
    const dir = makeTempSettingsDir();
    const settingsPath = path.join(dir, 'settings.json');
    // Do not create the file — pure ENOENT.
    __setQuestionAutoDelegateSettingsPathForTests(settingsPath);
    assert.equal(await __readQuestionAutoDelegateEnabledForTests(), true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('explicit false is preserved when settings are readable', async () => {
    const dir = makeTempSettingsDir();
    const settingsPath = path.join(dir, 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({ questionAutoDelegateEnabled: false }), 'utf8');
    __setQuestionAutoDelegateSettingsPathForTests(settingsPath);
    assert.equal(await __readQuestionAutoDelegateEnabledForTests(), false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('invalid JSON yields null (core unavailable gate — no auto timers)', async () => {
    const dir = makeTempSettingsDir();
    const settingsPath = path.join(dir, 'settings.json');
    fs.writeFileSync(settingsPath, '{not-json', 'utf8');
    __setQuestionAutoDelegateSettingsPathForTests(settingsPath);
    assert.equal(await __readQuestionAutoDelegateEnabledForTests(), null);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('unreadable settings path yields null (not default true)', async () => {
    const dir = makeTempSettingsDir();
    // Point at a directory path so readFileSync fails with EISDIR (not ENOENT).
    __setQuestionAutoDelegateSettingsPathForTests(dir);
    assert.equal(await __readQuestionAutoDelegateEnabledForTests(), null);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('corrupt settings keep core unavailable after start (no auto timer)', async () => {
    const dir = makeTempSettingsDir();
    const settingsPath = path.join(dir, 'settings.json');
    // Previously-off intent corrupted: must not arm timers via default-true collapse.
    fs.writeFileSync(settingsPath, 'null', 'utf8');
    __setQuestionAutoDelegateSettingsPathForTests(settingsPath);

    const manager = {
      getApiUrl: () => 'http://127.0.0.1:4099',
      getOpenCodeAuthHeaders: () => ({}),
      getWorkingDirectory: () => '/workspace',
    } as unknown as OpenCodeManager;

    startQuestionAutoDelegateRuntime(manager);
    const core = getQuestionAutoDelegateCore();
    assert.ok(core);
    // Allow start()'s async readEnabled to settle.
    await flush(20);
    processQuestionAutoDelegateEvent(asked('q-corrupt', 'ses-corrupt', '/workspace'));
    await flush(10);

    const snap = core!.snapshot();
    assert.equal(snap.enabled, false);
    // Identity may track as counting, but unavailable gate must not arm a deadline/timer.
    const entry = snap.requests.find((r) => r.requestID === 'q-corrupt');
    assert.ok(entry);
    assert.equal(entry?.deadlineAt, null);
    assert.equal(snap.coverage.state === 'partial' || snap.enabled === false, true);

    stopQuestionAutoDelegateRuntime();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
