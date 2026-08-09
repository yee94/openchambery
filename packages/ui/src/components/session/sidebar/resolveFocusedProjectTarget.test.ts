import { describe, expect, test } from 'bun:test';
import type { SessionNavigationTarget } from '@/sync/session-navigation';
import { resolveFocusedProjectTarget } from './resolveFocusedProjectTarget';

const target = (
  sessionId: string,
  projectId: string,
  extra: Partial<SessionNavigationTarget> = {},
): SessionNavigationTarget => ({
  scope: 'project',
  sessionId,
  projectId,
  directory: `/${projectId}`,
  groupKey: `${projectId}:root`,
  visibleIndex: 0,
  ...extra,
});

describe('resolveFocusedProjectTarget', () => {
  const targets = [
    target('ses_a', 'proj_1', { visibleIndex: 0 }),
    target('ses_b', 'proj_1', { visibleIndex: 5 }),
    target('ses_c', 'proj_2', { visibleIndex: 1 }),
  ];

  test('returns null when focus missing', () => {
    expect(resolveFocusedProjectTarget(null, targets)).toBeNull();
  });

  test('exact projectId match wins', () => {
    expect(
      resolveFocusedProjectTarget(
        { scope: 'project', sessionId: 'ses_c', projectId: 'proj_2' },
        targets,
      )?.projectId,
    ).toBe('proj_2');
  });

  test('deep-link focus with null projectId falls back to sessionId', () => {
    const hit = resolveFocusedProjectTarget(
      { scope: 'project', sessionId: 'ses_b', projectId: null },
      targets,
    );
    expect(hit?.sessionId).toBe('ses_b');
    expect(hit?.visibleIndex).toBe(5);
  });

  test('meta projectId preferred when focus.projectId is null', () => {
    const hit = resolveFocusedProjectTarget(
      { scope: 'project', sessionId: 'ses_c', projectId: null },
      targets,
      'proj_2',
    );
    expect(hit?.projectId).toBe('proj_2');
  });

  test('unloaded session id returns null (no invent)', () => {
    expect(
      resolveFocusedProjectTarget(
        { scope: 'project', sessionId: 'ses_missing', projectId: null },
        targets,
      ),
    ).toBeNull();
  });
});
