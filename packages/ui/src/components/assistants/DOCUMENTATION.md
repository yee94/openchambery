# Assistant UI

## Creation and session return

Creating a Bot forwards the current UI locale to the Host. The Host stores its
single welcome message in the contact transcript and returns its preview in the
creation DTO; the UI does not inject a fake user prompt or repeat it on mounting.

Phone session-card navigation captures the originating Assistant ID and root tab
in the mobile chat route. Header, system, browser and gesture Back restore that
contact instead of dismissing to the catalog. The immediate Assistant underlay
stays mounted and inactive, preserving its draft while the worker is open. Nested
chat, replacement and `/btw` routes retain the return target; tab/runtime changes
discard it. An unvisited worker parent cannot displace this explicit entry point.
Desktop/iPad and standalone VS Code keep their existing session/URL navigation.

## File resource ownership

`assistant-attachment-cache.ts` is a descriptor/error/display adapter over `runtime-file-resource.ts`. Its former independent body LRU and Assistant body databases (both Yuri and legacy brand namespaces) are retired; disposable bodies are deleted without blocking operations and are never imported into the shared store. The shared file owner verifies size/SHA-256 and owns singleflight, retention budgets, persistence and independent cancellation. Display URL leases and pending UI state remain in the Assistant adapter. Bearer descriptors can persist in the shared store; cookie-only descriptor reads retain their previous process-local authorization behavior. Captured scope/bearer tags allow explicit forget to remove the matching durable bytes, while runtime switches preserve durable partitions. Auth changes cancel live reads. The existing descriptor/upload limits and error codes remain protocol rules, not cache-budget rules.

Confirmed Assistant uploads seed the shared content owner after the real PUT and descriptor validation. Native incoming shares import staged local bytes once; forwarding/sending still performs the actual destination operation. Cross-consumer tests cover imported bytes → file reads → descriptor reads without another source transfer, persistent A→B→A recovery, failed writes, integrity checks and cancellation of one concurrent reader.

## Video and fullscreen save

Contact video attachments open the shared native-video preview. Descriptor-backed
videos acquire bytes through the existing attachment cache only after Preview is
pressed; their blob lease lives with the row. Legacy direct URLs and Markdown
video-file links use the same `ToolPopupContent.video` contract. The global preview
flag includes video. Every fullscreen preview hosts its own save sheet, including
image long-press, so contact conversations do not require a `ChatContainer` host.

## Hold-to-talk input

Mobile contact composers reuse the memoized `HoldToTalkComposer` shared with primary Chat: hold an empty textarea to record, release at center to edit, slide left to cancel or right to send. The dictation setting and capture/runtime support gate activation (VS Code is unsupported). Final recognition is passed explicitly into the existing contact admission path, retaining attachments, failed-send drafts and retry identity. Edit results use the reference-aware document commit. Text typed during finalization is preserved and receives the transcript without automatic submission. Inactive contacts unmount capture; the existing runtime/assistant key fences late results. Stable event callbacks isolate idle audio Hooks from ordinary typing; working contacts remain usable while admission-pending contacts disable dictation but keep text entry available.

## Contact session references

Contact submission keeps the textarea mounted, enabled and focused during admission. Inline send pointer presses preserve input focus; pending admission still blocks duplicate sends and attachment changes, while the next text draft remains editable. Mobile transcript bottom padding reserves an additional 2.75rem outside the content/status slot to clear the composer fade, including with a reduced keyboard viewport. The existing auto-follow hook remains the sole scroll writer.

The Assistant workspace and conversation pane are `overflow-clip` frames, never
scroll owners. Mobile's generic `overflow-hidden` rewrite would turn these into
vertical scrollports: the native composer's full-viewport keyboard curtain then
creates an outer scrollbar during keyboard opening, which can reserve horizontal
space and reflow messages. Keep scrolling inside the contact transcript (and the
desktop catalog), not on either frame. `assistantKeyboardGeometry.chrome.test.ts`
loads production CSS and checks three open/close cycles for Android's composer
transform, iOS-style shell shrink and hosted-mobile resize, with short and long
content. It guards outer scroll ownership and horizontal geometry; physical-device
IME animation and platform scrollbar painting still require device validation.

Assistant Settings resolves model choices through the directory-scoped `providerQueryOptions`, which reuses the complete `providerCatalogQueryOptions` loader and its abort signal. The catalog includes models and thinking variants; the v2 provider-only list is not a model catalog. Favorites and recents remain shortcuts alongside the full provider/model sections.

`AssistantSessionComposer` composes the existing inline `ChatPromptComposer` with a session-only `@` picker. It uses `resolveComposerAutocompleteTrigger`, `getVisibleSessionMentionCandidates`, `ComposerAutocompleteLayer`, and the shared touch-selection controller. Keyboard arrows navigate; Enter/Tab insert; Escape, outside press, and the close button dismiss. IME confirmation retains input ownership. Mobile uses the shared keyboard-aware body portal, scroll bounds, and touch-pan guard. The textarea remains focused after selection.

The mounted picker observes the existing transport-scoped `sessionIndexSnapshotQueryOptions` through TanStack Query. Its select projection takes each row's directory from the authoritative snapshot directory bucket, excludes archived rows, and shares Chat's title-relevance ranking, literal ID fallback and updated-time tie-breaker. This recent-session-only surface explicitly requests its own presentation bounds: empty search shows up to 3 rows; title/ID search shows up to 10. Unlike the primary mixed picker, it does not remove those bounds. The source is the server's bounded per-directory recent summary (currently newest 20), so older catalog entries beyond that window require a future bounded server search capability. The header explicitly describes recent indexed sessions. Opening revalidates the existing Query; query text changes and ordinary parent renders issue zero additional requests. Closing or deactivating unmounts the observer. Query retains cached rows on failure and exposes Retry; loading, unsupported, and successful empty states remain distinct. This surface performs zero full-catalog, file-search, or agent-catalog requests.

Selection inserts ordinary editable message text in this format:

```text
@session:ses_example {"title":"Readable session title","sessionID":"ses_example","directory":"/workspace/project"}
```

The token reuses `getSessionMentionToken`; JSON serialization escapes the title and directory. Selection only updates the existing contact draft. The user adds their watch/continue/stop instruction and sends through the existing text part; backend tools own `watch_session`, `assign_session` with `sessionID`, and `stop_session`. Message admission, attachment handling, failed-send draft retention, and retry message identity stay owned by `AssistantConversationSurface`. Picker UI resets across Assistant/runtime changes while the existing surface retains draft ownership. Web, Electron, VS Code, hosted mobile, and Capacitor use this shared React contact composer and runtime transport; the primary Chat native composer keeps its own path.

Focused `AssistantSessionComposer.test.tsx` covers selection, cancellation, IME/paste, mobile touch, query failure/retry, runtime isolation, and bounded row/request counts. `AssistantConversationSurface.scroll.test.tsx` verifies plain-text reference admission, failed-send preservation, and same-ID retry. Physical-device keyboard geometry and live assistant tool execution require integration validation.

## English display naming

The feature's English navigation and Settings name is **Bots**; individual
contacts use **bot**. English actions, accessibility labels, notifications and
native share surfaces use the same terminology. Other locales and user-defined
contact names are unchanged. Internal `assistants` routes, translation keys,
types, native identifiers and stored data retain their existing names. Coding
Agent terminology and the generic chat `assistant` role are separate concepts.

## Generated avatars

Assistant faces use the locally bundled procedural avatar engine through
`AgentAvatar kind="assistant"` and `ProceduralAssistantAvatar`. This covers list,
header, transcript, Settings, navigation, recipient picker and native share PNG
handoff without changing coding-agent Bottts Neutral faces or application branding.
Names stay intact, including emoji. No third-party avatar API, image model, WebGL
or runtime network fetch is used. Pinned engine and data files, including
the optional geometry callback patch, live in `lib/assistant-avatar/vendor/`.

`lib/assistant-avatar/recipe.ts` owns deterministic seed resolution, whitelist
validation, nineteen shapes, twelve fixed artwork pigment identifiers and the saved animation
switch. Legacy eye/expression fields remain valid in stored recipes but no longer
choose the rendered rest-eye specification. Fixed pigments are artwork, not UI
theme/status colors. A versioned recipe fits the existing opaque, maximum-256-char
`avatarSeed` field: `yuri-avatar:v1:<shape>:<eyes>:<color>:<expression>:<0|1>:<nonce>`.
No SQLite migration, extra settings store or network request is required. Existing
IDs/random seeds remain deterministic; malformed/future recipes are treated as
opaque seeds, never executable config or URLs. Old UI builds preserve the string
but paint their old style until upgraded; restoring a saved seed on a new client
restores the configured face. `update_avatar` still randomizes/restores this string.
The recipe module is pure and imports no rendering engine or animation data;
server-side default seed creation does not initialize geometry, trails or scenes.

