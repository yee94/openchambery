import * as React from 'react';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { ScrollShadow } from '@/components/ui/ScrollShadow';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { NumberInput } from '@/components/ui/number-input';
import { Button } from '@/components/ui/button';
import {
  groupedCardClassName,
  groupedCardRowClassName,
  groupedSectionTitleClassName,
} from '@/components/ui/grouped-card.styles';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { toast } from '@/components/ui';
import { ModelSelector } from '@/components/sections/agents/ModelSelector';
import { AgentSelector } from '@/components/sections/commands/AgentSelector';
import { isPrimaryMode } from '@/components/chat/mobileControlsUtils';
import { CommandAutocomplete, type CommandAutocompleteHandle, type CommandInfo } from '@/components/chat/CommandAutocomplete';
import { FileMentionAutocomplete, type FileMentionHandle } from '@/components/chat/FileMentionAutocomplete';
import { SnippetAutocomplete, type SnippetAutocompleteHandle } from '@/components/chat/SnippetAutocomplete';
import { Icon } from "@/components/icon/Icon";
import { MobileDetailNavigation } from '@/mobile/MobileDetailNavigation';
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import type { ScheduledTask } from '@/lib/scheduledTasksApi';
import { useI18n } from '@/lib/i18n';
import { isValidCronExpression, getNextRuns, CRON_EXAMPLES } from '@/lib/cron';

const WEEKDAY_INDEXES = [0, 1, 2, 3, 4, 5, 6] as const;

const FORM_CONTROL_CLASS = '!h-9 !min-h-9 w-full min-w-0 rounded-full border-0 bg-[var(--surface-elevated)] px-3 py-1 ring-1 ring-inset ring-border/60 transition-[background-color,box-shadow,transform] duration-150 ease-out hover:[&:not(:focus)]:bg-[var(--surface-subtle)] hover:[&:not(:focus)]:ring-transparent active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)] data-[popup-open]:bg-[var(--surface-subtle)] data-[popup-open]:shadow-sm motion-reduce:transition-none';
const PANEL_CONTROL_CLASS = 'oc-settings-inline-value';
const PANEL_ROW_CLASS = `oc-settings-split-row ${groupedCardRowClassName}`;
const MOBILE_PANEL_CONTROL_CLASS = PANEL_CONTROL_CLASS;
const MOBILE_PANEL_ROW_CLASS = PANEL_ROW_CLASS;

const getLocalDateISO = () => {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const parseISODateToLocal = (value: string): Date | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (
    Number.isNaN(date.getTime())
    || date.getFullYear() !== year
    || date.getMonth() !== month - 1
    || date.getDate() !== day
  ) {
    return null;
  }
  return date;
};

const formatLocalDateISO = (date: Date): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const formatDateLabel = (isoDate: string, fallbackLabel: string, locale: string): string => {
  const date = parseISODateToLocal(isoDate);
  if (!date) {
    return fallbackLabel;
  }
  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(date);
};

const shiftMonth = (date: Date, delta: number): Date => {
  return new Date(date.getFullYear(), date.getMonth() + delta, 1);
};

const getCalendarCells = (monthDate: Date, weekStartsOn: number): Array<{ date: Date; inCurrentMonth: boolean }> => {
  const year = monthDate.getFullYear();
  const month = monthDate.getMonth();
  const firstDay = new Date(year, month, 1);
  const firstWeekday = firstDay.getDay();
  const leadDays = (firstWeekday - weekStartsOn + 7) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const daysInPrevMonth = new Date(year, month, 0).getDate();

  const cells: Array<{ date: Date; inCurrentMonth: boolean }> = [];
  for (let index = 0; index < 42; index += 1) {
    const dayOffset = index - leadDays + 1;
    if (dayOffset <= 0) {
      const day = daysInPrevMonth + dayOffset;
      cells.push({ date: new Date(year, month - 1, day), inCurrentMonth: false });
      continue;
    }
    if (dayOffset > daysInMonth) {
      cells.push({ date: new Date(year, month + 1, dayOffset - daysInMonth), inCurrentMonth: false });
      continue;
    }
    cells.push({ date: new Date(year, month, dayOffset), inCurrentMonth: true });
  }
  return cells;
};

const parse24hTime = (value: string): { hour24: string; hour12: string; minute: string; meridiem: 'AM' | 'PM' } => {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) {
    return { hour24: '00', hour12: '12', minute: '00', meridiem: 'AM' };
  }
  const hour24 = Number(match[1]);
  const minute = match[2];
  const meridiem = hour24 >= 12 ? 'PM' : 'AM';
  const rawHour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return {
    hour24: String(hour24).padStart(2, '0'),
    hour12: String(rawHour12).padStart(2, '0'),
    minute,
    meridiem,
  };
};

const to24hTime = (hour12: string, minute: string, meridiem: 'AM' | 'PM'): string => {
  const hourNumRaw = Number(hour12);
  const minuteNumRaw = Number(minute);
  const hourNum = Number.isFinite(hourNumRaw) ? Math.min(12, Math.max(1, hourNumRaw)) : 12;
  const minuteNum = Number.isFinite(minuteNumRaw) ? Math.min(59, Math.max(0, minuteNumRaw)) : 0;

  let hour24 = hourNum % 12;
  if (meridiem === 'PM') {
    hour24 += 12;
  }
  return `${String(hour24).padStart(2, '0')}:${String(minuteNum).padStart(2, '0')}`;
};

const getValidNumber = (value: string, config: { max: number; min?: number; loop?: boolean }) => {
  const { max, min = 0, loop = false } = config;
  let numericValue = Number.parseInt(value, 10);

  if (Number.isFinite(numericValue)) {
    if (!loop) {
      if (numericValue > max) {
        numericValue = max;
      }
      if (numericValue < min) {
        numericValue = min;
      }
    } else {
      if (numericValue > max) {
        numericValue = min;
      }
      if (numericValue < min) {
        numericValue = max;
      }
    }
    return String(numericValue).padStart(2, '0');
  }

  return '00';
};

const getValid12Hour = (value: string) => {
  if (/^(0[1-9]|1[0-2])$/.test(value)) {
    return value;
  }
  return getValidNumber(value, { min: 1, max: 12 });
};

const getValidMinute = (value: string) => {
  if (/^[0-5][0-9]$/.test(value)) {
    return value;
  }
  return getValidNumber(value, { max: 59 });
};

const getArrowHour = (value: string, step: number) => {
  return getValidNumber(String(Number.parseInt(value, 10) + step), { min: 1, max: 12, loop: true });
};

const getArrowMinute = (value: string, step: number) => {
  return getValidNumber(String(Number.parseInt(value, 10) + step), { min: 0, max: 59, loop: true });
};

const getWeekStartsOn = (locale: string): number => {
  try {
    const localeApi = (Intl as unknown as {
      Locale?: new (tag: string) => { weekInfo?: { firstDay?: number } };
    }).Locale;
    if (typeof localeApi !== 'function') {
      return 1;
    }
    const weekInfo = new localeApi(locale).weekInfo;
    const firstDayRaw = weekInfo?.firstDay;
    if (typeof firstDayRaw !== 'number') {
      return 1;
    }
    return firstDayRaw % 7;
  } catch {
    return 1;
  }
};

const getUses24Hour = (locale: string): boolean => {
  try {
    const options = new Intl.DateTimeFormat(locale, { hour: 'numeric' }).resolvedOptions();
    if (typeof options.hour12 === 'boolean') {
      return !options.hour12;
    }
    return options.hourCycle === 'h23' || options.hourCycle === 'h24';
  } catch {
    return true;
  }
};

const getLocalizedWeekdayLabels = (locale: string): string[] => {
  const formatter = new Intl.DateTimeFormat(locale, { weekday: 'short' });
  const sundayBase = new Date(2023, 0, 1);
  return WEEKDAY_INDEXES.map((offset) => formatter.format(new Date(sundayBase.getFullYear(), sundayBase.getMonth(), sundayBase.getDate() + offset)));
};

const rotateWeekdays = <T,>(items: T[], weekStartsOn: number): T[] => {
  return [...items.slice(weekStartsOn), ...items.slice(0, weekStartsOn)];
};

interface TimePillProps {
  value: string;
  onChange: (next: string) => void;
  className?: string;
  use24Hour: boolean;
  hourAriaLabel: string;
  minuteAriaLabel: string;
  periodAriaLabel: string;
  amLabel: string;
  pmLabel: string;
}

const FieldLabel: React.FC<{
  htmlFor?: string;
  required?: boolean;
  className?: string;
  children: React.ReactNode;
}> = ({ htmlFor, required, className, children }) => (
  <div className="flex items-center gap-1.5">
    <label htmlFor={htmlFor} className={cn('typography-ui-label font-normal text-foreground', className)}>
      {children}
      {required && <span className="ml-0.5 text-destructive">*</span>}
    </label>
  </div>
);

