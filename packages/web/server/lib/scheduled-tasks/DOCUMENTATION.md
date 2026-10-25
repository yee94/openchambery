# Scheduled Tasks module

Server-owned scheduled task runtime and routes for Yuri-only automation.

## Scope

- Per-project scheduled task persistence is owned by `packages/web/server/lib/projects/project-config.js`.
- Runtime orchestration and execution is owned by this module.
- Durable run history is owned by an independent SQLite store in this module.
- This module is Yuri feature logic; it is intentionally separate from OpenCode proxy/runtime internals.
- Prompt and goal execution preserve hash-prefixed text literally; no snippet discovery or expansion occurs before dispatch.

## Assistant result handoff

`setTaskResultHandler(handler)` installs the Host's assistant result consumer and
returns its cleanup function. The feature-route composition wires it to the
assistant service. A handler returns `true` once associated contacts have reviewed
the result (including explicit silence); `false` retains ordinary scheduled-task
notification delivery. The scheduler releases its execution slot independently
of assistant inference. Handler failures keep the result pending.

Run history stores the original execution prompt privately alongside a
`result_pending` marker. The same terminal history update makes the result
eligible for delivery, including an in-flight run reconciled after restart.
`listPendingResults` uses bounded keyset pages of 20; the existing five-second
recovery pass retries handoffs with at most four in flight per runtime. A failing
page does not prevent the cursor from reaching later results. `acknowledgeResult`
clears only the delivery marker, never the execution result. Execution failure,
history-persistence failure, and assistant delivery failure remain distinct.

The additive migration leaves already-terminal old history acknowledged, avoiding
an upgrade notification backlog. Old running records enroll when they really
settle. Public history DTOs expose neither the prompt nor internal delivery state.
Assistant receipts deduplicate completed reviews, including silent ones; this is
a retryable handoff, not an exactly-once guarantee for model requests or device
pushes during crashes/concurrent Hosts. Result review is read-only.

## Built-in new-session skill

`session-skill.js` intercepts new `POST /api/session` admissions on a Host using
the local official shared OpenCode service. It preserves the official `{ data }`
HTTP envelope and uses the official client to create the session and put one
`yuri.scheduled-task` instruction entry. This is an on-demand built-in
workflow, not a globally installed native `skill` registration: the entry names
one `describe` command; its result supplies `SESSION_SKILL.md` and bound
create/list commands. No repository/global OpenCode files are modified. Existing
sessions and sessions created directly in OpenCode are not enrolled.

The self-contained helper is published atomically into a content-addressed Host
data directory, including for packaged/OTA backends. The Host runs the exact
helper's `check` before installing the instruction. It reads the existing shared
service registration credential internally; no password/token is placed in
instructions, arguments, task JSON or tool output. Browser/password/client auth
continues to protect session creation. The reserved bridge accepts only local,
non-browser POSTs with the current shared-service Basic credential, and then
checks the authoritative session's Host binding. That credential does not grant
access through ordinary UI routes. Credentials are re-read on every invocation.

The bridge resolves project ownership from `session.location.directory`, not
model-supplied IDs or shell cwd. Create defaults come from the current session
model/agent, then its location's model default. The bridge dispatches into the
same project CRUD router as the UI, retaining catalog checks, write guards and
scheduler sync semantics. The create-only flag prevents replacing an existing
ID. Unknown writes report the generated ID for read-back and are never retried;
`schedulerSynced:false` remains committed success.

Failed capability preparation fails admission visibly. A confirmed newly created
session is removed on failure; if removal cannot be confirmed (or the caller
provided an explicit session ID), the response includes the retained session ID.
No unrelated session is removed. Registration/auth problems are detected before
the model can be offered a non-working entry.

Web, Electron, hosted-mobile and Capacitor clients share this Host path. Electron
uses its executable in `ELECTRON_RUN_AS_NODE` mode; the helper lives outside the
application archive. Windows command descriptions use a hidden PowerShell
wrapper. External/cross-machine OpenCode and VS Code's extension-owned server
do not receive this local capability; private managed mode retains its existing
managed-plugin path. Fork/import and existing sessions are not retrofitted.
The Host must remain running to serve the skill and schedule tasks.

`session-skill.test.js` covers real password-enabled Host auth, the advertised
subprocess commands, durable task read-back, project isolation, caller-independent
model defaults, denied origins/credentials, preflight failures and rollback.

## Files