The original seven-shape/six-color opaque-seed mapping is frozen separately from picker
order: adding/reordering choices does not reassign contacts. Explicit v1 recipes
retain their shape selection; the new renderer intentionally replaces the artwork.
`catalog.ts` owns the nineteen-shape whitelist. `geometry.ts` independently fills
the upstream player's missing non-sphere branch following the article's pipeline:
normalized outline -> solid convex envelope / beveled extrusion / loft mesh ->
quaternion projection -> silhouette -> front or curved surface eye seat. Convex
hulls are used only for solid bodies; extrusion/loft silhouette edges feed the
reference radial union so concave valleys survive. Mesh topology and radial
profiles are lazy, finite, per-shape data, never identity-keyed or built per frame.
Only vertices on the front/back silhouette boundary are projected, not every
interior mesh vertex. Compact single-body frames without an active morph bypass
cross-body outline mixing and angle sorting: solid hulls retain their vertices,
while concave bodies use the reference 192 base rays. Full-size, morph and
cross-body frames retain the general reference builder; static exports retain
its full detail. Compact sample points are tested against that builder.
Cloud/superellipse/rounded-polygon formulas follow the article; missing contour
functions (including heart/shield/leaf/drop) are independently authored. This is
not a claim of original-app frame equivalence for non-sphere bodies. There is no
fallback that silently turns an unsupported body into a sphere.

New Bot drafts use `createDefaultAssistantAvatarSeed`: round body, capsule eyes,
neutral rest pose and animation enabled; only pigment and nonce vary. The server
applies the same complete v1 recipe when create omits `avatarSeed`, covering API,
tool and first-run creation without migrating existing identities. Explicit
customizations still win.

The twelve-color pool mixes the unchanged mint, iris, coral, sky, sand and graphite
artwork with orange, jade, blue, violet, rose and cyan. New defaults and explicit
randomization can choose every pigment. `createRandomAssistantAvatarSeed` persists
the selected color in a complete v1 recipe instead of a fresh opaque UUID, so
expanding the pool does not reassign any saved opaque seed. Randomization retains
the existing seven-shape random distribution; the shape picker is unchanged.
The compact color picker uses two six-column rows on desktop and mobile. All
pigments share the same static/live/native-PNG paint path and existing graphite
eye-contrast policy. These pigments are avatar artwork, not UI/status theme tokens.

The reference neutral eye descriptors (`wid: .13`, `tilt: 0`), eye basis, mirror
flags and base head quaternion are used without screen-space angle overrides.
Sphere rendering follows the reference spherical mapping / horizon clipping
pipeline. Non-sphere contours sample that same descriptor and use the reference
shape metrics to seat it on the front/curved surface before the shared quaternion
projection; surface normals clip back-facing portions. Body clipping/masking
prevents detached eyes. No eye dimensions, angles or expressions are randomized
per Bot. Stored eye/expression fields remain round-trippable but do not select
different rest eyes. Static/rest always uses the reference neutral settle sequence
(pause, seek zero, sixty .1-second steps), and the original eye data is unmodified.
Light pigments use the source cutout mode. Graphite uses the source painted-eye
mode with a fixed light artwork pigment, preserving contrast on dark surfaces.
Its eye paths/projection are identical; non-sphere painted eyes are clipped to
the body. Static SVG, live SVG and PNG use the same pigment policy.

`engine.ts` owns a fixed per-shape artboard derived from the projected rest model,
not browser measurement. The longest rest dimension fills 94% of the slot.
Static SVG/native PNG, live SVG and reduced-motion poses use that same viewBox at
every display size. During an excursion the entire posed scene is uniformly fit
only if necessary to stay inside the slot; eye proportions are never fit separately.
Bounds come from model coordinates (including the thinking discs), not per-frame
DOM measurements or SVG path parsing. Rest models/artboards have at most nineteen
entries each (at most two paint variants per rest model), independent of seeds
and runtime identity. No extra rounded CSS mask
clips the leaf, working wrapper or Settings avatar instances.

The picker offers sixteen shapes through `AVATAR_PICKER_SHAPES`; tall, compact
and large are retired from selection only. The nineteen-shape recipe whitelist,
legacy-seed mapping and renderer still support those stored identities. Editing
color or other preferences never silently replaces a retired shape.

`AssistantAvatarEditor` previews changes in the existing Settings draft. Save uses
the ordinary revision-checked Assistant mutation; failed saves retain the draft,
and leaving discards unsaved changes. Its compact visual picker shows one live
shape thumbnails, pigment swatches and a compact labelled randomize button, without a visible title, Reset or separate
preview stage. The existing contact header shows the selected face. Shape targets
use 44px mobile targets (36px on desktop, 32px artwork), in four mobile columns
or eight desktop columns. Mobile has wider tile gaps, larger symmetric inner
padding and a larger randomize label/icon; desktop stays compact. Randomize is absolutely positioned in the card's top-right padding as a
muted small icon/text button; it reserves no row height. The picker has symmetric
vertical padding. This replaces the hidden header-avatar
overlay, and only changes the draft until Save. Shape/color edits preserve any existing hidden eye, rest-expression and
motion preferences.

Name, enabled state and model selection share the first configuration card.
There is no manual default-share switch or corresponding Settings search entry.
Share catalogs mark the first enabled contact in authoritative snapshot order as
their default, ignoring the retired client preference; disabling/deleting it
promotes the next eligible entry. Empty/all-disabled catalogs have no target.
No nonfunctional generation/upload tabs are shown. These selected-entity controls
are deliberately not indexed in Settings search.

Live list/header/contact faces, including settled transcript rows and empty/error
states, receive idle or working motion from the same existing live working
authority, never from persisted message status. Peer faces follow their own
sender's live authority. Inactive contact surfaces, standalone historical faces,
pickers and PNG exports remain static; navigation has its own ambient mode below. Live SVGs use the
source attribute-diff renderer, mask/clipPath skeleton and decoration-node pool,
without React state updates per frame. `lib/assistant-avatar/runtime.ts` owns the
player, SVG, pointer lease and subscriptions behind mount/update/hover/dispose;
the React leaf only supplies live eligibility and semantic state. The runtime owns
an isolated DOM subtree and instance-unique definition IDs; React owns only the mounting leaf. Global button
SVG styles must preserve rect fills inside `defs`: the white mask
background is functional geometry, not an icon background to clear. This applies
to desktop list buttons and mobile contact cards as well as plain headers.
Ordinary idle faces hold the reference static up-right pose without continuous
animation or mouse gaze. They allocate no player, pointer lease or frame callback
until hover; its bounded resting player is released after restoring the exact
static pose. Work completion also returns to that pose and releases live work.
The player and state machine persist through continuous non-idle motion changes,
so those transitions use the source bridge/springs. Only intersecting,
foreground, motion-enabled faces subscribe to Motion's shared read/render pipeline
with a 30fps geometry cap; offscreen,
hidden-document, reduced-motion and unmounted faces release it and paint a stable
rest pose. Visibility resumes create a bounded player without replaying background
time. Working wrappers and the legacy `animated` prop select the source `working`
state (Working_A–F, looking around), not the three-dot `thinking` morph. Explicit
idle/thinking/happy states remain available independently. Display sizes below
48px select the source compact clips;
resizing updates that mode on the same state machine, not the viewBox or eye size.
The saved motion-off switch bypasses live observers altogether. At rest,
all static faces share the existing 128-entry / 1 MiB artwork LRU.

During non-idle work and ambient navigation, mouse gaze follows the pointer
anywhere in the avatar's owning window, using
the source width-based/upwards-y mapping. `pointerTracker.ts` owns one shared
pointer sample and one listener per event type (pointermove, window leave, blur)
per window, acquired only by active live faces. Mouse events only replace that
sample; they do not measure DOM, render React or schedule additional frames.
Touch/pen movement, leaving the window and blur clear the sample. The last active
face releasing it removes all listeners and discards the sample. Ordinary idle,
standalone
historical, picker, native-PNG and saved motion-off faces never acquire it.

