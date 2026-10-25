# Yuri Docs Source

This package contains Yuri's user guides: project work, personal assistants, goals, scheduled tasks, and access across desktop, mobile, browser, and VS Code. Start with [the documentation overview](content/docs/index.mdx) or [简体中文](content/docs/zh-cn/index.mdx).

The source repository is [yee94/yuri](https://github.com/yee94/yuri). Public installers and store availability are tracked separately in the [release guide](../../docs/RELEASING.md).

## Layout

- `content/docs/*.mdx` - English docs pages (source of truth)
- `content/docs/<locale>/*.mdx` - translations, mirroring the English filenames
  (e.g. `uk/`, `zh-cn/`, `pt-br/`, `fr/`); see `CONTRIBUTING.md` → Localization
- `sidebar.config.json` - docs navigation structure for Starlight sidebar
- `CONTRIBUTING.md` - authoring guide for adding pages, sections, and translations
- `DEPLOYMENT.md` - release/manual packaging and sync trigger model

## Local validation

Run from repo root:

```bash
bun run docs:validate
```

This validates:

- frontmatter (`title`, `description`) exists for every MDX page
- sidebar links resolve to existing MDX routes

## Deployment model

This repo owns docs content.

Website rendering/deployment requires a separately configured website repository (`apps/docs`); the candidate name `yuri-website` is not an ownership or deployment claim.

Use `.github/workflows/docs-source.yml` to package docs source on release or manual trigger.
