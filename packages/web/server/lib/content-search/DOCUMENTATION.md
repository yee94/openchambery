# Global conversation content search

The Host owns `content-search.sqlite` alongside the session index. This index is
independent of browser transcript caches and includes all projects exposed by the
active OpenCode runtime. `session.list` is called without a project/directory
filter during initial backfill; descending opaque cursors stop at the thirty-day
boundary or exhaustion. The default coverage is
messages created in the last thirty days in recently updated root sessions.
Sessions with a non-empty `parentID` (subagents) are excluded before message
fetching and progress counting. Only root IDs enter the authoritative pruning
set, so a fully exhausted catalog scan also removes previously indexed subagent
messages, FTS entries and checkpoints. Failed catalog reads preserve the old index.

Two workers page native `message.list` directly, normalize via the shared server
projection, and retain only user text and settled assistant text. Synthetic,
ignored, slim, reasoning, attachments and tool parts are excluded. Assistant
excerpts keep at most 2048 characters; user text stays complete. A session's
projection and updated-time checkpoint commit together only after all its pages
succeed. Failures preserve previous hits and retry on subsequent scans. Restarts
skip unchanged sessions using persisted checkpoints. Failed catalog reads never
trigger deletion. Successful catalogs remove deleted sessions; thirty-day expiry
removes old message rows and corresponding FTS entries.

Each session checkpoint also stores its indexed `since` boundary. Existing
checkpoints without coverage are re-read, as are checkpoints whose coverage starts
after the requested boundary. Expanding from seven to thirty days therefore
backfills unchanged sessions too; failed reads preserve the previous projection
and checkpoint until a complete replacement succeeds.

## Startup coverage and onboarding

`search_coverage` durably records each runtime's `indexStartedAt`,
`indexCompletedAt`, `coveredSince`, and `verifiedAt`. These are index operation
timestamps, not installation/version timestamps or browser onboarding flags.
An absent completion marker requires initialization. A completed runtime does not
walk the catalog on startup or on a timer. It resumes only the durable dirty-session
queue populated by live events. Each dirty session is read by ID and refreshes its
own messages; unrelated sessions incur no upstream work. Initialization failures
retry using committed per-session checkpoints. Explicit `sync()` remains deliberate
catalog reconciliation; automatic scheduling uses incremental mode.
Already verified unchanged sessions are reused, including
sessions with no searchable text. Each session now commits an `indexed_at`
completion timestamp atomically with its projection, source update time and
coverage boundary. Existing databases gain this nullable column and the coverage
table without deleting their projections. Legacy checkpoints without a completion
timestamp are verified once by rereading native messages, even when they claim a
thirty-day boundary: a historical coverage claim alone cannot certify that a
pre-upgrade partial projection was complete. Successful new checkpoints survive
retries; subsequent scans reuse them normally.

The first start and completion timestamps survive incremental updates, partial
failures and restarts. Initial completion is recorded and the verified boundary
advances only after the whole catalog and required message
pages succeed, SQLite writes and pruning succeed, and no dirty event remains.
Partial/error passes retain the last verified boundary and keep completion null
for unfinished initialization; successful sessions resume from their committed
checkpoints. A successfully empty catalog completes normally. Malformed catalog
records are errors, never proof of absence. Pruning also advances per-session
coverage boundaries, so expired rows cannot leave a checkpoint claiming older
coverage (for example after a system-clock correction).

The status response adds `initializationRequired` and these durable timestamps.
`updatedAt` remains the current process's latest completed pass, including partial
passes; clients must not confuse it with successful durable completion. A warm
startup may be `pending` with `initializationRequired: false`; queued dirty sessions
remain background work. `initializationRequired` indicates unfinished first-time
initialization, not whether the latest incremental pass has caught up. No
UI-triggered import or OpenCode database conversion is needed:
the existing readiness gate waits for OpenCode's migration, then native V2
session/message APIs supply the history directly.

Web/desktop and hosted/Capacitor mobile mount the same `OnboardingScreen`
`content-index` step after connecting. It displays thirty-day progress, preserves
progress on request failure, and closes when verification succeeds. The dialog
waits for a nonzero session total: pending catalog discovery and a successfully
empty fresh installation never flash onboarding. The status check continues
while the total is unknown/zero, so subsequently discovered history still opens
the step; hiding it does not certify coverage or cancel Host indexing. Continuing
in the background dismisses only this startup/runtime's UI, never writes a
completion marker and never cancels Host work. Polling stops after completion or
dismissal; runtime changes recheck. Older Hosts without the new status fields
keep their existing behavior. VS Code's direct OpenCode connection has no Host
FTS service and does not mount this step.

Global upstream events durably mark sessions dirty and coalesce work within one
second. Successful writes acknowledge only the captured dirty revision, so an event
during the fetch survives for another pass. Thirty-second retries are scheduled
only for unfinished initialization or pending dirty sessions, never idle catalog
polling. Deleted-session events and confirmed 404 remove that session; a time-bounded
catalog is not authoritative absence for unvisited IDs. Indexing does not depend on
any UI session being opened. Runtime identity is owned by the Host session index;
in-flight results are rejected if it changes. Stop aborts reads and drains the
active pass before closing SQLite.

`GET /api/yuri/content-search?q=...&limit=30` returns `{hits,index}`.
Each hit includes authoritative session title and directory plus message identity,
role, created time and a plain snippet. Each session contributes only its newest
matching message (created time descending, message ID descending for ties).
Deduplication happens before `limit`, which counts sessions rather than messages;
results are ordered by that matching message's recency, then session ID for ties.
The optional `directory` narrows searches;
omitting it searches every project. The endpoint uses the existing Host auth and
rejects preview-proxy credentials. Errors are not converted to empty successes.
An empty query returns index coverage/progress without hits. Index phase is
pending/indexing/ready/partial/error; previously completed coverage stays usable
during incremental scans.

FTS5 trigram MATCH narrows candidates for terms of at least three Unicode code
points; exact substring checks preserve AND semantics. Short terms use a scoped
scan. UI queries use runtime-scoped keys and refresh while search is open. No
browser IndexedDB contents or client-supplied generation determines visibility.
