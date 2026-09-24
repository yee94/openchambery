import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { applyDirectoryEvent } from "./event-reducer";
import { normalizeOpenCodeEvent, toLegacyEventShape } from "./opencode-event-normalizer";
import {
  clearSessionErrorLogForTests,
  getRecentSessionErrors,
  recordSessionError,
  summarizeOpenCodeError,
} from "./session-error-log";
import {
  appendNotification,
  clearSessionErrorNotifications,
  useLatestSessionError,
  useNotificationStore,
} from "./notification-store";
import { clearTurnCompleteNotificationGuardForTests, handleEvent, setActiveSession } from "./sync-context";
import type { ChildStoreManager } from "./child-store";
import { INITIAL_STATE, type Event, type State } from "./types";

function directoryState(overrides: Partial<State> = {}): State {
  return {
    ...INITIAL_STATE,
    ...overrides,
  };
}

const SESSION = "ses_fail_agent";
const DIRECTORY = "/workspace/project";

const realFailedEnvelope = {
  id: "evt_0c8986cc4001Vrz5dx75hSmMXC",
  created: 1790071827652,
  type: "session.execution.failed",
  data: {
    sessionID: SESSION,
    error: {
      type: "unknown",
      message: 'Agent not found: "Build"',
    },
  },
  durable: {
    aggregateID: SESSION,
    seq: 6,
    version: 1,
  },
};

type RoutingIndex = Parameters<typeof handleEvent>[3];

const emptyRoutingIndex: RoutingIndex = {
  sessionDirectoryById: new Map(),
  messageSessionById: new Map(),
  sessionMessageIdsById: new Map(),
} as RoutingIndex;

function createFailedChildStore() {
  const state: Record<string, unknown> = {
    session: [{
      id: SESSION,
      title: "fail",
      time: { created: 1, updated: 1 },
    }],
    session_status: { [SESSION]: { type: "busy" } },
    session_status_observed_at: {},
    session_error_at: {},
    permission: {},
    question: {},
    todo: {},
    session_diff: {},
    lsp: [],
  };
  return {
    getState: () => state,
    setState: (next: Record<string, unknown> | ((prev: Record<string, unknown>) => Record<string, unknown>)) => {
      if (typeof next === "function") {
        Object.assign(state, next(state));
        return;
      }
      Object.assign(state, next);
    },
    subscribe: () => () => {},
  };
}