The shared clock measures all active face rectangles before any SVG writes,
only when a mouse sample exists. This preserves gaze after scrolling/layout moves
without a long-lived geometry cache, per-event layout reads or read/write
interleaving. At twenty visible faces the upper bound is twenty rectangle reads
per paint (600/second at 30Hz), regardless of pointer-event frequency. Unchanged
gaze vectors do not call the runtime again.

Mouse hover triggers one .65-second whole-avatar shrink/rebound (down to 82%,
then up to 104% where containment permits), with a smooth-envelope sway of the
complete head quaternion composed after the ongoing runtime pose. Scale is
applied to the complete SVG scene after fitting so the fit cannot cancel the
shrink; rebound is capped at the available bounds. It does not rotate
individual eye descriptors, restart working clips, create timers or stack an
unbounded poke queue. Re-entry during the sway is ignored; completion returns
exactly to the continuing live pose, or the reference static pose for idle faces.
Touch, offscreen and reduced-motion faces
do not trigger it.

Desktop contact rows and mobile contact cards pass their button ref as
`hoverTarget` through `AssistantWorkingAvatar`/`AgentAvatar` to the live leaf.
One native `pointerenter` listener on that target covers the name, preview and
empty card area. Crossing descendants (including entering the face after text)
does not retrigger it. Standalone live faces default to their own host. The leaf
owns listener cleanup with visibility/motion and target changes; standalone historical and
motion-off faces attach none. No hover state, parent rerender, extra timer or
per-pointermove work is introduced.

Performance contract: 20 visible live faces share one pair of Motion read/render
callbacks at up to 30 paints/second each; ordinary idle faces outside hover and
static/standalone history faces schedule zero work;
50 unrelated parent renders cause zero observer rebinds or frame writes. Live
faces do not serialize an unused static SVG URI. Focused recipe, frame-clock and
mounted-component tests guard this. `bun run test:avatar-performance` is a separate,
serial production-Chromium gate with p95 CPU ceilings of 4ms (one ambient face),
8ms (20 idle) and 10ms (20 working), plus actual lifecycle/React/pointer checks.
See `lib/assistant-avatar/DOCUMENTATION.md` for the reusable interface and exact
measurement limits. The isolated production-component lab and browser evidence
remain documented in `scripts/experiments/assistant-avatar/README.md`.
Native PNG generation reuses the same static recipe; actual device share-sheet
painting, Electron/VS Code and Capacitor runtime acceptance are separate validation.

The Settings refresh icon appears at the avatar's bottom-right on hover or
keyboard focus (always available on touch) and generates a new `avatarSeed` in the local draft only.
Its compact circular badge uses the Settings avatar-action white background and
black foreground tokens on both desktop and mobile; the full avatar remains the touch target.
Mobile Settings hosts provide a navigation action container: the editor portals
its save action there using the same glass/check control as Scheduled Tasks,
including pending-state disabling and a spinner. Desktop keeps the footer save action.
Save persists it through the existing revision-checked mutation; leaving without
saving preserves the stored face. All contact avatar surfaces and native share
PNG handoffs use this seed, falling back to the assistant ID for older servers.
Working subscriptions remain keyed by assistant ID, independently of the seed.
This selected-entity action is intentionally absent from Settings search.

## Contact message time separators

The contact transcript inserts a centered, muted timestamp before the first visible message, after a gap greater than five minutes, and across local calendar days. Timestamps use message `createdAt` and the viewer's local timezone: today plus 24-hour time, localized month/day for earlier dates, and the year for other years. Labels refresh on the next render after a local day change; no timer or extra request is introduced. One linear pass compares visible rows; internal settle-only records and empty processing previews do not consume boundaries. Cards, attachments, and errors participate. Prepending history recomputes boundaries from loaded rows, preserving message DOM anchors and the existing auto-follow owner. A separator also restarts the assistant avatar grouping.

## Homepage message previews

Mobile catalog cards retain the shared soft touch press-grow feedback. Their
swipe shell uses `overflow-clip`, never `overflow-hidden` (which mobile-pointer
rewrites into a vertical scrollport). The foreground still grows while pressed
without introducing a nested scrollbar; horizontal swipe actions and the
independent mouse-only avatar hover rebound remain intact. The existing soft
feedback marker also enables native tap haptics. The catalog/page owns scrolling.
`assistantMessagePreview.chrome.test.ts` loads production CSS and source-derived
card classes/feedback to guard touch press, clipping, swipe and long-list scroll.

Assistant avatar frames have transparent backgrounds; desktop selection keeps
the existing elevated row background. `AssistantContactStatus` owns
the desktop and mobile header subtitle: live local/snapshot work displays the
localized typing label; otherwise it shows the timestamp from the authoritative
`latestMessagePreview.createdAt`, falling back to a passive projection of the
runtime-scoped contact cache for older snapshots. Only a complete, gap-free empty
cache displays no contact; unknown and failed reads retain loading/error states.
It subscribes only to that Assistant's live working entry and contact cache,
introduces no history request or timer, and never derives activity from timestamps.

Desktop sidebar rows and mobile catalog cards share `getAssistantMessagePreview` and `ASSISTANT_MESSAGE_PREVIEW_CLASS`: one title line plus one muted preview line, truncated with an ellipsis. A 44px softly rounded square avatar matches the combined title/preview height; the desktop conversation header uses a 40px face matching its two text lines. `AssistantDTO.latestMessagePreview` comes from the runtime-scoped snapshot and all Assistant mutation responses. The server selects the latest visible user/assistant message by its authoritative ordinal (peer messages map to user); internal tool content stays server-filtered. The UI displays nonempty text after whitespace normalization, including supplied filenames/card titles. Empty text uses the existing image/file/session/assistant/schedule locale label; null or a legacy missing field uses `assistants.contact.empty`. The parser normalizes missing fields to null. Configuration `defaultPrompt` stays in Settings.

Preview freshness follows the existing snapshot revision/events, foreground reconcile, and focus/reconnect query path. List rows add zero history requests, transcript-cache reads, or message subscriptions. Creation, selection, avatars, working dots, and context/long-press edit/delete ownership remain unchanged.

## Shared unread and read visibility

Desktop and mobile mark-all-read use the shared double-check icon action in the catalog header, immediately before the add button. Desktop uses a ghost icon button; mobile uses the shared glass icon button. The translated action remains available through its accessible label and title, not visible text or a separate row. When unread reaches zero the compact button is disabled and hidden with `visibility: hidden`, retaining its horizontal space so read updates do not shift the header or list.

`AssistantDTO.unreadCount`, `readWatermark`, and `readTip` come from the server snapshot. The shared watermark is scoped to the Assistant on that runtime and persists across clients. Legacy DTOs with missing fields normalize to zero/null. Desktop list rows and mobile catalog cards display `AssistantUnreadBadge`; the sidebar and mobile dock share a Query-selected catalog total (`useAssistantUnreadTotal` / `selectAssistantUnreadTotal` over the snapshot — no extra request). Positive counts display through `99`, larger counts display `99+`, and zero hides the badge. The selected assistant root tab still shows the dock total; only authoritative read/mark-all clears it. Web, Android, and hosted-mobile paint `AssistantNavigationUnreadBadge` on the floating dock icon with overflow-visible so the bubble is not clipped; native iOS still receives the same total via the dock bridge. A loading badge replaces that unread bubble only when the catalog unread total is zero and an assistant is working. The scheduled tab uses the same loading badge while a task is `running`; it has no unread count. Native iOS receives that mark as `activity` (spinner badge plus `activityLabel`) and never combines it with `badge`. Badge colors pair the solid status-info fill with status-info-foreground text and a subtle foreground-derived inset outline for light/dark legibility. All ten dictionaries own the unread label, mark-all action and partial-failure message.

Automatic reading uses `getLoadedAssistantReadPosition` and `AssistantReadMarker`. The cursor comes from the latest loaded, persisted, renderable complete/error message, with the contact page's generation. A newer snapshot tip may remain ahead of that row. Internal settle-only rows, empty text rows, and streaming/optimistic previews stay outside this selection (visible-part filter is per-part: settle beside body/file/card still qualifies). Read/already-read fencing and transcript merge use the full keyset `(ordinal, messageID)` with SQLite BINARY-equivalent string order — not `localeCompare`. The current snapshot supplies the generation fence and shared read watermark. The surface mounts one marker only while active, Settings is closed, and the loaded transcript is gap-free. Historical OpenCode history surfaces have no marker.

