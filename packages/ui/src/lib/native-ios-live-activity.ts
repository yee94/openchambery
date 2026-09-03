import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';

import { isIosNativeUiEnabled } from '@/lib/iosNativeUi';
import { getClientPlatform, isCapacitorApp } from '@/lib/platform';

const NATIVE_IOS_LIVE_ACTIVITY_PLUGIN = 'OpenChamberLiveActivity';
export const NATIVE_LIVE_ACTIVITY_BUSY_START_MS = 5_000;
export const NATIVE_LIVE_ACTIVITY_COMPLETE_DISMISSAL_SECONDS = 900;
export const NATIVE_LIVE_ACTIVITY_ERROR_DISMISSAL_SECONDS = 3600;
export const NATIVE_LIVE_ACTIVITY_COMMAND_RETRY_MS = 250;

export type NativeLiveActivityStatus =
  | 'working'
  | 'tool'
  | 'retry'
  | 'input'
  | 'permission'
  | 'stale'
  | 'complete'
  | 'error';

type NativeLiveActivityFields = {
  sessionId: string;
  startedAt: number;
  status: NativeLiveActivityStatus;
  eventVersion: number;
  updatedAt: number;
  endedAt?: number;
  dismissalSeconds?: number;
};

export type NativeLiveActivityPushTokenEvent = {
  activityId: string;
  sessionId: string;
  token: string;
};

export type NativeLiveActivityPlugin = {
  isSupported: () => Promise<{ supported: boolean }>;
  start: (options: {
    sessionId: string;
    startedAt: number;
    status: NativeLiveActivityStatus;
    eventVersion: number;
    updatedAt: number;
    endedAt?: number;
  }) => Promise<{ activityId?: string }>;
  update: (options: {
    sessionId: string;
    startedAt: number;
    status: NativeLiveActivityStatus;
    eventVersion: number;
    updatedAt: number;
    endedAt?: number;
  }) => Promise<void>;
  end: (options: {
    sessionId: string;
    startedAt: number;
    status: NativeLiveActivityStatus;
    eventVersion: number;
    updatedAt: number;
    endedAt?: number;
    dismissalSeconds?: number;
  }) => Promise<void>;
  addListener: (
    event: 'pushToken',
    listener: (payload: NativeLiveActivityPushTokenEvent) => void,
  ) => Promise<PluginListenerHandle>;
};

const OpenChamberLiveActivity = registerPlugin<NativeLiveActivityPlugin>(NATIVE_IOS_LIVE_ACTIVITY_PLUGIN);

type NativeLiveActivityAvailabilityInput = {
  isCapacitor: boolean;
  platform: string;
  pluginAvailable: boolean;
  nativeUiEnabled?: boolean;
};

export const evaluateNativeIosLiveActivityAvailability = (
  input: NativeLiveActivityAvailabilityInput,
): boolean => (
  input.isCapacitor
  && input.platform === 'ios'
  && input.pluginAvailable
  && input.nativeUiEnabled !== false
);

/** True only on Capacitor native iOS when the Live Activity plugin is registered and native UI is on. */
export function canUseNativeIosLiveActivity(): boolean {
  if (typeof window === 'undefined') return false;
  return evaluateNativeIosLiveActivityAvailability({
    isCapacitor: isCapacitorApp(),
    platform: getClientPlatform(),
    pluginAvailable: Capacitor.isPluginAvailable(NATIVE_IOS_LIVE_ACTIVITY_PLUGIN),
    nativeUiEnabled: isIosNativeUiEnabled(),
  });
}

export const getNativeIosLiveActivityPlugin = (): NativeLiveActivityPlugin => OpenChamberLiveActivity;

export type NativeLiveActivityObservation = {
  sessionId: string | null;
  statusType: string | undefined;
  hasPendingPermissions: boolean;
  hasPendingQuestions: boolean;
  hasSessionError: boolean;
  errorAt?: number;
  now: number;
  connected: boolean;
};

export type NativeLiveActivityState = {
  trackedSessionId: string | null;
  started: boolean;
  startedAt: number | null;
  busySince: number | null;
  lastStatus: NativeLiveActivityStatus | null;
  eventVersion: number;
};

type NativeLiveActivityCommand =
  | { type: 'wait'; delayMs: number }
  | { type: 'start'; payload: NativeLiveActivityFields }
  | { type: 'update'; payload: NativeLiveActivityFields }
  | { type: 'end'; payload: NativeLiveActivityFields };