- `packages/web/server/lib/scheduled-tasks/runtime.js`
  - Next-run computation (daily/weekly/cron compatibility)
  - Timer scheduling and queueing
  - Concurrency controls
  - Session create → goal/prompt/command execution
  - Emits Yuri task-run events
  - Isolates project sync failures, retries each failed project up to three times,
    and clears pending retries during shutdown
  - Injects `runHistoryStore` to persist every actual run

- `packages/web/server/lib/scheduled-tasks/run-history-store.js`
  - Independent SQLite file `scheduled-task-runs.sqlite` (WAL)
  - Keyset-paginated list of run records
  - Preserves `running` rows on open; repairs legacy synthetic restart errors
    with attached sessions back to pending reconciliation
  - Scheduled runs claim `(project_id, task_id, slot_at)` so multiple Yuri
    processes sharing a data dir cannot occupy the same fire slot

- `packages/web/server/lib/scheduled-tasks/routes.js`
  - Global scheduled task list endpoint with per-project partial-result handling
  - Global run history list endpoint
  - Project scheduled task CRUD endpoints
  - Manual run endpoint
  - Yuri events SSE stream endpoint (`GET /api/yuri/events`): 25s
    heartbeat interval unchanged; half-open clients that stay paused across two
    consecutive heartbeat cycles are destroyed and removed from the client set
    (idempotent cleanup). SSE is best-effort; authoritative data is HTTP pull.
  - Returns persisted mutation results with `schedulerSynced`; a failed scheduler
    sync schedules one bounded retry while preserving the committed response

- `packages/web/server/lib/scheduled-tasks/managed-tool-route.js`
  - Managed OpenCode `scheduled_task` bridge endpoint
  - Receives requests only after the API auth gate validates the current
    managed-child capability for the reserved bridge path
  - Resolves the authoritative OpenCode session and message model before selecting
    the deepest configured project containing the session directory
  - Requires `validateDirectoryPath` for realpath-backed directory validation
    across request context, OpenCode session context, worktrees, and projects
  - Requires an exact assistant/tool message and its in-session user parent
  - Uses `projectConfigRuntime.patchScheduledTask()` for partial updates
  - Returns persisted mutations with `schedulerSynced`; failed scheduler syncs
    schedule one bounded retry without including task prompts in logs
  - Exports `registerScheduledTaskToolRoute(app, dependencies)`
  - Shares `selectScheduledTaskProject()` with the new-session bridge.

- `packages/web/server/lib/scheduled-tasks/managed-tool-contract.js`
  - Exports `MANAGED_SCHEDULED_TASK_TOOL_PATH`
  - Exports `MANAGED_SCHEDULED_TASK_TOKEN_HEADER`

## Public exports (runtime.js)

- `createScheduledTasksRuntime(dependencies)`
- Returned API:
  - `start()`
  - `stop()`
  - `syncAllProjects()`
  - `syncProject(projectId)`
  - `runNow(projectId, taskId)`
  - `observeSessionEvent(event)`

Isolation dependencies (required for sidebar hide):

- `persistSessionMetadata(sessionID, patch)` — Host store write. Missing
  persist refuses the run **before** `session.create`. Persist failure after
  create fails the run before prompt.
- `onSystemSessionPersisted({ sessionID, directory, metadata })` — drop the
  session from the sidebar index immediately after Host commit.

Dependencies include optional `runHistoryStore` with:

- `startRun(record)`
- `attachSession(runID, sessionID)`
- `finishRun(runID, result)`
- `listRunningRuns({ before?, limit? })` for bounded restart recovery

## Public exports (run-history-store.js)

- `createScheduledTaskRunHistoryStore({ dbPath, clock? })`
- Returned API:
  - `startRun(record)`
  - `attachSession(runID, sessionID)`
  - `finishRun(runID, result)`
   - `listRuns({ before, limit, projectID?, taskID? })`
   - `listRunningRuns({ before?, limit? })`
  - `close()`

### Run record fields

Persisted columns:

| Column | Notes |
|---|---|
| `run_id` | Primary key |
| `project_id` | Owning project |
| `task_id` | Project-scoped task id |
| `task_name` | Snapshot at run start |
| `trigger` | `scheduled` or `manual` |
| `status` | `running`, `success`, or `error` |
| `session_id` | Nullable until attach |
| `directory` | Nullable project path snapshot |
| `error` | Nullable final error message |
| `started_at` | Epoch ms |
| `finished_at` | Nullable epoch ms |
| `duration_ms` | Nullable |
| `slot_at` | Scheduled occupancy key (the armed `nextRunAt`). Null for manual runs. List DTO omits this column. |

