# Assistants Module

## New-contact greeting

Every successful create (HTTP, contact tool, or first-run seed) atomically inserts
one completed assistant welcome message with the contact's name. It uses the
optional create-only `language` (the UI locale, or the creating contact turn's
locale); supported app locales are translated, with English as the default for
missing/unknown languages. This is a fixed greeting, not a model turn: it creates
no synthetic user message, tool execution, notification or upstream request.
It participates in the ordinary preview, unread and contact-history projections.
The contact and greeting roll back together on write failure. Existing contacts
are not backfilled; reopening, renaming and clearing history do not greet again.

## Contact activity ordering

Both individual and batched latest-message previews carry the persisted message's
`created_at` as `createdAt`. The bounded candidate SQL must select this column and
`messageFromPreviewRow` must preserve it before preview projection; otherwise JSON
silently omits the ordering field. Contact-list order and navigation avatar identity
use this timestamp, never assistant configuration `updatedAt`. Regression fixtures
return the timestamp actually inserted, and snapshot tests require a finite value.

## Transient contact errors

Contact model requests have no Yuri generation time limit (`timeoutMs: 0`).
Empty text-only model replies recover in the same generation call with capped
exponential backoff (500ms up to 30s), without an attempt limit, until a reply or
cancellation. The current turn remains `running`; prior tool calls/results and
published bubbles stay intact. Only the model request is repeated, never the
Agent loop or previously committed tool operations. User stop and service
shutdown still cancel the work. Provider errors and invalid response protocols
remain explicit failures, not invented completion. Host restart does not resume
this in-memory turn, and provider-owned time limits are outside this policy.

The text gateway requests and decodes a JSON text envelope for contact replies,
including tool follow-ups and terminal summaries. Application tool arguments and
final declarations then pass through the existing parser unchanged; an envelope
is transport framing, not permission to bypass tool/protocol validation. See
`../llm/DOCUMENTATION.md` for generation recovery and attachment-path behavior.

Contact-turn failures are delivered through `yuri:contact-turn-end` only,
never inserted into the durable contact transcript. The store rejects `status:error`
writes and atomically deletes legacy error messages and their parts during startup;
a cleanup failure rolls back and fails startup instead of exposing partial history.
User messages and already-published valid replies/cards remain intact. Live clients
show temporary error feedback until a newer message arrives; reconnect/restart does
not recover errors. Errors do not become list previews, unread counts, or LLM memory.
Worker-card execution status remains part of the card's authoritative state.

## Avatar identity

`avatarSeed` is an optional nonempty string (maximum 256 characters) on create
and update. SQLite schema v14 adds nullable `avatar_seed`; existing contacts
retain their ID-based face. DTOs return the stored seed or assistant ID. Omitted
updates preserve the seed, and revision conflicts cannot overwrite it. Avatar
changes do not reset sessions or alter the assistant identity.

New creates without `avatarSeed` persist a complete
`yuri-avatar:v1:round:capsule:<color>:neutral:1:<assistantID>` recipe. The twelve
pigments are chosen randomly; shape, eye style and rest pose are fixed. This
service-owned default covers HTTP/API, contact tools and first-run seeding.
Explicit caller-supplied seeds/recipes remain untouched. Existing null/legacy
seeds retain their original shape/color mapping; no migration or read-time write
is introduced. The shared renderer now uses one fixed capsule-eye specification
regardless of legacy eye/expression fields.

Contacts can call `update_avatar({ seed? })` to change their own avatar through
the existing revision-checked update path. Omitting seed generates a complete v1
recipe with a fresh nonce, one of the twelve mixed pigments and the existing
seven-shape random pool; the Node-only catalog mirror is checked against the UI
recipe catalog by service tests. No renderer or animation data is loaded on the Host;
an explicit seed restores a face. The server binds the contact ID; other targets
and unsupported customization arguments are rejected. Results include the old
and saved seeds; unchanged seeds do not bump revision. Storage failures remain
tool errors, and revision conflicts retry once.

Procedural-avatar guidance is progressively disclosed: the short tool description
points to `get_assistant_settings({ topic: 'avatar' })`. Only that result includes
the local MIT Open Mascot rendering explanation, deterministic-seed semantics,
restoration and limitations (no semantic image prompts, uploads or URLs).
Assistant Settings saves a versioned shape/color/eyes/expression/motion recipe in
the same opaque `avatarSeed` string. The server preserves it byte-for-byte through
create/update/snapshot/restart; no new column or write path is introduced. The tool
still edits only seed, not individual customization arguments. Legacy seeds remain
valid, and UI builds own their visual interpretation.
Ordinary settings reads expose `avatarSeed` without the full guide. Background
read-only turns cannot call the mutation tool.

## Contact model variants

Assistant Settings uses the shared model picker to choose a model and its
catalog-provided thinking variant in the same desktop dropdown or mobile panel.
The draft round-trips `AssistantDTO.variant`; selecting default clears it to
`null`, and changing models uses the picker's supported-variant selection rules.
Settings continues to preserve server-owned `agent` and `mode` fields.
This shared Settings contract applies to web, Electron, VS Code, hosted mobile,
and Capacitor when the Assistant capability is available.

Every contact completion, including tool follow-ups and protocol corrections,
forwards the captured assistant `variant` through the LLM gateway to OpenCode.
Existing null variants retain the provider default. Pi's local `thinkingLevel`
remains `off`: the custom stream adapter passes OpenCode variants directly,
including provider-specific names, rather than mapping them to pi's enum.
Reasoning stays private: the contact transcript and bubble events contain only
public messages and parsed replies. Selecting a thinking variant does not enable
reasoning display.

## Acceptance criteria

### Scheduled-task result review

- `schedule_task` retains the existing assistant/project/task mapping. The task
  prompt preserves the user's delivery intent. A terminal run is handed from the
  scheduler to `reportScheduledTaskResult`; prompt admission and intermediate
  session events do not wake the contact. Associations created after the run
  started do not receive its historical result.
- Each enabled owner receives a read-only contact-lane turn with the captured
  contact configuration, the run's original task prompt, authoritative outcome,
  error and bounded worker output. `read_session` can fetch the full result.
  The existing live contact-turn state drives working indicators; no synthetic
  user message is inserted. The review cannot execute the task again.
- The model decides whether to deliver requested findings or remain quiet for
  successful background work. Scheduled reviews and read-only worker-watch
  follow-ups register a terminal `stay_silent` tool; a turn ending in its result
  is silent. Empty/malformed responses remain errors. Background reviews get no
  `notify_user` tool; they speak once through the final reply. Silent reviews produce no transcript bubble,
  unread message, or contact notification. Worker-watch follow-ups still report
  the awaited result unless history already reports the same result.
- The additive `assistant_scheduled_result` table records terminal review
  receipts by assistant/run, including silence and cancellation. Stable turn IDs
  also reconcile already-persisted replies. Duplicate delivery and reopening the
  service do not replay completed reviews. The scheduler retains an unacknowledged
  result when the service closes or admission/preparation fails. User interruption
  follows the existing automatic-turn cancellation policy.
- Assistant-owned results bypass the generic scheduled-task notification;
  contact notification settings apply only when the review speaks. Disabled
  contacts consume the handoff without waking. Deleted/unowned associations use
  the scheduler's ordinary notification path. Per-owner receipts let one failed
  owner retry without replaying other completed owners.
- This is Host-owned behavior for web, Electron, hosted mobile, Capacitor and
  clients connected to that Host. It requires a running Host, not an open UI.
  The extension-owned VS Code runtime does not gain a scheduler.
- Integration coverage in `scheduled-tasks/runtime.test.js` runs the real
  scheduler, SQLite stores, assistant mapping/lane and pi response protocol with
  only upstream execution and model responses replaced. It covers report,
  silence, task failure and restart recovery. This does not measure live model
  decision quality or device push delivery.

### Contact memory recall