The marker requires a visible document, focused web/Electron/VS Code window or Capacitor's `yuri-native-app-active` lifecycle class, a fully intersecting row-end marker within the scroller and visual viewport, and the transcript's true bottom (2px tolerance). Inert/aria-hidden underlays and runtime-generation changes block reporting. Reading older scroll positions preserves unread state. Focus, visibility, native lifecycle, scroll and viewport resize re-check eligibility; a single mounted-marker timer retries failures after 15 seconds. A successful position is reported once per marker lifetime. Unmount releases browser observers, listeners and the retry timer. Contact polling and list badges introduce zero per-assistant history fetches.

`markAssistantContactRead` sends the exact `{ generation, ordinal, messageID }` through `runtimeFetch` to `POST /api/yuri/assistants/:id/contact/read`, with a 15-second timeout and runtime fencing. Authoritative complete snapshot GETs own count reconciliation after both success and failure; failed GETs preserve prior counts. The shared Assistant revision subscription is reference-counted per transport. Other-client reads converge through `assistants-changed`, focus/reconnect and the existing foreground reconcile interval.

Desktop and mobile catalogs keep `AssistantMarkAllReadButton` mounted in compact header mode. Empty catalogs, zero counts, and legacy missing counts hide the action; positive unread counts with missing read tips keep it visible and disabled until an actionable target exists. Component-owned pending and flight state survives unread → zero → unread transitions, keeping a single batch active until its promise settles. It freezes each target's click-time tip, runs at most four independent requests concurrently, and collects all failures. Successful targets stay committed on the server and refresh independently of failed targets. The action stays disabled during its flight, then exposes a translated error for partial failure and permits retry. New arrivals after the captured tip remain unread.

The UI native-iOS bridge includes nullable `badge` values and a boolean `activity` flag, and compares both when updating the dock. The Swift plugin in `packages/mobile` currently parses id/title only; its badge parsing and `UITabBarItem.badgeValue` rendering remain a native-owner integration task. Web, Android and hosted-mobile docks render the shared badge directly. UI tests verify bridge delivery and clearing; physical-device native painting remains separate validation.

Focused coverage: `queries/assistantUnread.test.tsx`, `AssistantUnread.test.tsx`, the visibility-gate case in `AssistantConversationSurface.scroll.test.tsx`, `mobile/useNativeIosTabBar.unread.test.tsx`, and `lib/native-ios-tab-bar.test.ts`. These cover server DTO fixtures, loaded-row versus newer-tip races, generation fencing, background/history/underlay guards, cooldown retries, shared GET subscriptions, cross-client changes, retained counts on failed GET, batch partial failure, runtime-stale completions, badge capping/zero hiding, and native bridge forwarding.

The web-painted mobile dock overrides the shared badge chrome with an inverse surface foreground/background pair, bold 11px digits and a 2px background ring. It sits beyond the icon's right edge with a 2px gap; multi-digit counts grow outward while the icon stays centered. Catalog and desktop badges retain their shared info styling.

## Acceptance criteria

Contact progress consists of model-authored natural-language messages delivered through
the existing bubble SSE and persisted history. Explicit public message records arrive
while the model and tools are still running; stable message IDs reconcile them without
turn-end duplication. The UI adds no tool log, timer narration, or progress widget.
Failed-turn previews render as centered, muted 11px `role=alert`
feedback, separately from assistant avatars and speech bubbles.
Only errors after the latest visible message show this error feedback: a newer user,
assistant, or peer message (including a live preview) dismisses earlier errors.
Errors arrive only through live turn-end events; the server does not persist error
messages and deletes legacy error rows and parts on startup. Reload does not recover
errors from history. Temporary previews retain their message anchor. Tool confirmation text remains
model input; the model supplies the visible result summary, including settings saves.

The Assistant conversation is a Grok-like **contact**, not an OpenCode coding agent. Primary Chat still owns LegendList / Activity / tools. Assistant must not wrap `ChatContainer` as its transcript. Server-side contact turns may run pi `read` / `write` / `edit` / `bash` in the assistant workspace and load merged `.agents`/`.claude` skills; the contact UI still does not render tool traces. Contact bubbles wrap unbreakable tokens (`overflow-wrap: anywhere`); the transcript scroller is `overflow-x-hidden` so a long path cannot grow the page sideways.

**Session cards (this PR)**

- Cards are first-class in-transcript UI (`type: 'card'`, `cardType` `session` | `assistant` | `schedule`), not markdown links and not Activity/tool rows.
- A session card is a compact cover: short title, one metadata line (project / model / branch), status chip (`Working` / `完成` / `失败` / `需要你`), and non-zero live change counts (`summary.additions` / `deletions` / `files`). `+0 −0` and other all-zero summaries stay off. Assistant/schedule covers hug content (`w-fit min-w-0 max-w-[min(100%,15rem)]`); session covers may be wider (`max-w-[min(100%,20rem)]`) but are not a full-width strip — card width is capped by the parent transcript column. The whole softly elevated, inset-outlined cover is the hit target and opens the session through `openSessionWithFeedback` (phone: `openSession`; desktop: `setActiveMainTab('chat')` + `setCurrentSession` / `/session/$id`). No visible CTA button.
- Assigned-session finish/error/question (SSE, session-goal settle, or boot/60s poll of in-flight watches) updates **that same card**. complete/error also kicks a server contact-lane continuation so the Agent summarizes or re-assigns; the user sees that spoken summary, not canned 「会话已完成/会话失败」. Legacy transcript rows whose text is `yuri.settle.*` are **not rendered**. The UI does not invent a second status banner. The worker session stays visible in Chat.
- Cards persist in the Yuri-owned contact transcript (SQLite) and survive reload.
- Contact attach supports images and files via paperclip, paste, and drag-drop, up to 25 MiB each. On Android the paperclip opens the shared photos/files half-sheet (`MobileAttachPickSheet`) before the system picker; iOS, desktop, and other mobile surfaces open the file picker directly. Android Capacitor photos use the native media picker, with the image file input as fallback. New attachments retain their original File and local Blob preview through upload and message admission; PUT returns `{ type: 'file', attachmentID, sha256, size, mime, filename? }` for the contact DB. Upload/send retries reuse uploadID/messageID, and completed uploads are reused while retrying admission. Images render inline; named file chips expose a download action. Historical URL parts retain direct web/data/blob image compatibility through the shared image-source resolver with no workspace-path authority.
- The card slot is extensible. Later project / worktree / watch cards reuse `cardType`. Do not invent a second card system.
- Cards are **assistant-emitted UI** (Grok-Bot style: title, status chip, metadata). The whole card is the hit target. The user never types `/card`. Insert: `assign_session` / `create_assistant` / `schedule_task` auto-cards, and API `POST /api/yuri/assistants/:id/contact/cards` for harness/tests.
- Assistant cards open that contact (`openAssistant`). Schedule cards and Assistant Settings task rows use `openScheduledTask(projectID, taskID)` to open the exact task route/editor. Mobile uses the shared resizable sheet. Session cards still open the worker session.

**Inter-assistant DM (this PR, read-only)**

- Assistant A can deliver a message to assistant B by name or `assistantID`. Natural Chinese (`给 PeerQA 说一声 …`) calls the `message_assistant` contact tool, which uses `POST /:fromID/contact/dm` `{ toAssistantID, text, parts? }`. The user never types `/dm`.
- Delivery is **read-only coordination**: it inserts text (and later cards) into B’s Yuri contact transcript only. It must not call OpenCode `session.promptAsync`, mutate B’s sessions/files/worktrees, or run tools on B’s behalf.
- The user sees inbound peer rows in the contact UI, visually distinct from user and assistant turns (`role: 'peer'`).
- Peer rows persist in the same contact store as user/assistant bubbles and session cards.
- This is the inbox primitive. Assign opens a worker session on the sender contact turn and auto-inserts a session card — it must not go through this DM channel. Full summon-to-work and unsolicited user pushes stay out; when they land they must use cards + this DM path.

**Contact memory (this PR)**

- Natural language `开新对话` / “new conversation” / `清除记忆` / “clear chat” calls the `new_conversation` contact tool. That clears **LLM memory only** (server context boundary). The transcript UI keeps every prior bubble. It does not call OpenCode `session/new`.
- Explicit wipe phrasing: `清空/清除聊天记录` / “clear chat history” / “delete chat history” is a tool-selection hint for `clear_chat_history` (or intentional `POST …/contact/reset`). When the tool runs it keeps only the wipe user + later-queued user admissions; all other roles (including late prior-lane assistant/cards) are deleted. There is no separate user-text authorization gate and no silent/denied warning bubble — a successful wipe shows only the short confirm.
- The same turn persists only the short confirm bubble; leftover model text about pre-reset attachments or cards is discarded.
- Settings does not expose a continuous/stateless memory toggle. List cards omit provider/model badges; Settings detail still shows the bound model. New assistants stay continuous contact history; the server trims the LLM window behind the durable boundary. The contact surface has no compact / new-session chrome.

