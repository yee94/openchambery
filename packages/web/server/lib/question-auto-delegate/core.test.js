import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  QUESTION_AUTO_DELEGATE_ANSWER,
  QUESTION_AUTO_DELEGATE_DELAY_MS,
  QUESTION_SUBMISSION_CLAIMED_CODE,
  buildAutoDelegateAnswers,
  createQuestionAutoDelegateCore,
} from './core.js';

const flush = async (times = 15) => {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
};

const createFakeTimers = () => {
  /** @type {Array<{ id: number, fireAt: number, callback: () => void, cleared: boolean }>} */
  const timers = [];
  let nextId = 1;
  let now = 1_000_000;
  return {
    now: () => now,
    advance: async (ms) => {
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
    createTimer: (callback, delayMs) => {
      const timer = {
        id: nextId++,
        fireAt: now + delayMs,
        callback,
        cleared: false,
      };
      timers.push(timer);
      return {
        clear: () => {
          timer.cleared = true;
        },
      };
    },
    pendingCount: () => timers.filter((timer) => !timer.cleared).length,
  };
};

const createIo = (overrides = {}) => {
  const clock = createFakeTimers();
  const posts = [];
  const io = {
    now: clock.now,
    createTimer: clock.createTimer,
    createEpoch: () => 'epoch-test',
    onChanged: vi.fn(),
    onUserTakeover: vi.fn(),
    readEnabled: async () => true,
    listDirectories: async () => ['/proj-a', '/proj-b'],
    listQuestions: async () => [],
    getSession: async (sessionID, directory) => ({
      id: sessionID,
      parentID: null,
      directory: directory || '/proj-a',
    }),
    postReply: async (requestID, directory, answers) => {
      posts.push({ kind: 'reply', requestID, directory, answers });
      return { ok: true, uncertain: false, status: 200, body: true };
    },
    postReject: async (requestID, directory, body) => {
      posts.push({ kind: 'reject', requestID, directory, body });
      return { ok: true, uncertain: false, status: 200, body: true };
    },
    ...overrides,
    __clock: clock,
    __posts: posts,
  };
  if (!overrides.now) io.now = clock.now;
  if (!overrides.createTimer) io.createTimer = clock.createTimer;
  return io;
};

const asked = (id = 'q1', sessionID = 'ses-1', directory = '/proj-a', questionCount = 1) => ({
  type: 'question.asked',
  properties: {
    id,
    sessionID,
    ...(directory ? { directory } : {}),
    questions: Array.from({ length: questionCount }, (_, index) => ({
      question: `Q${index}`,
      header: `H${index}`,
      options: [{ label: 'A', description: '' }],
    })),
  },
});

/** Ready settings without racing start() boot read. */
const ready = (core) => {
  core.applyEnabled(true);
};

describe('buildAutoDelegateAnswers', () => {
  it('builds one custom-text slot per question', () => {
    expect(buildAutoDelegateAnswers(2)).toEqual([
      [QUESTION_AUTO_DELEGATE_ANSWER],
      [QUESTION_AUTO_DELEGATE_ANSWER],
    ]);
  });
});

describe('question auto-delegate core — claim / upstream outcomes', () => {
  afterEach(() => vi.restoreAllMocks());

  it('fires auto-reply at 30000ms but not at 29999ms when directory-bound', async () => {
    const io = createIo();
    const core = createQuestionAutoDelegateCore({ io, delayMs: QUESTION_AUTO_DELEGATE_DELAY_MS });
    ready(core);
    core.processEvent(asked());
    expect(core.snapshot().requests[0]?.state).toBe('counting');
    expect(io.__clock.pendingCount()).toBe(1);

    await io.__clock.advance(29_999);
    expect(io.__posts).toHaveLength(0);

    await io.__clock.advance(1);
    expect(io.__posts).toHaveLength(1);
    expect(io.__posts[0].answers).toEqual([[QUESTION_AUTO_DELEGATE_ANSWER]]);
    expect(core.snapshot().requests[0]?.state).toBe('settled');
    core.dispose();
  });

  it('interaction pause cancels the auto-reply timer even without a directory hint', async () => {
    const io = createIo();
    const core = createQuestionAutoDelegateCore({ io });
    ready(core);
    core.processEvent(asked());
    expect(io.__clock.pendingCount()).toBe(1);
    const paused = await core.pause({
      requestID: 'q1',
      sessionID: 'ses-1',
      directory: '',
      reason: 'interaction',
    });
    expect(paused.outcome).toBe('paused');
    expect(io.__clock.pendingCount()).toBe(0);
    await io.__clock.advance(30_000);
    expect(io.__posts).toHaveLength(0);
    expect(core.snapshot().requests[0]?.state).toBe('paused');
    core.dispose();
  });

  it('HTTP 400 definitive reject releases claim and pauses for manual retry (no auto loop)', async () => {
    let calls = 0;
    const io = createIo({
      postReply: async () => {
        calls += 1;
        return { ok: false, uncertain: false, status: 400, body: { error: 'bad answers' } };
      },
    });
    const core = createQuestionAutoDelegateCore({ io });
    ready(core);
    core.processEvent(asked());
    await io.__clock.advance(30_000);
    expect(calls).toBe(1);
    const snap = core.snapshot().requests[0];
    expect(snap.state).toBe('paused');
    expect(snap.claimAuthority == null || snap.claimAuthority === null).toBe(true);

    // No automatic retry.
    await io.__clock.advance(60_000);
    expect(calls).toBe(1);

    // Manual can claim again.
    io.postReply = async (requestID, directory, answers) => {
      calls += 1;
      return { ok: true, uncertain: false, status: 200, body: true, answers };
    };
    const manual = await core.submit({
      requestID: 'q1',
      sessionID: 'ses-1',
      directory: '/proj-a',
      kind: 'reply',
      authority: 'manual',
      answers: [['yes']],
    });
    expect(manual.outcome).toBe('submitted');
    expect(calls).toBe(2);
    core.dispose();
  });

  it('uncertain after dispatch stays locked; successful scoped empty converges to external', async () => {
    const io = createIo({
      postReply: async () => ({ ok: false, uncertain: true, status: 503, body: null }),
      listQuestions: async (directory) => {
        if (directory === '/proj-a') return [];
        return null;
      },
    });
    const core = createQuestionAutoDelegateCore({ io });
    ready(core);
    core.processEvent(asked());
    await io.__clock.advance(30_000);
    expect(core.snapshot().requests[0].state).toBe('uncertain');
    expect(core.isBlockingSession('ses-1')).toBe(true);

    const claimed = await core.submit({
      requestID: 'q1',
      sessionID: 'ses-1',
      directory: '/proj-a',
      kind: 'reply',
      authority: 'manual',
      answers: [['x']],
    });
    expect(claimed.outcome).toBe('claimed');
    expect(claimed.code).toBe(QUESTION_SUBMISSION_CLAIMED_CODE);

    await core.reconcile({ directories: ['/proj-a'] });
    expect(core.snapshot().requests[0].state).toBe('settled');
    expect(core.snapshot().requests[0].resolution).toBe('external');
    core.dispose();
  });

  it('settled is not downgraded by a late POST failure', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const io = createIo({
      postReply: async () => {
        await gate;
        return { ok: false, uncertain: true, status: 503, body: null };
      },
    });
    const core = createQuestionAutoDelegateCore({ io });
    ready(core);
    core.processEvent(asked());
    const pending = core.submit({
      requestID: 'q1',
      sessionID: 'ses-1',
      directory: '/proj-a',
      kind: 'reply',
      authority: 'auto',
      answers: buildAutoDelegateAnswers(1),
    });
    // Authoritative event settles while POST in flight.
    core.processEvent({ type: 'question.replied', properties: { id: 'q1', sessionID: 'ses-1' } });
    expect(core.snapshot().requests[0].state).toBe('settled');
    release();
    const result = await pending;
    expect(result.outcome).toBe('settled');
    expect(core.snapshot().requests[0].state).toBe('settled');
    expect(core.snapshot().requests[0].resolution).toBe('replied');
    core.dispose();
  });

  it('manual answers:[] are forwarded as-is (never auto text)', async () => {
    const io = createIo();
    const core = createQuestionAutoDelegateCore({ io });
    ready(core);
    core.processEvent(asked());
    const result = await core.submit({
      requestID: 'q1',
      sessionID: 'ses-1',
      directory: '/proj-a',
      kind: 'reply',
      authority: 'manual',
      answers: [],
    });
    expect(result.outcome).toBe('submitted');
    expect(io.__posts[0].answers).toEqual([]);
    core.dispose();
  });

  it('manual missing answers array is rejected without claim', async () => {
    const io = createIo();
    const core = createQuestionAutoDelegateCore({ io });
    ready(core);
    core.processEvent(asked());
    const result = await core.submit({
      requestID: 'q1',
      sessionID: 'ses-1',
      directory: '/proj-a',
      kind: 'reply',
      authority: 'manual',
      answers: null,
    });
    expect(result.outcome).toBe('error');
    expect(result.status).toBe(400);
    expect(core.snapshot().requests[0].state).toBe('counting');
    core.dispose();
  });

  it('allows only one upstream mutation across concurrent manual and auto', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let replyCount = 0;
    const io = createIo({
      postReply: async () => {
        replyCount += 1;
        await gate;
        return { ok: true, uncertain: false, status: 200, body: true };
      },
    });
    const core = createQuestionAutoDelegateCore({ io });
    ready(core);
    core.processEvent(asked());
    const auto = core.submit({
      requestID: 'q1', sessionID: 'ses-1', directory: '/proj-a',
      kind: 'reply', authority: 'auto', answers: buildAutoDelegateAnswers(1),
    });
    const manual = core.submit({
      requestID: 'q1', sessionID: 'ses-1', directory: '/proj-a',
      kind: 'reply', authority: 'manual', answers: [['user']],
    });
    const manualResult = await manual;
    expect(manualResult.outcome).toBe('claimed');
    expect(manualResult.code).toBe(QUESTION_SUBMISSION_CLAIMED_CODE);
    expect(replyCount).toBe(1);
    release();
    await auto;
    expect(replyCount).toBe(1);
    expect(io.onUserTakeover).not.toHaveBeenCalled(); // auto won; manual never claimed
    core.dispose();
  });

  it('manual claim fires takeover for goal linkage', async () => {
    const io = createIo();
    const core = createQuestionAutoDelegateCore({ io });
    ready(core);
    core.processEvent(asked());
    await core.submit({
      requestID: 'q1', sessionID: 'ses-1', directory: '/proj-a',
      kind: 'reply', authority: 'manual', answers: [['ok']],
    });
    expect(io.onUserTakeover).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'interaction',
      sessionID: 'ses-1',
    }));
    core.dispose();
  });
});