const TimePill: React.FC<TimePillProps> = ({
  value,
  onChange,
  className,
  use24Hour,
  hourAriaLabel,
  minuteAriaLabel,
  periodAriaLabel,
  amLabel,
  pmLabel,
}) => {
  const parts = React.useMemo(() => parse24hTime(value), [value]);
  const hourRef = React.useRef<HTMLInputElement>(null);
  const minuteRef = React.useRef<HTMLInputElement>(null);
  const [hourDraft, setHourDraftState] = React.useState<string | null>(null);
  const [minuteDraft, setMinuteDraftState] = React.useState<string | null>(null);
  const hourDraftRef = React.useRef<string | null>(null);
  const minuteDraftRef = React.useRef<string | null>(null);

  const setHourDraft = React.useCallback((next: string | null) => {
    hourDraftRef.current = next;
    setHourDraftState(next);
  }, []);
  const setMinuteDraft = React.useCallback((next: string | null) => {
    minuteDraftRef.current = next;
    setMinuteDraftState(next);
  }, []);

  const getValid24Hour = (hour: string) => getValidNumber(hour, { min: 0, max: 23 });
  const getArrow24Hour = (hour: string, step: number) => getValidNumber(String(Number.parseInt(hour, 10) + step), {
    min: 0,
    max: 23,
    loop: true,
  });
  const to24hFrom24Hour = (hour24: string, minute: string) => {
    const hourNumRaw = Number(hour24);
    const minuteNumRaw = Number(minute);
    const hourNum = Number.isFinite(hourNumRaw) ? Math.min(23, Math.max(0, hourNumRaw)) : 0;
    const minuteNum = Number.isFinite(minuteNumRaw) ? Math.min(59, Math.max(0, minuteNumRaw)) : 0;
    return `${String(hourNum).padStart(2, '0')}:${String(minuteNum).padStart(2, '0')}`;
  };

  const onHourChange = (raw: string) => {
    const digits = raw.replace(/\D/g, '').slice(0, 2);
    setHourDraft(digits);
    if (digits.length === 2) {
      if (use24Hour) {
        onChange(to24hFrom24Hour(getValid24Hour(digits), parts.minute));
      } else {
        onChange(to24hTime(getValid12Hour(digits), parts.minute, parts.meridiem));
      }
      setHourDraft(null);
      minuteRef.current?.focus();
    }
  };
  const commitHour = () => {
    const digits = hourDraftRef.current;
    if (digits === null) return;
    setHourDraft(null);
    if (digits.length === 0) return;
    if (use24Hour) {
      onChange(to24hFrom24Hour(getValid24Hour(digits.padStart(2, '0')), parts.minute));
      return;
    }
    onChange(to24hTime(getValid12Hour(digits.padStart(2, '0')), parts.minute, parts.meridiem));
  };
  const onMinuteChange = (raw: string) => {
    const digits = raw.replace(/\D/g, '').slice(0, 2);
    setMinuteDraft(digits);
    if (digits.length === 2) {
      onChange(use24Hour
        ? to24hFrom24Hour(parts.hour24, getValidMinute(digits))
        : to24hTime(parts.hour12, getValidMinute(digits), parts.meridiem));
      setMinuteDraft(null);
    }
  };
  const commitMinute = () => {
    const digits = minuteDraftRef.current;
    if (digits === null) return;
    setMinuteDraft(null);
    if (digits.length === 0) return;
    onChange(use24Hour
      ? to24hFrom24Hour(parts.hour24, getValidMinute(digits.padStart(2, '0')))
      : to24hTime(parts.hour12, getValidMinute(digits.padStart(2, '0')), parts.meridiem));
  };
  const stepHour = (step: number) =>
    onChange(use24Hour
      ? to24hFrom24Hour(getArrow24Hour(parts.hour24, step), parts.minute)
      : to24hTime(getArrowHour(parts.hour12, step), parts.minute, parts.meridiem));
  const stepMinute = (step: number) =>
    onChange(use24Hour
      ? to24hFrom24Hour(parts.hour24, getArrowMinute(parts.minute, step))
      : to24hTime(parts.hour12, getArrowMinute(parts.minute, step), parts.meridiem));
  const setPeriod = (next: 'AM' | 'PM') => {
    if (next !== parts.meridiem) {
      onChange(to24hTime(parts.hour12, parts.minute, next));
    }
  };

  const onHourKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      commitHour();
      minuteRef.current?.focus();
      return;
    }
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      setHourDraft(null);
      stepHour(event.key === 'ArrowUp' ? 1 : -1);
    }
  };
  const onMinuteKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowLeft' && (event.currentTarget.selectionStart ?? 0) === 0) {
      event.preventDefault();
      commitMinute();
      hourRef.current?.focus();
      return;
    }
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      setMinuteDraft(null);
      stepMinute(event.key === 'ArrowUp' ? 1 : -1);
    }
  };

  return (
    <div
      className={cn(
        'flex h-9 w-full min-w-0 items-center gap-1 rounded-full border-0 bg-[var(--surface-elevated)] ring-1 ring-inset ring-border/60 transition duration-200 ease-out hover:[&:not(:focus-within)]:bg-[var(--surface-subtle)] hover:[&:not(:focus-within)]:ring-transparent focus-within:ring-2 focus-within:ring-[var(--interactive-focus-ring)]',
        use24Hour ? 'px-2' : 'pl-2 pr-1',
        className,
      )}
    >
      <input
        ref={hourRef}
        inputMode="numeric"
        value={hourDraft ?? (use24Hour ? parts.hour24 : parts.hour12)}
        onChange={(event) => onHourChange(event.target.value)}
        onKeyDown={onHourKeyDown}
        onFocus={() => setHourDraft('')}
        onBlur={commitHour}
        maxLength={2}
        aria-label={hourAriaLabel}
        className="h-7 w-7 shrink-0 rounded-sm bg-transparent text-center font-mono text-sm tabular-nums text-foreground outline-none caret-transparent focus:bg-interactive-hover"
      />
      <span className="font-mono text-sm text-muted-foreground">:</span>
      <input
        ref={minuteRef}
        inputMode="numeric"
        value={minuteDraft ?? parts.minute}
        onChange={(event) => onMinuteChange(event.target.value)}
        onKeyDown={onMinuteKeyDown}
        onFocus={() => setMinuteDraft('')}
        onBlur={commitMinute}
        maxLength={2}
        aria-label={minuteAriaLabel}
        className="h-7 w-7 shrink-0 rounded-sm bg-transparent text-center font-mono text-sm tabular-nums text-foreground outline-none caret-transparent focus:bg-interactive-hover"
      />
      {!use24Hour ? (
        <Select value={parts.meridiem} onValueChange={(next) => setPeriod(next as 'AM' | 'PM')}>
          <SelectTrigger
            aria-label={periodAriaLabel}
            className="ml-1 h-7 w-fit border-0 bg-transparent pl-2 pr-1 shadow-none hover:bg-interactive-hover focus:ring-0"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="motion-reduce:transition-none">
            <SelectItem value="AM">{amLabel}</SelectItem>
            <SelectItem value="PM">{pmLabel}</SelectItem>
          </SelectContent>
        </Select>
      ) : null}
    </div>
  );
};

const startOfMonth = (date: Date) => new Date(date.getFullYear(), date.getMonth(), 1);

const startOfToday = () => {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
};

const isSameCalendarDay = (a: Date, b: Date) => (
  a.getFullYear() === b.getFullYear()
  && a.getMonth() === b.getMonth()
  && a.getDate() === b.getDate()
);

type ScheduledTaskDraft = {
  id?: string;
  name: string;
  enabled: boolean;
  schedule: {
    kind: 'daily' | 'weekly' | 'once' | 'cron';
    times: string[];
    onceDate: string;
    onceTime: string;
    weekdays: number[];
    timezone: string;
    cronExpression: string;
  };
  execution: {
    prompt: string;
    providerID: string;
    modelID: string;
    variant: string;
    agent: string;
    goalEnabled: boolean;
    goalTokenBudget: number | null;
  };
  state?: ScheduledTask['state'];
};

const normalizeDraftTimes = (task: ScheduledTask | null): string[] => {
  if (!task) {
    return ['09:00'];
  }
  const candidates = Array.isArray(task.schedule.times)
    ? task.schedule.times
    : (task.schedule.time ? [task.schedule.time] : []);

  const valid = candidates
    .filter((value) => typeof value === 'string' && /^([01]\d|2[0-3]):([0-5]\d)$/.test(value))
    .map((value) => value.trim());

  const unique = Array.from(new Set(valid)).sort((a, b) => a.localeCompare(b));
  return unique.length > 0 ? unique : ['09:00'];
};

const toDraft = (
  task: ScheduledTask | null,
  defaults: {
    providerID: string;
    modelID: string;
    variant: string;
    agent: string;
  },
): ScheduledTaskDraft => {
  const timezoneFallback = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  if (!task) {
    return {
      name: '',
      enabled: true,
      schedule: {
        kind: 'daily',
        times: ['09:00'],
        onceDate: getLocalDateISO(),
        onceTime: '09:00',
        weekdays: [1],
        timezone: timezoneFallback,
        cronExpression: '',
      },
      execution: {
        prompt: '',
        providerID: defaults.providerID,
        modelID: defaults.modelID,
        variant: defaults.variant,
        agent: defaults.agent,
        goalEnabled: false,
        goalTokenBudget: null,
      },
    };
  }

  return {
    id: task.id,
    name: task.name,
    enabled: task.enabled,
    schedule: {
      kind: task.schedule.kind === 'cron'
        ? 'cron'
        : (task.schedule.kind === 'once'
          ? 'once'
          : (task.schedule.kind === 'weekly' ? 'weekly' : 'daily')),
      times: normalizeDraftTimes(task),
      onceDate: typeof task.schedule.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(task.schedule.date)
        ? task.schedule.date
        : getLocalDateISO(),
      onceTime: typeof task.schedule.time === 'string' && /^([01]\d|2[0-3]):([0-5]\d)$/.test(task.schedule.time)
        ? task.schedule.time
        : '09:00',
      weekdays: Array.isArray(task.schedule.weekdays) ? task.schedule.weekdays : [1],
      timezone: task.schedule.timezone || timezoneFallback,
      cronExpression: task.schedule.kind === 'cron' && typeof task.schedule.cron === 'string'
        ? task.schedule.cron
        : '',
    },
    execution: {
      prompt: task.execution.prompt,
      providerID: task.execution.providerID,
      modelID: task.execution.modelID,
      variant: task.execution.variant || '',
      agent: task.execution.agent || '',
      goalEnabled: task.execution.goalEnabled === true,
      goalTokenBudget: typeof task.execution.goalTokenBudget === 'number' && task.execution.goalTokenBudget > 0
        ? task.execution.goalTokenBudget
        : null,
    },
    state: task.state,
  };
};

