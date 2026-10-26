# Handbook authoring

Write for someone trying to complete a task. Lead with what they can do, give
concrete steps, and describe what success looks like. Link to the owning guide
instead of repeating its procedure. Keep product introductions on the website.

## Add or revise an article

1. Edit the English `.mdx` under `content/docs/` and its Chinese counterpart under
   `content/docs/zh-cn/`. Filenames must match.
2. Supply single-line `title` and `description` frontmatter fields.
3. Use one `#` heading matching the title, then `##` and `###` sections. The build
   supplies the visible page title and generates the in-page contents from sections.
4. Add the topic to `sidebar.config.json` with an English label and a real `zh-CN`
   translation. Use the Advanced reference section for specialist configuration.
5. Run the build and checks in the package README. Inspect both languages and a
   narrow viewport when changing layout or screenshots.

English and Chinese are the active publication editions. The seven other
translation directories are retained archives, not a requirement for new pages.
Do not copy English text into those directories as placeholder translations.

## Supported MDX subset

The existing `.mdx` filenames are retained, but the static renderer uses Markdown,
not executable JSX. It supports paragraphs, lists, tables, blockquotes, links,
images, fenced code and native HTML `details` / `summary`. No imports, exports,
React components, Astro components or runtime expressions are executed. Frontmatter
supports only single-line `title`, `description`, and optional `redirect` strings.

```md
---
title: Connect devices
description: Pair another device with your running Yuri host.
---

# Connect devices

## Pair your phone

1. Create a pairing QR code on the host.
2. Scan it from the mobile app.
```

## Links

- In English source, use `/topic/`; Chinese source uses `/zh-cn/topic/`.
- The renderer resolves documentation links to the active published edition:
  `/en/docs/topic/` or `/docs/topic/`.
- Link to the download chooser with `/en/#downloads` or `/#downloads`.
- Link to engineering references with their full repository URL.
- Use generated heading fragments for links within an article. `site:check`
  checks both same-page and cross-page fragments.
- Do not embed release-specific installer URLs in the handbook.

## Merge a topic

Move the useful instructions into the owning article. Replace the old page with
its title, description and a `redirect: /destination/` field, plus a readable
Markdown link for repository readers. Remove its sidebar entry. Redirect targets
must be articles, never another redirect. Keep both active languages aligned.

The static redirect works on a plain file server with a meta refresh and a visible
fallback link; it includes a canonical link and `noindex`. Changing domains or
recovering routes on a different deployment is outside this path mapping.

## Images

Reuse approved, sanitized screenshots under `site/assets/shots/`, with an absolute
`/assets/shots/file.webp` Markdown image URL and meaningful translated alt text.
The build copies and content-versions every referenced asset. Use a localized
screenshot when its interface text matters. No build-time image optimization is
implied; prepare the WebP asset before adding it.

For phone walkthroughs, use native `figure` / `figcaption` with the
`docs-phone-shot` class. Pair related figures in a `docs-shot-grid` wrapper; they
stack on narrow screens. Native `img` tags should include localized alt text,
the asset's width/height and `loading="lazy"`. Keep captions next to the operation
they illustrate and reuse the matching language asset under `/assets/shots/`.

## Accuracy

Check behavior against the owning module documentation and implementation. State
which host runs the work, which platforms support a feature, and when a native
installer is required. Do not infer availability from a screenshot alone. Use
neutral example hosts and user-supplied placeholders, never real credentials.

An implementation file, translation key or backend endpoint alone is not evidence
of a shipped user action. Trace the visible navigation/control through its runtime
and capability gates to the mounted editor or action handler. Record substantive
findings in `ENTRYPOINT-AUDIT.md`. An unmounted panel must not become an instruction
in the handbook. Keep generated Agent todos distinct from user-managed project
notes or checklists.

When replacing older prose, write from the verified user task with a new outline,
examples and explanation. Do not retain the earlier heading order and merely swap
synonyms, especially in English. Preserve exact commands and UI labels where they
are required for accuracy. Archived translations are not evidence for current UI.
