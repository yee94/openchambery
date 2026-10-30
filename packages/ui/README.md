# Yuri shared UI

`@yuriai/ui` owns the shared React surfaces, runtime contracts, state and persistence.
OpenCode package identities and protocols remain third-party contracts.

## Default themes

New preferences use Cursor Dark (`cursor-dark`) and Carbonfox Light
(`carbonfox-light`), following the system appearance. Explicit saved selections
remain authoritative. The web host fills missing theme preferences with the same
defaults; Web, Mini Chat and mobile cold-start backdrops use Cursor's dark surface
until persisted splash colors or the resolved runtime theme are available.

## Startup logo geometry

The mobile HTML also includes the canonical 120 × 120 logo inside `#root` before
JavaScript loads. React replaces it on first commit. GUI plugin discovery and
installation wait for the usable shell and a paint opportunity; plugin loading
stays in the background without a global dialog or sheet and never owns the application startup gate.
`OpenCodeUpgradeScreen` supplies a React logo while its first check or runtime
recheck is pending, and a logo Suspense fallback plus error boundary for the app.
This prevents createRoot from replacing static branding with an empty commit.
The web timeout removes its static overlay only after React has committed content;
mini-chat's in-root logo is replaced by React without a destructive timeout.
GUI revision checks, code downloads and installation stay silent; failures retain
their existing error feedback, and file previews own their local loading state.

The full-text index startup screen keeps the same transparent 120 × 120 CSS-pixel logo at the viewport center as the desktop/web splash. Its progress ring is concentric with the logo; percentage, description, and background action occupy an independently scrolling area below it. The fullscreen dialog must not scale during entrance or exit, and progress/text changes must never reposition the logo.

## Assistant avatars

Assistant contact faces use a locally bundled, MIT-licensed procedural SVG engine
with a compact preview/shape-grid/color-swatch picker in Assistant Settings.
They do not replace app branding or coding-agent faces. All shared UI and native
PNG share thumbnails resolve the same saved `avatarSeed` recipe. See
`src/components/assistants/DOCUMENTATION.md#generated-avatars` for persistence,
animation budgets, source provenance and runtime validation boundaries.

## Sidebar wordmark

The default sidebar brand is `Yuri`. Whenever the name contains `Yuri`,
`SidebarBrandMark` adds a 24px `YuriLogo` portrait before the name and vertically
centers the portrait, wordmark, and custom text.
`SidebarBrandMark` renders the approved
sculpted SVG through `YuriWordmark` for each exact, whitespace-separated `Yuri`
word, including mixed names such as `Yee Yuri`. Its width is cap-height-relative
(2.44814cap = 626.723 / 256), matching the visible artwork to the bold
Syne text's cap height. All words use the
same theme foreground. Custom text retains its original 1.0625rem size, 700
weight and 0.08em tracking; Syne loads only when custom text is present.
Whitespace-only names hide the slot. Store version 3 migrates exact historical default
names, preserving other custom values and the existing runtime-scoped storage.

## Brand migration

`src/lib/brand-storage-bootstrap.ts` is the single synchronous same-origin
localStorage coordinator. Storage consumers import it before evaluating persisted
state. It copies product-owned old namespaces into Yuri keys, preserving values
byte-for-byte, including malformed values for their owning store's recovery logic.
Encoded runtime/instance identities are opaque. Existing Yuri keys win; old values
are never deleted. Per-key completion markers prevent intentional deletions from
being resurrected. Failed writes/verification remain retryable on reload; bootstrap
fails closed instead of allowing empty stores to overwrite draft metadata.

The same migration owner gates the five IndexedDB databases used for draft blobs,
assistant attachments, durable transcripts, transcript search and diagnostics.
It snapshots old stores in one readonly transaction, preserves key paths/indexes,
and commits copied records plus a completion marker in one new-database transaction.
Existing records win. A failed transaction leaves the source intact and can retry.
An independently initialized Yuri database is authoritative and is not overwritten.
Completed migrations check only their marker; they do not rescan transcript blobs.
Absent old databases are probed with an aborted creation, so fresh installs do not
create old-brand databases. Neither user text nor stored file URLs are rewritten.

This only covers accessible storage in the **same origin**. Electron's old scheme,
a changed web domain, and a new mobile application sandbox require the owning
runtime's explicit export/import or re-pairing flow. Browser migration cannot read
another origin or transfer native Keychain credentials. The shell must finish any
origin import before loading shared UI modules.

### Legacy read exceptions

| Location | Allowed legacy input | Scope / exit condition |
| --- | --- | --- |
| `src/lib/brand-storage-migration.ts` | Two historical full-brand namespaces and product `oc` storage prefixes | Copy-only storage migration; remove no earlier than the next major migration window, after native import acceptance |
| `src/lib/brand-storage-migration*.test.ts` | Old keys, database names and sample user text | Migration regression fixtures; retire with the migrator |
| `src/apps/deepLinks.ts`, `src/lib/connectionPayload.ts`, `src/apps/deepLinks.test.ts` | Two old URI schemes | Read-only link parsing and regression fixtures; generated links use Yuri, pairing validation/expiry/exchange remain unchanged; retire after old-client migration window |
| `src/lib/theme/themes/index.ts` | Two old built-in theme IDs | Resolve existing preference values; retire after preference migration window |
| `src/sync/input-draft-composer-parser.ts` and its test | Two old serialized draft discriminants | Recover existing paste/reference sidecars without rewriting user text; retire with draft migration |
| `src/lib/messages/inlineMessageLinks.ts` | Old skill/agent fragment prefixes | Read stored message links, emit only Yuri fragments; retain while historical transcripts can contain them |
| `src/components/assistants/AssistantConversationSurface.tsx`, `src/components/assistants/contactMessageTime.ts`, `src/queries/assistantContactMessages.ts` | `oc.settle.*` | Hide persisted internal markers without rewriting transcript content; retain while historical transcripts can contain them |

