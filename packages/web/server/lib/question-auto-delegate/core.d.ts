/**
 * Platform-agnostic question auto-delegate core contracts.
 * Shared by the web runtime adapter and VS Code host integration.
 * API tip event: `openchamber:question-auto-delegate-changed` with `{ epoch, revision }` only —
 * consumers must GET `/api/question-auto-delegate` for the authoritative snapshot.
 */

export const QUESTION_AUTO_DELEGATE_DELAY_MS: 30000;

/** Fixed auto-reply text used for every question slot. */
export const QUESTION_AUTO_DELEGATE_ANSWER: string;

/** HTTP/API error code when another authority already claimed upstream submission. */
export const QUESTION_SUBMISSION_CLAIMED_CODE: 'question_submission_claimed';

export type QuestionAutoDelegateRequestState =
  | 'counting'
  | 'paused'
  | 'disabled'
  | 'submitting'
  | 'uncertain'
  | 'settled';

export type QuestionAutoDelegatePauseReason = 'interaction' | 'user' | 'goal' | null;

export type QuestionAutoDelegateSubmittedBy = 'manual' | 'auto' | null;

export type QuestionAutoDelegateResolution = 'replied' | 'rejected' | 'external' | null;

export type QuestionAutoDelegateCoverageState = 'ready' | 'reconciling' | 'partial';

export type QuestionAutoDelegateSubmitAuthority = 'manual' | 'auto' | 'delegate';

export type QuestionAutoDelegateSubmitKind = 'reply' | 'reject';

export interface QuestionAutoDelegateRequestSnapshot {
  requestID: string;
  sessionID: string;
  directory: string;
  questionCount: number;
  state: QuestionAutoDelegateRequestState;
  deadlineAt: number | null;
  pauseReason: QuestionAutoDelegatePauseReason;
  submittedBy: QuestionAutoDelegateSubmittedBy;
  resolution: QuestionAutoDelegateResolution;
}

export interface QuestionAutoDelegateSnapshot {
  epoch: string;
  revision: number;
  serverNow: number;
  enabled: boolean;
  delayMs: 30000;
  coverage: {
    state: QuestionAutoDelegateCoverageState;
    failedDirectories: string[];
  };
  requests: QuestionAutoDelegateRequestSnapshot[];
}

export interface QuestionAutoDelegatePauseInput {
  requestID: string;
  sessionID: string;
  directory?: string | null;
  /** HTTP accepts interaction|user; goal is the reverse path from session-goal pause/abort. */
  reason: 'interaction' | 'user' | 'goal';
}

export interface QuestionAutoDelegateDelegateInput {
  requestID: string;
  sessionID: string;
  directory?: string | null;
}

export interface QuestionAutoDelegateSubmitInput {
  requestID: string;
  sessionID?: string | null;
  directory?: string | null;
  kind: QuestionAutoDelegateSubmitKind;
  authority: QuestionAutoDelegateSubmitAuthority;
  /** Required for reply; ignored for reject. */
  answers?: string[][] | null;
  /** Optional opaque body forwarded on manual reject/reply when answers are already shaped. */
  body?: unknown;
}

export type QuestionAutoDelegateMutationOutcome =
  | 'ok'
  | 'paused'
  | 'delegated'
  | 'submitted'
  | 'claimed'
  | 'uncertain'
  | 'settled'
  | 'not_found'
  | 'disabled'
  | 'error';

export interface QuestionAutoDelegateMutationResult {
  outcome: QuestionAutoDelegateMutationOutcome;
  snapshot: QuestionAutoDelegateSnapshot;
  /** Present when outcome is `claimed`. */
  code?: typeof QUESTION_SUBMISSION_CLAIMED_CODE;
  /** Upstream HTTP status when a submission was attempted or forwarded. */
  upstreamStatus?: number;
  /** Upstream JSON/text body (preserve SDK shape for manual intercepts). */
  upstreamBody?: unknown;
  error?: string;
  status?: number;
}

export interface QuestionAutoDelegatePendingQuestion {
  id: string;
  sessionID: string;
  directory?: string | null;
  questions?: unknown[] | null;
}

export interface QuestionAutoDelegateSessionInfo {
  id: string;
  parentID?: string | null;
  directory?: string | null;
}

/**
 * Result of one upstream mutation.
 * - `uncertain` stops retries and keeps a tombstone (may have been sent).
 * - `notSent: true` is a compatible extension: the request never left the process;
 *   core releases the claim and pauses for human retry. Bare `status: 0` without
 *   `notSent` remains uncertain.
 */
export interface QuestionAutoDelegateUpstreamResult {
  ok: boolean;
  /** True when the transport finished without a definitive success/failure (timeout, empty 5xx, aborted). */
  uncertain?: boolean;
  /**
   * Compatible extension for VS Code / web adapters: only `true` means the POST
   * body was never transmitted. Must not be set when the send may have reached upstream.
   */
  notSent?: boolean;
  status: number;
  body: unknown;
}

