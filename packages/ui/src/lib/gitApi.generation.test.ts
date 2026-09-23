import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  runtimeFetch: vi.fn(),
  generateSessionAside: vi.fn(),
  renderMagicPrompt: vi.fn(async (id: string, vars?: Record<string, string>) => {
    if (id.includes('visible')) return `visible:${id}`;
    if (vars?.selected_files) return `instructions\n${vars.selected_files}`;
    if (vars?.base_branch) {
      return [
        'pr-instructions',
        `base=${vars.base_branch}`,
        `head=${vars.head_branch}`,
        vars.commits,
        vars.changed_files,
        vars.additional_context_block ?? '',
      ].join('\n');
    }
    return `instructions:${id}`;
  }),
  getGitDiff: vi.fn(async (_directory: string, options: { path: string; staged?: boolean }) => ({
    diff: options.staged ? `diff --git a/${options.path}` : '',
  })),
  getGitLog: vi.fn(async () => ({
    all: [
      { hash: 'abc1234deadbeef', message: 'feat: one', body: 'body line' },
      { hash: 'def5678cafebabe', message: 'fix: two', body: '' },
    ],
  })),
  getCommitFiles: vi.fn(async (_directory: string, hash: string) => ({
    files: [{ path: hash.startsWith('abc') ? 'src/a.ts' : 'src/b.ts' }],
  })),
  runtimeGeneration: 1,
  runtimeTransport: 'transport-a',
  currentSessionId: 'ses_active' as string | null,
  newSessionDraftOpen: false,
  materializeOpenDraftSession: vi.fn(),
  currentProviderId: 'openai' as string | null,
  currentModelId: 'gpt-test' as string | null,
}));

vi.mock('./runtime-fetch', () => ({ runtimeFetch: mocks.runtimeFetch }));
vi.mock('./opencode/client', () => ({
  opencodeClient: {
    generateSessionAside: mocks.generateSessionAside,
    getSdkClient: vi.fn(() => {
      throw new Error('getSdkClient must not be used by generation fallback');
    }),
    withDirectory: vi.fn(async () => {
      throw new Error('withDirectory must not be used by generation fallback');
    }),
  },
}));
vi.mock('./magicPrompts', () => ({ renderMagicPrompt: mocks.renderMagicPrompt }));
vi.mock('./gitApiHttp', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./gitApiHttp')>();
  return {
    ...actual,
    getGitDiff: mocks.getGitDiff,
    getGitLog: mocks.getGitLog,
    getCommitFiles: mocks.getCommitFiles,
  };
});
vi.mock('@/lib/runtime-switch', () => ({
  getRuntimeGeneration: () => mocks.runtimeGeneration,
  getRuntimeTransportIdentity: () => mocks.runtimeTransport,
}));
vi.mock('@/sync/session-ui-store', () => ({
  useSessionUIStore: {
    getState: () => ({
      currentSessionId: mocks.currentSessionId,
      newSessionDraft: { open: mocks.newSessionDraftOpen },
      getLastUserChoice: () => null,
    }),
  },
  materializeOpenDraftSession: mocks.materializeOpenDraftSession,
}));
vi.mock('@/stores/useConfigStore', () => ({
  useConfigStore: {
    getState: () => ({
      currentProviderId: mocks.currentProviderId,
      currentModelId: mocks.currentModelId,
      currentAgentName: null,
      currentVariant: null,
    }),
  },
}));
vi.mock('@/contexts/runtimeAPIRegistry', () => ({
  getRegisteredRuntimeAPIs: () => null,
}));

import {
  COMMIT_DIFF_FILE_LIMIT,
  collectSelectedFileDiffs,
  generateCommitMessage,
  generatePullRequestDescription,
} from './gitApi';

const commitJson = '{"subject":"feat: from session","highlights":["a"]}';
const prJson = '{"title":"PR title","body":"## Summary\\nDone"}';

