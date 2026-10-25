import * as gitHttp from '@/lib/gitApiHttp';
import type { GitWorktreeBootstrapStatus } from '@/lib/api/types';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { toast } from '@/components/ui';
import { formatMessage, useI18nStore, type I18nKey, type I18nParams } from '@/lib/i18n';
import { subscribeYuriEvents } from '@/lib/yuriEvents';

type WorktreeBootstrapState = GitWorktreeBootstrapStatus;
type WorktreeBootstrapFailureHandler = (status: GitWorktreeBootstrapStatus) => void;
type WorktreeBootstrapReadyHandler = (status: GitWorktreeBootstrapStatus) => void;
type WorktreeBootstrapListener = (directory: string, status: WorktreeBootstrapState) => void;

type BootstrapSettlement = {
  promise: Promise<GitWorktreeBootstrapStatus>;
  startCompensation: () => void;
  dispose: () => void;
};

type BootstrapWatcher = {
  cancelled: boolean;
  epoch: number;
  promise: Promise<void>;
  disposeSettlement: (() => void) | null;
};

type BootstrapWaiter = {
  promise: Promise<void>;
  dispose: () => void;
};

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 5 * 1000;

const normalizePath = (value: string): string => value.replace(/\\/g, '/').replace(/\/+$/, '') || value;

const state = new Map<string, WorktreeBootstrapState>();
const waiters = new Map<string, BootstrapWaiter>();
const watchers = new Map<string, BootstrapWatcher>();
const epochs = new Map<string, number>();
const listeners = new Set<WorktreeBootstrapListener>();
let eventSubscription: (() => void) | null = null;
let windowEventBound = false;

const getKey = (directory: string): string => normalizePath(directory);

const getEpoch = (key: string): number => epochs.get(key) ?? 0;

const bumpEpoch = (key: string): number => {
  const next = getEpoch(key) + 1;
  epochs.set(key, next);
  return next;
};

const getGitWorktreeBootstrapStatus = async (directory: string): Promise<GitWorktreeBootstrapStatus> => {
  const runtimeGit = getRegisteredRuntimeAPIs()?.git;
  if (runtimeGit?.worktree?.bootstrapStatus) {
    return runtimeGit.worktree.bootstrapStatus(directory);
  }
  if (runtimeGit?.getGitWorktreeBootstrapStatus) {
    return runtimeGit.getGitWorktreeBootstrapStatus(directory);
  }
  return gitHttp.getGitWorktreeBootstrapStatus(directory);
};

const notifyListeners = (directory: string, next: WorktreeBootstrapState): void => {
  for (const listener of listeners) {
    try {
      listener(directory, next);
    } catch {
      // One consumer cannot disrupt bootstrap waiters.
    }
  }
};

export const subscribeWorktreeBootstrapState = (listener: WorktreeBootstrapListener): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const setWorktreeBootstrapState = (directory: string, next: WorktreeBootstrapState): boolean => {
  const key = getKey(directory);
  if (!key) {
    return false;
  }
  const previous = state.get(key);
  const isTerminalUpgrade = previous?.status === 'pending' && next.status !== 'pending';
  if (
    previous
    && typeof previous.updatedAt === 'number'
    && Number.isFinite(previous.updatedAt)
    && typeof next.updatedAt === 'number'
    && Number.isFinite(next.updatedAt)
    && next.updatedAt < previous.updatedAt
    // Local markPending uses Date.now(); server ready/failed may carry a slightly
    // earlier updatedAt. Always allow pending → terminal so bootstrap cannot stick.
    && !isTerminalUpgrade
  ) {
    // Reject older HTTP seeds / delayed events so they cannot clobber a newer
    // ready/failed terminal state.
    return false;
  }
  state.set(key, next);
  if (next.status !== 'pending') {
    waiters.delete(key);
  }
  notifyListeners(key, next);
  return true;
};

export const applyWorktreeBootstrapStatusEvent = (
  directory: string,
  next: Pick<GitWorktreeBootstrapStatus, 'status' | 'error' | 'updatedAt'> | GitWorktreeBootstrapStatus,
): boolean => {
  const key = getKey(directory);
  if (!key) return false;
  const status = next.status === 'pending' || next.status === 'ready' || next.status === 'failed'
    ? next.status
    : null;
  if (!status) return false;
  return setWorktreeBootstrapState(key, {
    status,
    error: typeof next.error === 'string' && next.error.trim().length > 0 ? next.error.trim() : null,
    updatedAt: typeof next.updatedAt === 'number' && Number.isFinite(next.updatedAt) ? next.updatedAt : Date.now(),
  });
};

