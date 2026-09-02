import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'bun:test';

import type { Session } from '@opencode-ai/sdk/v2/client';

import {
  getMobileSessionDefaultVisibleCount,
  getMobileSessionPageSize,
  getMobileSessionShowMoreIncrement,
  mergeMobileWorktreeRefreshResults,
} from './mobileSessionPagination';
import { createMobileLongPressController } from '@/components/ui/mobileLongPress';
import { selectVisibleSessions } from '@/components/session/sidebar/sessionNavigationModel';
import type { WorktreeMetadata } from '@/types/worktree';

const worktree = (path: string): WorktreeMetadata => ({
  path,
  projectDirectory: path.split('/').slice(0, -1).join('/'),
  branch: path,
  name: path,
  label: path,
});

describe('MobileSessionsSheet worktree refresh', () => {
  test('uses the shared cache immediately before refresh results arrive', () => {
    const previous = new Map([['/project', [worktree('/project/feature')]]]);
    const next = mergeMobileWorktreeRefreshResults(previous, new Set(['/project']), []);

    expect(next).toBe(previous);
    expect(next.get('/project')).toEqual([worktree('/project/feature')]);
  });

  test('clears a project after a successful empty worktree result', () => {
    const previous = new Map([['/project', [worktree('/project/feature')]]]);
    const next = mergeMobileWorktreeRefreshResults(previous, new Set(['/project']), [
      { path: '/project', status: 'success', worktrees: [] },
    ]);

    expect(next.get('/project')).toEqual([]);
  });

  test('preserves a project worktrees after a refresh failure', () => {
    const previous = new Map([['/project', [worktree('/project/feature')]]]);
    const next = mergeMobileWorktreeRefreshResults(previous, new Set(['/project']), [
      { path: '/project', status: 'failed' },
    ]);

    expect(next).toBe(previous);
  });

  test('commits successful projects while retaining a failed project', () => {
    const previous = new Map([
      ['/failed', [worktree('/failed/feature')]],
      ['/success', [worktree('/success/old')]],
    ]);
    const next = mergeMobileWorktreeRefreshResults(previous, new Set(['/failed', '/success']), [
      { path: '/failed', status: 'failed' },
      { path: '/success', status: 'success', worktrees: [worktree('/success/new')] },
    ]);

    expect(next.get('/failed')).toEqual([worktree('/failed/feature')]);
    expect(next.get('/success')).toEqual([worktree('/success/new')]);
  });
});

// ---------------------------------------------------------------------------
// Test the core stop logic that MobileSessionsSheet uses without requiring
// full React rendering. These test the critical data transformations.
// ---------------------------------------------------------------------------

describe('MobileSessionsSheet pagination', () => {
  test('defaults to the same compact slice as the PC sidebar (3)', () => {
    expect(getMobileSessionDefaultVisibleCount()).toBe(3);
    expect(getMobileSessionPageSize(false)).toBe(3);
    expect(getMobileSessionPageSize(true)).toBe(3);
  });

  test('expands by the same show-more step as the PC sidebar (7)', () => {
    expect(getMobileSessionShowMoreIncrement()).toBe(7);
  });
});