describe('question auto-delegate core — directory binding', () => {
  it('does not arm auto timer until authoritative directory is bound', async () => {
    const io = createIo({
      getSession: async (sessionID) => ({
        id: sessionID,
        parentID: null,
        directory: '/worktree-child',
      }),
    });
    const core = createQuestionAutoDelegateCore({ io });
    ready(core);
    core.processEvent(asked('q-wt', 'ses-wt', '')); // no directory
    expect(core.snapshot().requests[0].directory).toBe('');
    expect(core.snapshot().requests[0].deadlineAt).toBeNull();
    expect(io.__clock.pendingCount()).toBe(0);

    await flush(20);
    expect(core.snapshot().requests[0].directory).toBe('/worktree-child');
    expect(core.snapshot().requests[0].deadlineAt).not.toBeNull();
    expect(io.__clock.pendingCount()).toBe(1);

    await io.__clock.advance(30_000);
    expect(io.__posts).toHaveLength(1);
    expect(io.__posts[0].directory).toBe('/worktree-child');
    core.dispose();
  });

  it('rejects claim/pause with conflicting directory or session hints (409)', async () => {
    const io = createIo();
    const core = createQuestionAutoDelegateCore({ io });
    ready(core);
    core.processEvent(asked('q1', 'ses-1', '/proj-a'));

    const badClaim = await core.submit({
      requestID: 'q1',
      sessionID: 'ses-OTHER',
      directory: '/proj-a',
      kind: 'reply',
      authority: 'manual',
      answers: [['x']],
    });
    expect(badClaim.outcome).toBe('error');
    expect(badClaim.status).toBe(409);

    const badDir = await core.pause({
      requestID: 'q1',
      sessionID: 'ses-1',
      directory: '/wrong',
      reason: 'user',
    });
    expect(badDir.outcome).toBe('error');
    expect(badDir.status).toBe(409);
    expect(core.snapshot().requests[0].directory).toBe('/proj-a');
    core.dispose();
  });

  it('unknown multi-question delegate recovers identity via scoped list (not invent count=1)', async () => {
    const io = createIo({
      listQuestions: async (directory) => {
        if (directory !== '/proj-a') return [];
        return [{
          id: 'q-unknown',
          sessionID: 'ses-1',
          directory: '/proj-a',
          questions: [
            { question: 'a', header: 'a', options: [] },
            { question: 'b', header: 'b', options: [] },
            { question: 'c', header: 'c', options: [] },
          ],
        }];
      },
    });
    const core = createQuestionAutoDelegateCore({ io });
    ready(core);
    // Feature off still allows explicit delegate.
    core.applyEnabled(false);
    const result = await core.delegate({
      requestID: 'q-unknown',
      sessionID: 'ses-1',
      directory: '/proj-a',
    });
    expect(result.outcome).toBe('delegated');
    expect(io.__posts[0].answers).toHaveLength(3);
    core.dispose();
  });
});