type NativeLiveActivityReduceResult = {
  state: NativeLiveActivityState;
  commands: NativeLiveActivityCommand[];
};

const IMMEDIATE_START_STATUSES: ReadonlySet<NativeLiveActivityStatus> = new Set([
  'permission',
  'input',
  'retry',
]);

export const createInitialNativeLiveActivityState = (): NativeLiveActivityState => ({
  trackedSessionId: null,
  started: false,
  startedAt: null,
  busySince: null,
  lastStatus: null,
  eventVersion: 0,
});

/** Monotonic ActivityKit version: max(floor(now ms), previous+1). Survives JS restarts. */
export const nextNativeLiveActivityEventVersion = (now: number, previous: number): number => (
  Math.max(Math.floor(now), previous + 1)
);

export const rollbackNativeLiveActivityState = (input: {
  failedEpoch: number;
  currentEpoch: number;
  previous: NativeLiveActivityState;
  current: NativeLiveActivityState;
}): NativeLiveActivityState => (
  input.failedEpoch === input.currentEpoch ? input.previous : input.current
);

export const shouldScheduleNativeLiveActivityRetry = (input: {
  failedEpoch: number;
  currentEpoch: number;
  retryCount: number;
}): boolean => input.failedEpoch === input.currentEpoch && input.retryCount < 1;

/**
 * Map live session status + pending permission/question onto the plugin enum.
 * SessionStatus is idle|busy|retry. Live error comes from `session_error_at`,
 * not persisted history. tool is never inferred without message-delta.
 */
export const mapNativeLiveActivityPhase = (input: {
  statusType: string | undefined;
  hasPendingPermissions: boolean;
  hasPendingQuestions: boolean;
  hasSessionError?: boolean;
}): NativeLiveActivityStatus | null => {
  if (input.hasSessionError) return 'error';
  if (input.hasPendingPermissions) return 'permission';
  if (input.hasPendingQuestions) return 'input';
  if (input.statusType === 'retry') return 'retry';
  if (input.statusType === 'busy') return 'working';
  if (input.statusType === 'idle') return 'complete';
  return null;
};

const flattenLiveActivityPayload = (payload: NativeLiveActivityFields): NativeLiveActivityFields => {
  const next: NativeLiveActivityFields = {
    sessionId: payload.sessionId,
    startedAt: payload.startedAt,
    status: payload.status,
    eventVersion: payload.eventVersion,
    updatedAt: payload.updatedAt,
  };
  if (payload.endedAt !== undefined) next.endedAt = payload.endedAt;
  if (payload.dismissalSeconds !== undefined) next.dismissalSeconds = payload.dismissalSeconds;
  return next;
};

const endActivity = (
  state: NativeLiveActivityState,
  now: number,
  status: NativeLiveActivityStatus,
  dismissalSeconds: number,
): NativeLiveActivityReduceResult => {
  const sessionId = state.trackedSessionId;
  if (!sessionId || !state.started) {
    return { state: createInitialNativeLiveActivityState(), commands: [] };
  }
  const eventVersion = nextNativeLiveActivityEventVersion(now, state.eventVersion);
  return {
    state: createInitialNativeLiveActivityState(),
    commands: [{
      type: 'end',
      payload: flattenLiveActivityPayload({
        sessionId,
        startedAt: state.startedAt ?? now,
        status,
        eventVersion,
        updatedAt: now,
        endedAt: now,
        dismissalSeconds,
      }),
    }],
  };
};

const startActivity = (
  sessionId: string,
  status: NativeLiveActivityStatus,
  startedAt: number,
  now: number,
  previousVersion: number,
): NativeLiveActivityReduceResult => {
  const eventVersion = nextNativeLiveActivityEventVersion(now, previousVersion);
  return {
    state: {
      trackedSessionId: sessionId,
      started: true,
      startedAt,
      busySince: null,
      lastStatus: status,
      eventVersion,
    },
    commands: [{
      type: 'start',
      payload: flattenLiveActivityPayload({
        sessionId,
        startedAt,
        status,
        eventVersion,
        updatedAt: now,
      }),
    }],
  };
};