`GET /api/yuri/assistants/capability` still hides navigation when Assistants are disabled.

---

Assistant history entries require `{ sessionID, directory, info, parts }`, where `directory` is `string | null`. The UI retains the server `Message` and `Part` objects, validates entry/message/part session and message identity, renders paged history from oldest to newest, and opens historical sessions when their entry directory is known. Unknown legacy directories retain a null source context, which keeps workspace-dependent source and file actions unavailable.

Assistant face frames retain an 8px corner radius across list, header, Settings and transcript. Width/min/max and height/min/max stay fixed; `overflow: clip` contains the procedural SVG without mobile overflow rewrites introducing scrollbars. The transparent SVG uses a 432-unit viewBox crop around the character. Names are unchanged; faces derive from their saved recipe/seed or stable ID, independently of emoji in the name. List cards show a name and one latest-message preview line, with model identity confined to Settings detail.

The Assistant UI owns the current-runtime Assistant surface. Its product information architecture is an assistant list plus the selected assistant’s **contact** conversation. Desktop uses a flat Scheduled Tasks-style workspace with a soft left assistant list beside the conversation, elevated selected rows, and a light border between panes. Phone navigation makes that hierarchy explicit: the Assistant root tab is a content-height catalog where every Assistant owns an independent shared floating-surface card, and choosing a card opens its full-width conversation as the shared second-level mobile page. Assistant list cards reuse the Project card title typography token for names and keep the prompt as a clamped body line — no model badge on the catalog. The conversation header owns the selected Assistant identity and a quiet trailing Settings gear; desktop uses a breathable identity cluster and a subtle divider, while phone owns Back through the same overlay header. On the dedicated phone shell, the gear pushes `MobileAssistantSettingsPage` above the retained conversation through `pushAssistantSettings`. The route owns its Assistant ID and reuses `AssistantsSettingsPage`; the Settings root tab, global Settings selection, and open-request revision stay unchanged. Header, system, and gesture Back pop this detail through the shared mobile coordinator, revealing the mounted conversation and its draft. The covered conversation is inactive while the detail is open. Desktop and iPad keep `openAssistantSettings`; catalog editing keeps its existing Settings entry. Tapping the Settings tab always returns to the first-level list. On phone the header uses the same overlay `MobileDetailNavigation` fade as session chat, placing the translucent gradient above the scrolling transcript. The contact scroller owns matching top padding (`max(0.625rem, safe-top)` + `--yuri-mobile-detail-navigation-height` + `1.25rem`) so the first bubble can scroll fully above that overlay. Settings runtime selection is model-only — no Agent picker. The root tab owns vertical catalog scrolling and hides native scrollbar chrome, while the conversation owns only its transcript scroll. Each Assistant DTO carries `mode` (`continuous` | `stateless`), the current `sessionID`, `sessionGeneration`, a bounded compatibility `historySessionIDs` window, and `historySessionCount`.

Working status is a **10px green dot** (`size-2.5`) on the bottom-right of the assistant avatar **only in the outer assistant list** (`AssistantWorkingAvatar`, `data-assistant-working-dot`). The conversation header and transcript avatars never show it. The avatar and dot share a fixed-size relative wrapper so the marker cannot drift with flex/text baseline. **Server snapshot is authoritative:** `AssistantDTO.working` / `activeContactTurn` from TanStack snapshot HTTP recover list green dots after APP restart or reconnect. Spoken bubbles and cards that have already published live in `GET /contact/messages` (same ids as turn-end persist) so another device or remount sees them while the turn is still running. Local optimistic send and SSE token-level bubble-delta previews are temporary continuity only for the in-flight bubble and must not become the durable source. The 3-dot processing row seeds from `activeContactTurn` on remount and stays through partial spoken bubbles until a real turn settle. When snapshot is idle and its revision covers admission, local admitted/streaming overlays clear (missed SSE end recovery); a newer send or still-sending optimistic turn is never wiped by a stale idle snapshot. TanStack foreground-reconciles snapshot/contact on a fixed cadence (busy ~2.5s, idle ~15s; `refetchIntervalInBackground: false`) so missed SSE start/end/revision tips still converge without APP restart; focus/reconnect and tip invalidation remain. Green dots cannot stick after a missed end, and completed replies appear without relying on heartbeat-only streams. `admission_timeout` re-checks the original `messageID` instead of minting a new send; durable server error bubbles recover failed state without SSE. Failed turn overlays are ephemeral: a newer user turn, history wipe, or vanished turnID drops them so a timeout cannot trail into the next conversation. Local false idle must not cover server busy; a stale `contact-turn-end` for an older `turnID` must not wipe a newer turn. Assigned-session busy in Chat does not keep the list badge on. This is Grok-Bot contact language, not an OpenCode Activity banner.

`AssistantConversationSurface` is the contact transcript: short bubbles, first-class session cards, and inbound peer DMs. User text stays a compact softened-primary bubble; assistant text uses an unbordered `surface-muted` fill, generous line height, and relaxed padding so replies feel spoken against `bg-background`. Contact bubbles share `--text-markdown` (`typography-markdown`) so user and assistant body text are the same size; peer keeps a quiet dashed muted bubble. Assistant and peer text render through the shared `MarkdownRenderer` (markstream-react by default, marked fallback). User bubbles stay plain text. Internal `yuri.settle.*` markers are skipped (not shown as plain-text notices). File-reference underlines stay off — this is spoken contact, not Chat. It does **not** host `ChatContainer`, Activity, tools, or thinking. Assign tool results appear as those same bubbles/cards, not OpenCode Activity. The composer reuses the shared `ChatPromptComposer` / `ChatComposerSurface` shell in `layout="inline"` — one compact ~48px idle row with paperclip on the left, a textarea that keeps a 48px idle rail and always measures soft-wrap or explicit-newline `scrollHeight` (`min-h-12`, `py-3`, `leading-6`, `max-h-32`), and Chat’s filled `SendCircleIcon` (`data-composer-send`, `bg-foreground`) on the right in ready / muted-empty / spinning-busy states. No empty footer band. Visual wrapping grows the pill up to `max-h-32`, then enables textarea scrolling; measured multiline height bottom-aligns the fixed 48px paperclip and send rails. Still a message box only: no `ChatInput`, slash commands, model/agent picker, or `/card` / `/dm`. Attach (paperclip + paste + drag-drop for images and files) is required and reuses `ChatPromptComposer` `onAddFiles`. Android paperclip opens the same photos/files half-sheet as primary chat before either picker. iOS and other non-Android surfaces open the file picker directly and must not show that sheet. Mobile applies `yuri-mobile-composer-surface` and `bottom-safe-area`; it does not copy the Chat pill-swap or `MobileFloatingSurface` catalog card. Composer send appends the user bubble (text + file previews) immediately and retains the draft and previews until upload and admission succeed. The pending composer and synchronous gate serialize submit; failure keeps the draft with Retry and reuses its original messageID/uploadIDs. Successful admission clears only the submitted draft and attachments, then owns a separate processing/streaming preview. The three-dot working marker stays after any spoken bubbles until that turn ends. The contact POST uses a 15s admission timeout and completes on the server’s `202` persistence acknowledgement. An admission timeout rechecks the original messageID before showing a failed user turn with `assistants.contact.timedOut`; structured server errors keep their supplied `error.message`. After admission, the authoritative user row reconciles independently from the turn preview keyed by that same `yuri_contact_*` turn ID. Consecutive Assistant rows sharing a `turnID` form one visual run: the first row owns the 28px avatar, later bubbles retain its indent, same-run gaps stay tight, and new turns open with substantially more vertical air. Processing is a small `surface-muted` typing pill beside that first avatar, using three staggered opacity pulses with reduced-motion support. A live streaming bubble carries a restrained pulsing caret while its real SSE delta text grows. Contact turn SSE streams real bubble deltas into local per-Assistant previews; completed bubbles remain visible while later bubble indexes begin, and the authoritative contact GET replaces previews after turn end. Delta events never act as revision watermarks and never invalidate the contact query individually. Settings still owns assistant create/edit/delete and model selection.

