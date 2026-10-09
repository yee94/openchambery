# Question Auto-Delegate

## Purpose

Server-owned automatic handling of OpenCode 2 question-tool forms (`form.created`,
`data.form.metadata.kind === "question"`). When
enabled (default), pending questions are answered after 30 seconds with a fixed
continuation text so agents (including background/subagent sessions) can proceed
without a connected UI. Manual reply/reject still use the official OpenCode
form schema. The Host adds a single-flight claim for timer, delegate, and
compatibility question routes. Native manual form replies settle via
`form.replied` / `form.cancelled`; upstream form settlement arbitrates any race
with a native reply already in flight.

Permission auto-accept is intentionally out of scope — this module never
replies to permission requests.

## Settings

Persisted via existing `PUT /api/config/settings`:

| Field | Type | Default |
|---|---|---|
| `questionAutoDelegateEnabled` | `boolean` | `true` (absent ⇒ on) |

After a **successful** persist that includes a **real boolean** value, the Host
calls `applyEnabled`. Invalid/non-boolean input must not change runtime state.
Failed saves never call `applyEnabled`.

Boot/`start()` loads settings asynchronously with a **generation guard**: a
concurrent `applyEnabled` wins over a late disk read. Settings read failure
enters `unavailable` (`enabled=false`, `coverage.partial`) and **never** falls
back to auto-answering as if enabled.

- `false`: cancel timers; pending → `disabled`; notify goal takeover pause.
- `false → true`: still-pending requests restart a fresh 30s window (directory-bound only).
- repeated `true`: no-op (does not reset deadlines).
- Feature **off** still allows an explicit single-shot `delegate`.

Auto-submit requires **settings ready + enabled + authoritative directory**.

## Architecture

`pause-store.js` owns monotonic per-question user holds shared by co-located Web, Electron and VS Code hosts. Default storage is the user's `.config/openchamber/question-pauses`; `OPENCHAMBER_QUESTION_PAUSE_DIR` can select a shared directory. Empty, atomically created files are keyed by the digest of globally unique upstream session/form IDs, contain no answers or credentials, survive host restart and are removed on authoritative settlement. All hosts attached to one upstream must use this shared location and the updated runtime; independent machines require a shared filesystem or a single OpenChamber host. This is not an upstream distributed lock or a cross-host submission claim.

Pause acknowledgement follows shared hold publication. Failure leaves the local timer stopped but returns an error so the UI can retry publication. An early pause with no recovered form records only a hold and still returns `not_found`; later discovery cannot arm it. Snapshot reads and automatic expiry adopt shared holds, and form IO rechecks immediately after schema GET, before answer POST. Unreadable coordination fails closed (local pause, partial coverage); explicit user reply/delegation remains allowed. A POST already dispatched upstream cannot be recalled. No polling loop or extra upstream request is introduced.

| File | Role |
|---|---|
| `core.js` / `core.d.ts` | Platform-agnostic state machine (IO/timer injected). Shared contract for VS Code. |
| `runtime.js` | Web adapter: OpenCode upstream fetch, global event hub, settings, SSE tips, project + session-index directories. |
| `form-io.js` / `form-io.d.ts` | Shared Web/VS Code native form list, schema lookup, answer mapping and cancellation. |
| `routes.js` | OpenChamber routes + precise `/api/question/:id/reply\|reject` intercepts. |

## Snapshot

`GET /api/question-auto-delegate` returns the snapshot in `core.d.ts`.

Tip event (not a data payload):

```ts
{ type: 'openchamber:question-auto-delegate-changed', properties: { epoch, revision } }
```

