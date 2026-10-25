# Yuri Docs Source

Repository and package links use candidate Yuri identities pending ownership verification. Do not treat these source changes as a completed public deployment. The VS Code identity change and recovery boundaries are documented in [`../vscode/MIGRATION.md`](../vscode/MIGRATION.md).

This package is the source-of-truth for Yuri public docs content.

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
