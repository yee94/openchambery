# Yuri handbook

This package owns user-facing documentation. The product website lives in
`site/`; its static build also renders this handbook. Engineering documentation
under root `docs/` and module `DOCUMENTATION.md` files has separate ownership.

## Content and routes

- `content/docs/*.mdx` and `content/docs/troubleshooting/`: English source.
- `content/docs/zh-cn/`: actively maintained Simplified Chinese edition.
- `sidebar.config.json`: shared, task-oriented navigation, with advanced references
  collapsed by default.
- `site/src/build-docs.mjs`: static renderer using Bun's built-in Markdown parser.
- Chinese publishes at `/docs/`; English at `/en/docs/`.
- Six merged topics per language retain frontmatter redirects. The former
  `/docs/zh-cn/…` path shape redirects to the corresponding Chinese article.

The other seven translation directories remain as source archives. They are not
published by the new handbook and are not silently represented as up to date.
Restoring an edition requires reviewing its content and adding explicit rendering,
navigation and link validation for that locale.

The handbook has 37 articles per active language: 29 main navigation topics and
8 advanced references. Installation, connections, assistants, mobile use, voice
and updates are the primary paths. Downloads belong to the website's shared
download chooser rather than copied release URLs in articles.

## Local preview

Requires Node.js 24 and Bun 1.3.14 or newer. No new package dependencies are needed.
From the repository root:

```sh
bun run docs:validate
bun run site:build
bun run site:check
bun run site:test
python3 -m http.server 8794 --bind 127.0.0.1 --directory site/dist
```

Open `http://localhost:8794/docs/`. Rebuild after content changes.

`docs:validate` checks source metadata and navigation existence across retained
sources. The site build additionally requires English/Chinese route parity and
valid redirect targets. `site:check` verifies generated internal links, fragments,
resource hashes, navigation state and one page heading per article. These checks
do not validate external services or prove that a product instruction works on a
physical device.

See [CONTRIBUTING.md](CONTRIBUTING.md) for authoring and
[DEPLOYMENT.md](DEPLOYMENT.md) for the unified publication path.

The active English and Chinese articles have been rewritten against current
entry points. [ENTRYPOINT-AUDIT.md](ENTRYPOINT-AUDIT.md) records the mounting and
platform evidence, including retired project notes, inaccessible PR/Integrate
panels, VS Code-only multi-run creation, and `/goal` activation. Other translation
sources remain historical archives and have not received this entry-point audit.

The Magpie follow-up guide covers gateway-backed models/plugins, host-scoped usage
discovery and explicitly selected desktop configuration transfer. It distinguishes
Magpie plugins from the OpenCode extensions managed by Yuri's Plugins settings.