describe('question auto-delegate core — reconcile scoping', () => {
  it('only settles directories that listed successfully (A empty does not clear B/C)', async () => {
    const io = createIo({
      listDirectories: async () => ['/A', '/B', '/C'],
      listQuestions: async (directory) => {
        if (directory === '/A') return [];
        if (directory === '/B') return null; // not queried successfully
        if (directory === '/C') return null; // failed
        return [];
      },
    });
    const core = createQuestionAutoDelegateCore({ io });
    ready(core);
    core.processEvent(asked('qa', 'ses-a', '/A'));
    core.processEvent(asked('qb', 'ses-b', '/B'));
    core.processEvent(asked('qc', 'ses-c', '/C'));

    await core.reconcile({ directories: ['/A', '/B', '/C'] });
    const byId = Object.fromEntries(core.snapshot().requests.map((r) => [r.requestID, r]));
    expect(byId.qa.state).toBe('settled');
    expect(byId.qa.resolution).toBe('external');
    expect(byId.qb.state).toBe('counting');
    expect(byId.qc.state).toBe('counting');
    expect(core.snapshot().coverage.state).toBe('partial');
    expect(core.snapshot().coverage.failedDirectories).toEqual(expect.arrayContaining(['/B', '/C']));
    core.dispose();
  });

  it('single-flight reconcile merges trailing scopes', async () => {
    const calls = [];
    let releaseFirst;
    const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
    const io = createIo({
      listQuestions: async (directory) => {
        calls.push(directory);
        if (directory === '/A') await firstGate;
        return [];
      },
    });
    const core = createQuestionAutoDelegateCore({ io });
    ready(core);
    const first = core.reconcile({ directories: ['/A'] });
    const second = core.reconcile({ directories: ['/B'] });
    releaseFirst();
    await Promise.all([first, second]);
    expect(calls).toContain('/A');
    expect(calls).toContain('/B');
    core.dispose();
  });
});