Partial unique index `scheduled_task_run_scheduled_slot` on
`(project_id, task_id, slot_at)` where `trigger = 'scheduled' AND slot_at IS NOT NULL`.
A second `startRun` for the same slot throws `SCHEDULED_SLOT_CLAIMED`.

Indexes support `started_at DESC, run_id DESC` listing with project/task filters.

### List pagination

- Opaque base64url keyset cursor over `(startedAt, runID)` descending.
- Default limit `20`, maximum `100`.
- Same-timestamp rows are stable and non-duplicating across pages.
- Response DTO is camelCase:
  `id, projectId, taskId, taskName, trigger, status, sessionId, directory, error, startedAt, finishedAt, durationMs`
  plus page fields `nextCursor, complete`.

### Restart recovery

Opening a store is not evidence that an OpenCode execution stopped: the shared
runner or another Host may still be executing. Store open preserves running rows.
For old records with an attached session and the exact synthetic error
`Run interrupted by process restart`, it clears the artificial terminal fields
and restores `running`. Real failures and successful history remain unchanged.

Runtime startup begins a non-overlapping recovery loop: one indexed keyset page
of at most 20 running rows every five seconds, wrapping after the last page.
Each pass has a ten-second upstream request deadline. It skips locally owned
executions and rows without a session; missing session association is not proof
of execution failure. Such rows remain unresolved rather than inventing a result.
Recovery checks live `session.active` before examining terminal messages or Host
goal state. Active, unavailable, malformed, and incomplete results remain pending.
Only confirmed terminal evidence finalizes history, with duration through the
time recovery observes completion. It neither dispatches a new prompt nor sends
a second completion notification.

The same loop independently visits at most 20 configured tasks per pass, wrapping
through the catalog, to reconcile persisted `lastStatus: running`. History and
task state are separate stores: a successful history row does not guarantee that
the task snapshot was finalized, and completed history no longer appears in the
running-history scan. The latest indexed history row may supply the session only
when its `startedAt` matches the task's `lastRunAt`; a different run is never used.
Without a history row, an existing last-session binding can be checked directly.
Live activity is checked before terminal messages/goal state, so old successful
history cannot hide a still-running continuation. Both success and error settle
task activity; failed/unknown/incomplete reads preserve it and retry later.

Task reconciliation has its own ten-second request deadline and skips local
executions. Stop and in-memory identity changes fence late reads. The project
write lock checks `updateScheduledTaskState(..., { expectedState })` against the
captured run/session/status/update timestamp before committing, so a newer run or
edit wins. Unconditional callers keep their existing behavior. Recovery changes
only status/error/session binding, retaining schedule, enabled state, last-run
time and duration; it emits the existing invalidation event on commit. Historical
continuation events use the same guarded terminal writes and settle failures as
well as successes. Regression tests cover already-finished history, restart,
busy/failed/incomplete authority, stop/new-run races, and bounded partial recovery.

`finishRun(..., { onlyIfRunning: true })` conditionally writes recovery results,
returning null if another writer already finalized the row. Recovery emits the
existing task-run invalidation event only on a committed result. Stop aborts its
requests and timer; late results from the stopped runtime cannot commit. Ordinary
finalized history (including later chat continuation) is never reopened.

## Public exports (routes.js)

- `registerScheduledTaskRoutes(app, dependencies)`
- Registers:
  - `GET /api/yuri/scheduled-tasks`
  - `GET /api/yuri/scheduled-task-runs`
  - `GET /api/projects/:projectId/scheduled-tasks`
  - `PUT /api/projects/:projectId/scheduled-tasks` — body must be `{ task }`. A bare task, `{ tasks: [] }`, or `{ task: [] }` is HTTP 400 with `expected` describing that envelope. After the project and goal checks, creates, provider/model changes, and disabled→enabled transitions load the connected catalog for `project.path` through `loadConnectedCatalog` / `isConnectedModel` (`ModelInfo.id`, not the internal `modelID`). An unconnected model is HTTP 400 and is not written. Catalog failure is HTTP 503 and is not written. Renames and disables that keep the stored provider/model are allowed when the catalog is down. The route passes the pre-read existence, provider, model, and enabled snapshot into the project-config write lock; a mismatch is HTTP 409 and is not written. Scheduler sync failure does not roll back a committed write. `GET /api/config/catalog/providers` remains HTTP 502 when its upstream catalog fails.
  - `DELETE /api/projects/:projectId/scheduled-tasks/:taskId`
  - `POST /api/projects/:projectId/scheduled-tasks/:taskId/run`
  - `GET /api/yuri/scheduled-tasks/status`
  - `GET /api/yuri/events`