- `search_memory({ query?, from?, to?, limit?, cursor? })` searches this contact's authored text beyond the automatically trimmed recent window. Empty query browses history. Search is literal (SQLite ASCII case folding, Chinese text preserved), with inclusive timezone-qualified ISO time bounds. Results contain source `messageID`, role, creation time, snippet, Unicode character offset and total length. Default 10 matches, maximum 20; each call examines at most 200 indexed message candidates. Empty matches with `complete:false` are partial, and the model must follow `nextCursor` before concluding that accessible history has no match.
- `read_memory({ messageID, offset?, maxChars? })` reads the original text in chunks (default 4,000, maximum 8,000 Unicode characters). `nextOffset` continues a long source. Both tools return data to the same model for a natural-language response; they add no transcript widget or canned reply. Attachment bodies/URLs, tool output, peer DMs, error rows, and internal settle markers stay outside recall. The stored text is quoted historical evidence, not current instructions or authorization.
- `memory.js` owns this read-only projection over the existing contact SQLite tables. Service closures bind the assistant identity, current-turn user ceiling, and lane-start snapshot ceiling. The model cannot supply an assistant selector, raise the ceiling, or read a later queued user. Exact IDs belonging to other contacts, deleted rows or cleared memory return `memory_not_found`. Failures propagate as real pi tool errors, never authoritative empty search results.
- Each call rechecks the current context boundary and transcript generation. Search cursors bind the assistant, both clear watermarks, generation, turn snapshot and query/time filters. Reusing a cursor after clear/wipe or under another scope fails explicitly. No persisted search cache or secondary memory database is introduced. Restart reloads the durable boundaries; a new turn starts a fresh search.
- Clearing memory keeps the transcript UI and advances two monotonic watermarks in `assistant_contact_context_boundary`: `after_ordinal` is the clearing user admission; `assistant_after_ordinal` is the committed transcript tip when the clear executes. The latter excludes replies from preceding lanes that arrived after the clear request was queued. Both the automatic history window and recall honor these watermarks. Later queued users survive, and the new model confirmation stays eligible. Existing databases add the assistant watermark with default zero and inherit their recorded user boundary; subsequent clears capture both. Transaction rollback restores both values.
- Wiping chat history deletes its messages/parts, clears the boundaries and bumps generation. Previously issued readers/cursors become stale. Assistant deletion continues to use the owning service's tombstone/cleanup path. These are recall-tool and automatic-window boundaries; the existing unrestricted workspace coding tools retain their separate filesystem permissions.
- `memory.http.test.js` runs real HTTP routes, the real pi Agent/tool loop, SQLite, and model reply persistence, replacing only the external completion provider. It proves retrieval after 36 newer turns, clear-memory persistence across service restart, foreign-ID rejection, wipe invalidation, and queued-clear/late-reply isolation. `memory.test.js` additionally covers bounded partial scanning, cursor scope, dates, literal matching, Unicode chunking, metadata exclusions, migration and rollback. Live provider quality and device transport behavior are separate validation surfaces.

The contact's default role is personable communication, workspace discovery,
task delegation, and result follow-up. Substantive implementation runs through
`assign_session` in the relevant existing OpenCode workspace; simple lookups and
small, bounded configuration changes can use the contact's pi tools directly.
This routing preference is prompt policy; the direct tools remain available.

Contact pi execution uses the configured workspace (its canonical effective path)
when present. Explicit `workspacePath: null` starts pi in `os.homedir()` for the
current server OS user, allowing user-global directory lookup. This applies on
the connected backend for web, desktop, and mobile. Archived OpenCode bindings,
`managedWorkspacePath`, and `effectiveWorkspacePath` retain their existing
storage/session meaning. Only the contact pi working directory changes.
Discovery starts in the configured directory, checks existing session metadata,
and walks parent directories to locate the nearest relevant workspace; broader
`list_sessions` lookups can find related conversations. Ambiguous targets need
clarification. An empty registered catalog still allows discovery; assigning a
discovered workspace requires its registration through existing Settings.

Worker submission uses one admission path for new and existing sessions.
Definite rejection cleans up only a session created by that call. Ambiguous
admission keeps the worker and confirms the exact message ID before reporting
success. Attachment deduplication uses ordered content digests; reordering
attachments is a different request.

The in-app Assistant is an Yuri-owned **contact**. OpenCode is only the LLM gateway (`POST /api/yuri/llm/chat/completions`) using already-connected `{providerID, modelID}`. Composer send runs `@earendil-works/pi-agent-core` with `thinkingLevel: 'off'`. When the assistant has an effective workspace, the harness attaches pi's four coding tools (`read`, `write`, `edit`, `bash`) via `NodeExecutionEnv` in that directory, applies `defaultPrompt`, and merges skills from `~/.claude/skills`, `~/.agents/skills`, plus the project's `.claude/skills` and `.agents/skills` (project wins on name). Yuri API tools remain (`new_conversation`, `clear_chat_history`, `list_projects`, `list_sessions`, `get_assistant_settings`, `update_default_prompt`, `create_assistant`, `schedule_task`, `message_assistant`, `assign_session`, `watch_session`, `read_session`, `steer_session`, `stop_session`, `archive_session`, `delete_session`). It does not use `SessionPrompt` / `session.prompt` as the conversation engine. The LLM gateway throwaway session still denies OpenCode tools (`session.create` PermissionRuleset deny-all + `session.prompt` tools map + hidden `yuri-llm` agent `permission: { "*": deny }`); file and shell work runs in-process through pi. The contact system prompt includes **full argument schemas** for both pi coding tools and Yuri contact tools. Skill directory entries are instructions loaded via `read`, not native/MCP tool names.

User contact turns retain the Yuri operation tools alongside the four
pi tools. Skill discovery contributes instructions to this combined tool set.
Assignment intent includes “建个会话” and “再建个会话”. Watch intent includes
“监听会话”; stop intent includes “停止会话”. The single missed-call
retry checks for a result from a requested operation tool; a `read` result alone
leaves an assignment request eligible for retry. A successful contact reset
retains its terminal semantics. Tool failures count as attempted operations
and keep their existing error result handling.

**User interruption is terminal for the current watch**

- Authoritative OpenCode `MessageAbortedError` on `session.error` or assistant `message.updated` settles the watched card as `cancelled`, not a retryable failure. Reconciliation and a complete/error pre-continuation worker-message check recognize the same error and convert that watch to `cancelled`. Successful `stop_session` also cancels the watch when upstream emits no event.
- `cancelled` is durable in the existing watch/card records and excluded from in-flight reconciliation. Later idle, busy, and error events cannot rearm it. Only an explicit assign/watch admission overwrites the cancelled watch for a new run. No schema migration is needed: watch/card status is an open string.
- Pending/running automatic continuations own cancellation controllers. A worker interruption aborts those complete/error continuations, including already queued ones, and does not abort a cancelled interrupt notify already queued for that worker. Duplicate `cancelled` reports (boot reconcile plus timer, or `session.error` plus `message.updated`) stay idempotent on the watch and still let that notify run. A newly admitted user message supersedes that assistant's existing automatic continuations, including a cancelled notify. Other assistants/workers remain independent. Aborted complete/error continuations clear activity and settle with `cancelled` without adding a retry, error bubble, or late response.
- When the watch **transitions** to `cancelled` from a user abort (event or reconcile), the service schedules the same read-only contact-lane continuation as complete/error. Internal `userText` states `status: cancelled` and `reason: user_interrupted` (manual OpenCode abort / `MessageAbortedError`, not a model failure, not `stop_session`). A cancelled resume that fetches worker messages must still run — it must not re-enter the abort short-circuit. `stop_session` marks `cancelled` without this extra continuation because the assistant already owns that user turn.
- The signal reaches pi tools and model generation. The stream adapter checks before/after model requests and before protocol retries, preventing a late tool response from executing. An already completed side effect is not rolled back. Cancellation is authoritative runtime state, not a language-model interpretation of “stop”.

**Workspace response and loop protocol**

- Inference uses the external OpenCode clean RPC bridge (`../llm/DOCUMENTATION.md`),
  never session.generate/session.prompt. Actual JSON schemas, native assistant
  tool_calls and tool-role results retain their call IDs across turns. Textless
  native tool calls continue the existing sequential pi loop. Progress/final
  declarations remain application text; older text-call records are still parsed
  by the existing validator but are no longer the requested tool transport.
- The contact's own explicit system prompt still includes its selected persona,
  workspace tools and discovered skill instructions. This is application-owned
  context, not hidden OpenCode Agent context. Summaries receive only their explicit
  system/prompt. Native inference is currently one-shot, not token-streaming.