## HTTP API

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/question-auto-delegate` | snapshot |
| `POST` | `.../requests/:id/pause` | `{ sessionID, directory, reason: 'interaction'\|'user' }` — bound identity conflicts → 409. Directory may be empty; pause still cancels the auto timer. |
| `POST` | `.../requests/:id/delegate` | recovers identity via scoped list; allowed when toggle off |
| `POST` | `/api/question/:id/reply` | manual: `answers` must be an array (incl. `[]`); never auto text |
| `POST` | `/api/question/:id/reject` | Compatibility route mapped to native form cancellation |

Concurrent claim losers: HTTP **409** + `code: "question_submission_claimed"`.

## Claim / upstream rules

OpenCode 2.0.15 upstream uses `GET /api/form?location[directory]=...` for
pending forms and `GET /api/session/:sessionID/form/:formID` before submitting
`POST .../reply` with `{ answer }`. Only question-tool forms are eligible.
The fresh schema owns field keys, option values and string/multiselect shape.
Failed schema reads are `notSent` and pause for retry. Cancellation uses
`POST .../cancel`. Session directory recovery reads `info.location.directory`;
live events read `payload.location.directory` and `payload.data`.
Web, Electron and mobile hosts use the Web adapter; VS Code imports the same
form IO and core, restoring `/api` for origin-only upstream URLs.

1. One authority owns at most one upstream POST per `requestID` (sync claim).
2. **Definitive reject** (400/409/422) or pre-send throw → **release claim**, pause for human retry. **No immediate auto retry.**
3. **Unclear post-dispatch result** (timeout/5xx/`uncertain`) → `uncertain` tombstone; no retry; still **blocks** goal.
4. **Settled** must not be downgraded by a late POST failure.
5. Successful **scoped** empty list may converge `uncertain`/pending → `external` settled **only for that directory**.
6. Compatibility manual reply passes `answers` (including `[]`) to the form adapter, which maps them by authoritative fields. Fixed text is auto/delegate only.
7. Client `sessionID`/`directory` hints never override a bound identity (conflict → 409).
8. Auto-submit requires an authoritative directory binding (from event, session cache, or `getSession` write-back). Missing directory → no timer.
9. Unknown pause/delegate recovers via scoped `form.list`, filtered to question-tool forms — never invents `questionCount=1`.

## Reconcile

- Inventory = projects + session-index directories + observed request/event dirs.
- Track `successfulDirectories`; only those may settle missing requests.
- Unscoped list discovers unknowns only; never means “all directories empty”.
- Unscoped / directory-less pending triggers `ensureSessionLineage(sessionID, hint, requestID)`
  so `getSession` can write the real worktree directory back and arm the 30s timer.
- Single-flight with trailing scope merge.
- Inventory/list failure → `coverage.partial`; prior state retained.

## UpstreamResult (`core.d.ts`)

```ts
{ ok, uncertain?, notSent?, status, body }
```

- `notSent: true` (compatible extension): request never left the process → release claim, pause for retry.
- Bare `status: 0` without `notSent` → `uncertain` (may have been sent). VS Code/web adapters that know the POST was never transmitted must set `notSent: true`.

## Session goal linkage

- Auto-handling ask: clear idle timer only (goal stays `active`).
- `isBlockingSession` includes `uncertain` (and counting/paused/disabled/submitting).
- Manual claim / user pause / disable → `onUserTakeover` → goal `pauseForQuestion` (walks to **root owner**, uses owner directory).
- Goal abort/pause → `onGoalPaused` → `pauseForSessionTree` (pause related question timers, `pauseReason: 'goal'`).
- Continuation re-checks blocker immediately before `prompt_async`.

## VS Code

`core.d.ts` is the shared contract. Compatible extensions in this fix:

- `readEnabled()` may return `null` (unavailable).
- `pauseForSessionTree` / `resolveRootSession` added.
- `applyEnabled` ignores non-boolean.
- Snapshot field set unchanged.

## Tests

```sh
bunx vitest run --project @openchamber/web \
  packages/web/server/lib/question-auto-delegate/core.test.js \
  packages/web/server/lib/question-auto-delegate/runtime.test.js \
  packages/web/server/lib/question-auto-delegate/routes.test.js \
  packages/web/server/lib/session-goal/runtime.test.js
```