const evaluateTrackedSession = (
  state: NativeLiveActivityState,
  obs: NativeLiveActivityObservation,
  sessionId: string,
): NativeLiveActivityReduceResult => {
  const phase = mapNativeLiveActivityPhase(obs);
  let busySince = state.busySince;
  if (phase === 'working') {
    busySince ??= obs.now;
  } else if (!state.started && !phase) {
    busySince = null;
  } else if (!state.started && phase === 'complete') {
    busySince = null;
  } else if (!state.started && phase === 'error') {
    busySince = null;
  }

  if (!state.started) {
    if (phase === 'working') {
      const elapsed = obs.now - (busySince ?? obs.now);
      const remaining = NATIVE_LIVE_ACTIVITY_BUSY_START_MS - elapsed;
      if (remaining > 0) {
        return {
          state: {
            ...state,
            trackedSessionId: sessionId,
            busySince,
          },
          commands: [{ type: 'wait', delayMs: remaining }],
        };
      }
    } else if (!phase || !IMMEDIATE_START_STATUSES.has(phase)) {
      return {
        state: {
          ...createInitialNativeLiveActivityState(),
          trackedSessionId: sessionId,
        },
        commands: [],
      };
    }

    const startedAt = busySince ?? obs.now;
    return startActivity(sessionId, phase as NativeLiveActivityStatus, startedAt, obs.now, state.eventVersion);
  }

  if (phase === 'complete') {
    return endActivity({ ...state, busySince }, obs.now, 'complete', NATIVE_LIVE_ACTIVITY_COMPLETE_DISMISSAL_SECONDS);
  }
  if (phase === 'error') {
    return endActivity({ ...state, busySince }, obs.now, 'error', NATIVE_LIVE_ACTIVITY_ERROR_DISMISSAL_SECONDS);
  }
  if (!phase || phase === state.lastStatus) {
    return {
      state: {
        ...state,
        trackedSessionId: sessionId,
        busySince,
      },
      commands: [],
    };
  }

  const eventVersion = nextNativeLiveActivityEventVersion(obs.now, state.eventVersion);
  return {
    state: {
      trackedSessionId: sessionId,
      started: true,
      startedAt: state.startedAt ?? obs.now,
      busySince: phase === 'working' ? busySince : null,
      lastStatus: phase,
      eventVersion,
    },
    commands: [{
      type: 'update',
      payload: flattenLiveActivityPayload({
        sessionId,
        startedAt: state.startedAt ?? obs.now,
        status: phase,
        eventVersion,
        updatedAt: obs.now,
      }),
    }],
  };
};

const updateActivity = (
  state: NativeLiveActivityState,
  status: NativeLiveActivityStatus,
  now: number,
): NativeLiveActivityReduceResult => {
  const sessionId = state.trackedSessionId;
  if (!sessionId || !state.started) {
    return { state, commands: [] };
  }
  const eventVersion = nextNativeLiveActivityEventVersion(now, state.eventVersion);
  return {
    state: {
      ...state,
      busySince: null,
      lastStatus: status,
      eventVersion,
    },
    commands: [{
      type: 'update',
      payload: flattenLiveActivityPayload({
        sessionId,
        startedAt: state.startedAt ?? now,
        status,
        eventVersion,
        updatedAt: now,
      }),
    }],
  };
};

/**
 * Pure Live Activity reducer. One selected session, one activity.
 * Disconnect clears a pending busy timer and leaves a running activity
 * for authoritative session state to finish later.
 */
export const reduceNativeLiveActivity = (
  state: NativeLiveActivityState,
  obs: NativeLiveActivityObservation,
): NativeLiveActivityReduceResult => {
  if (!obs.connected) {
    const next = state.busySince === null ? state : { ...state, busySince: null };
    if (!next.started || next.lastStatus === 'stale' || !next.trackedSessionId) {
      return { state: next, commands: [] };
    }
    return updateActivity(next, 'stale', obs.now);
  }

  const commands: NativeLiveActivityCommand[] = [];
  let current = state;

  if (current.trackedSessionId && current.trackedSessionId !== obs.sessionId) {
    if (current.started) {
      const ended = endActivity(
        current,
        obs.now,
        current.lastStatus ?? 'complete',
        0,
      );
      commands.push(...ended.commands);
      current = ended.state;
    } else {
      current = createInitialNativeLiveActivityState();
    }
  }

  if (!obs.sessionId) {
    if (current.started) {
      const ended = endActivity(
        current,
        obs.now,
        'complete',
        NATIVE_LIVE_ACTIVITY_COMPLETE_DISMISSAL_SECONDS,
      );
      return { state: ended.state, commands: [...commands, ...ended.commands] };
    }
    return { state: createInitialNativeLiveActivityState(), commands };
  }

  const next = evaluateTrackedSession(current, obs, obs.sessionId);
  return { state: next.state, commands: [...commands, ...next.commands] };
};