Markdown image/mermaid activation in contact bubbles matches session-body rendering: the surface passes `onShowPopup` into the shared `MarkdownRenderer` and hosts one lazy `ToolOutputDialog` image viewer (`useUIStore.setImagePreviewOpen` marks the global overlay). Activating a runtime-file image (absolute path / `file://`) opens the shared viewer, whose `useResolvedImageSource` streams it through the runtime API; on the marked fallback renderer the same prop also enables runtime-file image auto-load. Transcript attachment images (`AssistantContactAttachment`) share the same contract: inline images are focusable buttons that open the viewer with the leased display URL (legacy URL parts use their direct web/data/blob source). Switching assistants or unmounting the surface closes the viewer and releases the overlay flag. File-reference underlines remain off.

Standalone inline Markdown images have no bubble padding or painted bubble background on any platform, rather than the text bubble's 16px horizontal / 10px vertical padding. Detection is conservative: captions, multiple images and ambiguous syntax retain text spacing. `data-assistant-contact-media` scopes the shared image presentation: the decoded image keeps its intrinsic aspect ratio and the ordinary assistant bubble's 1.35rem radius, so rounded corners apply to the visible image rather than a letterboxed rectangle. Both Markdown renderers use this treatment. The transparent fixed-height frame still owns loading geometry; removing the backing does not move subsequent rows when bytes arrive.

Contact history starts with the query-owned latest 20 messages. The surface consumes `data.messages`, `fetchPreviousPage`, `hasPreviousPage`, `isFetchingPreviousPage`, `previousPageError`, `hasMessageGap`, `isFillingMessageGap`, and `retryMessageGap`. A quiet top button and upward gestures within 80px share one in-flight request; failed paging preserves rows and waits for explicit Retry. Gap recovery has a visible status and the same request gate. Initial loading and initial failure have accessible feedback and retry.

A fresh user send (not a same-ID retry) re-attaches bottom follow through `followLatest`, so the transcript scrolls to the new bubble even from a released reading position. Text-only sends clear the field immediately (iMessage behavior) and hand the text back on failure unless the user typed something new; sends with attachments keep their previews until admission.

The send transition (`contactSendFlight.ts`) uses Telegram-iOS `ChatMessageTransitionNode` text-input → bubble bezier parameters: 300ms; horizontal edges on `cubic-bezier(0.23, 1, 0.32, 1)`, bottom edge and height on `cubic-bezier(0.199, 0.011, 0.279, 0.910)`. One `aria-hidden` fixed overlay starts at the composer surface's exact frame and corner radii and morphs, bottom-anchored, into the bubble's frame and radii. Only the outer shell paints a background: its computed composer color transitions directly to the computed message color over 150ms, without overlapping translucent background layers. The typed text travels from the field's text origin (including its scroll offset) into the bubble while fading out over 100ms and the bubble text fades in over 80ms. The follow scroll uses the same vertical curve and duration (Telegram's `verticalListCurve`). The real bubble keeps its layout and is only `visibility: hidden`; its rectangle is re-read every frame so the overlay lands wherever the scroll owner moved it. The flown row skips the generic append fade. Voice, attachment, retry and reduced-motion sends do not morph. Deactivation, Assistant/runtime switches and unmount remove the overlay.

The three-dot status renders inside an assistant-style `surface-muted` bubble (36px tall) that scales in from its bottom-left; it stays absolutely positioned in the reserved 48px bottom padding.

Transcript message avatars and the typing bubble use 32px artwork in a shared 36px left gutter, with a 10px gap before message/status bubbles, without the list-only green dot. Avatar and dots share visibility and entry animation on desktop and mobile; the typing avatar does not add transcript height. Header and catalog avatar sizes are unchanged.

Desktop send flights start beside the typed text with a compact shell: target bubble width plus 32px, at least 120px and capped by the composer width. Mobile retains the full composer starting frame. Both land on the same measured target bubble.

Typing dots wait for both local send admission and the outgoing bubble's actual animation completion. Sending alone never activates dots; local processing or authoritative server work is still required. The flight completion callback also settles cancellation, and its UI gate is scoped to the runtime/contact. Reduced-motion and non-morph sends have no animation gate. This presentation gate does not delay requests or alter live working state.

Newly appended contact rows enter with a 180ms opacity/4px translation animation through Motion. Initial history, prepended pages, contact/runtime activation, and processing placeholders do not animate; stable message keys prevent streaming updates or persistence reconciliation from replaying entry. Reduced-motion preference disables entry animation. Animation never owns row height or scroll position; the existing auto-follow hook remains the sole scroll owner.

Assistant bubble React keys, part keys and Markdown renderer identity use runtime + assistant + turn + bubble index, so replacing a `:preview:*` message with its authoritative message preserves the mounted bubble and Markdown tree. Error rows retain their message identity. `data-message-id` and read acknowledgements continue to carry the actual message ID.

Transient state does not own transcript geometry. The content container always reserves 48px of bottom padding; one absolutely positioned three-dot status lives there during local processing/server work after the send/flight gate clears. Admitted preview rows stay in the domain model but are filtered from the rendered transcript before grouping/time separators. Sending labels are out of flow, and contact bubbles have no extra streaming-caret line. Working start/end, admission and streaming completion therefore do not insert/remove status-row height. No measured-height cache or monotonic min-height lock is used: primary text, images and cards retain natural layout.

The 1px read marker is absolutely positioned at the bottom of its relative bubble/error container. It still participates in intersection/read acknowledgement checks but never adds a flex gap or changes transcript height as the read cursor advances.

Snapshot and contact queries use `staleTime: 0` so reopening, focus/reconnect, and contact reactivation immediately revalidate instead of inheriting the global 30-second fresh-cache window. Activating a retained contact also invalidates its runtime's snapshot, sharing an in-flight snapshot GET without cancellation, since that observer may have stayed mounted. Published intermediate replies and `activeContactTurn` recover together without waiting for SSE or the next polling interval. Previous successful data remains visible if refresh fails; existing foreground polling cadence and disabled-contact polling behavior are preserved.

Within the same generation, an authoritative latest page replaces cached server messages from its first keyset through the latest end; a complete page replaces the full set. This reconciles reset-confirmation replacements even when deleting turn outputs moves the server tip backward. Older history outside a partial page remains cached, and generation/revision fences preserve newer state against stale responses. Optimistic and streaming overlays stay owned by the contact surface.

Each message root has a stable `data-message-id`. `useAssistantContactAutoFollow` exclusively captures the first visible message and its viewport offset before prepend, restores synchronously in layout, and compensates asynchronous image/content growth through its resize observer. User scrolling updates that anchor; bottom follow retains its existing gesture, keyboard, and inactive-surface contracts. The Chrome fixture covers a 20→40 prepend and delayed image growth above the reading anchor with ≤2px tolerance.

The anchor records the `scrollTop` it was captured at. A restore subtracts the scroll movement since capture, so wheel/scrollbar input that already moved the row is never undone and growth landing in the same frame as a scroll is still compensated; the scroll handler restores before re-capturing so that growth cannot become the new baseline. While a finger is down the hook only re-captures: a write would cancel the native pan. Images cannot cause that growth: contact images use `LoadingImage`'s fixed-height `contentFrame` (see `../ui/DOCUMENTATION.md#image-loading`). Other late growth during a held touch stays uncompensated, a known gap.

Render keys must be unique per row. Text bubbles use `turnID:assistant:bubbleIndex` so a live preview hands its DOM to the authoritative row; cards, files and errors key by `messageID`, because the server reuses a turn's bubble index across a text bubble and its card. Duplicate keys make React reorder rows during a prepend, which reads as a viewport jump. `AssistantConversationSurface.scroll.test.tsx` fails on a duplicate-key warning.

After the first transcript positioning, bottom-follow growth uses one 220ms ease-out Motion animation, retargeted only when the bottom changes. Each frame updates the accepted scroll baseline; upward intent, pending native upward movement, pagination, deactivation, identity/node changes and unmount stop the animation. Initial history and reduced-motion mode position immediately. Reading-anchor compensation stays synchronous and never animates.

`AssistantContactAttachment` consumes the cache lane's display lease for images and verified Blob for explicit file downloads. Stable scalar descriptor identity keeps ordinary polling from reacquiring a display URL. Runtime/descriptor changes and unmount abort work and release leases; late completions release immediately. Desktop/Capacitor receive cache-owned `yuri-asset` display URLs, while web/VS Code receive Blob URLs. Loading, failure and retry reuse shared Button/theme primitives and translated copy. Native download handling remains owned by the runtime/browser download boundary.

