# Scheduled Tasks module

Server-owned scheduled task runtime and routes for OpenChamber-only automation.

## Scope

- Per-project scheduled task persistence is owned by `packages/web/server/lib/projects/project-config.js`.
- Runtime orchestration and execution is owned by this module.
- Durable run history is owned by an independent SQLite store in this module.
- This module is OpenChamber feature logic; it is intentionally separate from OpenCode proxy/runtime internals.

## Files

- `packages/web/server/lib/scheduled-tasks/runtime.js`
  - Next-run computation (daily/weekly/cron compatibility)
  - Timer scheduling and queueing
  - Concurrency controls
  - Session create → archive → goal/prompt/command execution
  - Emits OpenChamber task-run events
  - Isolates project sync failures, retries each failed project up to three times,
    and clears pending retries during shutdown
  - Injects `runHistoryStore` to persist every actual run

- `packages/web/server/lib/scheduled-tasks/run-history-store.js`
  - Independent SQLite file `scheduled-task-runs.sqlite` (WAL)
  - Keyset-paginated list of run records
  - On open, converges leftover `running` rows to `error` with an interrupted message

- `packages/web/server/lib/scheduled-tasks/routes.js`
  - Global scheduled task list endpoint with per-project partial-result handling
  - Global run history list endpoint
  - Project scheduled task CRUD endpoints
  - Manual run endpoint
  - OpenChamber events SSE stream endpoint (`GET /api/openchamber/events`): 25s
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

Dependencies include optional `runHistoryStore` with:

- `startRun(record)`
- `attachSession(runID, sessionID)`
- `finishRun(runID, result)`

## Public exports (run-history-store.js)

- `createScheduledTaskRunHistoryStore({ dbPath, clock? })`
- Returned API:
  - `startRun(record)`
  - `attachSession(runID, sessionID)`
  - `finishRun(runID, result)`
  - `listRuns({ before, limit, projectID?, taskID? })`
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

Indexes support `started_at DESC, run_id DESC` listing with project/task filters.

### List pagination

- Opaque base64url keyset cursor over `(startedAt, runID)` descending.
- Default limit `20`, maximum `100`.
- Same-timestamp rows are stable and non-duplicating across pages.
- Response DTO is camelCase:
  `id, projectId, taskId, taskName, trigger, status, sessionId, directory, error, startedAt, finishedAt, durationMs`
  plus page fields `nextCursor, complete`.

### Crash convergence

On store open, any leftover `status=running` row is rewritten to:

- `status=error`
- explicit interrupted error message
- `finished_at=clock()`
- `duration_ms` from `started_at`

## Public exports (routes.js)

- `registerScheduledTaskRoutes(app, dependencies)`
- Registers:
  - `GET /api/openchamber/scheduled-tasks`
  - `GET /api/openchamber/scheduled-task-runs`
  - `GET /api/projects/:projectId/scheduled-tasks`
  - `PUT /api/projects/:projectId/scheduled-tasks`
  - `DELETE /api/projects/:projectId/scheduled-tasks/:taskId`
  - `POST /api/projects/:projectId/scheduled-tasks/:taskId/run`
  - `GET /api/openchamber/scheduled-tasks/status`
  - `GET /api/openchamber/events`

Dependencies include optional `runHistoryStore` for the history list route.

## Global task list contract

`GET /api/openchamber/scheduled-tasks` reads configured projects through
`readSettingsFromDiskMigrated()` and `sanitizeProjects(settings.projects)`, then
loads each project with `projectConfigRuntime.listScheduledTasks(project.id)`.

The response is `{ tasks, failedProjectIds }`, where every task entry has the
shape `{ projectId, task }`. Task IDs are project-scoped, so entries retain their
`projectId` even when multiple projects contain the same task ID. A project load
failure preserves tasks from completed projects and adds that project ID to
`failedProjectIds`; settings-read failures return HTTP 500.

## Run history API

`GET /api/openchamber/scheduled-task-runs?before=&limit=&projectId=&taskId=`

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
2. Persist task state `lastStatus=running`.
3. Create a per-run `AbortController` and race `runTaskWithWatchdog` against
   `maxRunDurationMs` (default 2 hours). Only this watchdog timeout aborts
   the controller; manual `runNow` cancellation and runtime `stop()` (timers/
   queue only) must not fire it.
4. Create an OpenCode session with:
   - title: `[Scheduled] ${taskName} yyyy-LL-dd HH:mm` (total length ≤ 120)
   - metadata: `openchamber.scheduledTask = { projectID, taskID, runID, name }`
   - SDK/HTTP calls receive `{ signal }` as the second request-options argument
     (`client.session.create(params, { signal })`, same for `update` /
     `command` / `command.list`; raw `fetch` for goal PATCH and `prompt_async`
     pass `signal` in `RequestInit`).
