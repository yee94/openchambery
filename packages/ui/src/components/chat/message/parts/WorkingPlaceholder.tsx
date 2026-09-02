import React from 'react';
import { useEvent } from '@reactuses/core';
import { useI18n } from '@/lib/i18n';
import { formatGoalDuration } from '@/lib/sessionGoalMetadata';
import { MorphOrb } from './MorphOrb';

interface WorkingPlaceholderProps {
  isWorking: boolean;
  isMobile: boolean;
  statusText: string | null;
  isGenericStatus?: boolean;
  isWaitingForPermission?: boolean;
  retryInfo?: { attempt?: number; next?: number } | null;
  turnStartedAt?: number;
  agentName?: string;
  /** Authoritative turn settle — hide immediately, no step-gap linger. */
  isTurnSettled?: boolean;
}

const STATUS_DISPLAY_TIME_MS = 1200;
/** Keep the last status painted briefly after isWorking drops so step gaps do not collapse the row. */
const STATUS_CLEAR_LINGER_MS = 600;

const EPOCH_SECONDS_THRESHOLD = 1_000_000_000;
const EPOCH_MILLISECONDS_THRESHOLD = 1_000_000_000_000;

const toRetryTargetTimestamp = (next: number): number => {
  if (next >= EPOCH_MILLISECONDS_THRESHOLD) {
    return next;
  }
  if (next >= EPOCH_SECONDS_THRESHOLD) {
    return next * 1000;
  }
  return Date.now() + next;
};

