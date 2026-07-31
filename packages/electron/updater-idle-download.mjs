// Idle-gated update downloads: only pull the package once the OS reports the
// user is away (powerMonitor idle/locked). Checking for updates can happen any
// time; the bandwidth-heavy step waits for a quiet moment.

export const IDLE_THRESHOLD_SECONDS = 60;
export const IDLE_POLL_INTERVAL_MS = 15_000;

/** OS idle states that are safe to start a background update download. */
export const isSystemIdleForUpdateDownload = (idleState) =>
  idleState === 'idle' || idleState === 'locked';

/**
 * Poll powerMonitor until the system is idle/locked, then run downloadUpdate
 * once. Manual downloads should call stop() (or share the same download lock)
 * so the two paths never fight.
 */
export const createIdleUpdateDownloadScheduler = ({
  getIdleState,
  downloadUpdate,
  isPendingDownload,
  idleThresholdSeconds = IDLE_THRESHOLD_SECONDS,
  pollIntervalMs = IDLE_POLL_INTERVAL_MS,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  log = console,
} = {}) => {
  let timer = null;
  let inFlight = false;
  let stopped = true;

  const clearTimer = () => {
    if (timer == null) return;
    clearTimeoutFn(timer);
    timer = null;
  };

  const stop = () => {
    stopped = true;
    clearTimer();
  };

  const arm = (delayMs) => {
    clearTimer();
    if (stopped) return;
    timer = setTimeoutFn(() => {
      timer = null;
      void tick();
    }, delayMs);
  };

  const tick = async () => {
    if (stopped || inFlight) return;
    if (typeof isPendingDownload === 'function' && !isPendingDownload()) {
      stop();
      return;
    }

    let idleState = 'unknown';
    try {
      idleState = getIdleState(idleThresholdSeconds);
    } catch (error) {
      log.warn?.('[electron] idle state probe failed', error);
      arm(pollIntervalMs);
      return;
    }

    if (!isSystemIdleForUpdateDownload(idleState)) {
      arm(pollIntervalMs);
      return;
    }

    inFlight = true;
    try {
      await downloadUpdate();
      // Success: leave stopped so we don't re-download until the next check
      // schedules us again (only when another version is pending).
      stop();
    } catch (error) {
      log.warn?.('[electron] idle update download failed', error);
      inFlight = false;
      if (!stopped && typeof isPendingDownload === 'function' && isPendingDownload()) {
        arm(pollIntervalMs);
      }
      return;
    } finally {
      inFlight = false;
    }
  };

  const schedule = () => {
    if (typeof isPendingDownload === 'function' && !isPendingDownload()) {
      stop();
      return;
    }
    // Re-arm even if a previous run stopped after success — a newer pending
    // update may have arrived from a later check.
    stopped = false;
    if (inFlight || timer != null) return;
    // Probe immediately so an already-idle machine starts downloading without
    // waiting a full poll interval.
    arm(0);
  };

  return {
    schedule,
    stop,
    isInFlight: () => inFlight,
  };
};
