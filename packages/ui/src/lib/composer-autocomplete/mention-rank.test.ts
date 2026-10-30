import { describe, expect, test } from 'vitest';
import { buildMentionRows } from './rows';
import { getVisibleSessionMentionCandidates } from '@/components/chat/fileMentionAutocompleteState';

const build = (options: Partial<Parameters<typeof buildMentionRows>[0]> = {}) => buildMentionRows({
  agents: [], sessions: [], skills: [], recentFiles: [], pathHits: [], untitledSession: 'Untitled',
  searchQuery: 'login', ...options,
});

describe('mixed session mention relevance and recall', () => {
  test('interleaves chat titles with skills and agents instead of appending chats', () => {
    const rows = build({
      agents: [{ name: 'login-helper' }],
      skills: [{ name: 'review', scope: 'user', description: 'login' }],
      sessions: [{ id: 'ses_exact', title: 'login' }, { id: 'ses_contains', title: 'Fix login' }],
    });
    expect(rows.map(({ id }) => id)).toEqual([
      'session:ses_exact', 'agent:login-helper', 'session:ses_contains', 'skill:review-user',
    ]);
  });

  test.each([0, 2, 5, 300])('retains all %i matching chats even when other matches fill ten slots', (count) => {
    const sessions = Array.from({ length: count }, (_, index) => ({ id: `ses_${index}`, title: 'Fix login' }));
    const rows = build({
      sessions,
      skills: Array.from({ length: 300 }, (_, index) => ({ name: `login-${index}`, scope: 'user' })),
      pathHits: [{ path: '/repo/login.ts', name: 'login.ts' }],
    });
    expect(rows.filter(({ id }) => id.startsWith('session:')).map(({ id }) => id))
      .toEqual(sessions.map(({ id }) => `session:${id}`));
    expect(rows.filter(({ id }) => !id.startsWith('session:'))).toHaveLength(10);
    expect(new Set(rows.map(({ id }) => id)).size).toBe(rows.length);
  });

  test('keeps matching paths without charging chat rows against their budget', () => {
    const rows = build({
      sessions: Array.from({ length: 15 }, (_, index) => ({ id: `ses_${index}`, title: 'login' })),
      pathHits: [{ path: '/repo/login.ts', name: 'login.ts' }],
    });
    expect(rows).toHaveLength(16);
    expect(rows.at(-1)?.id).toBe('file:/repo/login.ts');
  });

  test('retains recency ordering for tied duplicate titles through mixed ranking', () => {
    const sessions = getVisibleSessionMentionCandidates({
      sessions: [
        { id: 'ses_old', title: 'login', time: { created: 1, updated: 1 } },
        { id: 'ses_new', title: 'login', time: { created: 2, updated: 2 } },
      ], currentSessionId: null, searchQuery: 'login',
    });
    expect(build({ sessions }).map(({ id }) => id)).toEqual(['session:ses_new', 'session:ses_old']);
  });

  test('rejects unrelated chats and retains literal ID search without fuzzy ID noise', () => {
    const sessions = [{ id: 'ses_login', title: 'Other work' }, { id: 'ses_log_index', title: 'Unrelated' }];
    expect(build({ sessions }).map(({ id }) => id)).toEqual(['session:ses_login']);
    expect(build({ sessions, searchQuery: 'zzzzzz' })).toEqual([]);
  });

  test('empty query preserves the existing type order and five recent chat rows', () => {
    const sessions = getVisibleSessionMentionCandidates({
      sessions: Array.from({ length: 20 }, (_, index) => ({
        id: `ses_${index}`, title: 'Same', time: { created: index, updated: index },
      })), currentSessionId: null, searchQuery: '',
    });
    const rows = build({ searchQuery: '', sessions, agents: [{ name: 'general' }],
      pathHits: [{ path: '/repo/login.ts', name: 'login.ts' }],
    });
    expect(rows.map(({ id }) => id)).toEqual([
      'agent:general', 'file:/repo/login.ts',
      'session:ses_19', 'session:ses_18', 'session:ses_17', 'session:ses_16', 'session:ses_15',
    ]);
  });
});