Contact scroll ownership starts each active Assistant at the latest bubble, follows streaming plus asynchronous markdown/image growth while the user remains at the bottom, releases immediately on upward wheel/touch/key intent, and resumes after a downward user gesture reaches the true bottom. Released reading positions survive contact refetches and content resize. Inactive surfaces detach listeners and resize observation and perform zero scroll writes. The contact scroller matches primary chat geometry policy (`overflow-anchor: none`, `overscroll-behavior: contain`), requesting application-owned anchoring and contained scroll chaining in supporting engines. Shared Markdown code cards use `overflow-clip`; mobile compatibility opt-outs target the named legacy card shells. The [iOS overflow validation](../../styles/ios-overflow-validation.md) confirms static Safari CSS and gesture ownership. Full contact streaming, asynchronous image growth, and primary-chat virtualization remain application-level validation tasks.

Touch intent accumulates consecutive directional samples across small moves, resets accumulation on reversal or nested-scroll consumption, and checks vertical dominance. Every bottom-pin entry checks pending upward DOM movement against the last accepted scroll position before writing, including layout commits that precede native scroll delivery. That baseline resets on Assistant activation/identity or scroller-node changes; ordinary streaming commits preserve it. The comparison accounts for the current scroll-range maximum so content shrink and viewport expansion can clamp the browser while preserving follow. Released growth/refetch/resize and bottom no-op frames retain a zero-write budget.

Resume requires a positive native scroll-position delta plus current downward or mouse-scrollbar intent within the existing 2px bottom tolerance. Each touchstart clears the previous gesture's direction; eligible vertical touch samples update direction immediately, while cumulative upward intent retains its existing release threshold. A no-growth layout that releases a pending upward move consumes that position as its baseline, so delayed zero-delta scroll delivery preserves release through subsequent growth. Mouse scrollbar intent survives direction changes within its intent window, allowing the same drag to return downward to the bottom.

Pending capability or snapshot uses a spinner (`common.loading`), never `assistants.state.unavailable`. A `/assistant/$id` selection whose assistant is missing stays loading until the snapshot settles. Unavailable is only for error, unsupported, disabled, or a missing assistant after that success. The mobile catalog skeleton uses the same loading label.

Legacy OpenCode binding, share, and queued `promptAsync` paths remain server-side for share/queue. Assign uses `promptAsync` only on the dedicated worker session. They are not the user-visible contact thread.

`AssistantConversationSurface` previously hosted the shared `ChatContainer` shell. That path is retired for Assistant. It injects the Assistant session/directory, secondary `ChatInput` surface, embedded `SessionSurfaceContext`, and host `onRevertMessage` / continuous-only `onEditMessage` so message/timeline revert and sent-message edit restore into the Assistant draft partition (`surfaceDraftKey`). Continuous staged edits are owned by `assistantStagedMessageEdit.ts`, scoped by `transport + assistantID`, and serialized per scope for stage and best-effort rollback cleanup. `AssistantView` uses `stageExclusive` for continuous edit while primary `stagedMessageEdit` remains untouched. Staging retains an opaque CAS rollback handle for binding and runtime cleanup. Assistant send synchronously clears its staged marker and delivers the restored Composer content through the ordinary new-message path.

Revert success and successful `/new`/compact/shortcut-new intentionally clear the staged identity only (no pre-stage draft rollback): those paths are user-explicit history/binding replacements that already restore or replace the composer body through the existing command/revert consumption path; rolling back the pre-edit draft would fight that intentional replacement. Remote create/compact failure retains the stage. Stateless Assistants set `mutateSession: false` and omit `onEditMessage`, which removes edit/revert from message and timeline actions; continuous Assistants keep mutation. History segments stay read-only via source-scoped surfaces. Task and subagent rows use the same destinations as primary chat: desktop and iPad open the nested session in the right-hand `ContextPanel` (AssistantView mounts it with the assistant workspace directory), while phone, mobile web, and VS Code redirect into that session. Archived history rows keep nested navigation while remaining non-mutable. The surface also provides `openSourceSession`, so each Assistant reply can jump into its underlying OpenCode session in Chat for follow-up. On the dedicated mobile phone shell (Capacitor phone and hosted H5), that jump mounts chat through `useMobileNavigationStore.openSession` — the same secondary-route contract as scheduled-task history open — because `setActiveMainTab('chat')` alone does not mount the phone chat page. Desktop and iPad keep the main-tab + `setCurrentSession` path. The transcript uses the same MessageList / StatusRow / question-permission / timeline / auto-follow path as primary chat; Assistant does not keep a forked rendering tree. Assistant-only ownership stays in `AssistantView` (list, selection, binding, admission). `AssistantView` owns the complete secondary surface identity, scoped draft resources, scoped provider/model/agent/variant catalog (agents filtered via shared `chatComposerCatalog` / `filterVisibleAgents`), binding backend, command policy, activity, and shortcuts. Global Ctrl+X leader chords and agent-cycle hotkeys target the active mounted composer surface (`activeChatInputSurface`), not the primary chat tab alone. Assistant drafts and attachments use a stable transport-scoped `surfaceDraftKey` partition per Assistant. Selection PATCHes use latest-wins serialization keyed by Assistant ID, transport identity, and runtime generation; identity activation establishes the authoritative caller identity, while stale enqueue and flush callers reject with `AssistantSelectionStaleError`. Each selection flight owns an `AbortController`; retirement, disposal, and identity activation abort its in-flight conflict refresh. The selection backend verifies that identity before conflict refreshes and retries, then verifies it again after every asynchronous refresh boundary. Identity changes reject active selection and flush waiters as stale and isolate the new selection flight. A provider or model change clears the variant. Selection PATCH busy must not disable the composer textarea — Tab agent cycling stays focus-stable like primary chat. Hosted secondary composers must not block send on a missing directory session-list entity: the Assistant binding is authoritative, and mobile share/new often rebinds before the managed-workspace index has the row. When the session is busy, follow-up “queue” only admits through the server-backed queue; legacy/frozen ownership falls back to steer so share-busy turns stay sendable. ChatInput flushes the selection before direct or queued delivery. Assistant commands retain standard custom and skill routing; fork, thread, and branch commands are unavailable. Assistant SQLite owns admitted message durability; OpenCode sync owns richer live message content and replaces the matching SQLite fallback.

The current availability policy is authoritative for staged send behavior: sent-message restoration is best-effort. Assistant send clears the staged marker and delivers the captured Composer content through the ordinary new-message path; restoration state never gates delivery. The registry has no commit-before-send operation.

An admitted composer send completes immediately while bounded background materialization retries refresh its returned binding. The stable-ID pending user row remains visible until the same message ID appears in authoritative live or Assistant history, an explicit send failure removes it, or the runtime/component lifecycle releases the local surface state. Runtime changes retire delayed refresh work and clear every pending Assistant row.

Current hosts always enable Assistants and seed one `Yuri` contact on the first snapshot when a connected model is available. Settings has no global enable switch or corresponding search target. Existing contacts are preserved, and deleting the last contact does not recreate it. Supported instances with an empty catalog (no configured model yet, or explicitly deleted contacts) show onboarding. The primary action opens Settings → Assistants, records a create intent, and focuses the assistant name field after the settings page mounts. Successful creation invalidates the Assistant snapshot; the still-mounted Assistant surface selects the new first assistant after Settings closes. Pending catalog reads stay on the loading spinner. Unsupported, legacy-host disabled, transport-error, stale-data, assistant-disabled, and invalid-model states remain distinct from that spinner.

On native iOS and Android only, the first supported, enabled Assistant-page visit shows `AssistantShareWelcome`. It is dismissed per device with `yuri:assistant-share-welcome:v1`; the dialog explains the iOS Share Sheet, Android Direct Share, and selecting an Assistant target that receives shared content in its Inbox Topic. Settings can reopen the same dialog from the Assistants sidebar “Learn more” / “查看更多” control on any surface. On iOS, an admitted Assistant composer send donates an `INSendMessageIntent` through the native share bridge with identity and generated avatar metadata only; message content stays out of the donation. Share Extension submissions perform the same donation inside the extension, and suggested-recipient launches route by the donated `conversationIdentifier`.