const ensureBootstrapEventSubscription = (): void => {
  if (!eventSubscription) {
    eventSubscription = subscribeYuriEvents((event) => {
      if (event.type !== 'worktree-bootstrap-status') return;
      applyWorktreeBootstrapStatusEvent(event.directory, event);
    });
  }

  if (typeof window === 'undefined' || windowEventBound) {
    return;
  }
  windowEventBound = true;
  window.addEventListener('yuri:worktree-bootstrap-status', ((event: Event) => {
    const detail = (event as CustomEvent<unknown>).detail;
    if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return;
    const record = detail as Record<string, unknown>;
    const directory = typeof record.directory === 'string' ? record.directory : '';
    if (!directory) return;
    applyWorktreeBootstrapStatusEvent(directory, {
      status: record.status as GitWorktreeBootstrapStatus['status'],
      error: typeof record.error === 'string' ? record.error : null,
      updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : Date.now(),
    });
  }) as EventListener);
};

export const markWorktreeBootstrapPending = (directory: string): void => {
  const key = getKey(directory);
  if (!key) {
    return;
  }
  ensureBootstrapEventSubscription();
  setWorktreeBootstrapState(key, {
    status: 'pending',
    error: null,
    updatedAt: Date.now(),
  });
};

export const clearWorktreeBootstrapState = (directory: string): void => {
  const key = getKey(directory);
  if (!key) {
    return;
  }
  bumpEpoch(key);
  const watcher = watchers.get(key);
  if (watcher) {
    watcher.cancelled = true;
    watcher.disposeSettlement?.();
    watcher.disposeSettlement = null;
    watchers.delete(key);
  }
  const waiter = waiters.get(key);
  if (waiter) {
    waiter.dispose();
    waiters.delete(key);
  }
  state.delete(key);
};

export const getWorktreeBootstrapState = (directory: string): WorktreeBootstrapState | null => {
  const key = getKey(directory);
  if (!key) {
    return null;
  }
  return state.get(key) ?? null;
};

const t = (key: I18nKey, params?: I18nParams): string => {
  const dictionary = useI18nStore.getState().dictionary;
  return formatMessage(dictionary, key, params);
};

const createFailedStatus = (error: string): GitWorktreeBootstrapStatus => ({
  status: 'failed',
  error,
  updatedAt: Date.now(),
});

const markBootstrapFailed = (
  directory: string,
  error: string,
  onFailed?: WorktreeBootstrapFailureHandler,
): GitWorktreeBootstrapStatus => {
  const failed = createFailedStatus(error);
  setWorktreeBootstrapState(directory, failed);
  onFailed?.(failed);
  return failed;
};

const seedBootstrapStatus = async (
  directory: string,
  isCurrent: () => boolean = () => true,
): Promise<GitWorktreeBootstrapStatus | null> => {
  try {
    const result = await getGitWorktreeBootstrapStatus(directory);
    if (!isCurrent()) return null;
    const applied = setWorktreeBootstrapState(directory, result);
    if (!applied) {
      return getWorktreeBootstrapState(directory);
    }
    return result;
  } catch {
    return null;
  }
};

const waitForBootstrapSettlement = (
  directory: string,
  timeoutMs: number,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
): BootstrapSettlement => {
  const key = getKey(directory);
  const epoch = getEpoch(key);
  ensureBootstrapEventSubscription();

  let settled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let pollInFlight = false;
  let unsubscribe: (() => void) | null = null;
  let rejectPromise: ((error: Error) => void) | null = null;
  let check: (status: WorktreeBootstrapState | null | undefined) => void = () => {};

  const clearTimers = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  };

  const startCompensation = () => {
    if (settled || pollTimer) return;
    const compensationIntervalMs = Number.isFinite(pollIntervalMs)
      ? Math.max(1, pollIntervalMs)
      : DEFAULT_POLL_INTERVAL_MS;
    pollTimer = setInterval(() => {
      if (settled || pollInFlight) return;
      pollInFlight = true;
      void seedBootstrapStatus(directory, () => !settled && getEpoch(key) === epoch)
        .finally(() => {
          pollInFlight = false;
        });
    }, compensationIntervalMs);
  };

  const dispose = (error?: Error) => {
    if (settled) return;
    settled = true;
    clearTimers();
    unsubscribe?.();
    unsubscribe = null;
    if (error) {
      rejectPromise?.(error);
    }
  };

  const promise = new Promise<GitWorktreeBootstrapStatus>((resolve, reject) => {
    rejectPromise = reject;

    const finish = (result: () => void) => {
      if (settled) return;
      settled = true;
      clearTimers();
      unsubscribe?.();
      unsubscribe = null;
      result();
    };

    check = (status: WorktreeBootstrapState | null | undefined) => {
      if (!status) return;
      if (status.status === 'ready') {
        finish(() => resolve(status));
        return;
      }
      if (status.status === 'failed') {
        finish(() => reject(new Error(status.error || 'Worktree bootstrap failed')));
      }
    };

    unsubscribe = subscribeWorktreeBootstrapState((changedDirectory, status) => {
      if (getKey(changedDirectory) !== key) return;
      check(status);
    });

    timer = setTimeout(() => {
      finish(() => {
        const failed = markBootstrapFailed(directory, t('worktree.bootstrap.toast.timeoutDescription'));
        reject(new Error(failed.error || 'Timed out waiting for worktree bootstrap'));
      });
    }, Math.max(0, timeoutMs));

    check(state.get(key));
  });

  // Dispose/cancel can reject before any awaiter attaches; keep the rejection
  // observable to awaiters while avoiding unhandledRejection noise.
  void promise.catch(() => undefined);

  return {
    promise,
    startCompensation,
    dispose: () => dispose(new Error('Worktree bootstrap wait cancelled')),
  };
};

