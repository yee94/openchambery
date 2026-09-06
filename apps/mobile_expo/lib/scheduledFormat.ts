import { t } from '@/lib/i18n';
import type { ScheduledTask, ScheduledTaskRun, ScheduledTaskStatus } from '@/lib/scheduledTasksApi';

export const scheduleTimes = (task: ScheduledTask): string[] => {
  const raw = Array.isArray(task.schedule.times)
    ? task.schedule.times
    : task.schedule.time
      ? [task.schedule.time]
      : [];
  const valid = raw.filter(
    (value) => typeof value === 'string' && /^([01]\d|2[0-3]):([0-5]\d)$/.test(value),
  );
  return Array.from(new Set(valid)).sort((a, b) => a.localeCompare(b));
};

const formatWeekday = (value: number): string => {
  const keys = [
    'sessions.scheduledTasks.dialog.schedule.weekdayShort.sun',
    'sessions.scheduledTasks.dialog.schedule.weekdayShort.mon',
    'sessions.scheduledTasks.dialog.schedule.weekdayShort.tue',
    'sessions.scheduledTasks.dialog.schedule.weekdayShort.wed',
    'sessions.scheduledTasks.dialog.schedule.weekdayShort.thu',
    'sessions.scheduledTasks.dialog.schedule.weekdayShort.fri',
    'sessions.scheduledTasks.dialog.schedule.weekdayShort.sat',
  ] as const;
  if (value >= 0 && value <= 6) return t(keys[value]);
  return t('sessions.scheduledTasks.dialog.schedule.weekdayShort.unknown');
};

/** Cap MobileScheduledTab card subtitle: schedule label (no timezone on mobile). */
export const formatSchedule = (task: ScheduledTask, includeTimezone = false): string => {
  const timesLabel = scheduleTimes(task).join(', ') || '--:--';
  if (task.schedule.kind === 'daily') {
    if (includeTimezone && task.schedule.timezone) {
      return t('sessions.scheduledTasks.dialog.schedule.dailyWithTimezone', {
        time: timesLabel,
        timezone: task.schedule.timezone,
      });
    }
    return t('sessions.scheduledTasks.dialog.schedule.daily', { time: timesLabel });
  }
  if (task.schedule.kind === 'weekly') {
    const days = Array.isArray(task.schedule.weekdays)
      ? task.schedule.weekdays.map((value) => formatWeekday(value)).join(', ')
      : '';
    if (includeTimezone && task.schedule.timezone) {
      return t('sessions.scheduledTasks.dialog.schedule.weeklyWithTimezone', {
        days,
        time: timesLabel,
        timezone: task.schedule.timezone,
      });
    }
    return t('sessions.scheduledTasks.dialog.schedule.weekly', { days, time: timesLabel });
  }
  if (task.schedule.kind === 'once') {
    const date =
      typeof task.schedule.date === 'string' && task.schedule.date.trim().length > 0
        ? task.schedule.date
        : t('sessions.scheduledTasks.dialog.schedule.unknownDate');
    const time =
      typeof task.schedule.time === 'string' && task.schedule.time.trim().length > 0
        ? task.schedule.time
        : '--:--';
    if (includeTimezone && task.schedule.timezone) {
      return t('sessions.scheduledTasks.dialog.schedule.onceWithTimezone', {
        date,
        time,
        timezone: task.schedule.timezone,
      });
    }
    return t('sessions.scheduledTasks.dialog.schedule.once', { date, time });
  }
  if (includeTimezone && task.schedule.timezone) {
    return t('sessions.scheduledTasks.dialog.schedule.cronWithTimezone', {
      cron: task.schedule.cron || '',
      timezone: task.schedule.timezone,
    });
  }
  return t('sessions.scheduledTasks.dialog.schedule.cron', { cron: task.schedule.cron || '' });
};

export const formatRelativeTime = (value: number | undefined, nowMs = Date.now()): string => {
  if (!value || !Number.isFinite(value)) return '';
  const diff = value - nowMs;
  const abs = Math.abs(diff);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const future = diff >= 0;
  if (abs < minute) {
    return future
      ? t('sessions.scheduledTasks.dialog.relativeTime.inLessThanOneMinute')
      : t('sessions.scheduledTasks.dialog.relativeTime.justNow');
  }
  if (abs < hour) {
    const m = Math.round(abs / minute);
    return future
      ? t('sessions.scheduledTasks.dialog.relativeTime.inMinutes', { count: m })
      : t('sessions.scheduledTasks.dialog.relativeTime.minutesAgo', { count: m });
  }
  if (abs < day) {
    const h = Math.floor(abs / hour);
    const m = Math.round((abs % hour) / minute);
    const body = m > 0 ? `${h}h ${m}m` : `${h}h`;
    return future
      ? t('sessions.scheduledTasks.dialog.relativeTime.inDuration', { duration: body })
      : t('sessions.scheduledTasks.dialog.relativeTime.durationAgo', { duration: body });
  }
  const d = Math.floor(abs / day);
  const h = Math.round((abs % day) / hour);
  const body = h > 0 ? `${d}d ${h}h` : `${d}d`;
  return future
    ? t('sessions.scheduledTasks.dialog.relativeTime.inDuration', { duration: body })
    : t('sessions.scheduledTasks.dialog.relativeTime.durationAgo', { duration: body });
};

export const formatRunDateTime = (value: number, locale = 'zh-CN'): string =>
  new Intl.DateTimeFormat(locale, {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));

export const resolveRunDurationMs = (run: ScheduledTaskRun, nowMs: number): number | null => {
  if (run.status === 'running') return Math.max(0, nowMs - run.startedAt);
  if (typeof run.finishedAt === 'number' && Number.isFinite(run.finishedAt)) {
    const wallMs = Math.max(0, run.finishedAt - run.startedAt);
    if (typeof run.durationMs === 'number' && Number.isFinite(run.durationMs) && run.durationMs >= 0) {
      return Math.max(run.durationMs, wallMs);
    }
    return wallMs;
  }
  if (typeof run.durationMs === 'number' && Number.isFinite(run.durationMs) && run.durationMs >= 0) {
    return run.durationMs;
  }
  return null;
};

export const formatCompactRunDuration = (durationMs: number | null): string | null => {
  if (durationMs === null || !Number.isFinite(durationMs) || durationMs < 0) return null;
  if (durationMs < 1_000) return '<1s';
  const totalSeconds = Math.floor(durationMs / 1_000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) {
    return seconds > 0 ? `${totalMinutes}m ${seconds}s` : `${totalMinutes}m`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
};

export type StatusTone = 'success' | 'error' | 'warning' | 'muted';

export const statusTone = (status: ScheduledTaskStatus): StatusTone => {
  if (status === 'success') return 'success';
  if (status === 'error') return 'error';
  if (status === 'running') return 'warning';
  return 'muted';
};

export const statusLabel = (status: ScheduledTaskStatus): string =>
  t(`sessions.scheduledTasks.dialog.status.${status}`);
