# Session Goal

Server-side control loop that keeps a session working toward a user-defined
objective. On OpenCode 2.x the goal record lives in the OpenChamber session
metadata store (`packages/web/server/lib/session-metadata/`), folded back onto
`session.metadata` by the proxy. Capability is **open** (`supported: true`):
manual UI, goal routes, and scheduled-task goal create all write the same
store. The small model is an independent progress auditor. Built on
OpenChamber's backend-driven architecture: the loop lives in the web server
and survives UI disconnects.

## v2 storage (OpenChamber session metadata store)

OpenCode 2.x accepts session `metadata` only at create time — there is no
PATCH. Goal progress therefore belongs in the Host
`packages/web/server/lib/session-metadata/` store (merge-patched under
`openchamber.goal`), not an OpenCode `PATCH /session/:id`.

`createSessionGoalRuntime` accepts optional seams:

| Seam | Role |
|---|---|
| `readSessionMetadata` | Read Host metadata for the session |
| `persistSessionGoal` | Full goal replace (routes / scheduled create) |
| `mutateSessionMetadata` | Preferred conditional commit: `decide(committed) → { ok, patch }` on the store lock |

When `mutateSessionMetadata` is present, runtime goal commits use it exclusively
(no OpenCode PATCH). When only `readSessionMetadata` + `persistSessionGoal` are
present, the runtime falls back to read-then-persist. When neither store path is
wired, the legacy OpenCode PATCH path remains (tests / unwired servers).

Those seams, the proxy overlay, and `PUT /api/openchamber/sessions/:id/metadata`
are wired in `server/index.js`. A UI metadata write notifies the runtime with
a synthetic `session.updated` so create/resume can arm the loop. Metadata PUT
normalizes `executionGeneration` for goal patches inside the store mutate lock.

**Capability is open** (`supported === true`). Scheduled-task goal create and
`POST /api/goals/:sessionId` persist an active goal into the same store as
manual UI metadata writes; after first persist they notify the runtime with a
synthetic `session.updated` so the loop can arm.

## Goal payload (`metadata.openchamber.goal`)

```
{
  id,                      // opaque per-logical-goal id; stale-write guard
  objective,               // inline user text (fallback), <= 5000 chars
  objectiveFile,           // true: objective text lives in a server-side file
  status,                  // active | paused | blocked | budgetLimited | complete
  tokenBudget,             // optional positive int
  tokensUsed,              // tokensCommitted + current segment (snapshot - baseline)
  tokensBaseline,          // segment start snapshot (pre-goal turn; 0 after compaction)
  tokensCommitted,         // closed segments' total (one segment per compaction)
  turnsUsed,               // auto-continuation attempts committed (capped at MAX_AUTO_TURNS)
  blockedStreak,           // consecutive blocked audit verdicts
  auditFailStreak,         // consecutive failed/unavailable audit calls
  note,                    // latest audit progress note, <= 280 chars
  statusReason,            // why settled; 'resumed' is a kickoff signal from UI
  lastAccountedMessageID,  // incremental accounting cursor
  executionGeneration,     // execution permit generation (see pause boundary)
  pendingContinuation,     // durable admission (ticket 10); null when idle
  createdAt, updatedAt
}

### Durable continuation admission (`pendingContinuation`)

Minimal Host-metadata field (not a parallel store). Written only through the
same conditional goal owner as other goal commits:

```
{
  messageID,     // msg_goalc_<goalId>_<generation>_<turnsUsed>
  goalId, generation, turnsUsed,
  phase,         // reserved | transport | uncertain | accepted
  text,          // fixed prompt payload for legal same-id re-dispatch
  providerID, modelID, variant?, agent?,
  error?, at
}
```

Rules:

1. **Reserve before send** — persist fixed `messageID` + prompt/selection
   identity with `phase: reserved` **without** bumping `turnsUsed`.
2. **Accept commit** — `turnsUsed` increment and `pendingContinuation: null`
   share one conditional write after upstream accept (or reconcile `found`).
3. **Selection / pre-prompt drop** — pause or switchAgent/switchModel failure
   clears reserved pending; **0 count**.
4. **Uncertain transport** — keep durable identity; pause auto-continue with a
   user-visible `statusReason` (reuses blocked/pause reason UI). Reconcile via
   official `session.inbox.list` / `session.message.get` (or projected list);
   fetch failure is **unavailable**, never authoritative empty.
5. **Already received** — count once, clear pending; do not invent a new id.
6. **pause → resume / goal replace** — reserved pending cleared on pause;
   transport/uncertain/accepted identity retained (no claim of upstream revoke).
   Stale `goalId` / superseded `generation` never overwrite newer user ops;
   found-under-stale-gen still counts once.
7. **Reboot** — restore pending from metadata, reconcile first, then same-id
   fixed-payload re-dispatch only when still absent and generation matches.
```