Dependencies include optional `runHistoryStore` for the history list route.
`buildOpenCodeUrl` and `getOpenCodeAuthHeaders` are read at request time to
build the catalog client. Callers that do not pass an `expected` snapshot to
`upsertScheduledTask` keep the previous unconditional write.

## Global task list contract

`GET /api/yuri/scheduled-tasks` reads configured projects through
`readSettingsFromDiskMigrated()` and `sanitizeProjects(settings.projects)`, then
loads each project with `projectConfigRuntime.listScheduledTasks(project.id)`.

The response is `{ tasks, failedProjectIds }`, where every task entry has the
shape `{ projectId, task }`. Task IDs are project-scoped, so entries retain their
`projectId` even when multiple projects contain the same task ID. A project load
failure preserves tasks from completed projects and adds that project ID to
`failedProjectIds`; settings-read failures return HTTP 500.

## Run history API

`GET /api/yuri/scheduled-task-runs?before=&limit=&projectId=&taskId=`

- Success: `{ runs, nextCursor, complete }` where `runs` is an array,
  `nextCursor` is `string | null`, and `complete` is a boolean
- Empty catalog is a successful empty page, not an error
- `limit` accepts positive integers only (rejects fractions such as `1.5`)
- Invalid cursor or limit → HTTP 400
- Store failure or malformed page shape → HTTP 500 (never masqueraded as empty
  success with default `runs: []` / `complete: true`)
- History is independent of task deletion: deleting a scheduled task does not
  delete past runs

## Execution lifecycle

Every actual run (timer or manual):

1. Allocate a unique `runID` and persist `status=running` in the history store.
   Timer fires pass the armed `nextRunAt` as `slotAt`. A duplicate scheduled
   slot claim skips the run: no session, no task-state write, no notification.
   The losing scheduler arms the next occurrence and returns `{ skipped: true }`.
2. Persist task state `lastStatus=running`.
3. Create a per-run `AbortController` and race `runTaskWithWatchdog` against
   `maxRunDurationMs` (default 2 hours). Only this watchdog timeout aborts
   the controller; manual `runNow` cancellation and runtime `stop()` (timers/
   queue only) must not fire it.
