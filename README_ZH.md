# <picture><source media="(prefers-color-scheme: dark)" srcset="docs/references/badges/openchamber-logo-dark.svg"><img src="docs/references/badges/openchamber-logo-light.svg" width="32" height="32" align="absmiddle" /></picture> OpenChamberY

[![GitHub stars](https://img.shields.io/github/stars/yee94/openchamber?style=flat&labelColor=100F0F&color=66800B)](https://github.com/yee94/openchamber/stargazers)
[![GitHub release](https://img.shields.io/github/v/release/yee94/openchamber?style=flat&labelColor=100F0F&color=205EA6)](https://github.com/yee94/openchamber/releases/latest)
[![Created with OpenCode](docs/references/badges/created-with-opencode.svg)](https://opencode.ai)

**[OpenCode](https://opencode.ai) 的全端图形化 AI 编程工作台。**

桌面端 · 移动端 · 浏览器 · VS Code

[English](./README.md)

<p align="center">
  <img src="docs/references/chat_example.png" alt="OpenChamberY 桌面端界面" width="100%" />
</p>

<table align="center" border="0" cellspacing="0" cellpadding="4">
  <tr>
    <td width="33.3%" valign="top">
      <img src="docs/references/mobile_projects.png" alt="移动端项目与分支会话" width="100%" />
    </td>
    <td width="33.3%" valign="top">
      <img src="docs/references/mobile_chat.png" alt="移动端实时 Diff 与执行状态" width="100%" />
    </td>
    <td width="33.3%" valign="top">
      <img src="docs/references/mobile_schedules.png" alt="计划任务与自动化" width="100%" />
    </td>
  </tr>
</table>

---

## 关于 OpenChamberY

本项目 **OpenChamberY** 由 [@yee94](https://github.com/yee94) 维护，fork 自开源项目 [fedaykindev/openchamber](https://github.com/fedaykindev/openchamber)（作者 Bohdan Triapitsyn）。

在继承上游全端架构与 [OpenCode](https://opencode.ai) 强大引擎的基础上，OpenChamberY 持续演进以下重点能力：
- **Codex 级桌面交互**：`Ctrl+X` leader 快捷键、双 `Esc` 打断、`/fork` 分支管理等高密度键盘流。
- **深度原生移动端**：iOS 灵动岛与锁屏实时活动（Live Activity）、微压触感反馈、原生输入与系统分享。
- **计划任务与自动化**：内置 Cron 与周期调度器，支持 Goal 模式自主执行长任务与自动巡检。
- **会话可靠性与跨端同步**：SQLite 本地索引、冷启动请求合并、实时状态权威源。

---

## 核心特性

### 1. 会话与交互（Chat & Interaction）
- **Codex 级键盘流**：`Ctrl+X` leader 模式、双 `Esc` 快速打断、`/fork`、`/compact`、`Ctrl+C` 清空输入。
- **分支会话树**：随时从任意历史轮次一键 fork 分支，支持多层 timeline 展开、`/undo` 与 `/redo`。
- **智能工具卡片**：可视化展示 Diff 变动、文件读写、权限请求与长任务执行进度（含实时 tok/s）。
- **Plan / Build 双模式**：独立的计划草稿视图，支持在 diff 和计划上直接添加行内评论并反馈给 Agent。
- **多 Agent 并行隔离**：单个 Prompt 派生多个子 Agent，在独立的 Git worktree 中并行实验。
- **语音模式与图表**：支持语音输入与朗读回复；内置 Mermaid 流程图实时渲染。

### 2. Git 与 GitHub 工作流
- **应用内完整 Git 侧边栏**：代码暂存、提交、推送/拉取、分支切换与变基/合并。
- **自动化 PR 管理**：AI 生成 PR 描述、关联 CI 状态检查（Checks）与应用内直接合并。
- **关联 Issue / PR**：直接从 GitHub Issue 或 PR 创建带有上下文的专属工作会话。

### 3. 文件、Diff 与内置终端
- **专业级 Diff 审查**：支持堆叠/内联模式，大文件惰性加载，点击文件路径秒级跳转。
- **工作区文件树**：内置代码编辑器，支持语法高亮、Vim 模式与 Markdown 实时预览。
- **高性能终端**：基于 Ghostty 渲染引擎，支持多标签页与大量输出下的流畅运行。

### 4. 移动端原生体验（iOS / Android / PWA）
- **iOS 灵动岛与锁屏实时活动（Live Activity）**：后台长任务无需常驻 App，锁屏与灵动岛实时展示进度与待确认提示。
- **原生触感与输入体验**：微压弹性动效、轻量触控震动反馈与专为手机调优的原生输入条。
- **系统级分享接入**：在任意手机应用中，直接通过系统分享将链接、文本或截图投递给助理。
- **远程推送**：支持 APNs 与自建 Push Relay 状态提醒。

### 5. 计划任务与自动化（计划）
- **内置 Cron / 周期调度**：按每日、每周或自定义 Cron 规则自动唤醒 Agent。
- **Goal 目标驱动模式**：设定明确目标，Agent 自主规划直到完成，自动归档并保留完整运行历史。
- **自动化应用场景**：每日早间代码日报、凌晨依赖与安全检查、周期性架构健康巡检。

### 6. 多端协同与连接安全
- **一键扫码配对**：电脑端生成一次性二维码，手机 App 扫码即连，各端独立授权令牌。
- **Private Relay 外网穿透**：端到端加密通道，无需公网 IP 和复杂端口转发即可远程直连。
- **桌面端专属增强**：置顶 Mini Chat 悬浮窗、多窗口独立项目管理、SSH 远程主机连接与端口转发。
- **VS Code 扩展**：无缝嵌入编辑器侧边栏，支持 Agent Manager 与右键快捷上下文注入。

### 7. 定制与效能洞察
- **丰富主题生态**：内置 18+ 款精选主题（支持浅色/深色），支持 JSON 自定义主题热重载。
- **Token 与开销明细**：实时统计各 Provider 消耗、预测调用速率，内置 Raw 消息检查器。
- **项目笔记与 Skills**：项目级持久化 Notes / Todos，内置 Skills 目录与本地技能管理。

---

## 下载与安装

| 客户端 | 安装方式 |
|---|---|
| **桌面端**（macOS / Windows / Linux） | [GitHub Releases](https://github.com/yee94/openchamber/releases) 下载对应安装包 |
| **iOS**（TestFlight） | [加入 TestFlight 公测](https://testflight.apple.com/join/ZCENBHtm)（需先在 iPhone 上安装 TestFlight） |
| **Android** | [GitHub Releases](https://github.com/yee94/openchamber/releases/latest) 下载 `app-release.apk` |
| **VS Code 扩展** | 在扩展商店搜索 `OpenChamber` 或通过 [Marketplace](https://marketplace.visualstudio.com/items?itemName=fedaykindev.openchamber) 安装 |
| **Web / CLI** | 使用 `openchambery` 一键脚本安装（见下方） |

---

## 快速开始

> 桌面端已内置匹配的 OpenCode CLI；使用 Web/CLI 或 VS Code 时需本机安装 [OpenCode](https://opencode.ai)。

### Web / CLI 服务

需要 Node.js 22+：

```bash
curl -fsSL https://raw.githubusercontent.com/yee94/openchamber/main/scripts/install.sh | bash
openchambery --ui-password 自定义安全密码
```

启动后在浏览器打开终端打印的地址（默认 `http://localhost:3000`）。在设置中打开「连接设备」，用手机 App 扫码即可连接。

<details>
<summary>常用 openchambery CLI 命令</summary>

```bash
openchambery --port 8080              # 指定端口
openchambery --lan --port 3000        # 监听局域网 (0.0.0.0)
openchambery --ui-password secret     # 开启密码认证
openchambery startup enable           # 注册为系统开机自启服务
openchambery connect-url --port 3000 --qr # 生成终端配对二维码
openchambery stop                     # 停止后台服务
openchambery update                   # 升级到最新版本
```

</details>

<details>
<summary>Docker 部署</summary>

```bash
docker compose up -d
```

默认运行在 `http://localhost:3000`。生产环境可通过环境变量配置 `UI_PASSWORD`。

</details>

---

## 致谢与开源协议

| 角色 | 说明 |
|---|---|
| **本仓库维护** | [yee94](https://github.com/yee94)（Yee）— Codex 交互手感、移动端深度体验、会话可靠性与多端打磨 |
| **上游 OpenChamber** | [Bohdan Triapitsyn / fedaykindev](https://github.com/fedaykindev/openchamber) — 原始产品设计与架构 |
| **底座运行时** | [OpenCode](https://opencode.ai) — 开源 Agent 引擎与 API |

本项目为开源社区独立项目，与 OpenCode 官方无商业隶属关系。

## 许可证

[MIT](./LICENSE)