- Tools use native function calling only (`message.tool_calls`); text is never parsed for tool calls and no schema catalog is repeated in the prompt. A response without tool calls is the final reply.
- Public progress uses the harness-owned `notify_user` tool `{ text }` (max 2,000 characters), usually batched with the next call. Its text emits `done:true` bubbles when the response arrives, before the batch executes. Batched notes are dropped from execution and stored as the assistant message's public text (`contactPublicText`); a notes-only response executes and the loop continues. Text beside tool calls is model narration and stays private. Later rounds replay delivered notes to the model as `notify_user` calls.
- The model is prompted to send a progress message only when it adds information the user does not already have (a direction worth correcting, a meaningful finding, a blocker, or expected long work), then give a short final outcome. A message is not required before each tool call, and successful lookups need no separate confirmation. Public messages share the existing SSE, durable contact rows, and turn-global indices across web, desktop, VS Code, hosted mobile, and Capacitor. No timer narration, tool logs, progress widgets, or synthetic chat messages are added. Timing of model-authored milestones remains model policy; the transport guarantees immediate delivery once an explicit public record arrives.
- Completion notifications use the latest spoken message, keeping earlier progress out of the final notification body. Transcript persistence reconciles by stable bubble IDs and adds only remaining messages.
- Tool results remain model context for every tool. The outcome projector uses assistant-authored text only. Terminal operations retain the mutation stop gate, followed by a tools-disabled completion on the same provider/model to communicate the actual result. A failed/empty summary surfaces a turn error; a completed side effect stays committed and is never replayed by that summary pass.
- Reset summaries receive only the successful reset tool result, excluding prior messages and attachments. The service retains one model-generated confirmation and discards pre-reset output for that turn. Failures emit temporary live error feedback outside assistant speech bubbles, without a persisted failure row.

- Protocol correction never replays rejected assistant prose into model history: simulated User/Assistant turns and tool-result records are rejected as fabricated evidence. Corrections remain bounded and exhaustion is an error, not a completion.

- A workspace-backed contact keeps calling tools until the work is handed off or done; the prompt tells it that a response without tool calls ends the turn and is only for the final answer, a question, or a real blocker. Reading a skill loads instructions and does not itself complete the user's task.
- The stream adapter requests at most two protocol corrections for a rejected response (unknown tool, invalid arguments, forged transcript, mixed operation batch), retaining actual prior calls/results. Rejected prose, notes, and tool calls stay private/unexecuted; notes delivered by earlier accepted responses remain visible. Exhaustion becomes an upstream error containing the last validation reason, without including rejected model output or tool arguments. This guard enforces the response protocol; a model's explicit completion claim is not independent verification of arbitrary task semantics.
- `parseContactNativeToolCalls` returns an ordered `toolCalls` array from native calls, running shell-style aliases through `bash`. An invalid/unavailable call rejects the entire response before any call executes, with a correction naming the available tools.
- Multiple coding calls run sequentially through pi (`toolExecution: 'sequential'`), preserving dependencies such as write then read. Yuri operation tools must be sent one at a time: mixed/multiple-operation batches are rejected before execution so terminal assign/reset/watch semantics and side-effect gates remain intact.
- Completion history retains every assistant tool call (name, arguments, generated call ID) and its real tool result, including empty content and `isError`. Results still use gateway-supported user messages labeled `Yuri tool result name=... call=...` with a JSON body. Model-written result lookalikes are never executed or admitted as actual tool results. Final JSON text is opaque: quoted tool examples in a final answer cannot execute.
- Malformed calls or mixed final declarations use the same bounded correction path. Only a validated tool response or final reply reaches the pi stream; protocol corrections do not replay tools already executed. Runtime file/shell cleanup remains in `finally`.

**Session cards (this PR)**

- First-class contact parts reuse one slot: `cardType` `session` | `assistant` | `schedule`.
- Persist in `assistant_contact_message` / `assistant_contact_part`. Survive reload.
- Cards are **assistant-emitted UI**, not user slash commands. The user never types `/card`. Insert: tool auto-cards (`assign_session`, `watch_session`, `create_assistant`, `schedule_task`), and API `POST /:id/contact/cards` for harness/tests. Later project/worktree/PR, inbound pushes, and summon **must** reuse this card slot.

**Assign work (this PR)**