describe('question auto-delegate core — settings boot race', () => {
  it('applyEnabled during boot is not overwritten by a late settings read', async () => {
    let releaseRead;
    const readGate = new Promise((resolve) => { releaseRead = resolve; });
    const io = createIo({
      readEnabled: async () => {
        await readGate;
        return true; // stale "on"
      },
      // Keep the pending question present so reconcile does not external-settle it.
      listQuestions: async (directory) => (directory === '/proj-a'
        ? [{ id: 'q1', sessionID: 'ses-1', directory: '/proj-a', questions: [{ question: 'x', header: 'h', options: [] }] }]
        : []),
    });
    const core = createQuestionAutoDelegateCore({ io });
    core.start();
    core.applyEnabled(false);
    expect(core.snapshot().enabled).toBe(false);
    core.processEvent(asked());
    expect(core.snapshot().requests[0].state).toBe('disabled');
    releaseRead();
    await flush(30);
    expect(core.snapshot().enabled).toBe(false);
    expect(core.snapshot().requests[0].state).toBe('disabled');
    expect(io.__clock.pendingCount()).toBe(0);
    expect(io.__posts).toHaveLength(0);
    core.dispose();
  });

  it('settings read failure enters unavailable — no auto timers', async () => {
    const io = createIo({
      readEnabled: async () => null,
    });
    const core = createQuestionAutoDelegateCore({ io });
    core.start();
    await flush(20);
    expect(core.snapshot().enabled).toBe(false);
    expect(core.snapshot().coverage.state).toBe('partial');
    core.processEvent(asked());
    expect(io.__clock.pendingCount()).toBe(0);
    await io.__clock.advance(60_000);
    expect(io.__posts).toHaveLength(0);
    core.dispose();
  });

  it('applyEnabled ignores non-boolean input', () => {
    const io = createIo();
    const core = createQuestionAutoDelegateCore({ io });
    core.applyEnabled(true);
    const before = core.snapshot();
    core.applyEnabled('false');
    core.applyEnabled(null);
    core.applyEnabled(undefined);
    expect(core.snapshot().enabled).toBe(true);
    expect(core.snapshot().revision).toBe(before.revision);
    core.dispose();
  });

  it('settings not ready blocks auto-submit even if counting entry exists', async () => {
    const io = createIo({
      readEnabled: async () => {
        await new Promise(() => {});
        return true;
      },
    });
    const core = createQuestionAutoDelegateCore({ io });
    core.start();
    core.processEvent(asked());
    const result = await core.submit({
      requestID: 'q1',
      sessionID: 'ses-1',
      directory: '/proj-a',
      kind: 'reply',
      authority: 'auto',
      answers: buildAutoDelegateAnswers(1),
    });
    expect(result.outcome).toBe('disabled');
    expect(io.__posts).toHaveLength(0);
    core.dispose();
  });
});