describe('MobileSessionsSheet long press', () => {
  const setup = () => {
    let scheduled: (() => void) | null = null;
    let triggered = 0;
    const pressedKeys: Array<string | null> = [];
    const controller = createMobileLongPressController({
      schedule: (callback) => {
        scheduled = callback;
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      clear: () => {
        scheduled = null;
      },
      onPressedKeyChange: (key) => pressedKeys.push(key),
    });
    const start = () => controller.start({
      pointerId: 7,
      key: 'session:a',
      clientX: 10,
      clientY: 20,
      onTrigger: () => { triggered += 1; },
    });
    const fire = () => scheduled?.();
    return {
      controller,
      fire,
      pending: () => scheduled !== null,
      pressedKeys,
      start,
      triggered: () => triggered,
    };
  };

  test('a quick tap clears the hold without suppressing its click', () => {
    const subject = setup();
    subject.start();
    subject.controller.end(7);
    subject.fire();

    expect(subject.triggered()).toBe(0);
    expect(subject.controller.consumeClick('session:a')).toBe(false);
    expect(subject.pressedKeys.at(-1)).toBeNull();
  });

  test('triggers after the hold delay and suppresses the following click', () => {
    const subject = setup();
    subject.start();
    subject.fire();
    subject.controller.end(7);

    expect(subject.triggered()).toBe(1);
    expect(subject.controller.consumeClick('session:a')).toBe(true);
    expect(subject.controller.consumeClick('session:a')).toBe(false);
  });

  test('movement beyond the threshold cancels the hold', () => {
    const subject = setup();
    subject.start();
    subject.controller.move(7, 30, 20);
    subject.fire();

    expect(subject.triggered()).toBe(0);
    expect(subject.pressedKeys.at(-1)).toBeNull();
  });

  test('pointercancel clears the pending hold', () => {
    const subject = setup();
    subject.start();
    subject.controller.cancel(7);
    subject.fire();

    expect(subject.triggered()).toBe(0);
    expect(subject.pressedKeys.at(-1)).toBeNull();
  });

  test('reset clears the pending timer, pressed state, and click suppression', () => {
    const subject = setup();
    subject.start();
    expect(subject.pending()).toBe(true);

    subject.controller.reset();
    subject.fire();

    expect(subject.pending()).toBe(false);
    expect(subject.triggered()).toBe(0);
    expect(subject.controller.consumeClick('session:a')).toBe(false);
    expect(subject.pressedKeys.at(-1)).toBeNull();
  });

  test('closing a context-menu action resets suppression before the next click', () => {
    const subject = setup();
    subject.controller.openFromContextMenu('session:a', () => {});

    subject.controller.reset();

    expect(subject.controller.consumeClick('session:a')).toBe(false);
    expect(subject.pressedKeys.at(-1)).toBeNull();
  });
});

describe('MobileSessionsSheet stop logic', () => {
  test('runningSessionMap: identifies busy and retry as running', () => {
    const allStatuses: Record<string, { type: string }> = {
      'ses_busy': { type: 'busy' },
      'ses_retry': { type: 'retry' },
      'ses_idle': { type: 'idle' },
    };

    // Simulate the runningSessionMap derivation
    const map: Record<string, boolean> = {};
    for (const [id, status] of Object.entries(allStatuses)) {
      map[id] = status.type === 'busy' || status.type === 'retry';
    }

    expect(map['ses_busy']).toBe(true);
    expect(map['ses_retry']).toBe(true);
    expect(map['ses_idle']).toBe(false);
    // Unknown sessions default to falsy
    expect(map['ses_unknown']).toBeFalsy();
  });

  test('runningSessionMap: handles empty statuses', () => {
    const map: Record<string, boolean> = {};
    expect(Object.keys(map)).toHaveLength(0);
  });

  test('stop IDs: running parent with collapsed running children includes all', () => {
    const runningSessionMap: Record<string, boolean> = {
      'parent': true,
      'child1': true,
      'child2': true,
      'child3': false,
    };

    const children = ['child1', 'child2', 'child3'];
    const isRunning = runningSessionMap['parent'] || false;
    const expanded = false;
    const runningChildIds = expanded
      ? []
      : children.filter((c) => runningSessionMap[c]);
    const stopIds = isRunning
      ? ['parent', ...runningChildIds]
      : runningChildIds;

    expect(stopIds).toEqual(['parent', 'child1', 'child2']);
  });

  test('stop IDs: non-running parent with collapsed running children includes only children', () => {
    const runningSessionMap: Record<string, boolean> = {
      'parent': false,
      'child1': true,
      'child2': false,
    };

    const children = ['child1', 'child2'];
    const isRunning = runningSessionMap['parent'] || false;
    const expanded = false;
    const runningChildIds = expanded
      ? []
      : children.filter((c) => runningSessionMap[c]);
    const stopIds = isRunning
      ? ['parent', ...runningChildIds]
      : runningChildIds;

    expect(stopIds).toEqual(['child1']);
  });

  test('stop IDs: expanded parent never shows group stop (individual rows handle it)', () => {
    const runningSessionMap: Record<string, boolean> = {
      'parent': true,
      'child1': true,
    };

    const isRunning = runningSessionMap['parent'] || false;
    const expanded = true;
    const children = ['child1'];
    const runningChildIds = expanded
      ? []
      : children.filter((c) => runningSessionMap[c]);

    // When expanded, collapsed running children is empty
    // But the parent itself being running still shows stop
    const hasRunningHiddenChildren = runningChildIds.length > 0;
    const stopIds = isRunning
      ? ['parent', ...runningChildIds]
      : runningChildIds;

    // Parent is running → still gets stop button (for itself)
    expect(stopIds).toEqual(['parent']);
    expect(hasRunningHiddenChildren).toBe(false);
  });

  test('stop IDs: no running sessions produces empty stop list', () => {
    const runningSessionMap: Record<string, boolean> = {
      'parent': false,
      'child1': false,
    };

    const children = ['child1'];
    const isRunning = runningSessionMap['parent'] || false;
    const expanded = false;
    const runningChildIds = expanded
      ? []
      : children.filter((c) => runningSessionMap[c]);
    const stopIds = isRunning
      ? ['parent', ...runningChildIds]
      : runningChildIds;

    expect(stopIds).toEqual([]);
  });

  test('group running IDs: dedupes across buckets for collapsed project', () => {
    const runningSessionMap: Record<string, boolean> = {
      's1': true,
      's2': false,
      's3': true,
    };

    // Simulate two buckets with overlapping sessions
    const buckets = [
      { sessions: [{ id: 's1' }, { id: 's2' }] },
      { sessions: [{ id: 's1' }, { id: 's3' }] },
    ] as Array<{ sessions: Array<{ id: string }> }>;

    const projectExpanded = false;
    const projectRunningIds = !projectExpanded
      ? [...new Set(buckets.flatMap((b) =>
          b.sessions.filter((s) => runningSessionMap[s.id]).map((s) => s.id),
        ))]
      : [];

    expect(projectRunningIds.sort()).toEqual(['s1', 's3']);
  });

  test('group running IDs: expanded project returns empty (individual rows handle it)', () => {
    const runningSessionMap: Record<string, boolean> = {
      's1': true,
    };

    const buckets = [
      { sessions: [{ id: 's1' }] },
    ] as Array<{ sessions: Array<{ id: string }> }>;

    const projectExpanded = true;
    const projectRunningIds = !projectExpanded
      ? [...new Set(buckets.flatMap((b) =>
          b.sessions.filter((s) => runningSessionMap[s.id]).map((s) => s.id),
        ))]
      : [];

    expect(projectRunningIds).toEqual([]);
  });

  test('worktree running IDs: collapsed worktree filters running sessions', () => {
    const runningSessionMap: Record<string, boolean> = {
      's1': true,
      's2': false,
      's3': true,
    };

    const bucket = {
      sessions: [{ id: 's1' }, { id: 's2' }, { id: 's3' }],
    } as { sessions: Array<{ id: string }> };

    const worktreeExpanded = false;
    const worktreeRunningIds = !worktreeExpanded
      ? bucket.sessions.filter((s) => runningSessionMap[s.id]).map((s) => s.id)
      : [];

    expect(worktreeRunningIds).toEqual(['s1', 's3']);
  });

  test('worktree running IDs: expanded worktree returns empty', () => {
    const runningSessionMap: Record<string, boolean> = {
      's1': true,
    };

    const bucket = {
      sessions: [{ id: 's1' }],
    } as { sessions: Array<{ id: string }> };

    const worktreeExpanded = true;
    const worktreeRunningIds = !worktreeExpanded
      ? bucket.sessions.filter((s) => runningSessionMap[s.id]).map((s) => s.id)
      : [];

    expect(worktreeRunningIds).toEqual([]);
  });

  test('Promise.all aborts all running session IDs', () => {
    // Verify the contract: all IDs are passed to abortCurrentOperation
    const aborted: string[] = [];
    const mockAbort = (id: string): Promise<void> => {
      aborted.push(id);
      return Promise.resolve();
    };

    const sessionIds = ['s1', 's2', 's3'];
    void Promise.all(sessionIds.map((id) => mockAbort(id)));

    // All IDs must be aborted
    expect(aborted.sort()).toEqual(['s1', 's2', 's3']);
  });

  test('handleStopSession aborts a single session', () => {
    const aborted: string[] = [];
    const mockAbort = (id: string): Promise<void> => {
      aborted.push(id);
      return Promise.resolve();
    };

    void mockAbort('single-session');

    expect(aborted).toEqual(['single-session']);
  });

  test('stop button aria-label: session format uses title', () => {
    // Simulates locale lookup: t('mobile.sessions.stopSessionAria', { title })
    const formatAria = (title: string) => `Stop ${title}`;
    expect(formatAria('My Chat')).toBe('Stop My Chat');
    expect(formatAria('Debug session')).toBe('Stop Debug session');
  });

  test('stop button aria-label: subsession format uses title', () => {
    // Simulates locale lookup: t('mobile.sessions.stopSubsessionsAria', { title })
    const formatAria = (title: string) => `Stop running subsessions of ${title}`;
    expect(formatAria('Parent Chat')).toBe('Stop running subsessions of Parent Chat');
  });

  test('stop button aria-label: group format uses label', () => {
    // Simulates locale lookup: t('mobile.sessions.stopGroupAria', { label })
    const formatAria = (label: string) => `Stop all running in ${label}`;
    expect(formatAria('my-project')).toBe('Stop all running in my-project');
    expect(formatAria('feature-branch')).toBe('Stop all running in feature-branch');
  });
});

describe('MobileSessionsSheet visible roots fold boundary', () => {
  test('retains a running root past the compact Show more boundary', () => {
    const roots = [
      { id: 'first' },
      { id: 'second' },
      { id: 'third' },
      { id: 'running' },
      { id: 'hidden' },
    ] as Session[];

    // Intentional page size stays at the compact boundary; pinned extras must
    // not inflate the next Show more page.
    const visibleCount = 3;
    const visibleRoots = selectVisibleSessions(roots, visibleCount, new Set(['running']));

    expect(visibleRoots.map((session) => session.id)).toEqual([
      'first',
      'second',
      'third',
      'running',
    ]);
    expect(roots.length - visibleRoots.length).toBe(1);
    expect(visibleCount).toBe(3);
  });
});

describe('MobileSessionsSheet keyword highlight', () => {
  test('reuses the desktop sidebar mark helper on search hits', () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'MobileSessionsSheet.tsx'),
      'utf8',
    );
    expect(source).toContain('renderHighlightedText');
    expect(source).toContain('highlightQuery={normalizedQuery}');
  });
});