4. Create an OpenCode session with:
   - title: `[Scheduled] ${taskName} yyyy-LL-dd HH:mm` (total length ≤ 120)
   - metadata: `yuri.scheduledTask = { projectID, taskID, runID, name }`
    - SDK/HTTP calls receive `{ signal }` as the second request-options argument
      (`client.session.create(params, { signal })`, same for `prompt` /
      `command` / `command.list`; raw `fetch` for goal PATCH
      pass `signal` in `RequestInit`).
 5. `attachSession(runID, sessionID)` immediately after create.
    - If attach fails, the runtime fails the run without prompting.
  6. When `goalEnabled`: refuse before OpenCode ready / session create if
      `persistSessionGoal` is not injected; otherwise write objective file,
      persist an active goal into the Host session-metadata store, optionally
      notify `onGoalPersisted` to arm the goal loop, then command or
      `session.prompt`. Non-cancellable async gaps (small-model distill,
      objective file write) check `signal.throwIfAborted()` before continuing so
      a timed-out run never prompts.
    **Admission is not completion:** `session.prompt` / command return when the
    turn is accepted, not when the agent finishes.
  7. Wait for the real session outcome (bounded by the same watchdog):
     - Poll `session.active` + `message.list` until the session is idle and
       the **latest-side** message page settles. Settlement always uses
       `message.list({ limit: 50, order: 'desc' })` (newest first) — never
       `order: 'asc'` page-0 + `at(-1)`, which reads an old page once the
       session exceeds the limit.
      - OpenCode 2.0.16 emits a native `idle` tail whose `outcome` is authoritative:
        `succeeded` → success; `failed` / `interrupted` → error. An unknown idle
        outcome keeps polling. Read it only after `session.active` confirms the
        session is inactive; an older terminal record cannot settle live work.
        This also applies to post-run continuation snapshots. Earlier servers
         without idle records use the assistant-tail rules below.
      - Failed idle records carry no error detail. Prefer the current run's
        `session.execution.failed.error.message`, captured before prompt/command
        admission can finish. Otherwise read the newest assistant error in this
        turn on the same bounded page, stopping at the previous idle marker.
        Error text prefers `message` / legacy `data.message` over name/type;
        only missing detail falls back to the generic execution failure.
        Do not serialize provider response bodies or stacks. Persist this text
        through the existing history `error` and task `lastError` fields.
        The event capture is session-scoped, ignores unrelated sessions, and is
        removed on settlement or watchdog abort. It never determines activity
        or overrides succeeded/interrupted outcomes. Existing history is not
        backfilled.
      - Assistant-tail terminal success requires `time.completed`
       and finish not `tool-calls` (prefer `finish: 'stop'`). `finish:
       'tool-calls'`, incomplete assistants (no `time.completed`), and
       non-assistant tails such as `model-switched` never succeed — including
       after multiple incomplete idle probes.
     - `session.active` / `message.list` failures stay **unknown** (keep
       polling under the watchdog); they never masquerade as idle success.
     - Assistant `error` (and terminal finish `error` / `length` /
       `content-filter`) finalizes as `error`.
      - Goal-enabled runs: settle via Host goal terminal status when the store
        seam is available (`readSessionMetadata` preferred over OpenCode
        `session.get`). Store read failure is never empty-goal success.
     - `durationMs` / `finishedAt` are wall-clock from run start through this
       settlement — not the prompt admission latency.
 8. On watchdog timeout after a session exists: immediately throw the canonical
    `schedule run timed out` without awaiting non-cancellable helper work. A
    once-only abort listener registered after session create starts best-effort
     `client.session.interrupt({ sessionID, continue: false })` as soon as the watchdog
     aborts the signal (or right after create if the signal already aborted).
     Interrupt failures must not replace the timeout error. Successful runs and
     ordinary non-timeout failures never call session interrupt.
 9. Finalize history with the ultimate run status (timeout → `error` with
    `schedule run timed out`; assistant/goal failure → `error` with the
    recorded reason). An already-attached `session_id` remains on the history
    row so the session stays openable from history. Task state persistence
    failures also finalize history as `error`. A failed history finalize
    returns error and may leave a `running` row for session-outcome recovery.
 10. `lastSessionId` is written on the task state whenever the run has a
     session (success or error). If the run has no session, omit
     `lastSessionId` from the patch so a previous value is preserved. Full
     association still lives in the history table; history rows are not
     rewritten after finalize.

SSE events keep the existing `yuri:scheduled-task-ran` shape.

### Session create delivery

`session.create` is one shot unless the official client error proves the
request never left this process. The only proven-unsent causes, walked on the
SDK `cause` chain, are `ECONNREFUSED` with `syscall=connect` and `ENOTFOUND`
with `syscall=getaddrinfo`. Those retry inside the same run and the same
`slotAt`: the initial attempt plus three more, waiting 1s, 4s, then 10s.
The create phase deadline is 45s and is also cut by the run watchdog. A later
attempt is not started after either bound. Prompt and command are never
retried.

`session.create` is sent with `redirect: 'manual'`. A 3xx is not followed
and is not retried: the first response may already have created the session,
and a later `ECONNREFUSED` / `ENOTFOUND` on the redirect target is not proof
the create was never sent. Outcome stays unknown. Prompt and command keep
the platform redirect default; they are still not retried.

A response, a reset after accept (`UND_ERR_SOCKET`), a timeout, HTTP 3xx /
401 / 403 / 409 / 502 / 503 / 504, an abort, a decode failure, or a success body
without `id` is not retried. HTTP 503, a missing session id, and a body `id`
do not prove the session was not created. Those failures keep the error and
say `creation outcome unknown`. They do not post a second create and do not
prompt. Runtime-contract 409 is the existing gate (the private fetch is
inside it) and is not retried.

Each run passes its own `fetchImpl` to `makeOpenCodeV2Client`. Only that
run's `session.create` attempt signal is tracked: `redirect: 'manual'` and
failure capture apply to that signal, not to prompt or command. The fetch
holds the attempt object captured before the request is awaited, so a body
that arrives after the deadline stays on that attempt and is not read as the
next attempt's error. A failed attempt is summarized from its own capture
only. Failed responses are cloned with a byte and time bound; the original
`Response` is what the SDK reads. Parse or capture failure does not replace
the SDK error. The summary shared by history, task
`lastError`, logs, and notifications is at most 300 characters and only
keeps operation, HTTP status, message, code, and locally decided
`retryable`. HTTP status wins over a body status. Bearer tokens, credential
URLs, and token query values are redacted. Payloads, headers, and stacks are
not stored. Assistant text still prefers a top-level `message` /
`data.message`; `data.error.message` is used only when those are absent, and
code/status are appended only when present. A message with no code/status is
still redacted before the 300-character cut, including `Bearer` tokens,
`password:value`, and JSON `"token":"..."` forms. The wording stays the
message itself, not the HTTP summary template.