export function WorkingPlaceholder({
  isWorking,
  isMobile,
  statusText,
  isGenericStatus,
  isWaitingForPermission,
  retryInfo,
  turnStartedAt,
  isTurnSettled = false,
}: WorkingPlaceholderProps) {
  const { locale, t } = useI18n();
  const [displayedText, setDisplayedText] = React.useState<string | null>(null);
  const [displayedPermission, setDisplayedPermission] = React.useState<boolean>(false);
  const displayedTextRef = React.useRef(displayedText);
  const displayedPermissionRef = React.useRef(displayedPermission);
  const displayedGenericRef = React.useRef(false);
  displayedTextRef.current = displayedText;
  displayedPermissionRef.current = displayedPermission;

  const statusShownAtRef = React.useRef<number>(0);
  const queuedStatusRef = React.useRef<{ text: string; permission: boolean; generic: boolean } | null>(null);
  const processQueueTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearLingerTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  // Countdown state for retry mode
  const [retryCountdown, setRetryCountdown] = React.useState<number | null>(null);
  const [now, setNow] = React.useState(() => Date.now());

  React.useEffect(() => {
    if (!isWorking || typeof turnStartedAt !== 'number' || retryInfo) {
      return undefined;
    }
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, [isWorking, turnStartedAt, retryInfo]);

  React.useEffect(() => {
    const rawNext = retryInfo?.next;
    if (!rawNext || rawNext <= 0) {
      setRetryCountdown(null);
      return;
    }

    const retryTargetAt = toRetryTargetTimestamp(rawNext);

    const update = () => {
      const remaining = Math.max(0, retryTargetAt - Date.now());
      setRetryCountdown(Math.ceil(remaining / 1000));
    };

    update();
    const id = setInterval(update, 500);
    return () => clearInterval(id);
  }, [retryInfo?.next, retryInfo?.attempt]);

  const clearTimers = useEvent(() => {
    if (processQueueTimerRef.current) {
      clearTimeout(processQueueTimerRef.current);
      processQueueTimerRef.current = null;
    }
    if (clearLingerTimerRef.current) {
      clearTimeout(clearLingerTimerRef.current);
      clearLingerTimerRef.current = null;
    }
  });

  const showStatus = useEvent((text: string, permission: boolean, generic = false) => {
    clearTimers();
    queuedStatusRef.current = null;
    setDisplayedText(text);
    setDisplayedPermission(permission);
    displayedGenericRef.current = generic;
    statusShownAtRef.current = Date.now();
  });

  const scheduleQueueProcess = useEvent(() => {
    if (processQueueTimerRef.current) return;
    const elapsed = Date.now() - statusShownAtRef.current;
    const remaining = Math.max(0, STATUS_DISPLAY_TIME_MS - elapsed);
    processQueueTimerRef.current = setTimeout(() => {
      processQueueTimerRef.current = null;

      const queued = queuedStatusRef.current;
      if (queued) {
        showStatus(queued.text, queued.permission, queued.generic);
      }
    }, remaining);
  });

  React.useEffect(() => {
    if (isTurnSettled) {
      clearTimers();
      queuedStatusRef.current = null;
      if (displayedTextRef.current) {
        setDisplayedText(null);
        setDisplayedPermission(false);
        displayedGenericRef.current = false;
      }
      return;
    }

    if (!isWorking) {
      // Cancel status-queue work; keep the painted text briefly so a step gap
      // that flips isWorking off/on does not collapse the status row (±28px).
      if (processQueueTimerRef.current) {
        clearTimeout(processQueueTimerRef.current);
        processQueueTimerRef.current = null;
      }
      queuedStatusRef.current = null;
      if (!displayedTextRef.current) {
        return;
      }
      if (clearLingerTimerRef.current) {
        return;
      }
      clearLingerTimerRef.current = setTimeout(() => {
        clearLingerTimerRef.current = null;
        setDisplayedText(null);
        setDisplayedPermission(false);
        displayedGenericRef.current = false;
      }, STATUS_CLEAR_LINGER_MS);
      return;
    }

    // Working again — cancel a pending clear from a brief idle flap.
    if (clearLingerTimerRef.current) {
      clearTimeout(clearLingerTimerRef.current);
      clearLingerTimerRef.current = null;
    }

    // Retry state has its own display — skip the normal queue
    if (retryInfo) {
      clearTimers();
      queuedStatusRef.current = null;
      return;
    }

    const incomingText = isWaitingForPermission ? t('chat.assistantStatus.waitingForPermission') : statusText;
    const incomingPermission = Boolean(isWaitingForPermission);
    const incomingGeneric = Boolean(isGenericStatus) && !incomingPermission;

    if (!incomingText) {
      return;
    }

    if (!displayedTextRef.current) {
      showStatus(incomingText, incomingPermission, incomingGeneric);
      return;
    }

    if (incomingText === displayedTextRef.current && incomingPermission === displayedPermissionRef.current) {
      return;
    }

    // Ignore generic→generic churn entirely (do not queue).
    if (incomingGeneric && displayedGenericRef.current) {
      return;
    }

    // Generic is a low-info fallback: never paint it immediately over a
    // specific status — always wait out the display window via the queue.
    // Specific / permission remain progressive and paint immediately.
    if (incomingGeneric) {
      queuedStatusRef.current = { text: incomingText, permission: incomingPermission, generic: incomingGeneric };
      scheduleQueueProcess();
      return;
    }

    showStatus(incomingText, incomingPermission, incomingGeneric);
    // useEvent identities are stable; rerun only when status inputs change.
  }, [
    isWorking,
    isTurnSettled,
    statusText,
    isGenericStatus,
    isWaitingForPermission,
    retryInfo,
    t,
  ]);

  React.useEffect(() => () => clearTimers(), []);

  // Settled turn: hide in this commit. Do not wait for the linger timer or
  // the clear-state effect — that afterglow is what jitters height after
  // Changes chrome is already visible.
  if (isTurnSettled) {
    return null;
  }

  // Linger: keep painting after isWorking drops until the clear timer fires.
  if (!isWorking && !displayedText) {
    return null;
  }

  // Retry state: show countdown and attempt info
  if (retryInfo && isWorking) {
    const retryDuration = retryCountdown !== null && retryCountdown > 0
      ? new Intl.RelativeTimeFormat(locale, { numeric: 'always', style: 'short' }).format(retryCountdown, 'second')
      : null;
    const retryText = retryDuration
      ? retryInfo.attempt && retryInfo.attempt > 1
        ? t('chat.assistantStatus.retryingInAttempt', { duration: retryDuration, attempt: retryInfo.attempt })
        : t('chat.assistantStatus.retryingIn', { duration: retryDuration })
      : retryInfo.attempt && retryInfo.attempt > 1
        ? t('chat.assistantStatus.retryingAttempt', { attempt: retryInfo.attempt })
        : t('chat.assistantStatus.retrying');

    return (
      <div
        className="flex h-full items-center text-muted-foreground"
        role="status"
        aria-live="polite"
        aria-label={retryText}
      >
        <span className={`flex min-w-0 items-center ${isMobile ? "gap-1 typography-meta !text-[length:var(--text-meta)]" : "gap-1.5 typography-ui-header"}`}>
          <span className={`inline-flex flex-none items-center justify-center ${isMobile ? 'h-5 w-4' : 'h-6 w-3.5'}`}>
            <MorphOrb isMobile={isMobile} />
          </span>
          <span className="animate-text-shimmer min-w-0 truncate whitespace-nowrap">
            {retryText}
          </span>
        </span>
      </div>
    );
  }

  if (!displayedText) {
    return null;
  }

  const label = displayedText;
  const elapsed = typeof turnStartedAt === 'number' && isWorking
    ? formatGoalDuration(Math.max(0, now - turnStartedAt))
    : null;

  return (
    <div
      className="flex h-full items-center text-muted-foreground"
      role="status"
      aria-live={displayedPermission ? 'assertive' : 'polite'}
      aria-label={label}
      data-waiting={displayedPermission ? 'true' : undefined}
    >
      <span className={`flex min-w-0 items-center ${isMobile ? "gap-1 typography-meta !text-[length:var(--text-meta)]" : "gap-1.5 typography-ui-header"}`}>
        <span className={`inline-flex flex-none items-center justify-center ${isMobile ? 'h-5 w-4' : 'h-6 w-3.5'}`}>
          <MorphOrb isMobile={isMobile} />
        </span>
        <span className="animate-text-shimmer min-w-0 truncate whitespace-nowrap">
          {label}
        </span>
        {elapsed ? (
          <span className="typography-meta shrink-0 font-light text-muted-foreground/70 tabular-nums" aria-hidden="true">
            {elapsed}
          </span>
        ) : null}
      </span>
    </div>
  );
}
