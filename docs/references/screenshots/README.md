# Product screenshots

The root READMEs, website and handbook reuse the approved, sanitized WebP assets
under `site/assets/shots/`. English interface captures use the `en-` prefix;
Chinese captures use the corresponding unprefixed filename.

- `home.webp` / `en-home.webp`: desktop project sessions and composer.
- `m-home.webp` / `en-m-home.webp`: mobile projects and sessions.
- `m-assistants.webp` / `en-m-assistants.webp`: assistant contacts.
- `m-schedule.webp` / `en-m-schedule.webp`: scheduled tasks.

## Cursor Dark capture set

The current set contains 12 scenes and four theme previews per language (32
lossless, sRGB WebP files). Main scenes use Cursor Dark: background `#1a1a1a`,
primary `#4c9df3`. Desktop captures are 1440×900, phone captures 390×844, and the
desktop recording close-up is 1970×674. Desktop sidebars use the actual
approved SVG wordmark at 48px wide, not a text approximation.

These are browser-rendered captures of the current application DOM and theme
styles. Before capture, script-free snapshots replace project/session names,
assistant messages, task names and device labels with neutral examples. They
retain the application's layout, icons and controls. Theme previews apply the
styles produced by the application's theme selector to the same localized scene.
Cursor is the first preview; the others are Tokyo Night, Vitesse and Nord.

The desktop voice images are explicit exceptions to the refreshed DOM snapshots:
Chinese uses the user-supplied recording capture, while English reuses the earlier
sanitized recording capture, cropped and fitted to the same canvas. Both show the
requested green recording border, microphone and voice meter. They do not prove
successful recognition. Mobile voice images still show an editable example draft.
Swipe images capture the
actual touch gesture's revealed actions. Pairing and SSH images stop at setup;
they contain no QR credentials and do not demonstrate completed connections.

Use repository-relative image paths in the root READMEs and `/assets/shots/` paths
in handbook articles. Check the current UI entry point before describing a feature
shown in a capture. See `packages/docs/CONTRIBUTING.md` for handbook image guidance.

中文：根目录 README、官网与手册共用 `site/assets/shots/` 中已脱敏的素材，
按语言选图即可。更新图片时同步检查实际入口和配文，不需要另存一套副本。
