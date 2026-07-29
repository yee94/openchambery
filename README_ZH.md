# <picture><source media="(prefers-color-scheme: dark)" srcset="docs/references/badges/openchamber-logo-dark.svg"><img src="docs/references/badges/openchamber-logo-light.svg" width="32" height="32" align="absmiddle" /></picture> OpenChamber

[![GitHub stars](https://img.shields.io/github/stars/yee94/openchamber?style=flat&labelColor=100F0F&color=66800B)](https://github.com/yee94/openchamber/stargazers)
[![GitHub release](https://img.shields.io/github/v/release/yee94/openchamber?style=flat&labelColor=100F0F&color=205EA6)](https://github.com/yee94/openchamber/releases/latest)
[![Created with OpenCode](docs/references/badges/created-with-opencode.svg)](https://opencode.ai)

**OpenCode 的图形界面 · 对齐 Codex 的交互手感**

Desktop · Browser · Phone · VS Code

[English](./README.md)

![OpenChamber 主界面](docs/references/chat_example.png)

---

## 我们为什么做这件事

[OpenCode](https://opencode.ai) 是优秀的开源 coding agent 运行时：模型、工具、会话、技能都在这里。  
但日常写代码时，很多人更习惯 **Codex 那一套桌面交互**——侧栏会话树、快捷键 leader 模式、一键 fork、紧凑的状态条、随时可打断的运行流。

这个仓库（[yee94/openchamber](https://github.com/yee94/openchamber)）在上游 [OpenChamber](https://github.com/fedaykindev/openchamber) 之上持续改造，目标很简单：

> **用 OpenCode 的能力，做出接近 Codex 的交互体验。**

不是换引擎，而是把「看得见、摸得着、按得顺」的那一层做对：

| 方向 | 我们在做什么 |
|------|----------------|
| **手感对齐** | `Ctrl+X` leader 快捷键、双 Esc 中止、会话 Pin / 切换、`/fork` `/compact` 等与 Codex 相近的操作路径 |
| **会话工作流** | 可分支的时间线、冷启动可 fork、新建会话即时 Loading、右侧工作区按 Session 记忆 |
| **可靠与性能** | SQLite 会话索引、冷启动请求合并、队列调度、跨端同步与状态权威源 |
| **多端一体** | 桌面 / Web / 手机 / VS Code 共用同一套 UI 与运行时契约 |

## 近期改造亮点（本 fork）

围绕「Codex 手感 + OpenCode 能力」，近期重点包括：

- **快捷键与命令**
  - `Ctrl+X` leader 模式（模型、压缩、清空等）
  - 双 Esc 中止（第一次提示「再按一次」）
  - `/fork`、`/compact`、`Ctrl+C` 清空输入等对齐日常 agent 工作流
  - `openchamber://` deeplink，与 OpenCode / Codex 打开项目、新建会话的习惯对齐
- **会话与工作区**
  - 冷启动后 fork 不再静默失败
  - 新建会话立即进入 Loading 过渡页
  - 右侧面板（subagent / git changes / file preview）按 Session 绑定与恢复
  - Pinned 会话保留子会话树
- **可靠性**
  - 消息队列调度与目录作用域严格化
  - 冷启动并发预算、健康探测 / 升级状态请求合并
  - 草稿与附件持久化、跨 runtime 队列隔离
- **体验细节**
  - 聊天区状态条、变更列表字体与密度统一
  - 智能摘要独立设置、多语言 fork 进度文案
  - 移动端触控反馈与流式震动

完整变更见 [CHANGELOG.md](./CHANGELOG.md) 与 [Releases](https://github.com/yee94/openchamber/releases)。

## 快速开始

> **前置：** 桌面版内置匹配的 OpenCode CLI；CLI / Web / VS Code 使用你本机已安装的 [OpenCode](https://opencode.ai)。

### 桌面（macOS / Windows / Linux）

从 [Releases](https://github.com/yee94/openchamber/releases) 下载安装包。

Linux 请按架构选择 AppImage（`linux-x86_64` / `linux-arm64`），先 `chmod +x`，并放在可写目录以便应用内更新。需要 FUSE（`libfuse.so.2`）；若无 FUSE 可：

```bash
APPIMAGE_EXTRACT_AND_RUN=1 ./OpenChamber-*-linux-*.AppImage
```

### VS Code

在扩展市场搜索 **OpenChamber**，或打开 [Marketplace](https://marketplace.visualstudio.com/items?itemName=fedaykindev.openchamber)。

### 移动端（iOS TestFlight + Android）

- **iOS（TestFlight）：** https://testflight.apple.com/join/ZCENBHtm  
  公开测试链接。首次外部测试可能需等待 Apple Beta App Review 通过后才可安装。
- **Android：** 从 [Releases](https://github.com/yee94/openchamber/releases) 下载签名 APK/AAB。

原生 App 连接已有的 OpenChamber 服务端，本身不内嵌 OpenCode。

### CLI（Web + PWA）

需要 Node.js 22+：

```bash
curl -fsSL https://raw.githubusercontent.com/yee94/openchamber/main/scripts/install.sh | bash
openchamber --ui-password be-creative-here
```

<details>
<summary>更多 CLI 参数</summary>

```bash
openchamber --port 8080              # 自定义端口
openchamber --lan --port 3000        # 监听局域网 (0.0.0.0)
openchamber --ui-password secret     # UI 密码保护
openchamber startup enable           # 开机自启（系统服务）
openchamber tunnel start --provider cloudflare --mode quick --qr
openchamber connect-url --port 3000 --qr
OPENCODE_PORT=4096 OPENCODE_SKIP_START=true openchamber
openchamber stop
openchamber update
```

</details>

<details>
<summary>Docker</summary>

```bash
docker compose up -d
```

访问 `http://localhost:3000`。按需设置 `UI_PASSWORD` 与 Cloudflare 隧道相关环境变量。确保 `data/` 可写（`chown -R 1000:1000 data/`）。

</details>

## 核心能力

- 可分支的聊天时间线：`/undo`、`/redo`、一键 fork
- 智能工具 UI：diff、文件、权限、长任务进度
- 多 agent 并行与隔离 worktree
- 应用内 Git / GitHub 工作流（提交、PR、检查、合并）
- Plan/Build 模式，diff / 计划上的行内评论
- 集成终端、技能目录、语音模式
- 桌面：多窗口、Mini Chat、SSH/隧道、deep link
- Web/PWA：隧道扫码接入、移动端优先、自更新
- VS Code：编辑器内会话、Agent Manager、上下文操作

## 署名

| 角色 | 说明 |
|------|------|
| **本 fork 维护** | [yee94](https://github.com/yee94)（Yee）— 交互对齐、会话可靠性、桌面/多端体验持续迭代 |
| **上游 OpenChamber** | [Bohdan Triapitsyn / fedaykindev](https://github.com/fedaykindev/openchamber) — 原始产品与架构 |
| **运行时** | [OpenCode](https://opencode.ai) — agent 引擎与 API |

独立项目，与 OpenCode 官方团队无隶属关系。欢迎 Issue / PR。

## 贡献

见 [CONTRIBUTING.md](./CONTRIBUTING.md)。文档源码在 [`packages/docs`](packages/docs/README.md)。

## 许可证

MIT

---

<p align="center">
  <sub>
    维护：<a href="https://github.com/yee94">@yee94</a>
    · 基于 <a href="https://github.com/fedaykindev/openchamber">OpenChamber</a>
    · 运行时 <a href="https://opencode.ai">OpenCode</a>
  </sub>
</p>