const validateDraft = (draft: ScheduledTaskDraft, t: ReturnType<typeof useI18n>['t']): string | null => {
  if (!draft.name.trim()) {
    return t('sessions.scheduledTasks.editor.validation.taskNameRequired');
  }
  if (!draft.execution.prompt.trim()) {
    return t('sessions.scheduledTasks.editor.validation.promptRequired');
  }
  if (!draft.execution.providerID.trim() || !draft.execution.modelID.trim()) {
    return t('sessions.scheduledTasks.editor.validation.modelRequired');
  }

  if (draft.schedule.kind === 'once') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.schedule.onceDate)) {
      return t('sessions.scheduledTasks.editor.validation.dateFormat');
    }
    if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(draft.schedule.onceTime)) {
      return t('sessions.scheduledTasks.editor.validation.timeFormat');
    }
  } else if (draft.schedule.kind === 'cron') {
    if (!draft.schedule.cronExpression.trim()) {
      return t('sessions.scheduledTasks.editor.validation.cronRequired');
    }
    const cronResult = isValidCronExpression(draft.schedule.cronExpression);
    if (!cronResult.valid) {
      return t('sessions.scheduledTasks.editor.validation.cronInvalid');
    }
  } else {
    const validTimes = draft.schedule.times.filter((value) => /^([01]\d|2[0-3]):([0-5]\d)$/.test(value));
    if (validTimes.length === 0) {
      return t('sessions.scheduledTasks.editor.validation.atLeastOneTime');
    }
  }

  if (draft.schedule.kind === 'weekly' && draft.schedule.weekdays.length === 0) {
    return t('sessions.scheduledTasks.editor.validation.atLeastOneWeekday');
  }

  if (!draft.schedule.timezone.trim()) {
    return t('sessions.scheduledTasks.editor.validation.timezoneRequired');
  }

  return null;
};

const dedupeSortTimes = (times: string[]) => {
  const filtered = times.filter((value) => /^([01]\d|2[0-3]):([0-5]\d)$/.test(value));
  return Array.from(new Set(filtered)).sort((a, b) => a.localeCompare(b));
};