const watchBootstrapUntilSettled = async (
  directory: string,
  watcher: BootstrapWatcher,
  timeoutMs: number,
  pollIntervalMs: number,
  onFailed?: WorktreeBootstrapFailureHandler,
  onReady?: WorktreeBootstrapReadyHandler,
): Promise<void> => {
  const key = getKey(directory);
  // Subscribe before the one-shot seed so a status event that races the GET
  // cannot be missed between seed completion and waiter attachment.
  const settlement = waitForBootstrapSettlement(directory, timeoutMs, pollIntervalMs);
  watcher.disposeSettlement = settlement.dispose;

  const seeded = await seedBootstrapStatus(
    directory,
    () => !watcher.cancelled && watchers.get(key) === watcher && getEpoch(key) === watcher.epoch,
  );
  if (watcher.cancelled || watchers.get(key) !== watcher) {
    settlement.dispose();
    return;
  }

  if (seeded?.status === 'ready') {
    settlement.dispose();
    onReady?.(seeded);
    return;
  }
  if (seeded?.status === 'failed') {
    settlement.dispose();
    onFailed?.(seeded);
    toast.error(t('worktree.bootstrap.toast.failed'), {
      description: seeded.error || t('worktree.bootstrap.toast.failedDescription'),
    });
    return;
  }
  settlement.startCompensation();

  try {
    const ready = await settlement.promise;
    if (watcher.cancelled || watchers.get(key) !== watcher) return;
    onReady?.(ready);
  } catch (error) {
    if (watcher.cancelled || watchers.get(key) !== watcher) return;
    const current = getWorktreeBootstrapState(directory);
    if (current?.status === 'failed') {
      onFailed?.(current);
      toast.error(t('worktree.bootstrap.toast.failed'), {
        description: current.error || t('worktree.bootstrap.toast.failedDescription'),
      });
      return;
    }
    const failed = markBootstrapFailed(
      directory,
      error instanceof Error ? error.message : String(error),
      onFailed,
    );
    toast.error(t('worktree.bootstrap.toast.failed'), {
      description: failed.error || t('worktree.bootstrap.toast.failedDescription'),
    });
  }
};

export const startWorktreeBootstrapWatcher = (
  directory: string,
  options?: {
    timeoutMs?: number;
    /** Authoritative bootstrap-status compensation read interval. */
    pollIntervalMs?: number;
    onFailed?: WorktreeBootstrapFailureHandler;
    onReady?: WorktreeBootstrapReadyHandler;
  },
): void => {
  const key = getKey(directory);
  if (!key) {
    return;
  }

  const current = state.get(key);
  if (current?.status !== 'pending') {
    return;
  }

  if (watchers.has(key)) {
    return;
  }

  const watcher: BootstrapWatcher = {
    cancelled: false,
    epoch: getEpoch(key),
    promise: Promise.resolve(),
    disposeSettlement: null,
  };
  watcher.promise = watchBootstrapUntilSettled(
    directory,
    watcher,
    options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    options?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    options?.onFailed,
    options?.onReady,
  ).finally(() => {
    if (watchers.get(key) === watcher) {
      watchers.delete(key);
    }
  });
  watchers.set(key, watcher);
};

export const waitForWorktreeBootstrap = async (directory: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<void> => {
  const key = getKey(directory);
  if (!key) {
    return;
  }

  const current = state.get(key);
  if (!current) {
    return;
  }

  if (current.status === 'ready') {
    return;
  }
  if (current.status === 'failed') {
    throw new Error(current.error || 'Worktree bootstrap failed');
  }

  const existing = waiters.get(key);
  if (existing) {
    return existing.promise;
  }

  let disposeSettlement = () => {};
  const epoch = getEpoch(key);
  const pending = (async () => {
    const settlement = waitForBootstrapSettlement(directory, timeoutMs, DEFAULT_POLL_INTERVAL_MS);
    disposeSettlement = settlement.dispose;
    const seeded = await seedBootstrapStatus(
      directory,
      () => getEpoch(key) === epoch,
    );
    if (getEpoch(key) !== epoch) {
      settlement.dispose();
      return;
    }
    if (seeded?.status === 'ready') {
      settlement.dispose();
      return;
    }
    if (seeded?.status === 'failed') {
      settlement.dispose();
      throw new Error(seeded.error || 'Worktree bootstrap failed');
    }
    settlement.startCompensation();
    await settlement.promise;
  })().finally(() => {
    const waiter = waiters.get(key);
    if (waiter?.promise === pending) {
      waiters.delete(key);
    }
  });
  waiters.set(key, {
    promise: pending,
    dispose: () => disposeSettlement(),
  });
  return pending;
};