- `assign_session` is an Yuri AgentTool on the contact harness. It creates or reuses a visible OpenCode/Yuri session on a **registered project path** (Settings projects / `getAllowedRoots()`), optionally an **existing** Chat worktree/branch via `getWorktrees`, then kicks the coding prompt into that session with `session.create` + `session.prompt` (same worker path as `POST /api/yuri/conversations`).
- That worker session owns substantive implementation. The contact owns communication and coordination, with direct pi tools for small, bounded tasks. Assign sessions are **not** archived Assistant bindings and must not use `assistant-workspaces`.
- **Reuse / continue existing session:** `assign_session` with `sessionID` + coding prompt continues that worker. Before prompt, the service resolves directory/project from **authoritative** session metadata (session index directory → `session.get` payload → registered project match). User-supplied `projectPath`/`directory` are lookup **hints only** and never override scope. Missing/unregistered/failed session lookup **fails closed** (not empty success). Prior worker model/config semantics stay: omit model args to follow the session model when still connected.
- **`watch_session`:** listen-only attach for an existing session (`sessionID` required). No `session.prompt`. Emits the same session card slot and reuses `assistant_contact_watch` + `reportAssignedSession` / reconcile / resume. Baseline card/watch status comes from live `session.get` (+ messages when needed) via `mapSessionToWatchStatus` so an already-terminal idle is **not** treated as a fresh complete transition (no false resume). In-flight baseline (`busy`/`question`) keeps the watch until real settle. A plain user `@session:id` (or JSON title/sessionID/directory) reference is **context only** — it does not auto-call `watch_session`; the model must hear an explicit listen/watch/monitor intent.
- **`stop_session`:** calls real OpenCode `session.interrupt` for `sessionID` after the same authoritative directory resolve. Returns the true abort result — transport/`not_found`/upstream errors stay errors (never claim stopped on failure). Abort is registered in a private per-session inflight map before `await abort` so concurrent SSE `complete`/`error` cannot schedule a `resume=true` continuation ahead of `resume=false`. On successful abort the service marks the watch/card `cancelled` even when upstream emits no idle/error event. Idle/error events still flow through the existing watch reporter when a watch exists.
- **Worker model selection:** optional tool args `providerID` / `modelID` / `model` resolve against the live connected OpenCode catalog (`loadConnectedCatalog` / `GET /provider` + `GET /config/providers`). Explicit selection must match uniquely — missing or ambiguous names fail closed (`model_not_found` / `model_ambiguous`) with **no silent fallback**. Omitting model args on a **new** worker keeps the contact assistant's default provider/model. **Reusing `sessionID` without an explicit model** follows that session's last model (`session.get` → `session.model` `{ providerID, id|modelID }`, else newest user/assistant `info.model`) when it is still an exact providerID+modelID match in the connected catalog (`source: 'session'`); missing session model, catalog miss, or lookup failure **degrades** to the assistant default (`source: 'assistant'`) and never fails assign once the session itself resolved. Selecting a worker model **never** mutates the contact assistant row.
- Every user or automatic contact turn reloads the current instance's **Connected OpenCode models** block (exact providerID, modelID, providerName, name, acceptsImages), plus settings-backed favorite models in saved order and recent models newest first. Only connected catalog entries qualify as preference candidates; variants remain separate from model IDs. Catalog and preference read failures remain explicit unknown states, distinct from successful empty lists; either read can succeed independently. Contact prompts project only favoriteModels/recentModels from the strict settings reader; defaultModel/defaultVariant are used separately for initial contact creation, never arbitrary settings or credentials. No catalog is cached across turns or runtime switches. Informal `model` aliases normalize punctuation/spacing and require a unique catalog match; explicit `modelID` stays exact. Ambiguous aliases never silently prefer a favorite/provider. This server-owned context is shared by web, desktop, and mobile clients of that instance.
- **Current-turn attachments:** server-authoritative `userParts` file parts from this contact turn are forwarded into worker `session.prompt` parts by default (including “just open a session” intents). The model must not base64-encode or invent local paths. History images are **not** unbounded-forwarded. Image parts require a vision-capable catalog entry (`acceptsImages`); otherwise assign fails with `image_not_supported` before create. Sensitive file bodies are never logged.
- **Create-then-prompt failure:** if `session.create` succeeds and `session.prompt` fails, assign best-effort `session.delete`s the new worker so empty sessions are not left behind. Reused `sessionID` paths never delete on prompt failure.
- Successful `assign_session` and `watch_session` return `terminate: true` to stop the mutation loop. The harness then requests a tools-disabled model summary. Prerequisite tools (`list_projects` / `list_sessions`) may still run before assign/watch/stop in the same turn; multi-operation user intents remain ordered **across turns** after a successful assign/watch.
- Same contact-turn assign gate (tools instance lifetime only, not cross-turn): identical args after success replay the cached success result (no second worker); different args after success, or parallel mismatched args, fail closed with a validation error. The idempotent key includes worker model selection and current-turn attachment scope. Failure clears the gate so a corrected retry may run. Parallel identical args share one in-flight promise.
- After a successful assign or watch, the service persists the existing session card into the contact transcript (user bubbles first, then the card) and watches that worker session in `assistant_contact_watch` (watch baselines the live status). The user-facing outcome is the session card plus any `notify_user` progress note; English tool-result confirms (`Opened a coding session.`, `Watching that coding session.`, `Created assistant…`, `Sent to…`) for card/side-effect tools are **not** written into the transcript.
- Existing OpenCode SSE on the same `globalEventHub` as notifications (`session.idle`, `session.error`, `session.status`, `session.execution.*`, `question.asked`, `permission.asked`) updates **the same card** (`busy` → `complete` / `error` / `question` / `cancelled`). **No canned settle transcript bubbles** (`oc.settle.complete` / `error` / `question` are not written). On **complete, error, or cancelled (user interrupt)** when the watch status actually changed, the service schedules an async contact-lane **continuation** (`inContactTurnLane` + `runContactTurn`) per related assistant: no admitted user row (internal `userText` only), active contact turn (green dot / 3-dot), stable resume id `resume_${assistantID}_${sessionID}_${status}_${updatedAt}`, bounded last worker assistant text (~2000 chars; fetch failure still resumes with status only). Cancelled continuations include `reason: user_interrupted` so the contact can acknowledge the user's abort. The contact Agent can perform read-only lookups and summarize in the user's language, but cannot reassign or mutate a session during this notification — the user sees that Agent summary, not 「会话已完成/会话失败」. `question` updates the card only (worker waiting on the user). `stop_session` cancellation does not schedule this continuation. Session-goal settle (`emitGoalNotification`) uses the same reporter — not a second scheduler. Idle after `session.error` must not rewrite 失败 as 完成 (`changed=false` → no second resume). Same complete status re-reported is idempotent. The watch rows are read inside the `BEGIN IMMEDIATE` transition, so multiple Host processes sharing `assistants.sqlite` schedule at most one continuation per transition. The lock is SQLite's OS file lock, held only for that synchronous transaction (no awaits); a Host that exits mid-transaction releases it and its uncommitted write is discarded. Turn lanes and active-turn markers are process-local memory, so a dead Host never leaves a durable lock: whichever Host receives the next user send admits and runs it.
- **Shutdown interrupt (ticket 07):** official `session.execution.interrupted` reason is `user | shutdown | superseded | inactivity`. **`reason: shutdown` does not settle** the watch and does **not** schedule contact resume — upstream keeps the execution claim for restart recovery. The card stays `busy` until an authoritative terminal (`session.execution.succeeded` / `failed` / user interrupt / reconcile). `reason: user` settles `cancelled` + resume. Other non-shutdown interrupts settle `error` unless `MessageAbortedError`. No parallel recovery store — the existing watch row remains the owner.
- Restart or a missed `session.idle` cannot leave the watch stuck: boot and the existing 60s reconcile timer `listInFlightWatches` and poll OpenCode `session.get` / `message.list`. Idle, `time.completed`, or a missing session settles the same card (`busy` → 完成) and triggers the same contact continuation (no `oc.settle.complete` bubble). `session.error` or last-assistant `info.error` settles 失败 + resume once; last-assistant `MessageAbortedError` settles `cancelled` + the interrupt notify once. Transport / non-404 get errors leave the watch in flight (failure is not empty success). One failed watch does not block unrelated watches. Reconcile reuses `reportAssignedSession`, so an error watch is never rewritten as complete. Tombstoned assistants skip resume.
- Worker sessions stamp `metadata.yuri.assigned` (`from: 'contact'`, `assistantID`, `name`). They must **not** use `yuri.assistant.assistantID` — that marker hides archived Assistant bindings from Chat.
- `AssistantDTO.assignedSessionIDs` lists in-flight (`busy`/`question`) watches for assigned worker sessions. Session-card busy stays on the card; it does **not** drive the list green dot.
- **Contact active turn (server authoritative):** process-local metadata tracks admission → `queued` → `running` → settled (removed). `AssistantDTO.working` is true only while that assistant has an unsettled contact turn. `AssistantDTO.activeContactTurn` is `{ turnID, messageID, status: 'queued'|'running', admittedAt }` or `null` so APP restart / reconnect can rehydrate list green dots and the contact 3-dot row from the snapshot HTTP GET. Spoken bubbles and cards persist to SQLite as soon as they publish (`done:true` / `onCard`) so another device or APP restart can GET them while the turn is still running. Token-level SSE deltas remain live paint only. A server process restart clears in-memory activity (no permanent green; tools are not auto-rerun) but already-published bubbles/cards stay in the transcript. Per-assistant lanes isolate turns across assistants/runtimes. Stale `contact-turn-end` for an older `turnID` must not clear a newer active turn.
- **List latest-message preview (server authoritative):** every `AssistantDTO` path (`snapshot` / `create` / `update` / other `output` rows) carries `latestMessagePreview: { messageID, ordinal, createdAt, role: 'user'|'assistant', text, fallbackKind: 'image'|'file'|'session'|'assistant'|'schedule'|null } | null`. Source is the contact transcript only (not `defaultPrompt` / `updatedAt`). Order is the same keyset as contact pages: newest `(ordinal DESC, message_id DESC)`. Visible roles are `user`, `assistant`, and `peer` (peer maps to `role: 'user'` because inbound DMs are user-visible). Internal assigned-session settle markers (`oc.settle.*`) are excluded in the SQL candidate probe (and again in `buildContactMessagePreview`). Transient errors are never stored and cannot replace the preview. Plain text is sanitized and capped at `CONTACT_PREVIEW_MAX_CHARS` (500) with no data-URL/base64 bodies. File-only rows set `fallbackKind` `image`/`file`; pure cards set `session`/`assistant`/`schedule`. Empty transcript → `null`. **Snapshot cost:** one prepared statement reused per assistant (`assistant_id` + indexed `ORDER BY ordinal DESC, message_id DESC LIMIT candidateLimit`, catalog ≤100) collecting only those bounded candidates, then **one** parts `IN` query — not a window/`ROW_NUMBER` over full multi-assistant history and not HTTP N+1. SQL already drops pure settle tails so they cannot exhaust the LIMIT and hide an older real bubble; remaining non-preview empty rows may still consume a candidate slot within that same LIMIT. Admission, assistant completion, peer DM, card insert, wipe, and clear-memory already bump domain revision / `yuri:assistants-changed`; clients re-GET snapshot for the new preview. Clear-memory keeps transcript rows so the preview still reflects the last bubble; clear-history / reset remove rows so the preview becomes the wipe confirm (or `null` after a full unbounded wipe with no remaining user).
- No registered project → clear `project_required` (ask the user to configure a project). Never fall back to managed assistant-workspaces.
- Assign must not go through the peer DM channel.
- `assignWork` (service) resolves the worker model via the connected catalog (`capabilities.input.image` preferred), forwards tool `variant` (cross-model drops contact variant), passes AbortSignal into create/prompt/delete/catalog, and supplies `lookupMessage` over real SDK exact lookup (`v2.session.message` → `session.message` → bounded `message.list`). Ambiguous prompt admission returns `prompt_ambiguous` with `sessionID`/`messageID` and does **not** delete the worker; the contact-turn assign gate retains that identity so a same-args retry reuses the session and cannot blind-create another worker this turn.

- Share/queue may still use `session.prompt` on Assistant bindings.

**Registered projects + sessions (this PR)**

- Every contact turn injects a **Registered projects** block (`id`, `path`, `label`) from `listProjects()` into the system prompt via `formatRegisteredProjectsPrompt`. The model can fuzzy-match names like "yuri yee" without a tool call first. Empty catalog → discover the relevant existing workspace using sessions and directory lookups, then request registration in Settings before assignment.
- `list_projects` refreshes/filters that catalog (`query` optional). `list_sessions` searches the existing session-index (`sessionIndexService.snapshot()`) for sessions in a project (`projectPath` / `projectID`, optional title query). Results are bounded (`sessionID`, `title`, `directory`, `updatedAt`). Index/catalog failure is an error, never an empty success.
- After matching a project, open work with `assign_session` (`projectPath` and/or existing `sessionID`).

**Assistant settings — default prompt read/write (this PR)**