export interface QuestionAutoDelegateTimerHandle {
  clear(): void;
}

/**
 * Injected IO — no platform imports inside core.
 * Web adapter implements via direct OpenCode upstream fetch (never loopback through Host routes).
 */
export interface QuestionAutoDelegateIO {
  now(): number;
  createTimer(callback: () => void, delayMs: number): QuestionAutoDelegateTimerHandle;
  /** Random opaque epoch seed (called once on create). */
  createEpoch(): string;
  /**
   * List pending questions for a directory scope.
   * Return `null` exclusively for fetch failure (never treat failure as empty success).
   * Return `[]` only for authoritative empty.
   */
  listQuestions(directory: string | undefined): Promise<QuestionAutoDelegatePendingQuestion[] | null>;
  /** Session info for lineage / directory binding. Failure → null. */
  getSession(sessionID: string, directory?: string | null): Promise<QuestionAutoDelegateSessionInfo | null>;
  postReply(
    requestID: string,
    directory: string | undefined,
    answers: string[][],
  ): Promise<QuestionAutoDelegateUpstreamResult>;
  postReject(
    requestID: string,
    directory: string | undefined,
    body?: unknown,
  ): Promise<QuestionAutoDelegateUpstreamResult>;
  /** Project directories used for reconnect/start reconcile. */
  listDirectories(): Promise<string[]>;
  /**
   * Persist-backed enabled flag.
   * - `true` / `false` when readable (absent key ⇒ default true)
   * - `null` when settings cannot be read (core enters unavailable; no auto timers)
   */
  readEnabled(): Promise<boolean | null>;
  /** Tip-only SSE/broadcast: `{ epoch, revision }`. */
  onChanged?(tip: { epoch: string; revision: number }): void;
  /**
   * Fired on user pause, manual claim, or feature-disable so goal can apply its
   * existing pause path. Does not fire for successful auto-reply or goal-reason pauses.
   */
  onUserTakeover?(info: {
    requestID: string;
    sessionID: string;
    directory: string;
    reason: 'interaction' | 'user' | 'disabled';
  }): void;
}

export interface QuestionAutoDelegateCoreOptions {
  io: QuestionAutoDelegateIO;
  delayMs?: number;
  autoAnswer?: string;
}

export interface QuestionAutoDelegateCore {
  start(): () => void;
  dispose(): void;
  snapshot(): QuestionAutoDelegateSnapshot;
  /**
   * Apply enabled flag after successful settings persist.
   * Only accepts a real boolean; invalid values are ignored (state unchanged).
   * Generation-guarded against racing start() settings reads.
   */
  applyEnabled(enabled: boolean): QuestionAutoDelegateSnapshot;
  pause(input: QuestionAutoDelegatePauseInput): Promise<QuestionAutoDelegateMutationResult>;
  /**
   * Immediate auto-delegate for one request (same claim path as timer).
   * Allowed even when the feature toggle is off (explicit single-shot).
   * Recovers identity via scoped list — never invents questionCount=1.
   */
  delegate(input: QuestionAutoDelegateDelegateInput): Promise<QuestionAutoDelegateMutationResult>;
  /**
   * Shared synchronous claim + upstream POST for timer, manual reply/reject, and delegate.
   * Concurrent losers receive outcome `claimed` + code `question_submission_claimed` (HTTP 409).
   * Manual reply forwards answers as-is (including []); fixed text is auto/delegate only.
   */
  submit(input: QuestionAutoDelegateSubmitInput): Promise<QuestionAutoDelegateMutationResult>;
  /**
   * Per-directory pending reconcile. Only successfully listed directories may settle
   * missing requests. Failed directories keep prior state (`coverage.partial`).
   * Single-flight with trailing scope merge.
   */
  reconcile(options?: { directories?: string[] }): Promise<QuestionAutoDelegateSnapshot>;
  /** Ingest a global OpenCode SSE payload (+ authoritative directory). */
  processEvent(payload: unknown, directoryHint?: string | null): void;
  /**
   * True while this session or a known descendant has a blocking request
   * (counting|paused|disabled|submitting|uncertain).
   */
  isBlockingSession(sessionID: string): boolean;
  /** True when settings-ready+enabled and the request would be auto-handled. */
  isAutoHandling(sessionID: string, requestID?: string): boolean;
  /** Goal pause/abort reverse path — pause related question timers for the session tree. */
  pauseForSessionTree(sessionID: string, directory?: string | null): Promise<QuestionAutoDelegateSnapshot>;
  /** Resolve root owner session from cached lineage. */
  resolveRootSession(sessionID: string): { sessionID: string; directory: string };
}

export function createQuestionAutoDelegateCore(
  options: QuestionAutoDelegateCoreOptions,
): QuestionAutoDelegateCore;

export function buildAutoDelegateAnswers(
  questionCount: number,
  answerText?: string,
): string[][];