describe("session.execution.failed error settle", () => {
  beforeEach(() => {
    clearSessionErrorLogForTests();
    clearTurnCompleteNotificationGuardForTests();
    useNotificationStore.setState({
      list: [],
      index: {
        session: { unseenCount: {}, unseenHasError: {} },
        project: { unseenCount: {}, unseenHasError: {} },
      },
    });
  });

  test("normalizer preserves real Agent-not-found envelope error payload", () => {
    const result = normalizeOpenCodeEvent({
      type: "event",
      payload: realFailedEnvelope,
      directory: "global",
    });
    // Global wrapper uses payload; also accept bare envelope.
    const bare = normalizeOpenCodeEvent(realFailedEnvelope);
    expect(bare.action).toBe("emit");
    if (bare.action !== "emit") return;
    expect(bare.event.type).toBe("session.execution.failed");
    expect(bare.event.properties.sessionID).toBe(SESSION);
    expect(bare.event.properties.error).toEqual({
      type: "unknown",
      message: 'Agent not found: "Build"',
    });
    expect(toLegacyEventShape(bare.event).properties.error).toEqual({
      type: "unknown",
      message: 'Agent not found: "Build"',
    });
    void result;
  });

  test("summarizeOpenCodeError keeps Agent not found text", () => {
    expect(summarizeOpenCodeError({
      type: "unknown",
      message: 'Agent not found: "Build"',
    })).toEqual({
      name: "unknown",
      type: "unknown",
      message: 'Agent not found: "Build"',
    });
  });

  test("execution.failed records session_error_at and settles idle; succeeded does not invent error", () => {
    const draft = directoryState({
      session_status: { [SESSION]: { type: "busy" } },
    });
    const released: string[] = [];

    expect(applyDirectoryEvent(draft, {
      type: "session.execution.failed",
      properties: {
        sessionID: SESSION,
        error: { type: "unknown", message: 'Agent not found: "Build"' },
      },
    } as Event, {
      now: () => 1_790_071_827_652,
      onServerSessionIdle: (id) => {
        released.push(id);
      },
    })).toBe(true);

    expect(draft.session_status[SESSION]).toEqual({ type: "idle" });
    expect(draft.session_error_at[SESSION]).toBe(1_790_071_827_652);
    expect(released).toEqual([SESSION]);

    const ok = directoryState({
      session_status: { [SESSION]: { type: "busy" } },
    });
    expect(applyDirectoryEvent(ok, {
      type: "session.execution.succeeded",
      properties: { sessionID: SESSION },
    } as Event, { now: () => 99 })).toBe(true);
    expect(ok.session_status[SESSION]).toEqual({ type: "idle" });
    expect(ok.session_error_at[SESSION]).toBeUndefined();
  });

  test("busy after failed clears session_error_at", () => {
    const draft = directoryState({
      session_status: { [SESSION]: { type: "idle" } },
      session_error_at: { [SESSION]: 10 },
    });
    expect(applyDirectoryEvent(draft, {
      type: "session.status",
      properties: { sessionID: SESSION, status: { type: "busy" } },
    } as Event, { now: () => 20 })).toBe(true);
    expect(draft.session_error_at[SESSION]).toBeUndefined();
  });

  test("execution.started clears prior session_error_at like busy (retry must not keep failure)", () => {
    const draft = directoryState({
      session_status: { [SESSION]: { type: "idle" } },
      session_error_at: { [SESSION]: 10 },
    });
    expect(applyDirectoryEvent(draft, {
      type: "session.execution.started",
      properties: { sessionID: SESSION },
    } as Event, { now: () => 30 })).toBe(true);
    expect(draft.session_status[SESSION]).toEqual({ type: "busy" });
    expect(draft.session_error_at[SESSION]).toBeUndefined();
  });

  test("notification store retains authoritative error for live UI and latest-error hook", () => {
    const summary = summarizeOpenCodeError({
      type: "unknown",
      message: 'Agent not found: "Build"',
    });
    recordSessionError({
      sessionId: SESSION,
      directory: DIRECTORY,
      ...summary,
    });
    appendNotification({
      type: "error",
      session: SESSION,
      directory: DIRECTORY,
      time: 1_790_071_827_652,
      viewed: false,
      error: summary,
    });

    expect(getRecentSessionErrors()[0]?.message).toBe('Agent not found: "Build"');
    expect(useNotificationStore.getState().sessionHasError(SESSION)).toBe(true);

    // useLatestSessionError is a zustand selector hook; exercise the store path.
    const latest = useNotificationStore.getState().list
      .filter((n) => n.session === SESSION && n.type === "error")
      .at(-1);
    expect(latest && latest.type === "error" ? latest.error?.message : null)
      .toBe('Agent not found: "Build"');
    void useLatestSessionError;
  });

  test("unknown agent and interrupted do not share failed error stamp on interrupted", () => {
    const draft = directoryState({
      session_status: { [SESSION]: { type: "busy" } },
    });
    expect(applyDirectoryEvent(draft, {
      type: "session.execution.interrupted",
      properties: { sessionID: SESSION },
    } as Event, { now: () => 50 })).toBe(true);
    expect(draft.session_status[SESSION]).toEqual({ type: "idle" });
    expect(draft.session_error_at[SESSION]).toBeUndefined();
  });

  test("clearSessionErrorNotifications drops only that session's error rows", () => {
    const now = Date.now();
    appendNotification({
      type: "error",
      session: SESSION,
      directory: DIRECTORY,
      time: now,
      viewed: false,
      error: { name: "unknown", message: "old" },
    });
    appendNotification({
      type: "error",
      session: "ses_other",
      directory: DIRECTORY,
      time: now + 1,
      viewed: false,
      error: { name: "unknown", message: "keep" },
    });
    appendNotification({
      type: "turn-complete",
      session: SESSION,
      directory: DIRECTORY,
      time: now + 2,
      viewed: false,
    });
    clearSessionErrorNotifications(SESSION);
    const list = useNotificationStore.getState().list;
    expect(list.some((n) => n.session === SESSION && n.type === "error")).toBe(false);
    expect(list.some((n) => n.session === "ses_other" && n.type === "error")).toBe(true);
    expect(list.some((n) => n.session === SESSION && n.type === "turn-complete")).toBe(true);
  });

  test("handleEvent execution.started clears error marker and notification for retry", () => {
    const store = createFailedChildStore();
    store.setState({
      session_error_at: { [SESSION]: 99 },
      session_status: { [SESSION]: { type: "idle" } },
    });
    const childStores = {
      getChild: () => store,
      children: new Map([[DIRECTORY, store]]),
      ensureChild: () => store,
      mark: () => undefined,
    } as unknown as ChildStoreManager;

    appendNotification({
      type: "error",
      session: SESSION,
      directory: DIRECTORY,
      time: Date.now(),
      viewed: false,
      error: { name: "unknown", message: 'Agent not found: "Build"' },
    });

    setActiveSession(DIRECTORY, "ses_other");
    try {
      handleEvent(DIRECTORY, {
        type: "session.execution.started",
        properties: { sessionID: SESSION },
      } as Event, childStores, emptyRoutingIndex);

      const after = store.getState() as {
        session_status: Record<string, { type: string }>;
        session_error_at: Record<string, number>;
      };
      expect(after.session_status[SESSION]).toEqual({ type: "busy" });
      expect(after.session_error_at[SESSION]).toBeUndefined();
      expect(useNotificationStore.getState().list.some(
        (n) => n.session === SESSION && n.type === "error",
      )).toBe(false);
    } finally {
      setActiveSession("", "");
    }
  });

  test("handleEvent settles real Agent-not-found envelope into error notification without false success", () => {
    const store = createFailedChildStore();
    const childStores = {
      getChild: () => store,
      children: new Map([[DIRECTORY, store]]),
      ensureChild: () => store,
      mark: () => undefined,
    } as unknown as ChildStoreManager;

    // Keep this session inactive so the error stays unseen (sessionHasError
    // only indexes unviewed errors). Live UI still reads list / error log.
    setActiveSession(DIRECTORY, "ses_other");
    try {
      const normalized = normalizeOpenCodeEvent(realFailedEnvelope);
      expect(normalized.action).toBe("emit");
      if (normalized.action !== "emit") return;

      handleEvent(DIRECTORY, toLegacyEventShape(normalized.event) as Event, childStores, emptyRoutingIndex);

      const after = store.getState() as {
        session_status: Record<string, { type: string }>;
        session_error_at: Record<string, number>;
      };
      expect(after.session_status[SESSION]).toEqual({ type: "idle" });
      expect(typeof after.session_error_at[SESSION]).toBe("number");

      const errors = getRecentSessionErrors();
      expect(errors[0]?.sessionId).toBe(SESSION);
      expect(errors[0]?.directory).toBe(DIRECTORY);
      expect(errors[0]?.message).toBe('Agent not found: "Build"');

      expect(useNotificationStore.getState().sessionHasError(SESSION)).toBe(true);
      const latest = useNotificationStore.getState().list
        .filter((n) => n.session === SESSION && n.type === "error")
        .at(-1);
      expect(latest && latest.type === "error" ? latest.error?.message : null)
        .toBe('Agent not found: "Build"');
      // Must not look like a successful turn-complete.
      expect(
        useNotificationStore.getState().list.some(
          (n) => n.session === SESSION && n.type === "turn-complete",
        ),
      ).toBe(false);
    } finally {
      setActiveSession("", "");
    }
  });
});

