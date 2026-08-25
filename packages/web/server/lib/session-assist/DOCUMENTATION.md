# Session Assist

Server-side watcher that generates a short recap of the agent's last reply
with the small model (`lib/small-model`), storing it on the session's metadata
under `metadata.openchamber.assist`.

## Flow

1. `createSessionAssistRuntime` is a consumer of the server's global SSE
   fan-out (`index.js` → `onPayload`), riding the same upstream connection as
   notifications. Purely event-driven — dormant sessions never generate
   anything, there is no backfill and no session scanning.
2. `session.status: idle` arms a 60-second per-session timer; any `busy`/
   `retry` status or a user `message.updated` clears it (the "1 minute of
   quiet" rule).
3. On fire: fetch the session (skip sub-agent sessions with `parentID`),
   then build a trimmed excerpt via `buildAssistTranscript`: the LAST text
   block of the last assistant message (earlier blocks, reasoning, and tool
   output are excluded) plus the latest 3 real user messages (synthetic
   hidden-instruction parts never count). The excerpt is sent to
   `generateSmallModelText` with the
   session's own provider/model taken from the last assistant message — so
   the utility call spends the same subscription as the conversation.
   `restrictToPreferredProvider` forbids the resolver's global fallback:
   conversation content never goes to a provider the user didn't pick for
   the session, unless the small model was chosen explicitly (settings
   override or opencode config). A resolver 404 is silently skipped.
4. The requested JSON field (`recap`) is clamped and
   PATCHed onto the session metadata together with `forMessageID` (the last
   assistant message id) and `generatedAt`. Before writing, the session tail is
   re-checked (a stale result is dropped) and the metadata is merged from a
   fresh session read so concurrent metadata writes made during generation are
   preserved.

## Settings gate

`sessionRecapEnabled` in OpenChamber settings (Settings → Chat, default on) is
a hard generation switch checked at fire time. When off, no small-model calls
run and nothing is written. The UI also hides the recap when the setting is off.

## Freshness contract (no clearing writes)

Clients do not need the payload to be deleted: they render it only while
`assist.forMessageID` still equals the session's last assistant message id
(and the session is idle). Any new message invalidates the payload
everywhere instantly and offline; the next idle cycle overwrites it.

## UI consumers (packages/ui)

- `lib/sessionAssistMetadata.ts` — payload parsing.
- `hooks/useSessionAssist.ts` — freshness gating + the 1-minute quiet window
  for the recap (single timeout to the boundary, no polling).
- `components/chat/SessionRecapSpacer.tsx` — renders the recap inside the
  fixed-height reserved gap under the last message (height never changes).

## Limitations

- The watcher lives in the web server, so VS Code (extension-only, no web
  server) does not generate assists; it still renders payloads produced by a
  web/desktop instance of the same OpenCode server via `session.updated`.
- Metadata payloads ride every `session.updated` event — keep the clamp
  (`RECAP_CHAR_LIMIT`) small.