/** Plugin timestamps are unix seconds (`Date(timeIntervalSince1970:)`). Reducer state stays in ms. */
export const toNativeLiveActivityTimestamp = (ms: number): number => ms / 1000;

const toPluginFields = (payload: NativeLiveActivityFields): NativeLiveActivityFields => {
  const fields: NativeLiveActivityFields = {
    sessionId: payload.sessionId,
    startedAt: toNativeLiveActivityTimestamp(payload.startedAt),
    status: payload.status,
    eventVersion: payload.eventVersion,
    updatedAt: toNativeLiveActivityTimestamp(payload.updatedAt),
  };
  if (payload.endedAt !== undefined) {
    fields.endedAt = toNativeLiveActivityTimestamp(payload.endedAt);
  }
  if (payload.dismissalSeconds !== undefined) {
    fields.dismissalSeconds = payload.dismissalSeconds;
  }
  return fields;
};

export const applyNativeLiveActivityCommand = (
  available: boolean,
  plugin: NativeLiveActivityPlugin,
  command: NativeLiveActivityCommand,
): Promise<unknown> => {
  if (!available) return Promise.resolve();
  if (command.type === 'wait') return Promise.resolve();
  const fields = toPluginFields(command.payload);
  if (command.type === 'start') {
    return plugin.start({
      sessionId: fields.sessionId,
      startedAt: fields.startedAt,
      status: fields.status,
      eventVersion: fields.eventVersion,
      updatedAt: fields.updatedAt,
    });
  }
  if (command.type === 'update') {
    return plugin.update({
      sessionId: fields.sessionId,
      startedAt: fields.startedAt,
      status: fields.status,
      eventVersion: fields.eventVersion,
      updatedAt: fields.updatedAt,
    });
  }
  return plugin.end({
    sessionId: fields.sessionId,
    startedAt: fields.startedAt,
    status: fields.status,
    eventVersion: fields.eventVersion,
    updatedAt: fields.updatedAt,
    endedAt: fields.endedAt,
    dismissalSeconds: fields.dismissalSeconds,
  });
};

type NativeLiveActivityStepResult = {
  state: NativeLiveActivityState;
  delayMs: number | null;
  retry: boolean;
  superseded: boolean;
};

const isNativeLiveActivityStepCurrent = (input: {
  epoch: number;
  getCurrentEpoch: () => number;
  observation: NativeLiveActivityObservation;
  getCurrentSessionId?: () => string | null;
}): boolean => {
  if (input.getCurrentEpoch() !== input.epoch) return false;
  if (!input.getCurrentSessionId) return true;
  return input.getCurrentSessionId() === input.observation.sessionId;
};

/**
 * Apply one observation. Native commands commit only after success.
 * A failed command rolls back to the last successful checkpoint when this
 * epoch is still current, then may schedule one short retry.
 */
export const runNativeLiveActivityStep = async (input: {
  available: boolean;
  plugin: NativeLiveActivityPlugin;
  state: NativeLiveActivityState;
  observation: NativeLiveActivityObservation;
  epoch: number;
  getCurrentEpoch: () => number;
  getCurrentSessionId?: () => string | null;
  retryCount: number;
}): Promise<NativeLiveActivityStepResult> => {
  const previous = input.state;
  if (!isNativeLiveActivityStepCurrent(input)) {
    return { state: previous, delayMs: null, retry: false, superseded: true };
  }

  const reduced = reduceNativeLiveActivity(previous, input.observation);
  const wait = reduced.commands.find((command) => command.type === 'wait');
  const delayMs = wait?.type === 'wait' ? wait.delayMs : null;
  const nativeCommands = reduced.commands.filter((command) => command.type !== 'wait');

  if (nativeCommands.length === 0) {
    if (!isNativeLiveActivityStepCurrent(input)) {
      return { state: previous, delayMs: null, retry: false, superseded: true };
    }
    return { state: reduced.state, delayMs, retry: false, superseded: false };
  }

  let checkpoint = previous;
  try {
    for (const [index, command] of nativeCommands.entries()) {
      if (!isNativeLiveActivityStepCurrent(input)) {
        return { state: previous, delayMs: null, retry: false, superseded: true };
      }
      await applyNativeLiveActivityCommand(input.available, input.plugin, command);
      if (!isNativeLiveActivityStepCurrent(input)) {
        return { state: previous, delayMs: null, retry: false, superseded: true };
      }
      const isLast = index === nativeCommands.length - 1;
      checkpoint = command.type === 'end' && !isLast
        ? createInitialNativeLiveActivityState()
        : reduced.state;
    }
    return { state: reduced.state, delayMs, retry: false, superseded: false };
  } catch {
    if (!isNativeLiveActivityStepCurrent(input)) {
      return { state: previous, delayMs: null, retry: false, superseded: true };
    }
    const rolled = rollbackNativeLiveActivityState({
      failedEpoch: input.epoch,
      currentEpoch: input.getCurrentEpoch(),
      previous: checkpoint,
      current: reduced.state,
    });
    const retry = shouldScheduleNativeLiveActivityRetry({
      failedEpoch: input.epoch,
      currentEpoch: input.getCurrentEpoch(),
      retryCount: input.retryCount,
    });
    return {
      state: rolled,
      delayMs: retry ? NATIVE_LIVE_ACTIVITY_COMMAND_RETRY_MS : null,
      retry,
      superseded: false,
    };
  }
};