describe('question auto-delegate core — goal blocking helpers', () => {
  it('uncertain blocks session; pauseForSessionTree pauses counting timers', async () => {
    const io = createIo({
      postReply: async () => ({ ok: false, uncertain: true, status: 0, body: null }),
    });
    const core = createQuestionAutoDelegateCore({ io });
    ready(core);
    core.processEvent({
      type: 'session.created',
      properties: { info: { id: 'child', parentID: 'root', directory: '/proj-a' } },
    });
    core.processEvent({
      type: 'session.created',
      properties: { info: { id: 'grand', parentID: 'child', directory: '/proj-a' } },
    });
    core.processEvent(asked('q-g', 'grand', '/proj-a'));
    await io.__clock.advance(30_000);
    expect(core.snapshot().requests[0].state).toBe('uncertain');
    expect(core.isBlockingSession('root')).toBe(true);

    // Fresh counting sibling paused by goal reverse path.
    core.processEvent(asked('q2', 'child', '/proj-a'));
    expect(core.snapshot().requests.find((r) => r.requestID === 'q2').state).toBe('counting');
    await core.pauseForSessionTree('grand', '/proj-a');
    expect(core.snapshot().requests.find((r) => r.requestID === 'q2').state).toBe('paused');
    expect(core.snapshot().requests.find((r) => r.requestID === 'q2').pauseReason).toBe('goal');
    core.dispose();
  });
});

