# <picture><source media="(prefers-color-scheme: dark)" srcset="docs/references/badges/yuri-logo-dark.svg"><img src="docs/references/badges/yuri-logo-light.svg" width="32" height="32" align="absmiddle" /></picture> Yuri

[![GitHub stars](https://img.shields.io/github/stars/yee94/yuri?style=flat&labelColor=100F0F&color=66800B)](https://github.com/yee94/yuri/stargazers)
[![GitHub release](https://img.shields.io/github/v/release/yee94/yuri?style=flat&labelColor=100F0F&color=205EA6)](https://github.com/yee94/yuri/releases/latest)
[![Created with OpenCode](docs/references/badges/created-with-opencode.svg)](https://opencode.ai)

**The full-surface GUI and mission control for [OpenCode](https://opencode.ai).**

Desktop · Mobile · Browser · VS Code

[中文说明](./README_ZH.md)

<p align="center">
  <img src="docs/references/badges/yuri-logo-light.svg" alt="Yuri" width="160" />
</p>

---

## About Yuri

**Yuri** is maintained by [@yee94](https://github.com/yee94). Copyright and licensing notices are preserved in [LICENSE](LICENSE).

Building upon the upstream cross-surface architecture and [OpenCode](https://opencode.ai) runtime engine, Yuri focuses on:
- **Codex-grade desktop flow**: `Ctrl+X` leader shortcuts, double-`Esc` abort, `/fork` session branching, and keyboard-first operations.
- **Deep native mobile experience**: iOS Live Activities & Dynamic Island, refined haptics, native composer, and system share integration.
- **Scheduled automations & Goal mode**: Built-in Cron scheduler for recurring codebase health audits, standup digests, and autonomous tasks.
- **Reliability & cross-device sync**: SQLite session indexing, coalesced cold-start queries, and resilient synchronization.

---

## Features

### 1. Chat & Interaction
- **Codex-grade keyboard flow**: `Ctrl+X` leader chords, double-`Esc` abort, `/fork`, `/compact`, and `Ctrl+C` input clear.
- **Branchable session tree**: Fork sessions anytime from earlier turns, explore alternative paths, and navigate past timelines with `/undo` and `/redo`.
- **Smart tool UI**: Live visual diff cards, file operations, permission prompts, and long-running task progress (with real-time tok/s).
- **Plan / Build mode**: Dedicated plan drafting view; add inline comments on diffs and plans to feed back to the agent.
- **Parallel subagents & worktrees**: Spawn child agents running inside isolated Git worktrees without touching your active branch.
- **Voice mode & diagrams**: Speech input and read-aloud responses; embedded Mermaid diagram rendering.

### 2. Git & GitHub Workflows
- **Full Git sidebar**: Staging, commits, push/pull, branch management, rebase, and merge flows.
- **Automated PR workflows**: AI-generated PR descriptions, integrated CI status checks, and in-app merging.
- **Issue & PR context**: Start dedicated sessions directly from GitHub issues or pull requests with context pre-attached.

### 3. Files, Diff & Integrated Terminal
- **Interactive diff viewer**: Stacked and inline views, lazy loading for large changesets, and one-click file jump.
- **Workspace file tree**: Built-in editor with syntax highlighting, Vim mode, and live Markdown preview.
- **High-performance terminal**: Powered by the Ghostty engine with multi-tab support and stability under heavy output.

### 4. Native Mobile Experience (iOS / Android / PWA)
- **iOS Live Activities & Dynamic Island**: Track active tasks, runtime, and attention prompts without keeping the app open.
- **Refined touch & native composer**: Elastic press feedback, light haptics, and a mobile-optimized input experience.
- **System share integration**: Share links, text snippets, and images from any mobile app directly into Yuri assistants.
- **Push alerts**: Remote notifications supported via APNs and self-hosted Push Relay.

### 5. Scheduled Tasks & Automations
- **Built-in Cron / recurring schedules**: Trigger runs daily, weekly, or via custom Cron expressions.
- **Goal Mode**: Hand off high-level prompts that agents pursue autonomously until done, with complete run logs.
- **Common use cases**: Daily codebase morning digests, periodic dependency audits, and weekly architecture reviews.

### 6. Multi-Surface & Connectivity
- **One-tap QR pairing**: Scan from the mobile app to pair devices instantly with isolated authorization tokens.
- **Private Relay**: End-to-end encrypted remote access without opening router ports or exposing public IPs.
- **Desktop extras**: Floating Mini Chat, multi-window workspace, and SSH remote instance management with port forwarding.
- **VS Code Extension**: Run full sessions directly in your editor sidebar with Agent Manager and context menus.

### 7. Customization & Insights
- **18+ built-in themes**: Light and dark variants with hot-reloading for custom JSON themes.
- **Token usage & cost metrics**: Real-time token breakdowns across providers, run pacing, and raw message inspector.
- **Project notes & skills**: Persistent workspace Notes and Todos, plus built-in Skills catalog and management.

---

## Downloads

Release blocked pending ownership and signing verification. The repository and publisher below are candidate identities, not a claim that installers are available. See [release requirements](docs/RELEASING.md).

| Platform | Installation |
|---|---|
| **Desktop** (macOS / Windows / Linux) | [GitHub Releases](https://github.com/yee94/yuri/releases) |
| **iOS** (TestFlight) | New Yuri TestFlight identity pending verification; see [release requirements](docs/RELEASING.md) |
| **Android** | [GitHub Releases](https://github.com/yee94/yuri/releases/latest) (`app-release.apk`) |
| **VS Code** | Search `Yuri` in Extensions or install from [Marketplace](https://marketplace.visualstudio.com/items?itemName=yee94.yuri) |
| **Web / CLI** | Install via `yuri` script (see below) |

---

## Quick Start

> Desktop bundles a matching OpenCode CLI. Web/CLI and VS Code use your locally installed [OpenCode](https://opencode.ai).

### Web / CLI Server

Requires Node.js 22+:

```bash
curl -fsSL https://raw.githubusercontent.com/yee94/yuri/main/scripts/install.sh | bash
yuri --ui-password your-secure-password
```

Open `http://localhost:3000`. Under Settings → Remote Instances, generate a QR code to pair your mobile app.

<details>
<summary>Common yuri CLI commands</summary>

```bash
yuri --port 8080              # Custom port
yuri --lan --port 3000        # Listen on LAN (0.0.0.0)
yuri --ui-password secret     # Require UI password
yuri startup enable           # Enable auto-start service on boot
yuri connect-url --port 3000 --qr # Print pairing QR in terminal
yuri stop                     # Stop background service
yuri update                   # Update to latest version
```

</details>

<details>
<summary>Docker</summary>

```bash
docker compose up -d
```

Available at `http://localhost:3000`. Set `UI_PASSWORD` in your environment.

</details>

---

## Attribution

| Role | Details |
|---|---|
| **This fork** | Maintained by [yee94](https://github.com/yee94) (Yee) — Codex interaction parity, mobile UX, session reliability, and multi-surface polish |
| **Runtime Engine** | [OpenCode](https://opencode.ai) — open-source AI agent runtime & SDK |

Independent community project; not affiliated with the OpenCode team.

## License

[MIT](./LICENSE)