export type NativeLiveActivityTokenSnapshot = {
  activityId: string;
  sessionId: string;
  token: string;
};

export type NativeLiveActivityRegisteredToken = NativeLiveActivityTokenSnapshot & {
  runtimeIdentity: string;
};

export type NativeLiveActivityTokenState = {
  desired: NativeLiveActivityTokenSnapshot | null;
  registered: NativeLiveActivityRegisteredToken | null;
};

export type NativeLiveActivityTokenContext = {
  selectedSessionId: string | null;
  runtimeIdentity: string;
  connected: boolean;
  enabled: boolean;
};

export type NativeLiveActivityTokenAction =
  | NativeLiveActivityPushTokenEvent & { type: 'pushToken' }
  | { type: 'sync' }
  | { type: 'localEndSucceeded' }
  | { type: 'dispose' };

type NativeLiveActivityTokenCommand =
  | {
      type: 'register';
      payload: NativeLiveActivityTokenSnapshot;
      runtimeIdentity: string;
    }
  | {
      type: 'unregister';
      payload: { token: string };
      runtimeIdentity: string;
    };

export const createInitialNativeLiveActivityTokenState = (): NativeLiveActivityTokenState => ({
  desired: null,
  registered: null,
});

const readLiveActivityTokenField = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

export const parseNativeLiveActivityPushTokenEvent = (
  payload: unknown,
): NativeLiveActivityPushTokenEvent | null => {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  const activityId = readLiveActivityTokenField(record.activityId);
  const sessionId = readLiveActivityTokenField(record.sessionId);
  const token = readLiveActivityTokenField(record.token);
  if (!activityId || !sessionId || !token) return null;
  return { activityId, sessionId, token };
};

const sameLiveActivityTokenIdentity = (
  left: NativeLiveActivityTokenSnapshot,
  right: NativeLiveActivityTokenSnapshot,
): boolean => left.activityId === right.activityId && left.token === right.token;

const clearDesiredLiveActivityToken = (
  state: NativeLiveActivityTokenState,
  runtimeIdentity: string,
): NativeLiveActivityTokenState => {
  const registered = state.registered?.runtimeIdentity === runtimeIdentity
    ? state.registered
    : null;
  if (state.desired === null && registered === state.registered) return state;
  return { desired: null, registered };
};

const planNativeLiveActivityTokenCommands = (
  state: NativeLiveActivityTokenState,
  context: NativeLiveActivityTokenContext,
): NativeLiveActivityTokenCommand[] => {
  if (!context.connected) return [];

  if (
    state.desired
    && context.enabled
    && context.selectedSessionId
    && state.desired.sessionId === context.selectedSessionId
  ) {
    const registered = state.registered;
    if (
      registered
      && sameLiveActivityTokenIdentity(registered, state.desired)
      && registered.runtimeIdentity === context.runtimeIdentity
    ) {
      return [];
    }
    return [{
      type: 'register',
      payload: {
        activityId: state.desired.activityId,
        sessionId: state.desired.sessionId,
        token: state.desired.token,
      },
      runtimeIdentity: context.runtimeIdentity,
    }];
  }

  if (state.registered && state.registered.runtimeIdentity === context.runtimeIdentity) {
    return [{
      type: 'unregister',
      payload: { token: state.registered.token },
      runtimeIdentity: context.runtimeIdentity,
    }];
  }

  return [];
};