`queries/assistantQueries.ts` is the current-instance HTTP and TanStack Query boundary. Snapshot and capability keys begin with the active runtime transport identity. `fetchAssistantSnapshot(signal)` performs an abortable direct snapshot read for stale selection-conflict recovery; it parses the route response without Query cache writes or retries. Ensure and new return `SessionBinding`; compact returns `{ binding, summarized: true }`; messages return `{ binding, messageID, admitted: true }`. Snapshot hooks listen to the shared `yuri:assistants-changed` revision tip and invalidate only their exact runtime snapshot; returned bindings older than the cached Assistant generation are ignored. Assistant history uses a transport-, Assistant-, and binding-scoped `useInfiniteQuery` over `GET assistants/:id/messages?before=&limit=`. Both the history `queryFn` and `ensureAssistantSession` capture transport identity and runtime generation first, wait for `waitForSessionStartupBarrier()` before any network request, then re-assert that the captured identity is still current so a barrier-held boot cannot silently rewrite the flight onto another runtime. The surface reads one persisted history page initially, retains each server `Message`/`Part` plus its source session ID, inserts the existing session dividers before the current binding, and merges current-session SQLite rows with live messages by stable message ID. Timeline loading exhausts the live session sync page first, then requests the next Assistant history page only after live pagination is complete. History host `loading` is initial/next-page fetch only (not background refetch); `complete` is true when there is no next page or the history query has errored so load-older cannot spin forever. When assistant-owned history rows are already rendered, a live-session prefetch failure must not replace the transcript with the chat history load-failure wall. A share operation carries top-level `sessionID` and `messageID` plus its persisted state, phase, attempt, lease, and error fields. It polls `share-operations/:operationID` with its captured runtime identity and generation; only `completed` settles delivery, while `failed` and `unresolved` retain structured errors. A consumer that needs a completed share binding reads a fresh Assistant snapshot or calls ensure. `AssistantView` calls ensure only while the active Assistant has no authoritative snapshot binding; an existing binding proceeds directly to session materialization. Assistant activity and streaming presentation derive from the scoped standard OpenCode sync state after HTTP admission. Ordinary message admission uses a soft `ensureSessionRenderable` so the transcript updates in place from live sync; force rematerialization is reserved for `/new`, compact, and explicit retry. Full-body loading only covers cold empty transcripts, never a background refresh of an already-rendered conversation.

`stores/useAssistantUIStore.ts` owns current-runtime assistant selection, the transient Settings create-request revision, the client-global default share identity (`serverInstanceID + assistantID`), and persisted complete Assistant catalog partitions keyed by connection key. Persisted selection stores only the assistant ID. `MobileShareBridge` validates share targets after runtime switches, reads a fresh Assistant DTO, dispatches by assistant ID, and opens that assistant. Generic Android shares remain unassigned in native durable storage until the full-screen in-app recipient page assigns an enabled Assistant from the persisted catalog; this selector is a complete page using the shared `MobileDetailNavigation` secondary-page treatment, not a bottom sheet or a locally recreated bordered header. Android Direct Share retains its native exact target and bypasses the picker. Android share-draft handoff journals its exact assigned runtime target through `materializing`, `materialized`, and `cancelled`; a durable draft snapshot includes a stable synthetic receipt marker, cancellation retains the journal, successful target navigation finalizes it, and marker removal preserves existing attachment views in the Composer. Its durable outbox assigns each native share operation one OpenCode-compatible `msg_` message ID before network work; retry, resume, and WebView restoration reuse that ID, while `operationID` remains the native UUID.

Settings uses the standard split-page shell, background, border, spacing, sidebar layout, list rows, and semantic selection state shared by Agents, Providers, and Projects. Its Settings-only selection stays transient. Existing Assistant details include compact scheduled-task rows sourced from the Assistant mapping route. While that route is unavailable, contact transcript schedule cards join against the live global scheduled-task catalog; mapping and partial-project failures stay visible with Retry, and cached rows remain available. Selecting a row opens the shared Scheduled Tasks surface. New assistants default to the managed workspace (`workspacePath: null`); registered project options come from `useProjectsStore` and save their canonical paths. A removed project referenced by an existing assistant remains visible as a read-only current-path option until the user chooses a registered or managed workspace. Workspace changes are saved through the Assistant update route, where the server creates and binds the replacement session. Assistant UI contracts and mutation drafts carry no skill-root field.

Focused tests verify desktop and mobile menu order, independent scheduled-task visibility, empty-catalog Settings routing and create-field focus, phone catalog-to-conversation navigation, split Settings structure and responsive workspace selection, removal of topic and skill-root UI, semantic Assistant theme tokens, Assistant secondary surface isolation, and shared `ChatContainer` host / `ChatInput` consumption. Keep standard chat behavior unchanged when extending these shared surfaces.

A persisted session card status `cancelled` denotes a user-interrupted watch. It displays the localized cancelled label and takes precedence over trailing live idle/busy events; only an explicitly rearmed watch changes it.


The contact composer exposes the existing stop control while a contact turn is processing or the server reports working, including during a pending send. Pure sending keeps the existing input and attachment lock. It calls the Assistant abort endpoint with the current binding identity (including a null session ID for contact-only execution); no OpenCode binding must be created to stop a contact. Stop failures use the existing inline error surface. The control waits for authoritative end/idle instead of locally claiming the task stopped. Repeated clicks share one in-flight stop. While working, the textarea remains editable and Enter can submit a new message; upload/admission pending retains its existing input and attachment lock even while Stop is available.

Desktop and mobile contact lists share `sortAssistantContacts`: descending latest visible message `createdAt`, with stable source order for ties. Incoming and outgoing messages both advance interaction time, so a new sent message also ranks ahead of older unread messages. Unread state, unread volume, and configuration `updatedAt` do not rank contacts; marking read preserves the interaction order. Empty histories and legacy missing timestamps stay below timestamped contacts. Each list memoizes the bounded (at most 100 contacts) snapshot sort; no per-contact requests or token-frequency sorting are introduced. Settings catalog order is unchanged.

Navigation uses `useAssistantNavigationAvatar` to select an identity seed with the
same order among enabled contacts. Its narrow selector exposes only identity/seed;
work, unread counts and unrelated metadata do not restart the animator. React web,
Electron, VS Code and hosted/Capacitor web-dock navigation use an idle live face
with `randomizeShape`: every 4–7 seconds of active animation it chooses a different
shape from the sixteen picker shapes and blends through the existing body
spring. The most recently contacted Bot still supplies pigment and motion
preference; no stored recipe, individual contact face or new-Bot default changes.
Navigation eyes are opaque fixed artwork colors: pure white in the app's light
theme and pure black in its dark theme, never holes showing the dock/selection
behind them. Live animation, reduced motion and saved motion-off use the same
policy; ordinary contact faces and exported share thumbnails remain unchanged.
This ambient motion is not a work indicator. Empty/disabled catalogs restore the
default icon, and unread/activity badges retain their independent authority.

The cycle runs inside the existing bounded player advance and shared 30Hz clock,
not an interval or React update. Hidden/offscreen/reduced-motion faces stop and
paint their static identity; resume never replays missed changes. `size-full` on
the live SVG keeps Button's generic 16px icon rule from shrinking mobile artwork.
The native iOS dock is unchanged: `MobileTabsRoot` continues to send system tabs,
badges and activity, not per-frame SVGs. Its web fallback uses the ambient face.

Mobile web navigation keeps all icon slots at 23px with centered contents, preserving identical label baselines. The filled avatar artwork uses a centered 23px box with gentle 105% scaling (24.15px artwork box) to balance its visual weight against the outline icons; idle morphing and hover shrink/bounce remain unchanged. The default glyph, badges, and slot geometry do not scale. Native iOS retains its existing system icon slot. Verify painted bounds as well as box sizes.

Mobile contact cards expose Edit/Delete by left swipe, using the same `useMobileSwipeActions` and `MobileSwipeActionRail` as homepage session rows. Long hold does not open a menu. Vertical gestures keep scrolling, a swipe suppresses navigation, tapping a revealed row closes it, and only one rail stays open across both surfaces. Actions close the rail and reuse existing Settings/delete-confirmation flows. Desktop context actions are unchanged.

The contact session mention composer uses the regular Chat Composer document/reference codecs and `ComposerTriggerIconMark` overlay for session chips. Its external draft remains queue-canonical `@session:<id>` (no inline JSON metadata); selected titles are local display data, while exact IDs survive insert/edit, atomic delete, undo/redo, copy, and cut. Clipboard references serialize canonically instead of losing identity as labels. Incoming canonical drafts materialize through the same shared session codec. Referenced transcripts are read through the assistant's bounded `read_session` tool; a mention alone does not authorize worker mutation.