const CronScheduleSection: React.FC<{
  draft: ScheduledTaskDraft;
  setDraft: React.Dispatch<React.SetStateAction<ScheduledTaskDraft>>;
  locale: string;
  t: ReturnType<typeof useI18n>['t'];
  panel?: boolean;
  mobilePanel?: boolean;
}> = ({ draft, setDraft, locale, t, panel = false, mobilePanel = false }) => {
  const groupedPanel = panel || mobilePanel;
  const rowClassName = mobilePanel ? MOBILE_PANEL_ROW_CLASS : PANEL_ROW_CLASS;
  const cronExpression = draft.schedule.cronExpression;
  const cronValidation = React.useMemo(
    () => (cronExpression.trim() ? isValidCronExpression(cronExpression) : null),
    [cronExpression],
  );
  const nextRuns = React.useMemo(() => {
    if (!cronValidation?.valid || !cronExpression.trim()) {
      return [];
    }
    return getNextRuns(cronExpression, draft.schedule.timezone);
  }, [cronExpression, cronValidation, draft.schedule.timezone]);

  const formatNextRun = React.useCallback(
    (date: Date) => new Intl.DateTimeFormat(locale, {
      timeZone: draft.schedule.timezone,
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(date),
    [locale, draft.schedule.timezone],
  );

  return (
    <div className={cn('flex flex-col gap-3', groupedPanel && 'gap-0')}>
      <div className={cn('flex flex-col gap-1', groupedPanel && rowClassName)}>
        <FieldLabel htmlFor="sched-cron" required>{t('sessions.scheduledTasks.editor.cronExpression.label')}</FieldLabel>
        <div
          data-settings-value={groupedPanel ? '' : undefined}
          className={cn(groupedPanel && 'oc-settings-split-row-control flex-col items-end')}
        >
          <Input
            id="sched-cron"
            value={cronExpression}
            onChange={(event) => setDraft((prev) => ({
              ...prev,
              schedule: { ...prev.schedule, cronExpression: event.target.value },
            }))}
            placeholder={t('sessions.scheduledTasks.editor.cronExpression.placeholder')}
            className={cn('w-full font-mono', groupedPanel && 'min-w-[140px] text-right')}
          />
          {cronValidation && !cronValidation.valid && cronExpression.trim() ? (
            <span className="typography-micro text-destructive">
              {t('sessions.scheduledTasks.editor.validation.cronInvalid')}
            </span>
          ) : null}
        </div>
      </div>

      {nextRuns.length > 0 ? (
        <div className={cn('flex flex-col gap-1', groupedPanel && rowClassName)}>
          <span className="typography-meta text-muted-foreground">{t('sessions.scheduledTasks.editor.cronExpression.nextRuns')}</span>
          <span
            data-settings-value={groupedPanel ? '' : undefined}
            className={cn('typography-micro text-foreground', groupedPanel && 'oc-settings-split-row-control text-right')}
          >
            {nextRuns.map(formatNextRun).join(', ')}
          </span>
        </div>
      ) : null}

      <div className={cn('flex flex-col gap-1', groupedPanel && [rowClassName, 'items-start'])}>
        <span className="typography-meta text-muted-foreground">{t('sessions.scheduledTasks.editor.cronExpression.examples')}</span>
        <div
          data-settings-value={groupedPanel ? '' : undefined}
          className={cn('flex flex-wrap gap-1.5', groupedPanel && 'oc-settings-split-row-control justify-end')}
        >
          {CRON_EXAMPLES.map((example) => (
            <button
              key={example.expression}
              type="button"
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 typography-micro text-foreground hover:bg-interactive-hover"
              onClick={() => setDraft((prev) => ({
                ...prev,
                schedule: { ...prev.schedule, cronExpression: example.expression },
              }))}
            >
              <span className="font-mono">{example.expression}</span>
              <span className="text-muted-foreground">{t(example.labelKey as Parameters<typeof t>[0])}</span>
            </button>
          ))}
        </div>
      </div>

    </div>
  );
};

export function ScheduledTaskEditorDialog(props: {
  open: boolean;
  task: ScheduledTask | null;
  onOpenChange: (open: boolean) => void;
  onSave: (draft: Partial<ScheduledTask>) => Promise<ScheduledTask | void>;
  presentation?: 'dialog' | 'panel' | 'mobile-panel' | 'mobile-tab';
  onDirtyChange?: (dirty: boolean) => void;
  onRun?: (task: ScheduledTask) => Promise<void>;
  onDelete?: (task: ScheduledTask) => Promise<void>;
  onToggleEnabled?: (task: ScheduledTask, enabled: boolean) => Promise<void>;
  actionBusy?: boolean;
  projectID?: string;
  projectOptions?: Array<{ id: string; label: React.ReactNode }>;
  onProjectChange?: (projectID: string) => void;
}) {
  const {
    open,
    task,
    onOpenChange,
    onSave,
    presentation = 'dialog',
    onDirtyChange,
    onRun,
    onDelete,
    onToggleEnabled,
    actionBusy = false,
    projectID = '',
    projectOptions = [],
    onProjectChange,
  } = props;
  const desktopPanel = presentation === 'panel';
  const mobilePanel = presentation === 'mobile-panel';
  const mobileTab = presentation === 'mobile-tab';
  const mobileGroupedPanel = mobilePanel || mobileTab;
  const compactMobileEditor = mobilePanel || mobileTab;
  const groupedPanel = desktopPanel || mobileGroupedPanel;
  const panelControlClassName = mobileGroupedPanel ? MOBILE_PANEL_CONTROL_CLASS : PANEL_CONTROL_CLASS;
  const panelRowClassName = mobileGroupedPanel ? MOBILE_PANEL_ROW_CLASS : PANEL_ROW_CLASS;
  const { t, locale } = useI18n();
  const loadProviders = useConfigStore((state) => state.loadProviders);
  const loadAgents = useConfigStore((state) => state.loadAgents);
  const providers = useConfigStore((state) => state.providers);
  const currentProviderID = useConfigStore((state) => state.currentProviderId);
  const currentModelID = useConfigStore((state) => state.currentModelId);
  const currentVariant = useConfigStore((state) => state.currentVariant || '');
  const currentAgentName = useConfigStore((state) => state.currentAgentName || '');
  const timeFormatPreference = useUIStore((state) => state.timeFormatPreference);
  const weekStartPreference = useUIStore((state) => state.weekStartPreference);
  const isMobile = useUIStore((state) => state.isMobile);

  const [draft, setDraft] = React.useState<ScheduledTaskDraft>(() =>
    toDraft(task, {
      providerID: currentProviderID,
      modelID: currentModelID,
      variant: currentVariant,
      agent: currentAgentName,
    })
  );
  const [saving, setSaving] = React.useState(false);
  const [isDatePickerOpen, setIsDatePickerOpen] = React.useState(false);
  const [showFileMention, setShowFileMention] = React.useState(false);
  const [mentionQuery, setMentionQuery] = React.useState('');
  const [showCommandAutocomplete, setShowCommandAutocomplete] = React.useState(false);
  const [commandQuery, setCommandQuery] = React.useState('');
  const [showSnippetAutocomplete, setShowSnippetAutocomplete] = React.useState(false);
  const [snippetQuery, setSnippetQuery] = React.useState('');
  const [calendarMonth, setCalendarMonth] = React.useState<Date>(() => {
    const initialDate = parseISODateToLocal(task?.schedule?.date || '') || new Date();
    return new Date(initialDate.getFullYear(), initialDate.getMonth(), 1);
  });
  const datePickerRef = React.useRef<HTMLDivElement>(null);
  const promptTextareaRef = React.useRef<HTMLTextAreaElement>(null);
  const mentionRef = React.useRef<FileMentionHandle>(null);
  const commandRef = React.useRef<CommandAutocompleteHandle>(null);
  const snippetRef = React.useRef<SnippetAutocompleteHandle>(null);
  const pristineDraftRef = React.useRef('');
  const resetTaskIDRef = React.useRef<string | null | undefined>(undefined);
  const taskRef = React.useRef(task);
  taskRef.current = task;
  const taskID = task?.id || null;
  const localeUse24Hour = React.useMemo(() => getUses24Hour(locale), [locale]);
  const localeWeekStartsOn = React.useMemo(() => getWeekStartsOn(locale), [locale]);
  const use24Hour = React.useMemo(() => {
    if (timeFormatPreference === '24h') {
      return true;
    }
    if (timeFormatPreference === '12h') {
      return false;
    }
    return localeUse24Hour;
  }, [timeFormatPreference, localeUse24Hour]);
  const weekStartsOn = React.useMemo(() => {
    if (weekStartPreference === 'sunday') {
      return 0;
    }
    if (weekStartPreference === 'monday') {
      return 1;
    }
    return localeWeekStartsOn;
  }, [weekStartPreference, localeWeekStartsOn]);
  const orderedWeekdays = React.useMemo(() => {
    const labels = getLocalizedWeekdayLabels(locale);
    return rotateWeekdays(
      WEEKDAY_INDEXES.map((value) => ({ value, label: labels[value] || '' })),
      weekStartsOn,
    );
  }, [locale, weekStartsOn]);

  React.useEffect(() => {
    if (!open) {
      return;
    }
    void loadProviders({ source: 'scheduledTaskEditor' });
    void loadAgents({ source: 'scheduledTaskEditor' });
  }, [open, loadProviders, loadAgents]);

  React.useEffect(() => {
    if (!open) {
      resetTaskIDRef.current = undefined;
      return;
    }
    if (resetTaskIDRef.current === taskID) {
      return;
    }
    resetTaskIDRef.current = taskID;
    const currentTask = taskRef.current;
    const nextDraft = toDraft(currentTask, {
        providerID: currentProviderID,
        modelID: currentModelID,
        variant: currentVariant,
        agent: currentAgentName,
      });
    pristineDraftRef.current = JSON.stringify(nextDraft);
    setDraft(nextDraft);
    onDirtyChange?.(false);
    const sourceDate = parseISODateToLocal(currentTask?.schedule?.date || '') || new Date();
    setCalendarMonth(new Date(sourceDate.getFullYear(), sourceDate.getMonth(), 1));
    setIsDatePickerOpen(false);
    setShowCommandAutocomplete(false);
    setShowFileMention(false);
    setCommandQuery('');
    setMentionQuery('');
  }, [open, taskID, currentProviderID, currentModelID, currentVariant, currentAgentName, onDirtyChange]);

  React.useEffect(() => {
    if (!open || !task || draft.id !== task.id || draft.enabled === task.enabled) {
      return;
    }
    setDraft((prev) => ({ ...prev, enabled: task.enabled }));
    if (pristineDraftRef.current) {
      const pristine = JSON.parse(pristineDraftRef.current) as ScheduledTaskDraft;
      pristineDraftRef.current = JSON.stringify({ ...pristine, enabled: task.enabled });
    }
  }, [draft.enabled, draft.id, open, task]);

  React.useEffect(() => {
    if (!open || !pristineDraftRef.current) {
      return;
    }
    onDirtyChange?.(JSON.stringify(draft) !== pristineDraftRef.current);
  }, [draft, onDirtyChange, open]);

  React.useEffect(() => {
    if (!isDatePickerOpen) {
      return;
    }

    const onPointerDown = (event: MouseEvent) => {
      if (datePickerRef.current && !datePickerRef.current.contains(event.target as Node)) {
        setIsDatePickerOpen(false);
      }
    };

    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [isDatePickerOpen]);

  const selectedModelForVariant = React.useMemo(() => {
    const provider = providers.find((item) => item.id === draft.execution.providerID);
    return provider?.models?.find((item) => item.id === draft.execution.modelID) as { variants?: Record<string, unknown> } | undefined;
  }, [draft.execution.modelID, draft.execution.providerID, providers]);
  const availableVariants = React.useMemo(
    () => selectedModelForVariant?.variants ? Object.keys(selectedModelForVariant.variants) : [],
    [selectedModelForVariant],
  );

  React.useEffect(() => {
    if (!selectedModelForVariant || !draft.execution.variant || availableVariants.includes(draft.execution.variant)) return;
    setDraft((prev) => ({
      ...prev,
      execution: { ...prev.execution, variant: '' },
    }));
  }, [availableVariants, draft.execution.variant, selectedModelForVariant]);

  const toggleWeekday = React.useCallback((weekday: number, nextChecked: boolean) => {
    setDraft((prev) => {
      const current = new Set(prev.schedule.weekdays);
      if (nextChecked) {
        current.add(weekday);
      } else {
        current.delete(weekday);
      }
      return {
        ...prev,
        schedule: {
          ...prev.schedule,
          weekdays: Array.from(current).sort((a, b) => a - b),
        },
      };
    });
  }, []);

  const updateTimeAt = React.useCallback((index: number, value: string) => {
    setDraft((prev) => {
      const next = prev.schedule.times.slice();
      next[index] = value;
      return {
        ...prev,
        schedule: {
          ...prev.schedule,
          times: next,
        },
      };
    });
  }, []);

  const removeTimeAt = React.useCallback((index: number) => {
    setDraft((prev) => {
      const next = prev.schedule.times.filter((_, idx) => idx !== index);
      return {
        ...prev,
        schedule: {
          ...prev.schedule,
          times: next.length > 0 ? next : ['09:00'],
        },
      };
    });
  }, []);

  const addTime = React.useCallback(() => {
    setDraft((prev) => ({
      ...prev,
      schedule: {
        ...prev.schedule,
        times: [...prev.schedule.times, '12:00'],
      },
    }));
  }, []);

  const todayDate = React.useMemo(() => startOfToday(), []);
  const currentMonthStart = React.useMemo(() => startOfMonth(todayDate), [todayDate]);
  const selectedDateLabel = React.useMemo(() => {
    const selectedDate = parseISODateToLocal(draft.schedule.onceDate);
    if (!selectedDate) {
      return null;
    }
    if (isSameCalendarDay(selectedDate, todayDate)) {
      return t('sessions.scheduledTasks.editor.date.today');
    }
    return new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(selectedDate);
  }, [draft.schedule.onceDate, locale, t, todayDate]);
  const isAtCurrentMonth = React.useMemo(
    () => startOfMonth(calendarMonth).getTime() <= currentMonthStart.getTime(),
    [calendarMonth, currentMonthStart],
  );
  const calendarWeekdayLabels = React.useMemo(
    () => orderedWeekdays.map((weekday) => weekday.label),
    [orderedWeekdays],
  );

  const setOneTimeDate = React.useCallback((isoDate: string) => {
    setDraft((prev) => ({
      ...prev,
      schedule: {
        ...prev.schedule,
        onceDate: isoDate,
      },
    }));
  }, []);

  const updateAutocompleteState = React.useCallback((value: string, cursorPosition: number) => {
    if (value.startsWith('/')) {
      const firstSpace = value.indexOf(' ');
      const firstNewline = value.indexOf('\n');
      const commandEnd = Math.min(
        firstSpace === -1 ? value.length : firstSpace,
        firstNewline === -1 ? value.length : firstNewline,
      );

      if (cursorPosition <= commandEnd && firstSpace === -1) {
        setCommandQuery(value.substring(1, commandEnd));
        setShowCommandAutocomplete(true);
        setShowFileMention(false);
        setShowSnippetAutocomplete(false);
        return;
      }
    }

    setShowCommandAutocomplete(false);

    const textBeforeCursor = value.substring(0, cursorPosition);
    const lastHashSymbol = textBeforeCursor.lastIndexOf('#');
    if (lastHashSymbol !== -1) {
      const charBefore = lastHashSymbol > 0 ? textBeforeCursor[lastHashSymbol - 1] : null;
      const textAfterHash = textBeforeCursor.substring(lastHashSymbol + 1);
      const isWordBoundary = !charBefore || /\s/.test(charBefore);
      if (isWordBoundary && !textAfterHash.includes(' ') && !textAfterHash.includes('\n')) {
        setSnippetQuery(textAfterHash);
        setShowSnippetAutocomplete(true);
        setShowFileMention(false);
        return;
      }
    }

    setShowSnippetAutocomplete(false);

    const lastAtSymbol = textBeforeCursor.lastIndexOf('@');
    if (lastAtSymbol !== -1) {
      const charBefore = lastAtSymbol > 0 ? textBeforeCursor[lastAtSymbol - 1] : null;
      const textAfterAt = textBeforeCursor.substring(lastAtSymbol + 1);
      const isWordBoundary = !charBefore || /\s/.test(charBefore);
      if (isWordBoundary && !textAfterAt.includes(' ') && !textAfterAt.includes('\n')) {
        setMentionQuery(textAfterAt);
        setShowFileMention(true);
      } else {
        setShowFileMention(false);
      }
      return;
    }

    setShowFileMention(false);
  }, []);

  const setPromptValue = React.useCallback((value: string) => {
    setDraft((prev) => ({
      ...prev,
      execution: {
        ...prev.execution,
        prompt: value,
      },
    }));
  }, []);

  const handleFileSelect = React.useCallback((file: { name: string; path: string; relativePath?: string }) => {
    const promptValue = draft.execution.prompt;
    const textarea = promptTextareaRef.current;
    const cursorPosition = textarea?.selectionStart ?? promptValue.length;
    const textBeforeCursor = promptValue.substring(0, cursorPosition);
    const lastAtSymbol = textBeforeCursor.lastIndexOf('@');
    const mentionPath = (file.relativePath && file.relativePath.trim().length > 0)
      ? file.relativePath.trim()
      : (file.path || file.name);

    const startIndex = lastAtSymbol !== -1 ? lastAtSymbol : cursorPosition;
    const nextPrompt = `${promptValue.substring(0, startIndex)}@${mentionPath} ${promptValue.substring(cursorPosition)}`;
    const nextCursor = startIndex + mentionPath.length + 2;

    setPromptValue(nextPrompt);
    setShowFileMention(false);
    setMentionQuery('');

    requestAnimationFrame(() => {
      const currentTextarea = promptTextareaRef.current;
      if (currentTextarea) {
        currentTextarea.selectionStart = nextCursor;
        currentTextarea.selectionEnd = nextCursor;
        currentTextarea.focus();
      }
      updateAutocompleteState(nextPrompt, nextCursor);
    });
  }, [draft.execution.prompt, setPromptValue, updateAutocompleteState]);

  const handleAgentSelect = React.useCallback((agentName: string) => {
    const promptValue = draft.execution.prompt;
    const textarea = promptTextareaRef.current;
    const cursorPosition = textarea?.selectionStart ?? promptValue.length;
    const textBeforeCursor = promptValue.substring(0, cursorPosition);
    const lastAtSymbol = textBeforeCursor.lastIndexOf('@');
    const startIndex = lastAtSymbol !== -1 ? lastAtSymbol : cursorPosition;
    const nextPrompt = `${promptValue.substring(0, startIndex)}@${agentName} ${promptValue.substring(cursorPosition)}`;
    const nextCursor = startIndex + agentName.length + 2;

    setPromptValue(nextPrompt);
    setShowFileMention(false);
    setMentionQuery('');

    requestAnimationFrame(() => {
      const currentTextarea = promptTextareaRef.current;
      if (currentTextarea) {
        currentTextarea.selectionStart = nextCursor;
        currentTextarea.selectionEnd = nextCursor;
        currentTextarea.focus();
      }
      updateAutocompleteState(nextPrompt, nextCursor);
    });
  }, [draft.execution.prompt, setPromptValue, updateAutocompleteState]);

  const handleCommandSelect = React.useCallback((command: CommandInfo) => {
    const nextPrompt = `/${command.name} `;
    setPromptValue(nextPrompt);
    setShowCommandAutocomplete(false);
    setCommandQuery('');
    setShowSnippetAutocomplete(false);

    requestAnimationFrame(() => {
      const currentTextarea = promptTextareaRef.current;
      if (currentTextarea) {
        currentTextarea.focus();
        currentTextarea.selectionStart = currentTextarea.value.length;
        currentTextarea.selectionEnd = currentTextarea.value.length;
      }
      updateAutocompleteState(nextPrompt, nextPrompt.length);
    });
  }, [setPromptValue, updateAutocompleteState]);

  const handleSnippetSelect = React.useCallback((_snippet: unknown, trigger: string) => {
    const promptValue = draft.execution.prompt;
    const textarea = promptTextareaRef.current;
    const cursorPosition = textarea?.selectionStart ?? promptValue.length;
    const textBeforeCursor = promptValue.substring(0, cursorPosition);
    const lastHashSymbol = textBeforeCursor.lastIndexOf('#');
    const startIndex = lastHashSymbol !== -1 ? lastHashSymbol : cursorPosition;
    const nextPrompt = `${promptValue.substring(0, startIndex)}#${trigger} ${promptValue.substring(cursorPosition)}`;
    const nextCursor = startIndex + trigger.length + 2;

    setPromptValue(nextPrompt);
    setShowSnippetAutocomplete(false);
    setSnippetQuery('');

    requestAnimationFrame(() => {
      const currentTextarea = promptTextareaRef.current;
      if (currentTextarea) {
        currentTextarea.selectionStart = nextCursor;
        currentTextarea.selectionEnd = nextCursor;
        currentTextarea.focus();
      }
      updateAutocompleteState(nextPrompt, nextCursor);
    });
  }, [draft.execution.prompt, setPromptValue, updateAutocompleteState]);

  const handlePromptKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (showCommandAutocomplete && commandRef.current) {
      if (event.key === 'Enter' || event.key === 'ArrowUp' || event.key === 'ArrowDown' || event.key === 'Escape' || event.key === 'Tab') {
        event.preventDefault();
        commandRef.current.handleKeyDown(event.key);
        return;
      }
    }

    if (showFileMention && mentionRef.current) {
      if (event.key === 'Enter' || event.key === 'ArrowUp' || event.key === 'ArrowDown' || event.key === 'Escape' || event.key === 'Tab') {
        event.preventDefault();
        mentionRef.current.handleKeyDown(event.key);
      }
    }

    if (showSnippetAutocomplete && snippetRef.current) {
      if (event.key === 'Enter' || event.key === 'ArrowUp' || event.key === 'ArrowDown' || event.key === 'Escape' || event.key === 'Tab') {
        event.preventDefault();
        snippetRef.current.handleKeyDown(event.key);
      }
    }
  }, [showCommandAutocomplete, showFileMention, showSnippetAutocomplete]);

  const handleSubmit = React.useCallback(async () => {
    const validationError = validateDraft(draft, t);
    if (validationError) {
      toast.error(validationError);
      return;
    }

    const payload: Partial<ScheduledTask> = {
      ...(draft.id ? { id: draft.id } : {}),
      name: draft.name.trim(),
      enabled: draft.enabled,
      schedule: {
        kind: draft.schedule.kind,
        timezone: draft.schedule.timezone.trim(),
        ...(draft.schedule.kind === 'cron'
          ? { cron: draft.schedule.cronExpression.trim() }
          : draft.schedule.kind === 'once'
            ? {
                date: draft.schedule.onceDate,
                time: draft.schedule.onceTime,
            }
            : {
                times: dedupeSortTimes(draft.schedule.times),
                ...(draft.schedule.kind === 'weekly' ? { weekdays: draft.schedule.weekdays } : {}),
              }),
      },
      execution: {
        prompt: draft.execution.prompt,
        providerID: draft.execution.providerID,
        modelID: draft.execution.modelID,
        ...(draft.execution.variant.trim() ? { variant: draft.execution.variant.trim() } : {}),
        ...(draft.execution.agent.trim() ? { agent: draft.execution.agent.trim() } : {}),
        ...(draft.execution.goalEnabled ? { goalEnabled: true } : {}),
        ...(draft.execution.goalEnabled && draft.execution.goalTokenBudget
          ? { goalTokenBudget: draft.execution.goalTokenBudget }
          : {}),
      },
      ...(draft.state ? { state: draft.state } : {}),
    };

    setSaving(true);
    try {
      const savedTask = await onSave(payload);
      if (presentation === 'panel') {
        const nextDraft = toDraft(savedTask || task, {
          providerID: currentProviderID,
          modelID: currentModelID,
          variant: currentVariant,
          agent: currentAgentName,
        });
        pristineDraftRef.current = JSON.stringify(nextDraft);
        setDraft(nextDraft);
        onDirtyChange?.(false);
      } else {
        onOpenChange(false);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('sessions.scheduledTasks.editor.toast.saveFailed'));
    } finally {
      setSaving(false);
    }
  }, [currentAgentName, currentModelID, currentProviderID, currentVariant, draft, onDirtyChange, onOpenChange, onSave, presentation, t, task]);

  const descriptionId = React.useId();
  const hasOpenFloatingMenu = React.useCallback(() => {
    if (typeof document === 'undefined') return false;
    return Boolean(
      document.querySelector(
        '[data-slot="dropdown-menu-content"], [data-slot="select-content"]'
      )
    );
  }, []);

  const title = task ? t('sessions.scheduledTasks.editor.title.edit') : t('sessions.scheduledTasks.editor.title.new');
  const description = t('sessions.scheduledTasks.editor.description');

  const formBody = (
    <div className={cn(
      'oc-settings-workspace oc-settings-page-content oc-scheduled-task-form',
      isMobile ? 'oc-settings-workspace-mobile' : 'oc-settings-workspace-desktop',
    )}>
      <div className={cn('flex flex-col gap-1', (desktopPanel || mobileTab) && 'hidden')}>
        <FieldLabel htmlFor="sched-name" required>{t('sessions.scheduledTasks.editor.taskName.label')}</FieldLabel>
        <Input
          id="sched-name"
          value={draft.name}
          onChange={(event) => setDraft((prev) => ({ ...prev, name: event.target.value }))}
          placeholder={t('sessions.scheduledTasks.editor.taskName.placeholder')}
          maxLength={80}
          className="w-full"
        />
      </div>

      <div className={cn('flex flex-col gap-3 border-t border-border/40 pt-5', groupedPanel && 'oc-settings-group order-4 animate-in fade-in slide-in-from-right-1 border-0 pt-0 duration-200 [animation-delay:80ms] [animation-fill-mode:both] motion-reduce:animate-none')}>
        {groupedPanel ? (
          <h3 className={groupedSectionTitleClassName}>
            {t('sessions.scheduledTasks.editor.panel.frequency')}
          </h3>
        ) : null}
        <div className={cn(groupedPanel && groupedCardClassName, groupedPanel && draft.schedule.kind === 'once' && isDatePickerOpen && 'overflow-visible')}>
        <div className={cn('grid grid-cols-1 gap-x-4 gap-y-3', groupedPanel && 'flex flex-col gap-0', !isMobile && !groupedPanel && 'sm:grid-cols-2')}>
          <div className={cn('flex min-w-0 flex-col gap-1', groupedPanel && [panelRowClassName, 'last:border-b'])}>
            <FieldLabel>{t('sessions.scheduledTasks.editor.scheduleType.label')}</FieldLabel>
            <div
              data-settings-value={groupedPanel ? '' : undefined}
              className={cn(groupedPanel && 'oc-settings-split-row-control')}
            >
              <Select
                value={draft.schedule.kind}
                onValueChange={(value: 'daily' | 'weekly' | 'once' | 'cron') => {
                  setDraft((prev) => ({
                    ...prev,
                    schedule: {
                      ...prev.schedule,
                      kind: value,
                      ...(value === 'cron' && !prev.schedule.cronExpression
                        ? { cronExpression: '0 * * * *' }
                        : {}),
                    },
                  }));
                }}
              >
                <SelectTrigger className={cn(!groupedPanel && FORM_CONTROL_CLASS, groupedPanel && panelControlClassName)}>
                  <SelectValue>
                    {(value) => value === 'daily'
                      ? t('sessions.scheduledTasks.editor.scheduleType.daily')
                      : value === 'weekly'
                        ? t('sessions.scheduledTasks.editor.scheduleType.weekly')
                        : value === 'cron'
                          ? t('sessions.scheduledTasks.editor.scheduleType.cron')
                          : t('sessions.scheduledTasks.editor.scheduleType.once')}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent className="motion-reduce:transition-none">
                  <SelectItem value="daily">{t('sessions.scheduledTasks.editor.scheduleType.daily')}</SelectItem>
                  <SelectItem value="weekly">{t('sessions.scheduledTasks.editor.scheduleType.weekly')}</SelectItem>
                  <SelectItem value="once">{t('sessions.scheduledTasks.editor.scheduleType.once')}</SelectItem>
                  <SelectItem value="cron">{t('sessions.scheduledTasks.editor.scheduleType.cron')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

        </div>

          {draft.schedule.kind === 'cron' ? (
            <CronScheduleSection draft={draft} setDraft={setDraft} locale={locale} t={t} panel={desktopPanel} mobilePanel={mobileGroupedPanel} />
          ) : draft.schedule.kind === 'once' ? (
            <div className={cn('grid grid-cols-1 gap-x-4 gap-y-3', groupedPanel && 'flex flex-col gap-0', !isMobile && !groupedPanel && 'sm:grid-cols-2')}>
              <div className={cn('flex min-w-0 flex-col gap-1', groupedPanel && panelRowClassName)} ref={datePickerRef}>
                <FieldLabel>{t('sessions.scheduledTasks.editor.date.label')}</FieldLabel>
                <div data-settings-value={groupedPanel ? '' : undefined} className={cn('relative', groupedPanel && 'oc-settings-split-row-control')}>
                  <button
                    type="button"
                    className={cn(!groupedPanel && FORM_CONTROL_CLASS, 'flex items-center justify-between gap-2 text-left', groupedPanel && [panelControlClassName, 'w-full'])}
                    onClick={() => setIsDatePickerOpen((prev) => !prev)}
                  >
                    <span className="inline-flex min-w-0 items-center gap-2">
                      <Icon name="calendar" className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="truncate typography-ui-label text-foreground">{formatDateLabel(draft.schedule.onceDate, t('sessions.scheduledTasks.editor.date.placeholder'), locale)}</span>
                    </span>
                    <Icon name="arrow-down-s" className="h-4 w-4 shrink-0 text-muted-foreground" />
                  </button>

                  {isDatePickerOpen ? (
                    <div className={cn(
                      'absolute top-[calc(100%+6px)] z-50 w-[min(288px,calc(100vw-2rem))] animate-in fade-in zoom-in-95 slide-in-from-top-1 rounded-xl border border-border bg-background p-3 shadow-sm duration-150 motion-reduce:animate-none',
                      mobileGroupedPanel ? 'right-0' : 'left-0',
                    )}>
                      <div className="mb-2 flex items-center justify-between">
                        <button
                          type="button"
                          className="inline-flex h-8 w-8 items-center justify-center rounded-md hover:bg-interactive-hover disabled:cursor-not-allowed disabled:opacity-40"
                          onClick={() => setCalendarMonth((prev) => shiftMonth(prev, -1))}
                          aria-label={t('sessions.scheduledTasks.editor.date.previousMonth')}
                          disabled={isAtCurrentMonth}
                        >
                          <Icon name="arrow-left-s" className="h-4 w-4" />
                        </button>
                        <div className="typography-ui-label text-foreground">
                          {new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(calendarMonth)}
                        </div>
                        <button
                          type="button"
                          className="inline-flex h-8 w-8 items-center justify-center rounded-md hover:bg-interactive-hover"
                          onClick={() => setCalendarMonth((prev) => shiftMonth(prev, 1))}
                          aria-label={t('sessions.scheduledTasks.editor.date.nextMonth')}
                        >
                          <Icon name="arrow-right-s" className="h-4 w-4" />
                        </button>
                      </div>

                      <div className="mb-1 grid grid-cols-7 gap-1 px-1">
                        {calendarWeekdayLabels.map((weekday, index) => (
                          <div key={`${weekday}-${index}`} className="py-1 text-center typography-micro text-muted-foreground">
                            {weekday}
                          </div>
                        ))}
                      </div>

                      <div className="grid grid-cols-7 gap-1">
                        {getCalendarCells(calendarMonth, weekStartsOn).map(({ date, inCurrentMonth }) => {
                          const isoDate = formatLocalDateISO(date);
                          const isSelected = isoDate === draft.schedule.onceDate;
                          const isToday = isSameCalendarDay(date, todayDate);
                          const isPast = date.getTime() < todayDate.getTime();
                          const dayClass = isSelected
                            ? 'bg-interactive-selection text-interactive-selection-foreground'
                            : (isPast
                              ? 'text-muted-foreground/40'
                              : (inCurrentMonth
                                ? 'text-foreground hover:bg-interactive-hover'
                                : 'text-muted-foreground/60 hover:bg-interactive-hover'));
                          return (
                            <button
                              key={isoDate}
                              type="button"
                              onClick={() => {
                                if (isPast) {
                                  return;
                                }
                                setOneTimeDate(isoDate);
                                setIsDatePickerOpen(false);
                              }}
                              disabled={isPast}
                              className={[
                                'h-8 rounded-md typography-ui-label',
                                dayClass,
                                isToday && !isSelected
                                  ? 'ring-1 ring-inset ring-interactive-focusRing bg-interactive-hover/50'
                                  : '',
                                isPast ? 'cursor-not-allowed opacity-45' : '',
                              ].join(' ')}
                            >
                              {date.getDate()}
                            </button>
                          );
                        })}
                      </div>

                      <div className="mt-2 flex items-center justify-between border-t border-border pt-2">
                        <div className="typography-micro text-muted-foreground">{selectedDateLabel || ''}</div>
                        <Button
                          type="button"
                          size="xs"
                          variant="ghost"
                          onClick={() => {
                            setOneTimeDate(formatLocalDateISO(todayDate));
                            setCalendarMonth(new Date(todayDate.getFullYear(), todayDate.getMonth(), 1));
                          }}
                        >
                          {t('sessions.scheduledTasks.editor.date.jumpToToday')}
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>

              <div className={cn('flex min-w-0 flex-col gap-1', groupedPanel && panelRowClassName)}>
                <FieldLabel>{t('sessions.scheduledTasks.editor.time.label')}</FieldLabel>
                <div
                  data-settings-value={groupedPanel ? '' : undefined}
                  className={cn(groupedPanel && 'oc-settings-split-row-control')}
                >
                  <TimePill
                    value={draft.schedule.onceTime}
                    className={cn(groupedPanel && 'oc-settings-inline-value w-fit min-w-0 justify-end')}
                    use24Hour={use24Hour}
                    hourAriaLabel={t('sessions.scheduledTasks.editor.time.hourAria')}
                    minuteAriaLabel={t('sessions.scheduledTasks.editor.time.minuteAria')}
                    periodAriaLabel={t('sessions.scheduledTasks.editor.time.periodAria')}
                    amLabel={t('sessions.scheduledTasks.editor.time.period.am')}
                    pmLabel={t('sessions.scheduledTasks.editor.time.period.pm')}
                    onChange={(next) => setDraft((prev) => ({
                      ...prev,
                      schedule: { ...prev.schedule, onceTime: next },
                    }))}
                  />
                </div>
              </div>
            </div>
          ) : (
            <div className={cn('grid grid-cols-1 gap-x-4 gap-y-3', groupedPanel && 'flex flex-col gap-0', !isMobile && !groupedPanel && 'sm:grid-cols-2')}>
              {draft.schedule.kind === 'weekly' ? (
                <div className={cn('flex flex-col gap-1', groupedPanel && [groupedCardRowClassName, 'oc-settings-split-row'], !isMobile && !groupedPanel && 'sm:col-span-2')}>
                  <FieldLabel>{t('sessions.scheduledTasks.editor.weekdays.label')}</FieldLabel>
                  <div data-settings-value={groupedPanel ? '' : undefined} className={cn('flex flex-wrap gap-x-3 gap-y-2', groupedPanel && 'oc-settings-split-row-control justify-end')}>
                    {orderedWeekdays.map((weekday) => {
                      const checked = draft.schedule.weekdays.includes(weekday.value);
                      return (
                        <div
                          key={weekday.value}
                          className={[
                            'group inline-flex items-center gap-1.5 px-0.5 py-0.5 typography-meta',
                            checked ? 'text-foreground' : 'text-muted-foreground',
                          ].join(' ')}
                        >
                          <Checkbox checked={checked} onChange={(next) => toggleWeekday(weekday.value, next)} ariaLabel={weekday.label} />
                          <button
                            type="button"
                            onClick={() => toggleWeekday(weekday.value, !checked)}
                            className="group-hover:text-foreground"
                          >
                            {weekday.label}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : null}

              <div className={cn('flex min-w-0 flex-col gap-2', groupedPanel && [panelRowClassName, 'justify-start'], mobileGroupedPanel && 'flex-col items-stretch')}>
                <FieldLabel>{t('sessions.scheduledTasks.editor.times.label')}</FieldLabel>
                <div
                  data-settings-value={groupedPanel ? '' : undefined}
                  className={cn(groupedPanel ? 'oc-settings-split-row-control relative flex-wrap justify-end' : 'contents')}
                >
                <div className={cn('flex flex-col gap-2', groupedPanel && 'flex-row flex-wrap justify-end transition-[padding] motion-reduce:transition-none', desktopPanel && 'group-hover:pr-8')}>
                  {draft.schedule.times.map((time, index) => (
                    <div key={index} className="flex min-w-0 items-center gap-2">
                      <TimePill
                        value={time}
                        className={cn(groupedPanel && 'oc-settings-inline-value w-fit min-w-0')}
                        use24Hour={use24Hour}
                        hourAriaLabel={t('sessions.scheduledTasks.editor.time.hourAria')}
                        minuteAriaLabel={t('sessions.scheduledTasks.editor.time.minuteAria')}
                        periodAriaLabel={t('sessions.scheduledTasks.editor.time.periodAria')}
                        amLabel={t('sessions.scheduledTasks.editor.time.period.am')}
                        pmLabel={t('sessions.scheduledTasks.editor.time.period.pm')}
                        onChange={(next) => updateTimeAt(index, next)}
                      />
                      {draft.schedule.times.length > 1 ? (
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          onClick={() => removeTimeAt(index)}
                          aria-label={t('sessions.scheduledTasks.editor.times.removeAria')}
                        >
                          <Icon name="close" className="h-4 w-4" />
                        </Button>
                      ) : null}
                    </div>
                  ))}
                </div>
                <div className={cn(groupedPanel && 'shrink-0', desktopPanel && 'absolute right-0')}>
                  <Button
                    type="button"
                    size={groupedPanel ? 'icon' : 'sm'}
                    variant={groupedPanel ? 'ghost' : 'outline'}
                    className={cn('h-9', desktopPanel && 'size-7 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 motion-reduce:transition-none', mobileGroupedPanel && 'size-9')}
                    onClick={addTime}
                    aria-label={t('sessions.scheduledTasks.editor.times.add')}
                  >
                    <Icon name="add" className={cn('h-4 w-4', !groupedPanel && 'mr-1')} />
                    {!groupedPanel ? t('sessions.scheduledTasks.editor.times.add') : null}
                  </Button>
                </div>
                </div>
              </div>
            </div>
          )}

        </div>
      </div>

      <div className={cn('flex flex-col gap-3 border-t border-border/40 pt-5', groupedPanel && 'contents')}>
        <div className={cn(groupedPanel ? 'oc-settings-group order-2' : 'contents')}>
          {groupedPanel ? (
            <h3 className={groupedSectionTitleClassName}>
              {t('sessions.scheduledTasks.editor.panel.details')}
            </h3>
          ) : null}
          <div className={cn('grid grid-cols-1 gap-x-4 gap-y-3', groupedPanel && ['flex flex-col gap-0 animate-in fade-in slide-in-from-right-1 duration-200 [animation-delay:40ms] [animation-fill-mode:both] motion-reduce:animate-none', groupedCardClassName], !isMobile && !groupedPanel && 'sm:grid-cols-2')}>
            {projectOptions.length > 0 ? (
              <div className={cn('flex min-w-0 flex-col gap-1', groupedPanel && panelRowClassName)}>
                <FieldLabel>{t('sessions.scheduledTasks.dialog.project.label')}</FieldLabel>
                <div
                  data-settings-value={groupedPanel ? '' : undefined}
                  className={cn(groupedPanel && 'oc-settings-split-row-control')}
                >
                  <Select value={projectID} disabled={!onProjectChange} onValueChange={onProjectChange}>
                    <SelectTrigger className={cn(!groupedPanel && FORM_CONTROL_CLASS, groupedPanel && panelControlClassName)}>
                      <SelectValue>
                        {(value) => projectOptions.find((project) => project.id === value)?.label}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent className="motion-reduce:transition-none">
                      {projectOptions.map((project) => (
                        <SelectItem key={project.id} value={project.id}>{project.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            ) : null}
            <div className={cn('flex min-w-0 flex-col gap-1', groupedPanel && panelRowClassName)}>
              <FieldLabel required>{t('sessions.scheduledTasks.editor.model.label')}</FieldLabel>
              <div
                data-settings-value={groupedPanel ? '' : undefined}
                className={cn(groupedPanel && 'oc-settings-split-row-control')}
              >
                <ModelSelector
                  providerId={draft.execution.providerID}
                  modelId={draft.execution.modelID}
                  variant={draft.execution.variant}
                  className={cn(!groupedPanel && FORM_CONTROL_CLASS, groupedPanel && panelControlClassName, '[&>div]:min-w-0 [&>div]:flex-1 [&_span]:truncate')}
                  showIcon={!desktopPanel}
                  onChange={(providerID, modelID, variant = '') => {
                    setDraft((prev) => ({
                      ...prev,
                      execution: {
                        ...prev.execution,
                        providerID,
                        modelID,
                        variant,
                      },
                    }));
                  }}
                />
              </div>
            </div>
            {groupedPanel ? (
              <div className={panelRowClassName}>
                <FieldLabel>{t('sessions.scheduledTasks.editor.agent.label')}</FieldLabel>
                <div data-settings-value="" className="oc-settings-split-row-control">
                  <AgentSelector
                    agentName={draft.execution.agent}
                    className={cn(panelControlClassName, '[&>div]:min-w-0 [&>div]:flex-1 [&_span]:truncate')}
                    showIcon
                    filter={(agent) => isPrimaryMode(agent.mode)}
                    onChange={(agent) => setDraft((prev) => ({
                      ...prev,
                      execution: { ...prev.execution, agent },
                    }))}
                  />
                </div>
              </div>
            ) : null}
            {groupedPanel ? (
              <label className={cn(panelRowClassName, 'cursor-pointer')}>
                <span className="typography-ui-label text-foreground">{t('sessions.scheduledTasks.editor.goal.label')}</span>
                <span data-settings-value="" className="oc-settings-split-row-control">
                  <Checkbox
                    checked={draft.execution.goalEnabled}
                    onChange={(goalEnabled) => setDraft((prev) => ({
                      ...prev,
                      execution: { ...prev.execution, goalEnabled },
                    }))}
                    ariaLabel={t('sessions.scheduledTasks.editor.goal.aria')}
                  />
                </span>
              </label>
            ) : null}
          </div>
        </div>

          {!groupedPanel ? <div className="flex min-w-0 flex-col gap-1">
            <FieldLabel>{t('sessions.scheduledTasks.editor.agent.label')}</FieldLabel>
            <AgentSelector
              agentName={draft.execution.agent}
              className={cn(FORM_CONTROL_CLASS, '[&>div]:min-w-0 [&>div]:flex-1 [&_span]:truncate')}
              filter={(agent) => isPrimaryMode(agent.mode)}
              onChange={(agent) => setDraft((prev) => ({
                ...prev,
                execution: {
                  ...prev.execution,
                  agent,
                },
              }))}
            />
          </div> : null}

          <div className={cn('flex flex-col gap-1', groupedPanel && 'order-1')}>
            <div className={cn(groupedPanel && 'sr-only')}>
              <FieldLabel htmlFor="sched-prompt" required>{t('sessions.scheduledTasks.editor.prompt.label')}</FieldLabel>
            </div>
            <div className="relative">
              <Textarea
                id="sched-prompt"
                ref={promptTextareaRef}
                value={draft.execution.prompt}
                onChange={(event) => {
                  const nextPrompt = event.target.value;
                  setPromptValue(nextPrompt);
                  const cursorPosition = event.target.selectionStart ?? nextPrompt.length;
                  updateAutocompleteState(nextPrompt, cursorPosition);
                }}
                onKeyDown={handlePromptKeyDown}
                rows={groupedPanel ? 4 : 8}
                simple={groupedPanel}
                placeholder={t('sessions.scheduledTasks.editor.prompt.placeholder')}
                className={cn(
                  'typography-meta min-h-[120px] max-h-[300px] resize-none overflow-y-auto',
                  groupedPanel && '!h-32 !min-h-32 !max-h-32 rounded-2xl border border-border/60 bg-[var(--surface-elevated)] px-4 py-4 text-base shadow-none ring-0 placeholder:text-muted-foreground/65 focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]',
                )}
              />

              {showCommandAutocomplete ? (
                <CommandAutocomplete
                  ref={commandRef}
                  searchQuery={commandQuery}
                  onCommandSelect={handleCommandSelect}
                  onClose={() => setShowCommandAutocomplete(false)}
                  style={{
                    left: 0,
                    top: 'auto',
                    bottom: 'calc(100% + 6px)',
                    marginBottom: 0,
                    maxWidth: '100%',
                  }}
                />
              ) : null}

              {showFileMention ? (
                <FileMentionAutocomplete
                  ref={mentionRef}
                  searchQuery={mentionQuery}
                  onFileSelect={handleFileSelect}
                  onAgentSelect={handleAgentSelect}
                  onClose={() => setShowFileMention(false)}
                  style={{
                    left: 0,
                    top: 'auto',
                    bottom: 'calc(100% + 6px)',
                    marginBottom: 0,
                    maxWidth: '100%',
                  }}
                />
              ) : null}

              {showSnippetAutocomplete ? (
                <SnippetAutocomplete
                  ref={snippetRef}
                  searchQuery={snippetQuery}
                  onSnippetSelect={handleSnippetSelect}
                  onClose={() => setShowSnippetAutocomplete(false)}
                  style={{
                    left: 0,
                    top: 'auto',
                    bottom: 'calc(100% + 6px)',
                    marginBottom: 0,
                    maxWidth: '100%',
                  }}
                />
              ) : null}
            </div>
          </div>

          {!groupedPanel ? <div className="flex flex-wrap items-center gap-x-8 gap-y-2">
            <label className="inline-flex cursor-pointer items-center gap-2">
              <Checkbox
                checked={draft.execution.goalEnabled}
                onChange={(goalEnabled) => setDraft((prev) => ({
                  ...prev,
                  execution: { ...prev.execution, goalEnabled },
                }))}
                ariaLabel={t('sessions.scheduledTasks.editor.goal.aria')}
              />
              <span className="typography-meta">{t('sessions.scheduledTasks.editor.goal.label')}</span>
            </label>
            {draft.execution.goalEnabled ? (
              <label className="inline-flex cursor-pointer items-center gap-2">
                <Checkbox
                  checked={draft.execution.goalTokenBudget !== null}
                  onChange={(hasBudget) => setDraft((prev) => ({
                    ...prev,
                    execution: { ...prev.execution, goalTokenBudget: hasBudget ? 200_000 : null },
                  }))}
                  ariaLabel={t('sessions.scheduledTasks.editor.goal.budgetAria')}
                />
                <span className="typography-meta">{t('sessions.scheduledTasks.editor.goal.budgetLabel')}</span>
              </label>
            ) : null}
            {draft.execution.goalEnabled && draft.execution.goalTokenBudget !== null ? (
              <NumberInput
                value={draft.execution.goalTokenBudget}
                onValueChange={(value) => {
                  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
                    setDraft((prev) => ({
                      ...prev,
                      execution: { ...prev.execution, goalTokenBudget: Math.floor(value) },
                    }));
                  }
                }}
                min={1000}
                max={100000000}
                step={50000}
              />
            ) : null}
          </div> : null}
      </div>
    </div>
  );

  const footerRow = (
    <div className={cn('flex flex-wrap items-center justify-between gap-3', presentation === 'panel' && 'justify-end', compactMobileEditor && 'flex-nowrap gap-2')}>
      <label className={cn('inline-flex items-center gap-2', presentation === 'panel' && 'hidden')}>
        <Checkbox
          checked={draft.enabled}
          onChange={(enabled) => setDraft((prev) => ({ ...prev, enabled }))}
          ariaLabel={t('sessions.scheduledTasks.editor.enabled.aria')}
        />
        <span className="typography-meta">{t('sessions.scheduledTasks.editor.enabled.label')}</span>
      </label>

      <div className={cn('flex flex-wrap items-center justify-end gap-2', compactMobileEditor && 'ml-auto flex-nowrap')}>
        {presentation !== 'panel' && !compactMobileEditor ? (
          <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={saving}>
            {t('sessions.scheduledTasks.editor.actions.cancel')}
          </Button>
        ) : null}
        <Button type="button" size="sm" className={cn(presentation === 'panel' && 'rounded-lg', compactMobileEditor && 'min-h-11 px-5')} onClick={handleSubmit} disabled={saving}>
          {saving
            ? t('sessions.scheduledTasks.editor.actions.saving')
            : task
              ? t('sessions.scheduledTasks.editor.actions.save')
              : t('sessions.scheduledTasks.dialog.actions.create')}
        </Button>
      </div>
    </div>
  );

  if (presentation === 'panel') {
    if (!open) {
      return null;
    }
    return (
      <section className="flex h-full min-h-0 flex-col bg-background" aria-labelledby="scheduled-task-panel-title">
        <header className="shrink-0 animate-in fade-in slide-in-from-right-1 px-6 pb-4 pt-5 duration-200 motion-reduce:animate-none">
          <div className="flex items-center justify-between gap-3">
            <span className={cn(
              'typography-meta font-medium',
              task?.enabled ? 'text-[var(--status-info)]' : 'text-muted-foreground',
            )}>
              {task
                ? (task.enabled
                  ? t('sessions.scheduledTasks.dialog.taskToggle.enabled')
                  : t('sessions.scheduledTasks.dialog.taskToggle.paused'))
                : title}
            </span>
            <div className="flex items-center gap-1">
              {task && onDelete && onRun ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className={cn('rounded-lg transition-transform duration-150 active:scale-90 motion-reduce:transition-none', isMobile ? 'size-11' : 'size-8')}
                      disabled={saving || actionBusy}
                      aria-label={t('sessions.scheduledTasks.dialog.actions.moreAria', { taskName: task.name })}
                    >
                      <Icon name="more-2" className="size-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="min-w-40 motion-reduce:transition-none">
                    <DropdownMenuItem onSelect={() => void onRun(task)}>
                      <Icon name="play" className="size-4" />
                      {t('sessions.scheduledTasks.dialog.actions.runNow')}
                    </DropdownMenuItem>
                    {onToggleEnabled ? (
                      <DropdownMenuItem onSelect={() => void onToggleEnabled(task, !task.enabled)}>
                        <Icon name={task.enabled ? 'pause' : 'play'} className="size-4" />
                        {task.enabled
                          ? t('sessions.scheduledTasks.dialog.taskToggle.pauseAria', { taskName: task.name })
                          : t('sessions.scheduledTasks.dialog.taskToggle.enableAria', { taskName: task.name })}
                      </DropdownMenuItem>
                    ) : null}
                    <DropdownMenuItem variant="destructive" onSelect={() => void onDelete(task)}>
                      <Icon name="delete-bin" className="size-4" />
                      {t('sessions.scheduledTasks.dialog.actions.delete')}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
              {task && onToggleEnabled ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className={cn('group rounded-lg transition-transform duration-150 active:scale-90 motion-reduce:transition-none', isMobile ? 'size-11' : 'size-8')}
                  disabled={saving || actionBusy}
                  onClick={() => void onToggleEnabled(task, !task.enabled)}
                  aria-label={task.enabled
                    ? t('sessions.scheduledTasks.dialog.taskToggle.pauseAria', { taskName: task.name })
                    : t('sessions.scheduledTasks.dialog.taskToggle.enableAria', { taskName: task.name })}
                >
                  <Icon name={task.enabled ? 'pause' : 'play'} className="size-4 transition-transform duration-150 group-active:scale-75 motion-reduce:transition-none" />
                </Button>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={cn('rounded-lg transition-transform duration-150 active:scale-90 motion-reduce:transition-none', isMobile ? 'size-11' : 'size-8')}
                onClick={() => onOpenChange(false)}
                aria-label={t('sessions.scheduledTasks.editor.actions.cancel')}
              >
                <Icon name={isMobile ? 'arrow-left' : 'close'} className="size-4" />
              </Button>
            </div>
          </div>
          <h2 id="scheduled-task-panel-title" className="sr-only">{title}</h2>
          <Input
            value={draft.name}
            onChange={(event) => setDraft((prev) => ({ ...prev, name: event.target.value }))}
            placeholder={t('sessions.scheduledTasks.editor.taskName.placeholder')}
            aria-label={t('sessions.scheduledTasks.editor.taskName.label')}
            maxLength={80}
            className="mt-1 !h-9 !min-h-9 border-0 bg-transparent px-0 text-lg font-semibold shadow-none ring-0 hover:!bg-transparent focus:!bg-transparent focus:ring-0"
          />
        </header>
        <ScrollShadow className="min-h-0 flex-1 overflow-auto [scrollbar-gutter:stable]" size={64} hideTopShadow>
          <div className="px-6 pb-6 pt-2">{formBody}</div>
        </ScrollShadow>
        <footer className="shrink-0 border-t border-border/50 bg-background/95 px-6 py-3 backdrop-blur-sm">
          {footerRow}
        </footer>
      </section>
    );
  }

  if (presentation === 'mobile-panel') {
    if (!open) {
      return null;
    }
    return (
      <section className="flex min-h-0 flex-1 flex-col bg-background" aria-label={title}>
        <ScrollShadow className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden" size={48} hideTopShadow>
          <div className="w-full px-3 pb-6 pt-4">{formBody}</div>
        </ScrollShadow>
        <footer className="shrink-0 border-t border-border/50 bg-background/95 px-3 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] backdrop-blur-sm">
          {footerRow}
        </footer>
      </section>
    );
  }

  if (presentation === 'mobile-tab') {
    if (!open) {
      return null;
    }
    return (
      <section className="flex min-h-0 flex-1 flex-col bg-background" aria-label={title}>
        <MobileDetailNavigation
          title={title}
          backAriaLabel={t('header.actions.backAria')}
          onBack={() => onOpenChange(false)}
          backDisabled={saving}
        />
        <ScrollShadow className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden" size={48} hideTopShadow>
          <div className="pb-5 pt-4">
            <Input
              value={draft.name}
              onChange={(event) => setDraft((prev) => ({ ...prev, name: event.target.value }))}
              placeholder={t('sessions.scheduledTasks.editor.taskName.placeholder')}
              aria-label={t('sessions.scheduledTasks.editor.taskName.label')}
              maxLength={80}
              className="oc-mobile-detail-editor-title mb-5 !h-auto min-h-0 border-0 bg-transparent px-0 py-0 text-xl font-semibold shadow-none ring-0 hover:!bg-transparent focus:!bg-transparent focus:ring-0"
            />
            {formBody}
          </div>
        </ScrollShadow>
        <footer
          data-scheduled-editor-footer=""
          className="relative z-20 shrink-0 border-t border-border/50 bg-background/95 px-3 pb-[calc(1rem+var(--safe-area-inset-bottom,env(safe-area-inset-bottom,0px)))] pt-2 backdrop-blur-sm"
        >
          {footerRow}
        </footer>
      </section>
    );
  }

  if (isMobile) {
    return (
      <MobileOverlayPanel
        open={open}
        title={title}
        onClose={() => onOpenChange(false)}
        contentMaxHeightClassName="max-h-[min(80vh,640px)]"
        renderHeader={(closeButton) => (
          <div className="flex flex-col gap-1 border-b border-border/40 px-3 py-2">
            <div className="flex items-center justify-between gap-2">
              <h2 className="typography-ui-label font-semibold text-foreground">{title}</h2>
              {closeButton}
            </div>
            <p className="typography-micro text-muted-foreground">{description}</p>
          </div>
        )}
        footer={footerRow}
      >
        {formBody}
      </MobileOverlayPanel>
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && hasOpenFloatingMenu()) {
          return;
        }
        onOpenChange(next);
      }}
    >
      <DialogContent
        aria-describedby={descriptionId}
        className="!max-w-[720px] w-[90vw] h-[680px] max-h-[85vh] gap-0 p-0 overflow-hidden"
      >
        <DialogDescription id={descriptionId} className="sr-only">
          {description}
        </DialogDescription>

        <header className="shrink-0 px-4 sm:px-6 pt-5 pb-3">
          <div className="mx-auto w-full max-w-2xl">
            <DialogTitle className="typography-ui-label font-medium text-foreground">
              {title}
            </DialogTitle>
            <p className="typography-meta mt-0.5 text-muted-foreground">{description}</p>
          </div>
        </header>

        <ScrollShadow
          className="flex-1 min-h-0 overflow-auto [scrollbar-gutter:stable_both-edges]"
          size={64}
          hideTopShadow
        >
          <div className="mx-auto w-full max-w-2xl px-4 sm:px-6 pb-5">{formBody}</div>
        </ScrollShadow>

        <div className="shrink-0 px-4 sm:px-6 py-3">
          <div className="mx-auto w-full max-w-2xl">{footerRow}</div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