5. `attachSession(runID, sessionID)` immediately after create.
6. Archive the session via SDK `client.session.update({ sessionID, directory, time: { archived } })`.
   - 404 receives one short bounded retry (also signal-aware); other failures
     abort without prompt.
   - If attach fails, the runtime still attempts archive, then fails the run.
 7. Only after a successful archive: goal metadata PATCH (preserving the
    `scheduledTask` marker together with `goal`), then command or `prompt_async`.
    Non-cancellable async gaps (small-model distill, objective file write) check
    `signal.throwIfAborted()` before continuing so a timed-out run never prompts.
    **Admission is not completion:** `prompt_async` / command return when the
    turn is accepted, not when the agent finishes.
 8. Wait for the real session outcome (bounded by the same watchdog):
    - Poll `session.status` + `session.messages` until the session is idle and
      the tail is a settled assistant turn (completed, or incomplete-but-stable
      while idle). Assistant `error` (including abort) finalizes as `error`.
    - Goal-enabled runs poll `session.get` for terminal goal status
      (`complete` → success; `blocked` / `budgetLimited` → error) and do not
      finish on the first idle between goal turns.
    - `durationMs` / `finishedAt` are wall-clock from run start through this
      settlement — not the prompt admission latency.
 9. On watchdog timeout after a session exists: immediately throw the canonical
    `schedule run timed out` without awaiting non-cancellable helper work. A
    once-only abort listener registered after session create starts best-effort
    `client.session.abort({ sessionID, directory })` as soon as the watchdog
    aborts the signal (or right after create if the signal already aborted).
    Abort failures must not replace the timeout error. Successful runs and
    ordinary non-timeout failures never call session abort.
 10. Finalize history with the ultimate run status (timeout → `error` with
    `schedule run timed out`; assistant/goal failure → `error` with the
    recorded reason). An already-attached `session_id` remains on the history
    row so the session stays openable from history. Task state persistence
    failures also finalize history as `error`. A failed history finalize
    returns error and may leave a `running` row for next-start convergence.
  11. `lastSessionId` is written on the task state whenever the run has a
     session (success or error). If the run has no session, omit
     `lastSessionId` from the patch so a previous value is preserved. Full
     association still lives in the history table; history rows are not
     rewritten after finalize.

SSE events keep the existing `openchamber:scheduled-task-ran` shape.

## Post-run continuation

After a run has finalized with a session, the user may continue chatting in
that same history session. `observeSessionEvent` corrects **only task state**
(history rows are not rewritten, `finishRun` is not called again):

- `session.status` busy/retry while `lastStatus` is `error` or `success` →
  `lastStatus` `running`, clear `lastError`, keep/set `lastSessionId`
- later `session.idle` (or idle `session.status`) with a success snapshot →
  `lastStatus` `success`
- do not change `lastRunAt` / `lastDurationMs` / `nextRunAt`

A live run (`runningTaskKeys`) owns settlement; the observer is a no-op while
the task is in `runningTaskKeys`. Idle correction is a no-op if `lastStatus`
is already `success`, or if the snapshot is still error/busy/unknown. Observer
failures are logged and must not throw out of the event bus.

Run start also emits `scheduled-task-ran` with `status: running` as soon as
task state is persisted, so the outer task list can show in-progress before
the session is attached.

## Watchdog cancel / upstream abort

- Timeout path: abort the per-run signal → cancel in-flight cancellable
  SDK/HTTP → start best-effort OpenCode `session.abort` via the create-time
  abort listener (independent of whether the current await is cancellable) →
  **do not wait** for non-cancellable helpers (small-model distill /
  `writeObjective`) to finish → history and task state finalize as `error`
  with `schedule run timed out` within the watchdog bound. The detached
  `runPromise` is settled with a catch so late rejections are not unhandled.
- When uncancellable helper work eventually finishes, post-await
  `throwIfAborted` gates stop goal PATCH / command / `prompt_async`.
- Non-timeout failures: no timeout abort; no forced `session.abort` from the
  watchdog.
- Runtime `stop()` clears timers, project-sync retries, and the queue only; it
  does not abort in-flight run controllers.
- Remaining non-cancellable edges: work already fully admitted and completed
  HTTP-wise before timeout cannot be rolled back by aborting the HTTP request
  alone; `session.abort` is the upstream stop for admitted command/prompt
  execution. Small-model distillation and objective file writes are not passed
  a signal; the watchdog does not await them, and abort gates block later
  stages after they complete.

## Shutdown

Graceful shutdown stops `scheduledTasksRuntime` (timers/queue only). It does
**not** close the process-lifetime `runHistoryStore` singleton: in-flight
attach/finalize may still write after `stop()`, and
`startWebUiServer().stop({ exitProcess: false })` must be able to restart in the
same process without reopening a closed SQLite handle. Store `close()` remains
for isolated tests and any process-final owner that truly owns process exit.
Server wiring stores the SQLite file under `OPENCHAMBER_DATA_DIR` as
`scheduled-task-runs.sqlite`.
