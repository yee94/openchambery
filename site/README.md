# Yuri landing page

Build both languages with `node build.mjs` from this directory. `src/index.template.html`
owns the page and `src/i18n.mjs` owns Chinese and English copy. Generated entrypoints
are `dist/index.html` and `dist/en/index.html`. Asset URLs carry content hashes to prevent
stale scripts and markup from being mixed. No dependencies or application runtime
are needed; serve `dist/` with any static server. Only referenced public resources
and vendor licenses are copied to `dist/`; source, tests and deployment state are
not published or committed as build output.

## Visual direction and sequence

The page is a continuous dark canvas, not a feature-card grid. Large, restrained
sans-serif typography accompanies the existing Yuri portrait, fine lines, signal
points, and waveforms. `assets/site.css` defines the static site's semantic surface,
interaction, selection, and primary-action tokens; it does not import React app
primitives or distribute Cursor assets or fonts. Brand masters are unchanged.

The sequence moves from overview to mechanism to usage and details:

1. Full-bleed portrait, Yuri wordmark, existing tagline, and one capability sentence.
2. A connection panorama: the device illustration recedes as real desktop and
   phone screenshots advance. On wide, tall viewports only, one 160svh section has
   a sticky stage. There is no wheel interception, snap, or scroll hijacking.
3. A tunnel-backed connection selector distinguishes LAN, encrypted relay, and
   desktop SSH, with real configuration screenshots and explicit runtime boundaries.
4. Assistant artwork leads into the real contact conversation and parallel-work notes.
5. A phone-centered scene offers assistant, swipe, voice, and schedule screenshots.
6. A full-width waveform leads into a desktop composer close-up.
7. Clickable theme previews, an expandable schedule screenshot, and source-run links.

Mobile has its own natural-flow composition: no sticky scenes, smaller bounded
phones, portrait artwork framing, and stacked controls. No content depends on an
entrance animation. With JavaScript unavailable, all primary screenshots and copy
remain visible, including the original device frames. Native `details` still works.
The selectors require JS; each defaults to a meaningful screenshot.

## Device and interaction contracts

The connection panorama uses a custom CSS laptop and overlapping phone, with
real screenshots inside. Device labels and the local illustration footnote are
omitted; the page footer retains the illustration disclosure.
The dedicated mobile feature scene uses the iPhone 14 Pro black subset of
[Devices.css](https://github.com/picturepan2/devices.css), under MIT. Its original
geometry remains in `assets/vendor/devices.css`, alongside the license. Build-time
device macros expand its markup. CSS includes exact width/428 fallback scales for
every responsive phone size; one ResizeObserver updates scale on resize, never on
scroll. Screenshots fit inside the screen below the illustrative status bar.

Selectors are semantic button groups with `aria-pressed`, visible focus, and arrow,
Home, and End keyboard support. Loading previews retain the last decoded image;
failed loads show translated retry guidance, and stale requests cannot replace a
newer selection. Mobile captions use a polite live region. Reduced
motion disables the sticky transition and smooth scrolling without removing any
content. Long English text uses normal document flow, not fixed text boxes.

Scroll performance budget: at most one requestAnimationFrame per scroll frame,
one bounded progress calculation, and one CSS-variable write only when progress
changes. Geometry is read on setup/resize, not per scroll. The phone observer is
independent. Outside the scene, clamped unchanged progress causes no style writes;
mobile and reduced-motion modes have no scroll listener. No timer, continuous
animation loop, or per-scroll screenshot switching is used.

## Download catalog

The header, hero and footer use the approved SVG wordmark. Inline icon symbols
are defined in `src/icons.mjs` (Simple Icons GitHub/Apple/Android paths, CC0-1.0).
`assets/downloads.mjs` exports a verified release snapshot for static HTML and
refreshes the catalog from public GitHub release assets in the browser. It uses
the same installer source as the auto-updater, not the stale repository update
manifest or OTA web bundles. Stable releases take priority; if none exist, the
latest prerelease is explicitly marked Beta. HTTP failures preserve the snapshot.
No missing installer URL is synthesized. iOS uses the configured public TestFlight
link from the update service; availability is controlled by App Store Connect.

Production CI runs `sync-downloads.mjs` with its GitHub token before building. It
replaces the marked snapshot in `assets/downloads.mjs` from published `v*` installer
assets and `TESTFLIGHT_PUBLIC_URL`; OTA archive releases are excluded. Missing
installers or failed catalog requests abort deployment and retain the existing
website. The generated snapshot is shared by static HTML and browser fallback,
so visitors do not need a working anonymous GitHub API request for current links.

UA Client Hints may refine architecture; iPadOS touch detection precedes desktop
classification. Unknown CPU architectures use the all-platform chooser, with
Apple Silicon explicitly required for the current macOS build. No UA data is
sent to the download service. Keep the verified fallback snapshot up to date on
releases; it is also the no-JavaScript and API-rate-limit path.

## Local verification

From the repository root:

```sh
bun run site:build
bun run site:check
bun run site:test
python3 -m http.server 8794 --directory site/dist
```

## CI/CD

`.github/workflows/site.yml` validates website pull requests. Changes to `site/`
on `main`, published releases, completion of the `Release` workflow, and manual workflow dispatch deploy the verified
revision to the existing Vercel website project. PR jobs never receive deployment
credentials. Production deploys are serialized, with live HTML, anchors and asset
hash checks after deployment. A release event checks out `main`, not the possibly
older application tag. This workflow does not publish application installers or
change the update service. `workflow_run` is required because releases published
with `GITHUB_TOKEN` do not trigger another workflow's `release` event. Completion
also refreshes installers when a later OTA job fails; only public releases enter
the catalog, and release-triggered builds always use the website on `main`.

Required GitHub settings:

- Secret `VERCEL_TOKEN`: existing Vercel deployment credential.
- Variables `SITE_VERCEL_ORG_ID`, `SITE_VERCEL_PROJECT_ID`: the website project,
  intentionally separate from update-service IDs.
- Variable `SITE_URL`: public production origin used by smoke verification.
- Variable `YURI_RELEASE_IDENTITIES_VERIFIED=true`: repository publishing gate.

The CLI deployment root is `site/`, build is `node build.mjs`, output is `dist`.
The workflow invokes the CLI from that directory; no local `.vercel/` is committed.
If using Vercel's Git integration instead, set its repository root to `site/` and
avoid enabling a second production deployment path alongside this workflow.
For rollback, revert the website commit on `main`, or redeploy a known-good
deployment in Vercel. Build artifacts and unused draft images are excluded from
the repository; keep approved brand masters in the repository's brand directory.

Download regressions: `bunx vitest run --config site/vitest.config.mjs` from
the repository root (OS/CPU detection, release selection, and fetch failure).

Run `node build.mjs`, `node --check assets/site.js`, and `node --check src/i18n.mjs`.
Inspect Chinese and English at 1440×900 and 390×844, plus a short desktop viewport.
Verify the connection's beginning/middle/end, all selectors (including keyboard),
schedule disclosure, locale links, image loading, hash-versioned resources, device
bounds, no horizontal overflow, no-JS, and reduced motion. A static site preview
does not exercise real pairing, relay, SSH, voice recognition, or task execution.
