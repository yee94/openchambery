# Yuri

**An AI workspace for coding, personal assistants, and recurring tasks — across desktop, mobile, browser, and VS Code.**

[中文](README_ZH.md) · [Documentation](packages/docs/content/docs/index.mdx) · [Contributing](CONTRIBUTING.md)

<p align="center">
  <img src="docs/references/badges/yuri-logo-light.svg" alt="Yuri" width="160" />
</p>

Yuri brings conversations, code changes, terminals, and automated work into one workspace. Start a task at your desk, check it from your phone, review what changed, and decide what happens next.

## Work with agents

- **Projects and sessions.** Organize work by project, branch a conversation, and use Git worktrees to isolate changes.
- **Review and ship.** Inspect file edits and diffs, use the integrated terminal, and manage Git and GitHub workflows alongside the conversation.
- **Personal assistants.** Keep assistant conversations close at hand and bring in text, links, and images from mobile sharing.
- **Goals and schedules.** Give a session an objective with progress checks, or schedule prompts to run daily, weekly, or once. Inspect each run in its history. Scheduled work requires a running Yuri server.
- **Your models and tools.** Configure providers, models, agents, skills, and MCP tools for each workflow.

## Take the workspace with you

| Surface | Role |
| --- | --- |
| Desktop | Electron app with local workspaces, Mini Chat, multiple windows, and SSH connections |
| Mobile | iOS and Android clients that connect to a Yuri server; iOS Live Activities and system sharing |
| Browser | Self-hosted access to the workspace, with device pairing and optional private relay |
| VS Code | Sessions and project context inside the editor |

Yuri uses the OpenCode runtime for agent execution. Yuri owns the application experience, device connectivity, session coordination, and automation around that runtime.

## Run from source

Use Node.js 24 (see `.nvmrc`) and Bun 1.3.14. Install the OpenCode runtime before starting a local web development instance.

```bash
git clone https://github.com/yee94/yuri.git
cd yuri
bun install
bun run dev
```

Open the URL printed by the development server. For desktop development, run `bun run electron:dev` instead.

See [Contributing](CONTRIBUTING.md) for build commands and development checks, and the [connection guide](packages/docs/content/docs/connect-devices.mdx) for connecting another device.

## Downloads and deployment

Published artifacts belong in [GitHub Releases](https://github.com/yee94/yuri/releases). Installer, store, and signing setup is tracked in the [release guide](docs/RELEASING.md); source availability does not imply that every platform has a published installer.

- [Web server](packages/web/README.md)
- [Desktop app](packages/electron/README.md)
- [Mobile apps](packages/mobile/README.md)
- [VS Code extension](packages/vscode/README.md)
- [Private relay](packages/relay-server/README.md)

## Repository

Shared UI lives in `packages/ui`. The web server and runtime services live in `packages/web`; Electron, mobile, and VS Code packages provide their platform integrations. User documentation lives in `packages/docs`.

## Acknowledgments

Thank you to [OpenChamber](https://github.com/openchamber/openchamber) and [OpenCode](https://opencode.ai) for the open-source foundations that helped make Yuri possible.

## License

[MIT](LICENSE). Original copyright and license notices are retained.