The UI maintainers own these exceptions. Legacy names are not emitted as new keys,
new URLs or new protocol defaults.

## Runtime contract integration

The Host version row in About and the desktop remote-instance menu share
`HostVersionUpdate`. It checks `/api/system/update` through the active runtime,
shows an update dot, and confirms an exact version/channel/plan before remote
update/restart. OTA, native installer and CLI package updates remain Host-owned;
beta-to-stable rollback is explicitly disclosed. Runtime-scoped Query state keeps
progress across reconnects and rejects stale mutations after a Host switch.

Desktop host-picker actions keep their popup visible during SSH preparation and
show the polled SSH phase inline. Switch, connect and new-window actions share a
synchronous local guard and disabled controls until completion; failures leave the
picker open for retry. The services menu ignores dismissal and tab changes while
an action is pending. Host-switch mutations from the picker opt into inline
progress, while the global overlay still covers the actual endpoint transition.

All runtime owners must agree on `__YURI_*`, `yuri:*`, `/api/yuri`, `Yuri*` native
plugins, `yuri-ui` / `yuri-asset` schemes and `yuri_url_token` / `yuri_preview_token`
query parameters. Product CSS/custom properties/data attributes now use `yuri-*`;
native keyboard, webview and desktop injection code must emit the same names.
The server metadata namespace is `metadata.yuri`; authoritative server migration
must preserve old session goals, reviews, assistant/task membership and title data.
Mixed old shells are not supported by merely changing a display name: the native
bundle/update compatibility gate belongs to the mobile/desktop owners.
Mobile OTA requests carry `applicationId` only from native `App.getInfo().id`.
Missing or unreadable native identity stays absent; the web bundle/config never
supplies a fabricated identity. Old/missing identities can receive an installer
decision but cannot accept or download Yuri OTA. Desktop checks invoke
`desktop_check_for_updates` with only the channel override; Electron supplies the
native identity at its privileged boundary.

Release builds must configure verified update URLs with
`VITE_YURI_EDGEONE_UPDATE_CHECK_URL`, `VITE_YURI_VERCEL_UPDATE_CHECK_URL`,
`VITE_YURI_EDGEONE_OTA_CHECK_URL`, `VITE_YURI_VERCEL_OTA_CHECK_URL`, and
`VITE_YURI_IOS_TESTFLIGHT_URL`. Unconfigured update services use reserved `.invalid`
addresses, and the iOS installer link falls back to the candidate releases page.
These defaults are not a configured or verified release service.

`src/components/ui/YuriLogo.tsx` and `src/assets/brand/yuri-mark-{black,white}.svg`
use the final approved vector geometry. The mark stays black or white; theme
containers own backgrounds. Animation honors reduced motion.

`src/components/ui/YuriWordmark.tsx` renders the approved sculpted-serif wordmark
from `src/assets/brand/yuri-wordmark.svg` as a current-color mask. The disconnected
welcome page places it in a safe-area-aware top-left header; the portrait remains
the central decorative mark. `assets/brand/yuri/build_wordmark.py` regenerates the
master artwork and synchronizes this bundled SVG. The welcome's connection/history
actions retain their existing shared sheet and modal behavior.

## File preview fallback

`FilesView` and `MobileFilesSurface` retain the inline GUI-plugin preview as the
outermost preview choice. The ordinary text fallback first reads authoritative
`FilesAPI.statFile` metadata; a binary result never triggers a UTF-8 content read,
editor or save. Unknown suffixes still display text when stat permits it. Stat
failure/unavailable capability is an error, not evidence of a text file. Existing
image/PDF rendering stays on its asset path.

`components/views/BinaryFileFallback.tsx` owns the shared non-text state. Local
desktop users explicitly choose “Open in system app”; both its visibility and
the existing `openDesktopPath` boundary require the active local origin. Remote
desktop, web, mobile and VS Code use `FilesAPI.downloadFile` when supplied by
their runtime. Opening a file tab never triggers either action automatically.

Mobile reuses the stat watcher query for classification instead of adding a
second metadata read, and revalidates cached classification on opening a file.
Runtime/scope/path/read-options remain part of its query
identity; binary transitions disable text refetch. Desktop preserves outside-file
read options/grants for stat and content and rejects stale stat completions before
starting a content read. Binary files keep metadata-only external-change watching.

The file-reference and mobile binary tests cover skipped reads/writes, explicit
actions, plugin precedence, stat failures and stale completions. They do not prove
real OS app opening, native mobile downloads or remote/Relay transfer behavior.

## Validation

Use `bun run --cwd packages/ui type-check`, `lint`, and `test`.
The `brand-storage-migration.chrome.test.ts` regression uses real Chromium
IndexedDB for Blob copying, transaction abort/retry and non-resurrection. This is
same-origin browser evidence, not proof of Electron cross-origin or native-sandbox
migration. Real shell install/import/relay/OTA acceptance remains required.
