# Session Title Refresh

Server-side watcher that regenerates a session's sidebar title from the
conversation's **main subject** (overall feature / goal) with the small model
(`lib/small-model`), then PATCHes `title` plus `metadata.openchamber.titleRefresh`.

OpenCode only auto-titles once from the first user message
(`SessionPrompt.ensureTitle`). Long sessions often need a refresh; this module
keeps the sidebar title aligned with the durable work being done — not the last
wrap-up utterance like "commit and push" — throttled to at most once per 5
minutes per session.

## Flow

1. `createSessionTitleRuntime` is a consumer of the server's global SSE
   fan-out (`index.js` → `globalMessageStreamHub.subscribeEvent`), same
   pattern as session-assist. Purely event-driven — dormant sessions never
   generate anything.
2. A newly observed root `session.created` generates its first title immediately
   on the first `session.status: idle`. A fork title (`(fork #n)`) waits for its
   first newly-created user message; the matching assistant completion triggers
   an immediate title refresh that bypasses inherited title metadata and throttle.
   Later idle transitions arm a 15-second quiet timer; any `busy`/`retry` status
   or a fresh user `message.updated` clears it.
   A sidebar smart-title request sets `titleRefresh.requestedAt`; its
   `session.updated` event arms the same flow immediately.
3. On fire:
   - Skip when Settings → Chat → session title refresh is off.
   - Skip sub-agent sessions (`parentID`), multi-run/fusion structural titles,
     and titles the user manually renamed (current title ≠ last auto title
     we wrote, and not still the OpenCode default placeholder).
   - Enforce the 5-minute throttle (`TITLE_THROTTLE_MS`). If still inside the
     window, re-arm for the remaining time instead of dropping the refresh.
   - Require 2+ real user turns (unless the title is still the default
     placeholder) so OpenCode's first-message title can land first.
   - Skip when `forMessageID` still matches the latest assistant message
     (no new content since the last refresh).
   - Set `metadata.openchamber.titleRefresh.isGenerating` while the small
     model call is active so connected clients animate the existing sidebar
     title as a loading state.
    - Call `generateSmallModelText` with a **bounded** transcript — never the
      full session history:
      - OpenCode session/message fetches (GET + PATCH) use a 30s timeout so
        long sessions that settle slowly after idle are less likely to abort.
      - Fetch only the latest ~16 messages (`limit` on OpenCode message API).
      - Keep the latest 5 user/assistant turns after the most recent
        compaction part (if any); content before compaction is ignored.
      - Limit each user message to 2,000 characters and each assistant
        message to 1,200 characters so verbose model output cannot dominate
        the title signal.
      - Optionally prepend an earlier subject anchor (first real user message
        still inside that post-compaction window when it fell outside the
        latest turns).
      - Hard-cap the final transcript under 20K characters (prefer latest
        content when over budget).
      - Pass the current title as a continuity hint. The prompt asks the model
        to name the main subject of the work, keep that subject across wrap-up
        turns, and only switch when the user clearly started a new topic.
        Restricted to the session's own provider unless the user explicitly
        configured a small model.
4. Clean the model output to a single short line, then PATCH `title` and
   `metadata.openchamber.titleRefresh` (`lastAutoTitle`, `forMessageID`,
   `generatedAt`) from a fresh session read so concurrent metadata writes
   are preserved. Transient `requestedAt` and `isGenerating` flags clear
   after the model call finishes.

## Sidebar ordering

`message.updated` events for real user messages persist their creation time as
`metadata.openchamber.titleRefresh.activityUpdatedAt`. Sidebar/global ordering
uses this user-activity timestamp. Assistant output, tool events, title writes,
and other session updates keep the existing ordering timestamp unchanged.

## Settings gate

`sessionTitleRefreshEnabled` in OpenChamber settings (Settings → Chat,
default on) controls background title refreshes. Explicit smart-title actions
still run when background refresh is disabled.

Settings → Summary AI controls the title model and the optional
`summarySessionTitlePrompt` override. The configured custom API receives the
title transcript only after the user explicitly selects that source.

## Manual rename contract

After this module writes a title, further auto-refreshes only proceed while
`session.title === titleRefresh.lastAutoTitle` (or the title is still the
OpenCode default). Renaming in the sidebar breaks that equality and stops
auto updates for that session.

## Limitations

Title language follows the user's real message text. Assistant responses, tool
output, and transcript labels provide context without selecting the title language.

- Lives in the web server, so VS Code (extension-only) does not generate
  refreshes; it still receives `session.updated` title changes produced by a
  web/desktop instance of the same OpenCode server.
- First OpenCode-generated title (no `titleRefresh` metadata yet) may be
  replaced once the conversation has 2+ real user turns — that is intentional.
