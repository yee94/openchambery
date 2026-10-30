# GrokBot Animation Anatomy

[English](README.md) | [中文](README.zh-CN.md)

An interactive explainer dissecting the **GrokBot avatar animation engine** — how the Grok Bot macOS app (Electron) animates its avatar with zero animation libraries, and why its procedural-SVG approach beats Lottie, video/GIF, WebGL shaders and CSS animation for a living, interactive character.

<p align="center">
  <img src="docs/media/hero.gif" width="260" alt="GrokBot avatar idling — every frame computed at runtime">
  &nbsp;&nbsp;&nbsp;
  <img src="docs/media/states.gif" width="260" alt="State switching: idle → thinking → waiting → idle, with spring-driven decor">
</p>

The page practices what it preaches: **0 third-party runtime dependencies, 0 build step** — plain HTML + CSS + native ES modules, every demo computed live. The showcase bots (hero and sections 01/03/05/07/08) run `js/vendor/grok-player.js`, a faithful line-level port of the original engine, driven by `js/vendor/grok-recipes.json` (animation data extracted from the local app).

There's also an **[animation editor](https://grokbot.yin.wiki/editor.html)**: a clip/state editor built on the same engine — visual keyframe tracks (position / rotation / squash / scale / lids / expression), draggable keyframe diamonds, per-keyframe Bézier easing editor, state config (face / morph / next / holdSeconds), live preview in the real engine, and JSON export in the engine's native format.

<p align="center">
  <img src="docs/media/gallery.png" width="49%" alt="State gallery — all 53 states running live engine instances">
  <img src="docs/media/editor.png" width="49%" alt="Animation editor — timeline, keyframes, easing editor, live engine preview">
</p>
<p align="center">
  <img src="docs/media/clip-lab.png" width="49%" alt="Cubic-Bézier playground and live clip track inspector">
  <img src="docs/media/state-machine.png" width="49%" alt="State machine demo with transition-anatomy timeline">
</p>

## Live demo / Run

GitHub Pages: **https://grokbot.yin.wiki/**

Or run locally (ES modules require HTTP, don't open the file directly):

```bash
python3 -m http.server 8000
# open http://127.0.0.1:8000/
```

## What's inside

- **Every frame is computed** — procedural SVG + a DOM-diff writer, with a live attribute panel
- **Shape morph: radial outline interpolation** — 192 ray samples, per-angle lerp, sampling-density comparison
- **Choreography in Bézier: clip keyframes** — 28 hand-authored clips × 6 tracks, cubic-bezier easing with out-of-range overshoot; draggable-curve playground + a live track inspector synced to the running engine
- **Springs, not timers** — a 120 Hz semi-implicit Euler integrator playground vs ease-out
- **Where the springs live** — live measured curves of the amount / swap / spin spring trio during state switches
- **Pseudo-3D: the eyes live on a sphere** — Rodrigues rotation + orthographic projection, flat-vs-sphere comparison
- **Blinks & liveliness** — blinks are clip-embedded keyframe events (0.26 s, closed at 45%) + imperative `blink()`; no ambient scheduler exists in the original bundle
- **State machine & recipe shuffle** — 53 states, seeded-PRNG clip shuffle with random phase; plus a transition-anatomy timeline (Bézier bridge vs measured springs)
- **State gallery** — all 53 states running live engine instances on one page, filterable by the five lifecycle groups, click to poke
- **Head-to-head comparison** — procedural SVG vs Lottie vs video/GIF vs WebGL vs CSS, plus a decision wizard

## Repository layout

- `index.html` + `js/sections/` — the explainer page, one ES module per section
- `shapes.html` — the shape-system explainer
- `workshop.html` — the shape workshop (add-your-own-shape guide + playground)
- `editor.html` + `js/editor.js` — the animation editor
- `glow.html` + `js/glow.js` — Glow Lab: the pseudo-3D look comes from fill, not geometry
- `design-system/` — site-wide design tokens, components, shared shell and per-page CSS (zero build, hand-written)
- `js/vendor/grok-player.js` — line-level port of the original engine (browser ESM, zero deps)
- `js/vendor/grok-recipes.json` — animation data extracted from the app: 28 clips, 53 states, 9 expressions, 25 shapes, all constants
- `tools/verify-frame.mjs` — frame-by-frame numeric regression of the port against the original engine
- `tools/extract-recipes.mjs` — extraction script for the animation data
- `tools/capture/` — deterministic frame renderer used to produce the README GIFs
- `docs/media/` — README assets (every one captured from the running port, not hand-drawn)

## Source

All findings come from static analysis of the unpacked `app.asar` of Grok Bot (Electron, macOS), for study and research only. `js/vendor/grok-player.js` is a **re-written port** of the engine logic (line-level, frame-verified against the original); `js/vendor/grok-recipes.json` is **animation data extracted from the local app** (clip keyframes, state registry, expressions, constants). The underlying design and data remain the property of their original owners; this material is published for study only and will be taken down on request. Grok and x.ai trademarks belong to their owners.

See also: [bloub](https://github.com/jeremy-prt/bloub) — another independent recreation, measured frame-by-frame from video.

## License

MIT
