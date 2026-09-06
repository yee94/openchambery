import { describe, expect, it } from 'vitest';

import { setLocale } from '@/lib/i18n';
import { formatCompactRunDuration, formatSchedule, resolveRunDurationMs } from '@/lib/scheduledFormat';
import {
  buildScheduledTaskCards,
  filterScheduledTasks,
  toScheduledTaskCardModel,
} from '@/lib/scheduledModel';
import type { GlobalScheduledTask, ScheduledTask, ScheduledTaskRun } from '@/lib/scheduledTasksApi';

setLocale('zh-CN');

const task = (over: Partial<ScheduledTask> = {}): ScheduledTask => ({
  id: 't1',
  name: '每日AI会话日报',
  enabled: true,
  schedule: { kind: 'daily', times: ['23:30'] },
  execution: { prompt: 'x', providerID: 'p', modelID: 'm' },
  state: {
    createdAt: 1,
    updatedAt: 2,
    nextRunAt: Date.now() + 23 * 3600_000 + 31 * 60_000,
    lastStatus: 'success',
  },
  ...over,
});

const entry = (over: Partial<ScheduledTask> = {}, projectId = 'p1'): GlobalScheduledTask => ({
  projectId,
  task: task(over),
});

describe('formatSchedule', () => {
  it('formats daily / weekly / cron without name-only fallback', () => {
    expect(formatSchedule(task())).toContain('23:30');
    expect(
      formatSchedule(
        task({
          schedule: { kind: 'weekly', times: ['07:00'], weekdays: [6] },
        }),
      ),
    ).toMatch(/07:00/);
    expect(
      formatSchedule(
        task({
          schedule: { kind: 'cron', cron: '0 9 1 * *' },
        }),
      ),
    ).toContain('0 9 1 * *');
  });
});

describe('card model Cap parity', () => {
  it('never emits name-only cards — always schedule · next-run', () => {
    const card = toScheduledTaskCardModel(entry(), Date.now());
    expect(card.name).toBe('每日AI会话日报');
    expect(card.scheduleLabel.length).toBeGreaterThan(0);
    expect(card.nextRunLabel.length).toBeGreaterThan(0);
    expect(card.metaLine).toContain('·');
    expect(card.metaLine).toContain(card.scheduleLabel);
    expect(card.status).toBe('success');
  });

  it('filters 全部/已启用/已暂停', () => {
    const tasks = [
      entry({ id: 'a', enabled: true, name: 'On' }),
      entry({ id: 'b', enabled: false, name: 'Off' }),
    ];
    expect(filterScheduledTasks(tasks, 'all')).toHaveLength(2);
    expect(filterScheduledTasks(tasks, 'active').map((e) => e.task.id)).toEqual(['a']);
    expect(filterScheduledTasks(tasks, 'paused').map((e) => e.task.id)).toEqual(['b']);
  });

  it('buildScheduledTaskCards sorts enabled first', () => {
    const cards = buildScheduledTaskCards(
      [
        entry({ id: 'paused', enabled: false, name: 'Z' }),
        entry({ id: 'active', enabled: true, name: 'A' }),
      ],
      'all',
    );
    expect(cards[0]?.taskId).toBe('active');
    expect(cards.every((c) => c.metaLine.includes('·'))).toBe(true);
  });
});

describe('history duration helpers', () => {
  it('prefers live elapsed while running', () => {
    const run: ScheduledTaskRun = {
      id: 'r1',
      projectId: 'p1',
      taskId: 't1',
      taskName: 'Daily',
      trigger: 'manual',
      status: 'running',
      sessionId: 's1',
      directory: '/code',
      error: null,
      startedAt: 1_000,
      finishedAt: null,
      durationMs: null,
    };
    expect(resolveRunDurationMs(run, 6_000)).toBe(5_000);
    expect(formatCompactRunDuration(125_000)).toBe('2m 5s');
  });
});