/**
 * Pure Live Activity token planner. Desired tokens stay in memory across
 * disconnects; HTTP commands only target the current runtime identity.
 */
export const reduceNativeLiveActivityToken = (
  state: NativeLiveActivityTokenState,
  context: NativeLiveActivityTokenContext,
  action: NativeLiveActivityTokenAction,
): { state: NativeLiveActivityTokenState; commands: NativeLiveActivityTokenCommand[] } => {
  let next = state;

  if (action.type === 'pushToken') {
    if (!context.enabled || action.sessionId !== context.selectedSessionId) {
      return { state, commands: [] };
    }
    next = {
      ...state,
      desired: {
        activityId: action.activityId,
        sessionId: action.sessionId,
        token: action.token,
      },
    };
  } else if (action.type === 'localEndSucceeded' || action.type === 'dispose') {
    next = clearDesiredLiveActivityToken(state, context.runtimeIdentity);
  } else if (!context.enabled || (state.desired && state.desired.sessionId !== context.selectedSessionId)) {
    next = clearDesiredLiveActivityToken(state, context.runtimeIdentity);
  } else if (state.registered && state.registered.runtimeIdentity !== context.runtimeIdentity && !state.desired) {
    next = { ...state, registered: null };
  }

  return { state: next, commands: planNativeLiveActivityTokenCommands(next, context) };
};

const settleLiveActivityTokenResult = async (
  work: Promise<{ ok: true } | null>,
): Promise<{ ok: true } | null> => {
  try {
    return await work;
  } catch {
    return null;
  }
};

export const applyNativeLiveActivityTokenCommands = async (input: {
  state: NativeLiveActivityTokenState;
  commands: NativeLiveActivityTokenCommand[];
  getRuntimeIdentity: () => string;
  register: (payload: NativeLiveActivityTokenSnapshot) => Promise<{ ok: true } | null>;
  unregister: (payload: { token: string }) => Promise<{ ok: true } | null>;
}): Promise<NativeLiveActivityTokenState> => {
  let state = input.state;

  for (const command of input.commands) {
    if (command.runtimeIdentity !== input.getRuntimeIdentity()) {
      if (
        command.type === 'unregister'
        && state.registered?.runtimeIdentity === command.runtimeIdentity
      ) {
        state = { ...state, registered: null };
      }
      continue;
    }

    if (command.type === 'register') {
      const previous = state.registered;
      if (command.runtimeIdentity !== input.getRuntimeIdentity()) continue;
      const result = await settleLiveActivityTokenResult(input.register(command.payload));
      if (result?.ok !== true) continue;
      if (command.runtimeIdentity !== input.getRuntimeIdentity()) continue;
      state = {
        ...state,
        registered: {
          ...command.payload,
          runtimeIdentity: command.runtimeIdentity,
        },
      };
      if (
        previous
        && previous.runtimeIdentity === command.runtimeIdentity
        && previous.token !== command.payload.token
      ) {
        if (command.runtimeIdentity !== input.getRuntimeIdentity()) continue;
        await settleLiveActivityTokenResult(input.unregister({ token: previous.token }));
      }
      continue;
    }

    if (command.runtimeIdentity !== input.getRuntimeIdentity()) {
      if (state.registered?.runtimeIdentity === command.runtimeIdentity) {
        state = { ...state, registered: null };
      }
      continue;
    }
    const result = await settleLiveActivityTokenResult(input.unregister(command.payload));
    if (result?.ok === true && state.registered?.token === command.payload.token) {
      state = { ...state, registered: null };
    }
  }

  return state;
};

export const runNativeLiveActivityTokenStep = async (input: {
  state: NativeLiveActivityTokenState;
  context: NativeLiveActivityTokenContext;
  action: NativeLiveActivityTokenAction;
  register: (payload: NativeLiveActivityTokenSnapshot) => Promise<{ ok: true } | null>;
  unregister: (payload: { token: string }) => Promise<{ ok: true } | null>;
}): Promise<NativeLiveActivityTokenState> => {
  const reduced = reduceNativeLiveActivityToken(input.state, input.context, input.action);
  return applyNativeLiveActivityTokenCommands({
    state: reduced.state,
    commands: reduced.commands,
    getRuntimeIdentity: () => input.context.runtimeIdentity,
    register: input.register,
    unregister: input.unregister,
  });
};