This batch does not compensate a slot missed across restart, and it does not
finalize a `running` history row that has no session. Another Host may still
be queued and not have claimed the slot; writing a terminal row here could
cancel that claim. One-time tasks still disable after a scheduled attempt,
including a failed one. `stop()` still does not abort an in-flight run.

## Post-run continuation

After a run has finalized with a session, the user may continue chatting in
that same history session. `observeSessionEvent` corrects **only task state**
(history rows are not rewritten, `finishRun` is not called again):

- `session.status` busy/retry while `lastStatus` is `error` or `success` →
  `lastStatus` `running`, clear `lastError`, keep/set `lastSessionId`
- later `session.idle` (or idle `session.status`) with a success snapshot from
  `session.active` + latest-side `message.list` → `lastStatus` `success`
- do not change `lastRunAt` / `lastDurationMs` / `nextRunAt`
- history rows are never rewritten; `finishRun` is not called again

A live run (`runningTaskKeys`) owns settlement; the observer only captures its
execution error detail while the task is in `runningTaskKeys`, without changing
task state or finalizing history. Idle correction is a no-op if `lastStatus`
is already `success`, or if the snapshot is still error/busy/unknown
(`session.active` failure and goal-unsupported goal tasks stay unknown).
Observer failures are logged and must not throw out of the event bus.

## Goal safety gating

Session goal Host state is advertised by
`packages/web/server/lib/session-goal/capability.js` as `{ supported: true }`.
Goal records live in the Yuri session-metadata store (same seam as
manual UI / `session-goal` runtime). Scheduled runs inject
`persistSessionGoal`, `readSessionMetadata`, and optional `onGoalPersisted`
from `server/index.js`.

| Path | Behavior |
|---|---|
| `PUT` scheduled task / managed-tool create·update with `execution.goalEnabled` | Allowed when capability supported |
| Existing `goalEnabled` task due or manual run | Requires `persistSessionGoal`; without it fail **before** OpenCode ready / session create / objective write / prompt; with it write objective + active goal then prompt |
| Ordinary non-goal task | Unchanged |
| Post-run observer on a goal-enabled task | Prefer Host store goal terminal status; never invent success from assistant-tail idle alone when goal is active |

Do not treat objective-file hints or first-turn assistant idle as a registered
goal success without a store-backed goal record.

Run start also emits `scheduled-task-ran` with `status: running` as soon as
task state is persisted, so the outer task list can show in-progress before
the session is attached.

## Watchdog cancel / upstream abort

- Timeout path: abort the per-run signal → cancel in-flight cancellable
  SDK/HTTP → start best-effort OpenCode `session.interrupt` via the create-time
  abort listener (independent of whether the current await is cancellable) →
  **do not wait** for non-cancellable helpers (small-model distill /
  `writeObjective`) to finish → history and task state finalize as `error`
  with `schedule run timed out` within the watchdog bound. The detached
  `runPromise` is settled with a catch so late rejections are not unhandled.
- When uncancellable helper work eventually finishes, post-await
  `throwIfAborted` gates stop goal PATCH / command / `session.prompt`.
- Non-timeout failures: no timeout abort; no forced `session.interrupt` from the
  watchdog.
- Runtime `stop()` clears timers, project-sync retries, and the queue, and aborts
  history-recovery reads. It does not abort in-flight run controllers.
- Remaining non-cancellable edges: work already fully admitted and completed
  HTTP-wise before timeout cannot be rolled back by aborting the HTTP request
  alone; `session.interrupt` is the upstream stop for admitted command/prompt
  execution. Small-model distillation and objective file writes are not passed
  a signal; the watchdog does not await them, and abort gates block later
  stages after they complete.

## Shutdown

Graceful shutdown stops `scheduledTasksRuntime` (timers/queue and history recovery). It does
**not** close the process-lifetime `runHistoryStore` singleton: in-flight
attach/finalize may still write after `stop()`, and
`startWebUiServer().stop({ exitProcess: false })` must be able to restart in the
same process without reopening a closed SQLite handle. Store `close()` remains
for isolated tests and any process-final owner that truly owns process exit.
Server wiring stores the SQLite file under `YURI_DATA_DIR` as
`scheduled-task-runs.sqlite`.
