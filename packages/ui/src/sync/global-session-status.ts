import { create } from 'zustand';
import type { Event } from '@/sync/types'

import { normalizeProjectPath } from '@/lib/projectResolution';

// Live busy/retry status for sessions in directories WITHOUT a synced child
// store. The global event stream (`/api/global/event/ws`) carries status
// events for every directory, but the sync dispatcher can only apply them to
// an existing child store — events for unopened directories used to be
// dropped. They land here instead, so cross-project consumers (the macOS tray)
// see live status for all sessions, not just the synced ones.
//
// Only non-idle entries are kept; absence means idle. Entries carry their
// directory so a one-shot per-directory snapshot can authoritatively replace
// that directory's slice (the server omits idle sessions from snapshots).

type ActiveStatusType = 'busy' | 'retry';

type GlobalSessionStatusEntry = { status: ActiveStatusType; directory: string };

type GlobalSessionStatusState = {
  statusById: Map<string, GlobalSessionStatusEntry>;
};

export const useGlobalSessionStatusStore = create<GlobalSessionStatusState>(() => ({
  statusById: new Map(),
}));

const normalizeStatusType = (type: unknown): ActiveStatusType | 'idle' =>
  type === 'busy' ? 'busy' : type === 'retry' ? 'retry' : 'idle';

// Both write paths normalize the directory key, so a one-shot snapshot can
// authoritatively replace entries written by events (and vice versa) even when
// the two sources format the same path differently (trailing slash, …).
const normalizeDirectory = (directory: string): string =>
  normalizeProjectPath(directory) ?? directory;

const setStatus = (
  sessionId: string,
  directory: string,
  status: ActiveStatusType | 'idle',
): void => {
  useGlobalSessionStatusStore.setState((state) => {
    const current = state.statusById.get(sessionId);
    if (status === 'idle') {
      if (!current) return state;
      const next = new Map(state.statusById);
      next.delete(sessionId);
      return { statusById: next };
    }
    if (current && current.status === status && current.directory === directory) return state;
    const next = new Map(state.statusById);
    next.set(sessionId, { status, directory });
    return { statusById: next };
  });
};

// Event-driven path: called by the sync dispatcher for status-bearing events
// whose directory has no child store. Mirrors the child reducer's semantics
// (`session.idle` / `session.error` both resolve to idle).
export const applyGlobalSessionStatusEvent = (
  directory: string,
  payload: Event,
): void => {
  switch (payload.type) {
    case 'session.status': {
      const props = payload.properties as { sessionID?: string; status?: { type?: string } } | undefined;
      if (typeof props?.sessionID !== 'string' || !props.sessionID) return;
      const status = normalizeStatusType(props.status?.type);
      setStatus(props.sessionID, normalizeDirectory(directory), status);
      return;
    }
    case 'session.idle':
    case 'session.error':
    case 'session.execution.succeeded':
    case 'session.execution.failed':
    case 'session.execution.interrupted': {
      const props = payload.properties as { sessionID?: string } | undefined;
      if (typeof props?.sessionID === 'string' && props.sessionID) {
        setStatus(props.sessionID, normalizeDirectory(directory), 'idle');
      }
      return;
    }
    case 'session.execution.started': {
      const props = payload.properties as { sessionID?: string } | undefined;
      if (typeof props?.sessionID === 'string' && props.sessionID) {
        setStatus(props.sessionID, normalizeDirectory(directory), 'busy');
      }
      return;
    }
    default:
      return;
  }
};

// One-shot path: an authoritative `/session/status?directory=X` snapshot used
// on connect/reconnect. Entries missing from the snapshot are idle now — cleared
// both by directory key and by the caller's session-id list (the server may
// report a canonicalized directory that differs from the key an event wrote,
// e.g. via symlinks). Seeds the initial state (events only deliver changes).
export const applyGlobalSessionStatusSnapshot = (
  rawDirectory: string,
  raw: Record<string, { type?: string }>,
  knownSessionIds?: Iterable<string>,
): void => {
  const directory = normalizeDirectory(rawDirectory);
  const known = new Set(knownSessionIds ?? []);
  useGlobalSessionStatusStore.setState((state) => {
    let changed = false;
    const next = new Map(state.statusById);

    for (const [sessionId, entry] of state.statusById) {
      if ((entry.directory === directory || known.has(sessionId)) && !(sessionId in raw)) {
        next.delete(sessionId);
        changed = true;
      }
    }

    for (const [sessionId, status] of Object.entries(raw)) {
      const type = normalizeStatusType(status?.type);
      const current = next.get(sessionId);
      if (type === 'idle') {
        if (current && current.directory === directory) {
          next.delete(sessionId);
          changed = true;
        }
        continue;
      }
      if (!current || current.status !== type || current.directory !== directory) {
        next.set(sessionId, { status: type, directory });
        changed = true;
      }
    }

    return changed ? { statusById: next } : state;
  });
};