The UI writes goals (create/edit/pause/resume/clear) by patching this
metadata; the runtime never creates a goal on its own. Goal creation happens
at send time via the arm store (`useSessionGoalArmStore`): the composer
target button arms "the next prompt is the objective", and the run-as-goal
flows (fork-from-answer dialog, plan implement dialog) arm the same way —
the plan flow additionally supplies an objective OVERRIDE carrying the plan
content, since "Implement this plan: X" alone gives the audit nothing to
judge against. The armed send also attaches a synthetic system-reminder
part telling the agent goal mode is active and that each turn should end
with a factual done/verified/remaining statement for the independent audit.

### Execution generation and pause/commit boundary

`executionGeneration` is the durable execution permit. It starts at `0` on
create and advances on:

- pause (user, abort, question) while status was `active`
- resume (`paused`/`blocked`/… → `active`)
- execution-condition edits (`tokenBudget`, `objective`, `objectiveFile`)

Settle paths (`active` → `complete` / `blocked` / `budgetLimited`) keep the
same generation. Writers go through `withGoalExecutionGeneration` (metadata
PUT, `persistSessionGoal` Host wiring) or the runtime's `advanceGeneration`
flag so UI patches that omit the field still bump correctly.

Runtime commits (continue accounting, settle, pause) validate **goal id +
expected generation + applicable status** on one serial boundary when the
Host `mutateSessionMetadata` seam is wired. A late audit that returns
`continue` / `complete` / `blocked` after pause cannot overwrite the paused
snapshot or start a new `session.prompt` continuation.

Local (in-process) ordering:

1. Pause / stop / `session.updated` paused → bump dispatch epoch + abort
   in-flight audit controller + clear idle timer (**before** awaiting durable
   write).
2. Tick captures epoch at start; re-checks before continue commit and before
   dispatch.
3. `sendContinuation` re-validates **epoch + shutdown recovery + stopped** after
   every await (`switchAgent` / `switchModel` / generation re-read) and again
   immediately before `session.prompt`. It also re-reads durable goal
   generation/status at the prompt boundary. A pause or shutdown that lands
   during selection must drop with `uncertain: false` and **zero** prompt.
4. Continuation identity `{ goalId, generation, turnsUsed }` and
   `phase: transport` are recorded **only at the actual prompt boundary** —
   not before selection. Selection failures (agent/model switch) must **not**
   be reported as prompt-uncertain. Uncertain applies only after prompt left
   the process and transport failed; the identity is kept for reconcile. The
   runtime does **not** claim full revoke of a request already handed upstream.
   Explicit stop of the upstream turn remains the existing abort/stop operation.

Public seams for tests / controlled async: `runTick`, `pauseGoal`,
`getDispatchEpoch`, `getDispatchedContinuation`.

## File-backed objectives

The objective TEXT lives in `<data-dir>/goals/<sessionId>.md` (data dir =
`OPENCHAMBER_DATA_DIR` or `~/.config/openchamber`), keyed by the SESSION ID:
sessions are globally unique and carry one goal at a time, so the mapping is
deterministic and a new goal simply overwrites the file. Metadata carries
only `objectiveFile: true` — never a path — so user-writable metadata cannot
become a file-read vector (`objectives.js` also validates the id shape
before touching the filesystem). Rationale: metadata rides every
`session.updated`, so multi-KB objectives must not live there.

- `objectives.js` — write/read/delete, 5000-char clamp.
- `capability.js` — `getSessionGoalCapability()` / `assertSessionGoalSupported()`
  (single source; currently `{ supported: true }`).
- `routes.js` — `GET /api/goals/capability`, create/resume endpoints,
  `PUT/GET/DELETE /api/goals/objective/:sessionId` (OpenChamber-owned,
  registered before the generic proxy; JSON parsing via the `/api/goals`
  family in core-routes). Create / resume require an injected
  `persistSessionGoal` (503 when missing); objective PUT writes the file when
  supported. The UI writes the file BEFORE patching the goal metadata and
  falls back to an inline objective when the write fails;
  `clearSessionGoal` deletes the file best-effort.
- The tick resolves the effective objective fresh on every cycle (the file
  is live-editable mid-goal) and falls back to the inline `objective` when
  the file is unreadable — a goal never dies because a file went away.
- UI display fetches content via the GET route
  (`useGoalObjectiveContent`); in VS Code the route is unavailable, so the
  strip degrades to the audit note (display-only fallback by design).
- Scheduled goal tasks write the file server-side directly via
  `objectives.js`.

## Flow