describe('question auto-delegate core — unscoped lineage + notSent', () => {
  it('cold-start unscoped 2-question child binds /worktree via getSession then auto-POSTs once', async () => {
    const io = createIo({
      listDirectories: async () => [],
      listQuestions: async (directory) => {
        // Only unscoped discovers the pending question (no directory on the item).
        if (directory === undefined) {
          return [{
            id: 'q-child',
            sessionID: 'ses-child',
            questions: [
              { question: 'one', header: 'h1', options: [] },
              { question: 'two', header: 'h2', options: [] },
            ],
          }];
        }
        return [];
      },
      getSession: async (sessionID) => ({
        id: sessionID,
        parentID: 'ses-root',
        directory: '/worktree',
      }),
    });
    const core = createQuestionAutoDelegateCore({ io });
    ready(core);
    await core.reconcile();
    await flush(30);

    const entry = core.snapshot().requests.find((r) => r.requestID === 'q-child');
    expect(entry).toBeTruthy();
    expect(entry.directory).toBe('/worktree');
    expect(entry.questionCount).toBe(2);
    expect(entry.deadlineAt).not.toBeNull();
    expect(io.__clock.pendingCount()).toBe(1);

    await io.__clock.advance(30_000);
    expect(io.__posts).toHaveLength(1);
    expect(io.__posts[0].directory).toBe('/worktree');
    expect(io.__posts[0].answers).toEqual([
      [QUESTION_AUTO_DELEGATE_ANSWER],
      [QUESTION_AUTO_DELEGATE_ANSWER],
    ]);
    core.dispose();
  });

  it('notSent:true releases claim for retry; bare status:0 stays uncertain', async () => {
    const io = createIo({
      postReply: async () => ({
        ok: false,
        uncertain: false,
        notSent: true,
        status: 0,
        body: { error: 'dns' },
      }),
    });
    const core = createQuestionAutoDelegateCore({ io });
    ready(core);
    core.processEvent(asked());
    await io.__clock.advance(30_000);
    expect(core.snapshot().requests[0].state).toBe('paused');

    // Human can retry after notSent.
    let calls = 0;
    io.postReply = async (requestID, directory, answers) => {
      calls += 1;
      return { ok: true, uncertain: false, status: 200, body: true, answers };
    };
    const retry = await core.submit({
      requestID: 'q1',
      sessionID: 'ses-1',
      directory: '/proj-a',
      kind: 'reply',
      authority: 'manual',
      answers: [['ok']],
    });
    expect(retry.outcome).toBe('submitted');
    expect(calls).toBe(1);
    core.dispose();

    const io2 = createIo({
      postReply: async () => ({ ok: false, uncertain: false, status: 0, body: null }),
    });
    const core2 = createQuestionAutoDelegateCore({ io: io2 });
    ready(core2);
    core2.processEvent(asked());
    await io2.__clock.advance(30_000);
    expect(core2.snapshot().requests[0].state).toBe('uncertain');
    const locked = await core2.submit({
      requestID: 'q1',
      sessionID: 'ses-1',
      directory: '/proj-a',
      kind: 'reply',
      authority: 'manual',
      answers: [['x']],
    });
    expect(locked.outcome).toBe('claimed');
    core2.dispose();
  });
});
