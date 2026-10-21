# Global conversation content search

The Host owns `content-search.sqlite` alongside the session index. This index is
independent of browser transcript caches and includes all projects exposed by the
active OpenCode runtime. `session.list` is called without a project/directory
filter; opaque cursors are followed until exhausted. The default coverage is
messages created in the last thirty days in recently updated sessions.

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
An absent completion marker requires initialization. Every startup still walks
the authoritative complete OpenCode catalog and compares each recent session's
updated time and indexed boundary; a prior global completion never bypasses
that check. Missing, stale, or insufficient-coverage checkpoints reopen the same
initialization step. Already verified unchanged sessions are reused, including
sessions with no searchable text. Each session now commits an `indexed_at`
completion timestamp atomically with its projection, source update time and
coverage boundary. Existing databases gain this nullable column and the coverage
table without deleting their projections. Legacy checkpoints without a completion
timestamp are verified once by rereading native messages, even when they claim a
thirty-day boundary: a historical coverage claim alone cannot certify that a
pre-upgrade partial projection was complete. Successful new checkpoints survive
retries; subsequent scans reuse them normally.

The start timestamp survives partial failures and restarts. Completion and the
verified boundary advance only after the whole catalog and required message
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
startup may be `pending` with `initializationRequired: false` until verification
discovers a gap. No UI-triggered import or OpenCode database conversion is needed:
the existing readiness gate waits for OpenCode's migration, then native V2
session/message APIs supply the history directly.

Web/desktop and hosted/Capacitor mobile mount the same `OnboardingScreen`
`content-index` step after connecting. It displays thirty-day progress, preserves
progress on request failure, and closes when verification succeeds. Continuing
in the background dismisses only this startup/runtime's UI, never writes a
completion marker and never cancels Host work. Polling stops after completion or
dismissal; runtime changes recheck. Older Hosts without the new status fields
keep their existing behavior. VS Code's direct OpenCode connection has no Host
FTS service and does not mount this step.

Global upstream events mark sessions dirty and coalesce a scan within one second;
a 30-second reconciliation discovers missed events. Indexing does not depend on
any UI session being opened. Runtime identity is owned by the Host session index;
in-flight results are rejected if it changes. Stop aborts reads and drains the
active pass before closing SQLite.

`GET /api/openchamber/content-search?q=...&limit=30` returns `{hits,index}`.
Each hit includes authoritative session title and directory plus message identity,
role, created time and a plain snippet. The optional `directory` narrows searches;
omitting it searches every project. The endpoint uses the existing Host auth and
rejects preview-proxy credentials. Errors are not converted to empty successes.
An empty query returns index coverage/progress without hits. Index phase is
pending/indexing/ready/partial/error; previously completed coverage stays usable
during incremental scans.

FTS5 trigram MATCH narrows candidates for terms of at least three Unicode code
points; exact substring checks preserve AND semantics. Short terms use a scoped
scan. UI queries use runtime-scoped keys and refresh while search is open. No
browser IndexedDB contents or client-supplied generation determines visibility.