1. `createSessionGoalRuntime` subscribes to the global SSE hub (it needs
   the envelope's `directory`).
2. `session.status: idle` arms a 15s per-session timer; `busy`/`retry` clears
   it. A `session.updated` carrying a fresh active goal (`turnsUsed === 0` or
   `statusReason === 'resumed'`) arms a kickoff timer — 3s for fresh goals,
   ~250ms for an explicit Resume so the nudge feels immediate — since setting
   a goal on an idle session emits no status transition.
3. On fire (`tick`), gated by the `sessionGoalEnabled` setting:
   - fetch session (skip sub-agent sessions), require an `active` goal;
   - quiescence check via the message tail (trailing user message or
     unfinished assistant reply → bail; the next idle transition re-arms).
     Exception: an unfinished assistant reply that also carries no error can
     be an ORPHAN left by force-killing the app mid-turn — the session is
     really idle even though the tail looks incomplete. In that case the tick
     corroborates against the live `/session/status` and, if the session is
     idle, resumes past the orphan instead of bailing forever. A genuinely
     busy session still bails;
   - token accounting as a SNAPSHOT of the latest completed assistant turn:
     `input + cache.read + output`. Earlier turns' inputs and outputs fold
     into the next turn's cache, so the latest snapshot already carries the
     whole run's paid tokens — no summing across messages. Goal-relative via
     `tokensBaseline` (the same snapshot of the newest pre-goal turn,
     captured on the first tick). Compaction (an assistant message with
     `summary: true`) breaks the snapshot chain, so accounting is segmented:
     the summary message closes the segment into `tokensCommitted` (the
     summary turn read the whole context, so its snapshot prices the
     compaction itself) and the next segment starts with a zero baseline.
     `tokensUsed = tokensCommitted + current segment`, kept monotonic so
     unflagged context shrinks never move the budget backwards;
    - a user abort pauses the goal instead of blocking it: the event path in
      `processPayload` pauses immediately on the MessageAbortedError message
      (before any tick could send a continuation over the user's explicit
      stop), with a tick-side safety net. Messages sent while paused leave
      the goal alone; Resume re-arms the loop, and resuming over an aborted
      tail skips the audit and goes straight to a continuation nudge;
    - `question.asked` pauses an active goal (including when a child /
      sub-agent session asks — the parent session's goal is the one paused)
      but does NOT abort the current turn: aborting would kill the pending
      question. After the user answers, they Resume manually to re-arm
      the loop. **Exception:** when question auto-delegate is handling the
      ask (`shouldKeepGoalActiveForQuestion`), the goal stays `active` and
      only the idle timer is cleared; `tick` also bails while
      `isQuestionBlockingGoal` reports a pending auto-delegated question on
      the session or a known descendant. User pause / disable of auto-delegate
      still calls `pauseForQuestion`. See `lib/question-auto-delegate/`.
      Explicit `session.updated` with `status: paused` notifies `onGoalPaused`
      (cancels related question timers) **except** when `statusReason` is
      `paused for question` (auto-delegate must keep counting). Abort after
      metadata already paused still notifies for non-question pause reasons
      (UI concurrent abort + metadata race).
   - terminal checks, cheapest first: assistant turn error → `blocked`;
     `tokensUsed >= tokenBudget` → `budgetLimited`;
     `turnsUsed >= MAX_AUTO_TURNS` (20) → `blocked`;
   - if the latest message is a compaction summary, skip the audit and
     continue unconditionally — running into the context window mid-work is
     by definition "in progress, not finished" (the summary is a retelling,
     not evidence, and must not be judged);
   - otherwise, small-model audit of the objective + the last assistant turn
     only — no conversation history and no continuation prompts
     (`restrictToPreferredProvider`, session's own provider/model preferred):
     JSON `{verdict: continue|complete|blocked, note}`. The audit is the SOLE
     termination authority besides the hard stops above — the working agent
     has no channel to settle its own goal. `complete` settles; `blocked`
     increments `blockedStreak` and settles only after 3 consecutive blocked
     verdicts, so a one-off snag cannot end the goal. Audit failure/absence
     tolerates ONE consecutive unaudited continuation (`auditFailStreak`); a
     second consecutive failure settles the goal as `blocked` ("progress
     audit unavailable") — resumable, and settling resets the streak so
     Resume gets fresh tolerance. A dead small model can never drive the
     loop blind to the turn cap;
    - continue (ticket 10 durable admission): persist accounting +
       `pendingContinuation` (`phase: reserved`, fixed `msg_goalc_…` id +
       prompt/selection payload) **without** bumping `turnsUsed`; re-check
       tail; then `session.switchAgent` / `session.switchModel` +
       `session.prompt` with that stable id. Accept → one conditional commit
       of `turnsUsed + 1` and clear pending. Selection/pre-prompt pause or
       failure clears reserved pending (0 count). Uncertain transport keeps
       durable identity and pauses auto-continue with a readable
       `statusReason`; next tick / reboot reconciles via inbox / exact
       message (fail ≠ empty) before any new id. Already-received counts
       once. Synthetic is metadata-only (`goalContinuation`).
    - **Shutdown recovery (ticket 07):** `session.execution.interrupted` with
      `reason: shutdown` clears the idle timer and sets a **local** recovery
      pending marker (not a parallel durable store). Auto-continue / tick stay
      gated until authoritative `session.status` idle or a non-shutdown
      execution terminal clears the marker. Goal status itself is unchanged.

4. Settling (`complete`/`blocked`/`budgetLimited`) fires the injected
   `emitGoalNotification` so the user hears about it even with the UI closed.
   The same settle also notifies a registered Assistant contact reporter
   (`setAssignedSessionSettleHandler`) so an assigned/watched session updates
   its contact card — read-only, no second scheduler:
   desktop + UI broadcast + the standard push fanout (web-push with full
   text; APNs with a generic per-type title and the session name as body).
   It obeys the notify-on-completion setting. Conversely, while a goal is
   ACTIVE the notifications runtime suppresses per-turn "ready"
   notifications on every channel — they would only echo the loop's own
   continuations; error/question/permission notifications are untouched.
    Pausing a goal from the UI also aborts the running turn (and vice versa —
    an abort pauses the goal), so "stop" means stop on both axes. A
    `question.asked` pause is the exception: it only writes `status: paused`
    and leaves the waiting turn intact.

## Continuation prompt

Built inline in `runtime.js`: the objective as untrusted user data in an
XML-escaped `<objective>` block, budget numbers, keep-the-full-objective and
work-from-evidence rules, a completion-audit instruction, and the requirement
to end every turn with a factual done/verified/remaining report — the audit
sees only that final turn, so the report is its evidence.

## UI consumers (packages/ui)

- `lib/sessionGoalMetadata.ts` — payload parsing/types.
- `lib/sessionGoalActions.ts` — create/edit/pause/resume/clear via
  `patchSessionMetadata`; `lib/sessionGoalPresentation.ts` — status
  colors/labels shared across surfaces.
- `stores/useSessionGoalArmStore.ts` — the "next prompt starts a goal" flag,
  consumed by `sendMessage` in `sync/session-ui-store.ts` (works for drafts).
- `hooks/useSessionGoal.ts` — live goal state.
- `components/chat/SessionGoalButton.tsx` — composer target button
  (arm / status color / cancel confirm); `SessionGoalRow.tsx` — goal strip
  above the composer; `SessionGoalDialog.tsx` — manage dialog
  (edit/pause/resume/complete/clear).
- Sidebar glyph next to the date in `SessionNodeItem`.

## Capability (Host goal state)

`capability.js` is the single source for whether Host goal state is available:

```
getSessionGoalCapability() → { supported: true }
```

Goal records live in the OpenChamber session-metadata store (not OpenCode
SessionInfo). Routes, scheduled tasks, and the proxy overlay share that store.

| Surface | While supported |
|---|---|
| `GET /api/goals/capability` | `{ supported: true }` |
| `POST /api/goals/:sessionId` (create) | Write objective + persist active goal (503 if persist missing) |
| `POST /api/goals/:sessionId/resume` | Set status active / statusReason resumed (404 if no goal) |
| `PUT /api/goals/objective/:sessionId` | Writes the objective file |
| `GET` / `DELETE` objective | Allowed |
| Scheduled `goalEnabled` create/edit | Allowed |
| Existing `goalEnabled` task run | Persist goal after session create; fail before create if persist unwired |

## Scheduled goals

Scheduled tasks with `execution.goalEnabled` (+ optional
`execution.goalTokenBudget`) write the objective file, persist an active goal
into the Host store (same shape as manual create), notify the goal runtime to
arm, and attach the goal-mode intro to the prompt. Without
`persistSessionGoal` injected, runs fail **before** session create (no
create/distill/prompt side effects).

## Limitations

- TODO(watch): Assistant contact assign skipped a watch tool this slice.
  Goal settle already notifies. Do not invent a second scheduler. A later
  thin contact tool can post a read-only session status card when
  `metadata.openchamber.goal` settles.
- Web-server feature: VS Code (extension-only) renders goal state via
  `session.updated` but does not run the loop.
- A goal on a session with no assistant reply yet starts after the first
  user exchange completes (no provider/model to continue with before that).
- `tokensUsed` only counts completed assistant messages seen within the
  40-message fetch window per tick; extremely long busy stretches between
  idles undercount (acceptable: budget is a guardrail, not billing).
