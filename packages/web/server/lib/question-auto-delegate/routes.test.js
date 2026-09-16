import express from 'express';
import { describe, expect, it, vi } from 'vitest';
import {
  QUESTION_AUTO_DELEGATE_ANSWER,
  QUESTION_SUBMISSION_CLAIMED_CODE,
  createQuestionAutoDelegateCore,
} from './core.js';
import { registerQuestionAutoDelegateRoutes } from './routes.js';

const listen = (app) => new Promise((resolve) => {
  const server = app.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    resolve({
      server,
      base: `http://127.0.0.1:${port}`,
      close: () => new Promise((r) => server.close(() => r())),
    });
  });
});

const createFakeTimers = () => {
  const timers = [];
  let now = 1_000_000;
  let nextId = 1;
  return {
    now: () => now,
    advance: async (ms) => {
      now += ms;
      const due = timers.filter((t) => !t.cleared && t.fireAt <= now);
      for (const timer of due) {
        timer.cleared = true;
        timer.callback();
        await Promise.resolve();
        await Promise.resolve();
      }
    },
    createTimer: (callback, delayMs) => {
      const timer = { id: nextId++, fireAt: now + delayMs, callback, cleared: false };
      timers.push(timer);
      return { clear: () => { timer.cleared = true; } };
    },
  };
};

describe('question auto-delegate HTTP routes — claim arbitration', () => {
  it('timer and manual POST share one upstream mutation (409 loser)', async () => {
    const clock = createFakeTimers();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let upstreamPosts = 0;
    const posts = [];

    const core = createQuestionAutoDelegateCore({
      delayMs: 30_000,
      io: {
        now: clock.now,
        createTimer: clock.createTimer,
        createEpoch: () => 'epoch-http',
        readEnabled: async () => true,
        listDirectories: async () => ['/repo'],
        listQuestions: async () => [],
        getSession: async (id, directory) => ({ id, parentID: null, directory: directory || '/repo' }),
        postReply: async (requestID, directory, answers) => {
          upstreamPosts += 1;
          posts.push({ requestID, directory, answers });
          await gate;
          return { ok: true, uncertain: false, status: 200, body: true };
        },
        postReject: async () => ({ ok: true, uncertain: false, status: 200, body: true }),
      },
    });
    core.applyEnabled(true);
    core.processEvent({
      type: 'question.asked',
      properties: {
        id: 'q-race',
        sessionID: 'ses-1',
        directory: '/repo',
        questions: [{ question: '?', header: 'h', options: [{ label: 'a', description: '' }] }],
      },
    });

    const runtime = {
      snapshot: () => core.snapshot(),
      pause: (input) => core.pause(input),
      delegate: (input) => core.delegate(input),
      submit: (input) => core.submit(input),
    };

    const app = express();
    app.use(express.json());
    registerQuestionAutoDelegateRoutes(app, runtime);
    const { base, close } = await listen(app);

    try {
      // Arm timer fire (auto claim starts and waits on gate).
      const timerPromise = (async () => {
        await clock.advance(30_000);
      })();

      // Give auto claim a tick to start.
      await Promise.resolve();
      await Promise.resolve();

      const manualResponse = await fetch(`${base}/api/question/q-race/reply?directory=${encodeURIComponent('/repo')}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answers: [['human']] }),
      });
      expect(manualResponse.status).toBe(409);
      const manualBody = await manualResponse.json();
      expect(manualBody.code).toBe(QUESTION_SUBMISSION_CLAIMED_CODE);

      release();
      await timerPromise;
      // Drain auto submit.
      for (let i = 0; i < 20; i += 1) await Promise.resolve();

      expect(upstreamPosts).toBe(1);
      expect(posts[0].answers).toEqual([[QUESTION_AUTO_DELEGATE_ANSWER]]);
      expect(core.snapshot().requests[0].state).toBe('settled');
      expect(core.snapshot().requests[0].submittedBy).toBe('auto');
    } finally {
      core.dispose();
      await close();
    }
  });

  it('manual answers:[] are accepted and forwarded without auto text', async () => {
    const posts = [];
    const core = createQuestionAutoDelegateCore({
      io: {
        now: () => 1,
        createTimer: () => ({ clear() {} }),
        createEpoch: () => 'e',
        readEnabled: async () => true,
        listDirectories: async () => ['/repo'],
        listQuestions: async () => [],
        getSession: async (id) => ({ id, parentID: null, directory: '/repo' }),
        postReply: async (requestID, directory, answers) => {
          posts.push(answers);
          return { ok: true, uncertain: false, status: 200, body: true };
        },
        postReject: async () => ({ ok: true, uncertain: false, status: 200, body: true }),
      },
    });
    core.applyEnabled(true);
    core.processEvent({
      type: 'question.asked',
      properties: {
        id: 'q-empty',
        sessionID: 'ses-1',
        directory: '/repo',
        questions: [{ question: '?', header: 'h', options: [] }],
      },
    });

    const app = express();
    app.use(express.json());
    registerQuestionAutoDelegateRoutes(app, {
      snapshot: () => core.snapshot(),
      pause: (i) => core.pause(i),
      delegate: (i) => core.delegate(i),
      submit: (i) => core.submit(i),
    });
    const { base, close } = await listen(app);
    try {
      const response = await fetch(`${base}/api/question/q-empty/reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answers: [], directory: '/repo' }),
      });
      expect(response.status).toBe(200);
      expect(posts).toEqual([[]]);
    } finally {
      core.dispose();
      await close();
    }
  });
});