- `get_assistant_settings` reads a live Assistant row from SQLite (`output(editable(id))`), not the turn-start `currentAssistant` snapshot. Omit `to`/`name`/`toAssistantID` → **this** contact. Pass `to="OpenCode 配置助手"` (or `toAssistantID`) → that live assistant. `details.settings` is `{ id, name, defaultPrompt, providerID, modelID, agent, variant, mode, workspacePath, enabled }`. Content is a short readable dump; empty `defaultPrompt` is labeled `(empty)`.
- `update_default_prompt` `{ prompt: string, to?, name?, toAssistantID? }` (prompt required; empty string clears) persists `defaultPrompt` via `updateAssistant(id, { expectedRevision, defaultPrompt })`. Omit target → this contact. Named/id target updates **that** row and does **not** overwrite this contact. This is **Assistant settings** (same field as Settings UI), not a one-shot user message and not `new_conversation` / clear-memory.
  - Unchanged value → idempotent no-op `{ updated:false, unchanged:true }` — no revision bump.
  - `revision_conflict` → re-read revision and retry **once**; a second conflict surfaces via `toolFailure` with `details.error: 'revision_conflict'` (`terminate: true`). Real storage errors are not swallowed.
  - Success → `{ updated:true, defaultPrompt }` with confirm text that the value applies on **later turns** only (current turn system prompt is already built). `terminate: false` (same as `create_assistant` / `schedule_task`) so the model can emit one short confirm bubble.
- Harness still injects `assistant.defaultPrompt` into the system prompt at turn start; a write mid-turn does not rebuild this turn's prompt. The next `runContactTurn` snapshot reads the new value from DB. UI Settings forms already bind `defaultPrompt` and refresh on `assistants-changed` / revision tip — no UI change required.

**Create assistant / schedule task (this PR)**

Reply language follows the user's latest substantive message and conversation context, with explicit language requests taking precedence. Ambiguous messages and background follow-ups retain the conversation language. The built-in prompt and terminal-tool summary never select a response language from UI locale. Reset summaries receive the current user request as language context alongside the reset result, without restoring earlier history. Explicit `{{LANGUAGE}}` placeholders in user-authored `defaultPrompt` retain their locale substitution contract; the built-in prompt no longer uses that token.

- `create_assistant` calls the same in-process `createAssistant` (`name`, connected OpenCode `providerID`/`modelID`, `mode: 'continuous'`). It emits an `assistant` card that opens that contact.
- `schedule_task` calls in-process `projectConfigRuntime.upsertScheduledTask` with the same payload as `PUT /api/projects/:id/scheduled-tasks` (`name`, `schedule.kind/time/timezone`, `execution.prompt` + provider/model) on a registered project, then best-effort `scheduledTasksRuntime.syncProject`. It emits a `schedule` card.
- `list_scheduled_tasks` lists registered projects' tasks with exact task/project IDs, schedule, model and a bounded prompt preview. Failed project reads remain explicit partial failures. Read-only background turns may list but cannot modify tasks.
- `update_scheduled_task` uses the existing project-config patch operation and scheduler sync, changing only supplied fields and validating explicit models against the connected catalog. It emits the existing schedule card; it can edit tasks created outside the Assistant.
- Native calls use tool-name validation and shell-alias normalization. `shell`, `powershell`, `grep`, `glob`, `find` and `ls` may resolve to the existing `bash` tool only when it is available. Native call IDs survive normalization. Unknown tool corrections identify the rejected name and available tools, without executing a rejected prefix. The contact harness owns bounded correction; generic completion callers retain strict tool-name validation.
- Successful `schedule_task` also writes an assistants-owned mapping row in `assistants.sqlite` (`assistant_scheduled_task`: assistantID + projectID + taskID). Project-config execution strips unknown fields, so ownership stays out of the task payload. `GET /api/yuri/assistants/:id/scheduled-tasks` returns those mappings joined with live `listScheduledTasks` records when possible; failed project lookups keep the mapping with `task: null`.
- `CONTACT_SYSTEM_PROMPT` + `formatContactToolsPrompt` + `formatPiCodingPrompt` tell the model to call these from natural language (开新对话 / 找项目 / 现有对话 / 查看助手设定·默认提示词 / 改默认提示词·设置人设 / 建助理 / 建会话·继续会话 / 监听会话 / 停止会话 / 排定时任务 / 给 X 说一声). Argument schemas travel only in the native tool definitions. A reply without the tool call does nothing; never say 已创建 / 已发送 / 已停止 unless the tool returned. Tool results are sent as native tool-role messages with JSON `{ isError, content }`; assistant calls keep their arguments/IDs so multi-step turns keep call/result association. The harness replaces every `{{LANGUAGE}}` token — in the built-in prompt and in `defaultPrompt` — with the UI locale sent on the composer payload (`language` field, whitelisted locale code → display name). Background/settle turns recall the last locale seen for that assistant; unknown or missing locales resolve to `the user's interface language`, so the token never leaks into the prompt.
- If the user asked for `new_conversation` / `clear_chat_history` / `list_projects` / `list_sessions` / `get_assistant_settings` / `update_default_prompt` / `create_assistant` / `schedule_task` / `message_assistant` / `watch_session` / `stop_session` / `assign_session` and the first completion has no tool call, the harness runs **one** follow-up completion whose user content is only `Call the requested tool now; do not claim success without its result.` If still no tool, the turn replies that it could not complete and does not fake a card. No slash commands. No second store.

**Clear memory vs clear chat history (this PR)**

