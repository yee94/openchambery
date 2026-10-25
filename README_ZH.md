# Yuri

**面向编程、个人助理与周期任务的 AI 工作台，覆盖桌面、手机、浏览器和 VS Code。**

[English](README.md) · [使用文档](packages/docs/content/docs/zh-cn/index.mdx) · [参与开发](CONTRIBUTING.md)

<p align="center">
  <img src="docs/references/badges/yuri-logo-light.svg" alt="Yuri" width="160" />
</p>

Yuri 把对话、代码修改、终端和自动化任务放在同一个工作空间里。在电脑上启动任务，用手机查看进展，审查改动，再决定下一步。

## 与 Agent 一起工作

- **项目与会话**：按项目组织工作，为对话创建分支，用 Git worktree 隔离代码变更。
- **审查与交付**：查看文件修改和 Diff，在内置终端执行命令，在对话旁完成 Git 与 GitHub 操作。
- **个人助理**：保留日常助理对话，通过手机系统分享带入文字、链接与图片。
- **目标与计划任务**：为会话设定目标并检查进展，或按每日、每周、单次时间自动运行提示词，在历史记录中查看结果。计划任务需要 Yuri 服务保持运行。
- **模型与工具**：为不同工作流配置提供商、模型、Agent、Skills 和 MCP 工具。

## 在不同设备上继续工作

| 入口 | 用途 |
| --- | --- |
| 桌面端 | Electron 应用，支持本地项目、Mini Chat、多窗口和 SSH 连接 |
| 移动端 | iOS、Android 客户端连接 Yuri 服务；iOS 支持实时活动与系统分享 |
| 浏览器 | 自托管工作空间，支持设备配对与可选的私有中继 |
| VS Code | 在编辑器里处理会话和项目上下文 |

Yuri 使用 OpenCode 运行时执行 Agent 任务，应用交互、设备连接、会话协调与自动化由 Yuri 提供。

## 从源码运行

使用 Node.js 24（见 `.nvmrc`）与 Bun 1.3.14。启动本地 Web 开发环境前，请先安装 OpenCode 运行时。

```bash
git clone https://github.com/yee94/yuri.git
cd yuri
bun install
bun run dev
```

打开开发服务打印的地址。开发桌面端时，将最后一条命令替换为 `bun run electron:dev`。

构建命令和开发检查见[贡献指南](CONTRIBUTING.md)，连接其他设备见[设备连接文档](packages/docs/content/docs/zh-cn/connect-devices.mdx)。

## 下载与部署

发布产物统一放在 [GitHub Releases](https://github.com/yee94/yuri/releases)。安装包、商店与签名配置的进展见[发布指南](docs/RELEASING.md)；源码可用不代表所有平台均已有可下载安装包。

- [Web 服务](packages/web/README.md)
- [桌面应用](packages/electron/README.md)
- [移动应用](packages/mobile/README.md)
- [VS Code 扩展](packages/vscode/README.md)
- [私有中继](packages/relay-server/README.md)

## 仓库结构

`packages/ui` 提供共享界面，`packages/web` 承载 Web 服务与运行时服务，Electron、移动端和 VS Code 包负责各自的平台集成。使用文档位于 `packages/docs`。

## 致谢

感谢 [OpenChamber](https://github.com/openchamber/openchamber) 与 [OpenCode](https://opencode.ai) 提供的开源基础。

## 许可证

[MIT](LICENSE)，保留原有版权与许可声明。