describe("session.execution.succeeded unread marker", () => {
  beforeEach(() => {
    clearTurnCompleteNotificationGuardForTests();
    useNotificationStore.setState({
      list: [],
      index: {
        session: { unseenCount: {}, unseenHasError: {} },
        project: { unseenCount: {}, unseenHasError: {} },
      },
    });
  });

  afterEach(() => {
    clearTurnCompleteNotificationGuardForTests();
    setActiveSession("", "");
    vi.restoreAllMocks();
  });

  function dispatch(type: string, sessionID = SESSION, extra: Record<string, unknown> = {}) {
    const store = createFailedChildStore();
    const childStores = {
      getChild: () => store,
      children: new Map([[DIRECTORY, store]]),
      ensureChild: () => store,
      mark: () => undefined,
    } as unknown as ChildStoreManager;
    handleEvent(DIRECTORY, {
      type,
      properties: { sessionID, ...extra },
    } as Event, childStores, emptyRoutingIndex);
  }

  test("records an unread turn-complete even when the session is selected and the window is focused", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    setActiveSession(DIRECTORY, SESSION);

    dispatch("session.execution.succeeded");

    const list = useNotificationStore.getState().list;
    expect(list).toEqual([
      expect.objectContaining({
        type: "turn-complete",
        session: SESSION,
        viewed: false,
      }),
    ]);
    expect(useNotificationStore.getState().sessionUnseenCount(SESSION)).toBe(1);
  });

  test("does not add a second unread marker when deprecated session.idle follows succeeded", () => {
    setActiveSession(DIRECTORY, "ses_other");
    dispatch("session.execution.succeeded");
    dispatch("session.idle");

    expect(useNotificationStore.getState().list.filter((n) => n.type === "turn-complete")).toHaveLength(1);
    expect(useNotificationStore.getState().sessionUnseenCount(SESSION)).toBe(1);
  });

  test("legacy session.idle still leaves an unread marker, and the next run can notify again", () => {
    setActiveSession(DIRECTORY, "ses_other");
    dispatch("session.idle");
    expect(useNotificationStore.getState().sessionUnseenCount(SESSION)).toBe(1);

    dispatch("session.execution.started");
    dispatch("session.execution.succeeded");
    expect(useNotificationStore.getState().sessionUnseenCount(SESSION)).toBe(2);
  });

  test("does not mark a child session unread", () => {
    const store = createFailedChildStore();
    (store.getState() as { session: Array<{ parentID?: string }> }).session[0].parentID = "ses_parent";
    const childStores = {
      getChild: () => store,
      children: new Map([[DIRECTORY, store]]),
      ensureChild: () => store,
      mark: () => undefined,
    } as unknown as ChildStoreManager;

    handleEvent(DIRECTORY, {
      type: "session.execution.succeeded",
      properties: { sessionID: SESSION },
    } as Event, childStores, emptyRoutingIndex);

    expect(useNotificationStore.getState().list).toEqual([]);
  });
});