- `new_conversation` clears **LLM memory only**. It advances the durable per-assistant context boundary in `assistant_contact_context_boundary` (`after_ordinal` watermark). `GET /:id/contact/messages` keeps the full transcript. Later `contactHistoryForLlm` returns only messages with `ordinal > after_ordinal`. The model authors the confirmation from the actual reset result. Natural language default (safe): 开新对话 / new conversation / 清除记忆 / clear memory / clear chat / start over.
- `clear_chat_history` **deletes** this assistant's contact transcript via `deleteContactMessages` (messages, parts, watches) and clears the boundary. The model authors the confirmation from the actual reset result. Natural-language tool-selection hint (missed-tool retry): 清空/清除/删除聊天记录 / clear chat history / delete chat history. Negation (不要清除聊天记录) is not a wipe request hint. When the model calls the tool, the wipe **executes** — there is no separate user-text authorization gate and no silent/denied bubble protocol. Real storage failures still surface as tool errors.
- Tool wipe (`upToOrdinal` = current turn's user ordinal) **keeps only** `role=user` rows with `ordinal >= ceiling` (the wipe request itself + later-admitted queued users) and their parts/`messageID`s. It **deletes all other roles at any ordinal** (prior users, assistant/peer/error/cards) — including late writes from an earlier still-running lane whose ordinal landed after the wipe user — so leftover A replies/cards cannot pollute the transcript or later LLM history. Watches and the context boundary always clear. Keeping the wipe user avoids delete+re-admit reordering queued users before it. Direct `POST /api/yuri/assistants/:id/contact/reset` → `resetContact` without a ceiling deletes **every** transcript row (existing contract; concurrent in-flight admissions are not preserved on that path).
- Service also exposes `clearContactMemory` for the watermark path (`new_conversation`). Neither path calls OpenCode `session/new` / `createNew`.
- Both tools terminate mutations (`terminate: true`). Persist only the isolated model confirmation. Discard leftover assistant text and cards from the same pre-reset generation. Tool result confirmation constants remain internal model input.
- Failed boundary/transcript writes roll back and keep the previous state.
- Contact send loads `contactHistoryForLlm` when the per-assistant turn lane starts (not at admit-time snapshot), so a prior clear-memory cannot leave a queued turn with stale history. The admitted user row is excluded from that window; `userText` / parts still go to the prompt. The current turn's user `ordinal` is the **upper bound for later-admitted user rows** (`beforeOrdinal`): queued user messages already in SQLite must not be injected into this turn's history. Assistant rows written by a prior completed lane turn after that ordinal still enter the window. Clear-memory watermark and tool wipe both use the **clearing turn's user ordinal** (`upToOrdinal`), not global MAX — otherwise later-admitted queued user rows would be permanently excluded (or deleted). Direct API `clearContactMemory` / `resetContact` without a turn ceiling still advance/delete through the current full set.

**Contact LLM window (this PR)**

- `contactHistoryForLlm` is a short algorithmic window documented in `contact-store.js`: durable context boundary first, then `CONTACT_LLM_MAX_TURNS` (32), `CONTACT_LLM_MAX_CHARS` (48000), `CONTACT_LLM_FETCH_LIMIT` (100), `CONTACT_LLM_FILE_CHAR_WEIGHT` (80). Newest user+assistant text pairs after the watermark are kept; peer / error rows are dropped; cards retain structured ID/status context. There is no summarizer and no user-facing compress or continuous/stateless memory control. SQLite and the transcript UI may still scroll older bubbles, including rows before the boundary.

**Contact attachments (this PR)**

- Attach is required on the contact composer: images and non-image files via picker, paste, and drag-drop.
- **Upload (frozen):** `PUT /api/yuri/assistants/:id/contact/attachments/:uploadID` raw bytes with headers
  `X-Content-SHA256`, `X-Content-Size`, `Content-Type`, optional `X-Attachment-Filename` (encodeURIComponent).
  Returns `{ type:'file', attachmentID, sha256, size, mime, filename? }` — never a filesystem path.
  Same uploadID + same content is idempotent; different content → `idempotency_conflict` (409).
- **Download (frozen):** `GET …/contact/attachments/:attachmentID` runtime-auth, opaque ID scoped to
  assistant + live `generation`. Body is raw bytes with `Content-Type`, `Content-Length`, `ETag`,
  `X-Content-Type-Options: nosniff`. Stale generation after clear-chat → 404.
- Bytes are content-addressed under `dataDir/prompt-attachments` (shared with Chat prompt uploads).
  DB metadata stores only controlled `relative_path` + descriptor; client paths/urls are never authority.
- New uploads capped at **25 MiB**; image magic-byte checks for PNG/JPEG/GIF/WEBP/BMP.
- Admission accepts `attachmentID` refs (validated ownership) or legacy data URLs (landed to disk then stored as descriptors).
- Harness + assign materialize descriptors to data URLs **only at execution time**; DB/UI keep descriptors.
- Clear-memory keeps attachment rows; clear-chat bumps generation so external GETs fail while in-flight
  materialize (owned read) may still complete for the running turn.
- Legacy data-URL migration: batch 20 / 50 MiB, write disk first, CAS-replace `part_json`; failure keeps old JSON.

**Inter-assistant DM (this PR, read-only)**

- `message_assistant` is the contact tool for natural language (给 PeerQA 说一声 / tell PeerQA). It calls in-process `deliverPeerMessage` and confirms with a short bubble. No card required. The user never types `/dm`.
- `POST /:fromAssistantID/contact/dm` `{ toAssistantID, text, parts? }` delivers into B’s contact transcript as `role: 'peer'` with `fromAssistantID` / `fromAssistantName`. The harness/API sends peer messages.
- Read-only: no `session.prompt`, no session/file/worktree mutation, no tools on the recipient. Assign is not delivered here.
- Peer rows are excluded from `contactHistoryForLlm` so they cannot become harness turns.
- This is the inbox primitive for later summon. Do not invent a second inbox.

`GET /api/yuri/assistants/capability` remains the navigation gate.

**Contact messages page (frozen UI contract)**

- `GET /api/yuri/assistants/:id/contact/messages?limit=20[&before=opaque][&messageID=…]`
  returns `{ messages, nextCursor, complete, generation, revision }`.
- Default `limit` is **20**, max **100**. The first page is the **newest**
  window (chat tail); each page's `messages` array is ascending by
  `(ordinal, messageID)`. Older pages use keyset `before` encoded as base64url
  JSON `{ v:1, assistantID, generation, ordinal, messageID }`.
- `generation` starts at **0** and increments **only** on transcript wipe
  (`clear_chat_history` / `POST …/contact/reset`). `new_conversation` /
  clear-memory does **not** bump it. A cursor whose generation does not match
  returns `contact_generation_conflict` (HTTP **409**); clients must refetch
  from the start. Invalid cursor encoding is `validation_error` (400).
- `messageID` exact admission is mutually exclusive with `before`. Same page
  envelope: at most one message for this assistant, `nextCursor: null`,
  `complete: true`. Missing or other-assistant IDs yield `messages: []`.
- `revision` is the assistants domain tip (same counter as snapshot).

**Contact unread / shared read watermark (this PR)**

- Server-authoritative **per-assistant shared** read watermark in `assistant_contact_read_state`
  (`last_read_ordinal`, `last_read_message_id`, `generation`). Multi-client; not per-device.
- **Countable unread:** only complete/error `role=assistant` replies and user-facing `role=peer`
  DMs after the watermark keyset `(ordinal, message_id)` that have ≥1 **visible part** (file,
  card, or non-empty text that is not an internal `oc.settle.*` marker). Visibility is
  **per-part** (same rule as the contact UI): a settle marker beside real body/file/card still
  counts; blank/whitespace-only rows do **not**. User rows and non-visible roles do **not**
  count. Token-level SSE deltas never create rows. Each published spoken bubble, card, or peer row is persisted immediately and ≡ one unread unit.
- **Schema v13 migrate:** existing transcript assistants seed watermark to the current tip so
  legacy history is default-read (`unreadCount: 0`). Messages written after the seed count as unread.
- **Monotonic mark-read:** `POST /api/yuri/assistants/:id/contact/read`
  body `{ generation, ordinal, messageID }` advances only forward in keyset order; late/stale
  lower cursors are no-ops (`changed: false`, **no** revision bump / no `assistants-changed`).
  Generation must match live transcript generation or → `contact_generation_conflict` (409).
  Incoming cursor clamps to the current transcript tip (cannot invent future ids).
- **Wipe/reset:** `clear_chat_history` / `POST …/contact/reset` bumps generation and resets the
  read watermark to empty on the new generation so post-wipe confirm bubbles can surface as unread.
  Stale-generation mark-read fails closed. Clear-memory does **not** touch generation or read state.
- **AssistantDTO** (every `output` / snapshot path):
  - `unreadCount: number`
  - `readWatermark: { generation, ordinal, messageID }` — persisted shared cursor
  - `readTip: { generation, ordinal, messageID }` — highest safe reportable tip (transcript head)
  Clients open a contact, observe messages through `readTip`, then POST that tip.
- **Snapshot cost:** `getContactUnreadSnapshots` batches watermarks + tips + counts for the
  catalog (≤100) — no per-assistant HTTP N+1. Each assistant's full `(ordinal, message_id)`
  read watermark is pushed into SQL (VALUES marks CTE + keyset predicate on
  `assistant_contact_message_page`); `COUNT` aggregates only post-watermark visible candidates
  so fully-read history does not scan parts. Uses the same domain revision /
  `yuri:assistants-changed` tip after a **changed** mark-read (and after new countable
  messages via existing admit/persist bumps).
- Response of mark-read: `{ assistantID, changed, unreadCount, readWatermark, readTip, revision }`.

## History coverage

Snapshots expose the latest 50 `historySessionIDs` in chronological order and `historySessionCount` for the full count. The messages pagination endpoint owns complete OpenCode history across archived and current bindings.

**V2 authority:** OpenCode session projections (`message.list` / `GET /session/:id/message`) are the sole message-body source. Assistant SQLite does **not** persist message/part bodies on send, share, live events, or demand reads. Legacy `assistant_message_mirror` / `assistant_message_part_mirror` / `assistant_message_backfill` tables may still exist for leftover rows and assistant-delete cleanup, but runtime never writes or serves them for history. Live SSE events may still drive assigned-session watch settlement; they do not cache transcript bodies.

`GET /api/yuri/assistants/:assistantID/messages?before=&limit=` returns `{ entries: [{ sessionID, directory, info, parts }], nextCursor, complete, partial, failed? }`. The service lists bindings from `assistant_session_history` plus the live current session and walks them newest-first. Each binding reads the official v2 projection (`message.list` / `GET /api/session/:id/message`): first page uses `order=desc` only; continuation uses the opaque `cursor` only (never combine `order` + `cursor`). Rows keep the authoritative projection sequence (not `time.created` re-sort). The Host `before` cursor stores binding ordinal + upstream opaque cursor + page-local `skip` (positions only — no message bodies). A demand request uses at most three upstream pages with a stable `limit` page size. Public `entries` are ascending. `complete` is true only when every binding is exhausted and nothing failed. A mid-scan binding failure sets `partial: true`, `complete: false`, `failed: [{ sessionID, sessionOrdinal, status }]`, keeps already-fetched newer siblings, and leaves `nextCursor` on that binding so a retry can fill the gap without permanently skipping it. Transient 5xx/network failures retry up to three times; persistent total failure (no successful binding and no entries) throws `upstream_error`. Authoritative 404 for a binding skips it without blocking others. Leftover mirror rows are ignored. When `fetchImpl` is injected, history uses the same official path shape (`/api/session/:id/message`, `limit`, first-page `order=desc` or continuation `cursor`, optional `directory`).

`assistants` owns Assistant configuration, session bindings, and contact/share metadata in `assistants.sqlite`. OpenCode message bodies are read from upstream projections, not mirrored. Routes register before the generic OpenCode proxy.

`GET /api/yuri/assistants/capability` returns `supported`, `enabled: true`, domain revision, relay-derived stable `serverInstanceID`, and explicit v2 gaps `sharingAvailable` (always `false`), `archiveMetadataAvailable` (true only when Host archive is injected), and `sessionMetadataAvailable` (always `false`). Assistants are always enabled. Startup atomically upgrades an old disabled instance flag and advances its revision without changing contacts. The legacy `PUT /api/yuri/assistants/settings` validates `expectedRevision` but returns `enabled: true` without a mutation, so older clients cannot globally disable the feature. Individual contact enable/disable remains supported. CRUD and snapshots live under `/api/yuri/assistants`. Session routes are `POST /:id/session/ensure`, `/:id/session/new`, and `/:id/session/compact`; composer sends use `POST /:id/messages` (contact harness, not `session.prompt`); contact history is `GET /:id/contact/messages` (full transcript, including rows before a clear-memory boundary); contact reset wipe is `POST /:id/contact/reset`; shared contact read watermark is `POST /:id/contact/read`; session cards are `POST /:id/contact/cards`; read-only inter-assistant DMs are `POST /:fromID/contact/dm`; assistant-owned scheduled tasks are `GET /:id/scheduled-tasks`. Shares still use `POST /:id/share` and `GET /share-operations/:operationID`.

Both HTTP snapshot aliases call `ensureDefaultAssistant` before reading. A never-used catalog automatically gets one enabled `Yuri` contact in its managed workspace, with no OpenCode session or model call. It uses the configured default model/variant if connected, otherwise the first connected catalog model. No configured models leaves the catalog empty until a later read after provider setup; catalog/preferences failures reject the read and remain retryable. Same-process initialization is single-flight, and the SQLite write transaction rechecks all rows (including tombstones) so multiple clients/processes cannot seed duplicates or resurrect an explicitly deleted last contact. Existing catalogs bypass model reads entirely. The preference dependency also supplies `defaultModel`/`defaultVariant` for seeding; only favorites/recents enter contact prompts.

`AssistantDTO.mode` remains `continuous` or `stateless` (default `continuous`) for share/queue OpenCode session binding. It is **not** a user-facing memory setting: Settings no longer exposes the continuous/stateless toggle, and new assistants stay continuous contact history with server-side LLM trim. `historySessionIDs` lists prior OpenCode session bindings in chronological order (oldest first, capped). Continuous Assistants keep one long-lived current session across composer turns. Stateless Assistants create and bind a fresh OpenCode session for every composer send, share admission, and queued delivery so the model executes without prior transcript context; prior sessions remain available in OpenCode history. The Assistant surface follows the current binding, so each stateless turn rematerializes onto that fresh session. `AssistantDTO.workspacePath` retains the configuration value: `null` selects the managed workspace and a string selects a registered project path. `AssistantDTO.managedWorkspacePath` always carries the canonical managed target at `dataDir/assistant-workspaces/<assistantID>`, including for project-configured Assistants. `AssistantDTO.effectiveWorkspacePath` carries the resolved OpenCode session directory. `AssistantDTO.variant` is nullable and reaches OpenCode `session.prompt` with provider, model, agent, and system prompt. `SessionBinding` is `{ sessionID, directory, sessionGeneration }` with the effective directory. `ensure` and `new` return `SessionBinding`; `compact` returns `{ binding, summarized: true }`; messages return `{ binding, messageID, admitted: true }`; shares return top-level `{ operationID, assistantID, sessionID, messageID, state, phase, attempt, leaseExpiresAt, errorCode }`. `contracts.js` exports serialization fixtures for these DTOs. Binding replacement uses generation CAS, so concurrent creation retains one winner while orphan sessions stay available in OpenCode history. Workspace changes create and bind a session in the new directory. Session metadata carries `yuri.assistant.assistantID` and `name` as the authoritative ownership marker. New OpenCode sessions use the fixed human title `[Assistant] ${name}` and persist that isolation through the Host session-metadata store immediately after create (`persistSessionMetadata` + `onSystemSessionPersisted`) so the sidebar index drops them without waiting for list sync. They are archived via Host archive immediately after create and before binding is returned, so ordinary active lists never flash them; metadata isolation still applies if archive fails after create. The session index and global session lists hide system sessions by this metadata (never by title prefix). Assistant history and direct source open remain the entry points.

**Contact send admission + SSE (this PR)**

- `POST /api/yuri/assistants/:id/messages` returns **202** `{ messageID, admitted: true, binding }` as soon as the **user row** is persisted (`status: complete`). It does **not** wait for the LLM turn. Validation errors still fail synchronously with 4xx before admit.
- After admit: bump revision + `yuri:assistants-changed`, register active contact turn (`queued`), broadcast `yuri:contact-turn-start` `{ assistantID, turnID, messageID, occurredAt }` (`turnID` = client `messageID`), then kick `runContactTurn` asynchronously (serialized per assistant). Lane start marks the turn `running`. Lane start marks the turn `running` and bumps revision. Same `messageID`+payload replays admission once (`replayed: true`) without a second lane run; payload mismatch → `idempotency_conflict`. Failures persist a durable assistant `status: error` bubble for query recovery. Catalog/project list loads use a bounded deadline so the lane cannot hang forever.
- Contact SSE reuses `/api/yuri/events`: `yuri:contact-bubble-delta` `{ assistantID, turnID, bubbleIndex, delta, done, occurredAt }`. `notify_user` notes publish when their response arrives; text beside tool calls remains private. Each `done:true` bubble persists immediately as `${userMessageID}:bubble:${index+1}` and bumps `assistants-changed`, allowing another client to fetch it before the turn ends. Token deltas (`done:false`) remain ephemeral. Turn-global indices continue from `projectStreamedContactTurnBubbles` plus the current completion's published records, including corrections. On normal turns these messages form the final array's stable prefix and turn-end persistence adds only the remainder. Every tool result stays model-only; missed-tool exhaustion with no model text becomes an error. Tool cards persist on `onCard` with the existing `${userMessageID}:card:${index+1}` identity.
- Turn end: strip/parse/tools (existing), persist any **remaining** assistant bubbles + cards (skip ids already published mid-turn; never re-insert the user row), clear active contact turn, bump + assistants-changed (error paths bump even without assistant rows), broadcast `yuri:contact-turn-end` `{ assistantID, turnID, status: 'complete'|'error', error?, occurredAt }`. On failure the admitted user row stays; clients must not spin forever. Completing a contact turn also sends the same completion notification path as a normal contact: SMS-style title (assistant name) + body (spoken bubbles), via desktop / UI SSE / push, gated by `notifyOnCompletion`.
- **Successful `new_conversation` / `clear_chat_history`:** mid-turn spoken/card publishes for that turn are discarded. `persistContactAssistantReply({ reset:true })` deletes this turn's `role=assistant` rows by `assistantID+turnID` (parts first; same delete pattern as contact-store, **not** `deleteContactMessages`) inside the existing write transaction, then inserts the single confirm bubble and bumps revision. Clearing user, queued users, peers, older turns, watches, generation, context boundary, and read watermark stay. Late bubble/card publish after reset success is ignored; `spokenByIndex` and `assignedCards` clear. Failure keeps prior error semantics.
- **`stop_session` abort race:** before `session.interrupt`, the service registers a private per-`sessionID` inflight map (shared promise + observed terminal). Concurrent stop calls on the same worker share that promise. While inflight, `reportAssignedSession` only stashes terminals (`cancelled` > `error` > `complete`) and delays watch writes / continuations. Abort success (including silent no-SSE): release map, `cancelAssignedResumes({ sessionID })`, then `reportAssignedSession(cancelled, resume=false)`. Abort throw / 404 / error / `data:false` / signal failure: release map, replay one observed terminal through the normal reporter when present (else watch unchanged), return the real tool failure. `close()` clears the map; late events stay cancelled-idempotent.
- In-process tests use `whenContactTurnSettled(messageID)` (not part of the HTTP JSON body).
- Completions: public `POST /llm/chat/completions` still rejects `stream:true`. In-process contact harness passes `onTextDelta` + `globalEventHub` through `boundCompletion` → `createChatCompletion` → throwaway generate for real tokens only.

Composer messages carry a client message ID. The service accepts the existing OpenCode delivery parts (`{ type: 'text' }` and `{ type: 'file', mime, url, filename? }` data URLs — not a second attachment store), extracts text (`[attachment]` when the send is file-only), admits the user at 202, then runs the contact harness asynchronously (`runContactTurn` / pi-agent-core, thinking off, pi `read` / `write` / `edit` / `bash` in the assistant workspace, Yuri tools `new_conversation` / `clear_chat_history` / `list_projects` / `list_sessions` / `get_assistant_settings` / `update_default_prompt` / `create_assistant` / `schedule_task` / `message_assistant` / `assign_session`, merged `.agents`/`.claude` skills, plus the registered-projects catalog each turn) through the Yuri completions gateway (public HTTP non-streaming; in-process `onTextDelta` for contact SSE). Assistant bubbles and tool cards persist when they publish (bubble `done:true` / card insert) and turn end upserts any remainder. File parts survive `GET /:id/contact/messages`. The harness forwards those file parts to the completions gateway. Image data URLs reach `session.prompt` only when the connected catalog marks the model as vision-capable; otherwise generate keeps the `[image: …]` description and text-file bytes so a non-vision model cannot stall the contact turn. Gateway 502 responses include `{ error, message }` so the composer can show the OpenCode error string. OpenCode `session.prompt` is not the contact conversation engine; assign uses it only on the **worker** session. Share and queued delivery still use it on Assistant bindings. OpenCode `204` is an admitted empty response. A 404 restores one generation-scoped binding before retrying. Ambiguous network errors preserve the client message ID without another send. Every committed Assistant revision publishes `yuri:assistants-changed` only after its SQLite transaction completes; clients use the tip to reload the authoritative snapshot after worker-driven stateless binding changes. `POST /:id/session/abort` requires the same `{ sessionID, sessionGeneration }`, returns the binding and `aborted: true`, reports a changed binding as `revision_conflict`, and preserves upstream missing-session `not_found` semantics.

`GET /api/yuri/assistants/:assistantID/messages?before=&limit=` is documented under **History coverage** (OpenCode projection source; no SQLite body mirror).

Queue admission accepts `{ kind: 'assistant', assistantID }`, captures a structured binding plus provider, model, agent, nullable variant, default prompt/system, compiled text parts, and durable attachment descriptors. Direct messages, shares, and queued Assistant deliveries accept up to 129 strict OpenCode text/file parts, including up to 64 file parts. Queue dispatch uses `sendWithCapturedConfig`, so queued work never reads mutable Assistant configuration. Continuous delivery retains binding fencing and a changed binding produces `stale_target`. Stateless delivery instead belongs to the stable `assistant:<assistantID>` queue lane: it ignores disposable binding replacement, serializes prompt admissions per Assistant, and creates a fresh execution Session for every row.

Share operations persist operation identity, Assistant identity, payload hash, phase, session ID, message ID, state, attempt, lease expiry, and error for seven days. `ShareOperationDTO` exposes top-level `sessionID` and `messageID` with `state` in `submitting`, `running`, `completed`, `failed`, or `unresolved`; it carries no binding. Admission and claims use SQLite transactions and compare-and-swap updates. A `reserving` phase is inserted or read under `BEGIN IMMEDIATE` before any session ensure or creation side effect. Its unique owner chooses and records the session and message IDs before claim and submit; duplicate matching requests reuse and poll that operation, while payload conflicts return `idempotency_conflict` without session work. Reservation-owner session creation failures delete the still-reserving record so a retry can reserve and recover. `running` work has a lease; `submitted` phase reconciles through message-ID lookup; expired submitted work becomes `unresolved`; failed work permits one CAS claimant to retry. `ShareOperationDTO` is available from the share response and `GET /share-operations/:operationID`. Repeated shares reuse that record. Ordinary composer messages create no operation record. Share/queue admissions do not write Assistant message-mirror bodies; OpenCode projection remains authoritative.

Schema v2 migrates legacy Inbox bindings once. It prefers the legacy Inbox session, then the latest successful operation or turn session. Schema v5 makes `workspace_path` nullable and migrates stored managed paths under `dataDir/assistant-workspaces/<assistantID>` to `NULL`. Schema v7 adds `mode` (`continuous` | `stateless`, default `continuous`) and preserves legacy `assistant.mode` during Inbox migration. Schema v10 establishes demand-driven history backfill semantics; existing mirror rows remain partial until a complete backfill state is persisted. Schema v13 adds `assistant_contact_read_state` and seeds existing contact transcripts to the current tip (default-read). New records use `assistant_v2` and carry no legacy topic field. Legacy topic, turn, operation, and assistant tables remain migration sources and compatibility backups. Runtime code never reads or writes them. Migration retains OpenCode sessions and messages.

Assistant workspaces resolve only under the Assistant workspace root or configured project roots. DTO serialization resolves and creates the managed target through the same containment checks, so project-configured Assistants expose a ready canonical destination for a future managed switch. Managed workspace creation resolves and creates `dataDir/assistant-workspaces/<assistantID>` before a session switch creates its OpenCode session and commits the configuration CAS. Route registration refreshes the authoritative project roots for each request. Each OpenCode session, prompt, message lookup, and skill discovery uses the effective workspace directory, so OpenCode applies its standard workspace skill discovery and configuration. Contact turns additionally merge `~/.claude/skills`, `~/.agents/skills`, and the workspace `.claude/skills` plus `.agents/skills` into the pi system prompt (project wins on name) and append `defaultPrompt`. `skill_roots` is a legacy schema field; migration removes it from `assistant_v2`, and runtime DTOs, input payloads, and writes omit it. `close()` clears the share-retention scheduler and closes SQLite.

### Session operations from a contact

Contact tools expose `assign_session` (new or continued session), `steer_session` (insert a user instruction using SDK `session.prompt` with `delivery: steer`, without a model override), `stop_session` (real SDK abort), `archive_session` (Host archive via `session-metadata` `yuri.archive.archivedAt`, not upstream `session.update`), and `delete_session` (SDK delete; Host metadata cleanup follows `session.deleted`). All existing-session mutations resolve directory from authoritative session metadata and apply the same registered-project scope checks. They accept exact session IDs from references, history, or `list_sessions`; ambiguous targets require clarification. Delete is permanent and is only offered for an explicit deletion request. SDK failures remain tool errors, never success confirmations; a failed mutation does not clear its watch. Successful archive/delete cancel assistant watches and pending automatic resumes, just as explicit stop does. Archive itself does not abort OpenCode execution: stopping and archiving are separate operations. Steering preserves the upstream session's model and does not create a second session. Terminal operation tools execute once per successful contact turn. All surfaces use the same server contact tool implementation.

### Contact context and background notification boundary

- The model history is bounded to 32 recent turns, 48,000 estimated characters and 100 transcript rows (newest turn remains intact). It is not unlimited memory or a durable summary. Clear-memory still applies its persisted ordinal boundary. User instructions and assistant replies retain chronological ordering; card-only rows now contribute structured card context with exact session ID, directory and current status, instead of disappearing from the next model request. Peer inbox and failed rows remain excluded.
- Assigned-session settlement is a read-only result notification. The harness filters its tools to project/session/settings lookups and does not create a coding runtime. It cannot restart, assign, steer, archive, delete or write files even if the model attempts to do so. The latest user constraints remain in history.
- A new admitted user turn cancels running background notifications and durably disables notifications from existing watches (`resume_allowed`). Live card status continues updating truthfully. Explicit assign/watch admission rearms only that watch. This prevents a delayed completion after a stop/new instruction from restarting an obsolete background turn, including after server restart.
- Contact turns own AbortControllers. The existing session-abort route validates the current binding/generation, cancels active/queued contact turns and background notifications even without a legacy OpenCode binding, propagates the signal into the harness, and discards late generated output. With no active contact work it retains the legacy binding abort behavior. Already committed side effects are not rolled back.

Assign/watch tools forward the contact AbortSignal into their service calls and discard late cards after cancellation. Assign checks cancellation before creation and again before prompt submission. A session whose create completes after cancellation remains available but receives no prompt; cancellation never implicitly deletes it. Once prompt admission has begun, the existing ambiguous-admission identity and lookup rules remain authoritative.

### Referenced conversation content

`read_session` is a read-only contact tool available on user turns and background notifications. An `@session:<id>` chip supplies identity only. The model reads contents through this tool before answering about the reference, and treats returned messages as quoted data, never as new user instructions or authorization to resume/watch/mutate. The quoted payload stays on the tool transcript for the model; contact bubbles keep only `notify_user` notes and the post-read reply.

The service resolves the exact session and registered project through the existing authoritative session resolver, then calls SDK `message.list` with `limit` (default 20, maximum 50) and the turn AbortSignal. The first page sends `order=desc`; a continuation sends only the opaque `before` as `cursor` (upstream rejects `order` together with `cursor`). Native v2 rows are projected to role + parts and quoted oldest→newest. The upstream body `cursor.next` (falling back to the `x-next-cursor` header) is returned unchanged as `nextCursor`. Missing sessions, transport errors, malformed message lists and cross-session message identity mismatches fail closed. Empty successful lists remain distinguishable from failures.

Results retain message IDs, roles, text and bounded tool-result/file metadata. Text is limited to 4,000 characters per field and 24,000 total; each message contributes at most 20 parts. File URLs/bodies, reasoning and tool inputs are omitted. `partial` explicitly marks truncation, omissions or older pages. Reading creates no watch, prompt or other mutation.