beforeEach(() => {
  mocks.runtimeFetch.mockReset();
  mocks.generateSessionAside.mockReset();
  mocks.getGitDiff.mockClear();
  mocks.getGitLog.mockClear();
  mocks.getCommitFiles.mockClear();
  mocks.materializeOpenDraftSession.mockReset();
  mocks.runtimeGeneration = 1;
  mocks.runtimeTransport = 'transport-a';
  mocks.currentSessionId = 'ses_active';
  mocks.newSessionDraftOpen = false;
  mocks.currentProviderId = 'openai';
  mocks.currentModelId = 'gpt-test';
  mocks.generateSessionAside.mockResolvedValue({ text: commitJson });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('collectSelectedFileDiffs budget', () => {
  test('labels partial coverage when file budget omits selected paths', async () => {
    const files = Array.from({ length: COMMIT_DIFF_FILE_LIMIT + 3 }, (_, i) => `f${i}.ts`);
    const budget = await collectSelectedFileDiffs('/repo', files);
    expect(budget.selectedFileCount).toBe(files.length);
    expect(budget.includedFileCount).toBe(COMMIT_DIFF_FILE_LIMIT);
    expect(budget.omittedFileCount).toBe(3);
    expect(budget.budgetNote).toContain('omittedFiles=3');
    expect(budget.budgetNote).toMatch(/partial|omitted/i);
    expect(budget.text).toContain('more selected files omitted by file budget');
    expect(budget.text).not.toMatch(/full selected-set dump without budget/i);
  });
});

describe('generateCommitMessage routing', () => {
  test('small-model success keeps session.generate unused and includes budgeted diffs', async () => {
    mocks.runtimeFetch.mockResolvedValue(
      new Response(JSON.stringify({ text: commitJson }), { status: 200 }),
    );

    const result = await generateCommitMessage('/repo', ['a.ts', 'b.ts']);
    expect(result.message.subject).toBe('feat: from session');
    expect(mocks.generateSessionAside).not.toHaveBeenCalled();
    expect(mocks.runtimeFetch).toHaveBeenCalledTimes(1);
    const [, init] = mocks.runtimeFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as { prompt: string; purpose: string };
    expect(body.purpose).toBe('commit');
    expect(body.prompt).toContain('Diff budget:');
    expect(body.prompt).toContain('- a.ts');
    expect(body.prompt).toContain('diff --git a/a.ts');
  });

  test('404 falls back to session.generate with diffs, budget note, and captured session', async () => {
    mocks.runtimeFetch.mockResolvedValue(new Response('not found', { status: 404 }));
    mocks.generateSessionAside.mockResolvedValue({ text: commitJson });

    const result = await generateCommitMessage('/workspace', ['src/x.ts']);
    expect(result.message).toEqual({ subject: 'feat: from session', highlights: ['a'] });
    expect(mocks.generateSessionAside).toHaveBeenCalledTimes(1);
    const call = mocks.generateSessionAside.mock.calls[0]?.[0] as {
      sessionId: string;
      directory: string;
      prompt: string;
      signal?: AbortSignal;
    };
    expect(call.sessionId).toBe('ses_active');
    expect(call.directory).toBe('/workspace');
    expect(call.signal).toBeInstanceOf(AbortSignal);
    expect(call.prompt).toContain('Do not call any tools');
    expect(call.prompt).toContain('session.generate session contract');
    expect(call.prompt).toContain('Diff budget:');
    expect(call.prompt).toContain('diff --git a/src/x.ts');
    expect(call.prompt).toContain('- src/x.ts');
  });

  test('missing session fails without steer and without inventing success', async () => {
    mocks.runtimeFetch.mockResolvedValue(new Response('not found', { status: 404 }));
    mocks.currentSessionId = null;
    mocks.newSessionDraftOpen = false;

    await expect(generateCommitMessage('/repo', ['a.ts'])).rejects.toThrow(/active session/i);
    expect(mocks.generateSessionAside).not.toHaveBeenCalled();
  });

  test('invalid structured output from session.generate is an error', async () => {
    mocks.runtimeFetch.mockResolvedValue(new Response('not found', { status: 404 }));
    mocks.generateSessionAside.mockResolvedValue({ text: 'not json at all' });

    await expect(generateCommitMessage('/repo', ['a.ts'])).rejects.toThrow(/invalid structured output/i);
  });

  test('caller abort cancels session.generate and does not return a result', async () => {
    mocks.runtimeFetch.mockResolvedValue(new Response('not found', { status: 404 }));
    const controller = new AbortController();
    mocks.generateSessionAside.mockImplementation(async (input: { signal?: AbortSignal }) => {
      await new Promise<void>((_, reject) => {
        input.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
      return { text: commitJson };
    });

    const pending = generateCommitMessage('/repo', ['a.ts'], { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: expect.stringMatching(/Abort|Timeout/) });
  });

  test('runtime switch after capture rejects late session.generate results', async () => {
    mocks.runtimeFetch.mockResolvedValue(new Response('not found', { status: 404 }));
    mocks.generateSessionAside.mockImplementation(async () => {
      mocks.runtimeGeneration += 1;
      return { text: commitJson };
    });

    await expect(generateCommitMessage('/repo', ['a.ts'])).rejects.toThrow(/Runtime changed/i);
  });
});

describe('generatePullRequestDescription routing', () => {
  test('small-model success does not call session.generate', async () => {
    mocks.runtimeFetch.mockResolvedValue(
      new Response(JSON.stringify({ text: prJson }), { status: 200 }),
    );

    const result = await generatePullRequestDescription('/repo', {
      base: 'main',
      head: 'feature',
      context: 'ship it',
    });
    expect(result.title).toBe('PR title');
    expect(result.body).toContain('Summary');
    expect(mocks.generateSessionAside).not.toHaveBeenCalled();
    const body = JSON.parse(String((mocks.runtimeFetch.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body.prompt).toContain('base=main');
    expect(body.prompt).toContain('ship it');
    expect(body.prompt).toContain('feat: one');
  });

  test('404 falls back to session.generate keeping commit range and context', async () => {
    mocks.runtimeFetch.mockResolvedValue(new Response('not found', { status: 404 }));
    mocks.generateSessionAside.mockResolvedValue({ text: prJson });

    const result = await generatePullRequestDescription('/repo', {
      base: 'main',
      head: 'feature',
      context: 'extra notes',
    });
    expect(result).toEqual({ title: 'PR title', body: '## Summary\nDone' });
    const call = mocks.generateSessionAside.mock.calls[0]?.[0] as {
      sessionId: string;
      prompt: string;
      signal?: AbortSignal;
    };
    expect(call.sessionId).toBe('ses_active');
    expect(call.signal).toBeInstanceOf(AbortSignal);
    expect(call.prompt).toContain('base=main');
    expect(call.prompt).toContain('head=feature');
    expect(call.prompt).toContain('feat: one');
    expect(call.prompt).toContain('extra notes');
    expect(call.prompt).toContain('src/a.ts');
    expect(call.prompt).not.toContain("delivery: 'steer'");
  });
});

describe('generation fallback contract (no steer idle path)', () => {
  test('source no longer steers or waits idle for assistant extraction', async () => {
    const { readFile } = await import('node:fs/promises');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const source = await readFile(
      join(dirname(fileURLToPath(import.meta.url)), 'gitApi.ts'),
      'utf8',
    );
    expect(source).toContain('generateSessionAside');
    expect(source).toContain('session.generate');
    expect(source).not.toContain("delivery: 'steer'");
    expect(source).not.toContain('session.wait');
    expect(source).not.toContain('message.list');
    expect(source).not.toContain('extractAssistantTextFromMessages');
  });
});
