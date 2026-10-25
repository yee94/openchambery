# Yuri rebrand 验证记录

本次实现采用用户指定的 vector-B 人物侧影，品牌源见 [`assets/brand/yuri`](../assets/brand/yuri/README.md)。发布状态和外部身份前置条件见 [迁移手册](YURI_MIGRATION.md)。本记录区分本地工程验证与实际发布验收。

## 后续补充：旧深链接收兼容

用户要求继续兼容历史外部深链。所有新生成链接仍使用 Yuri，旧别名仅用于接收；桌面打包声明、运行时冷/热启动入口、iOS URL Types、Android browsable intent 已同步注册。详见两端 README 的 deep-link compatibility 说明。配对 v2 校验、过期时间与一次性兑换保持原有行为。

- 定向 3 文件、27 项测试通过，覆盖各别名接收、原始 payload 保留、桌面/手机注册一致性及解析后只生成新链接。
- Electron 语法检查与主进程 bundle 通过。
- iOS Simulator 与 Android debug APK 重建成功，两个原生产物均包含三个 scheme 注册。
- 独立 iOS 模拟器对两个旧别名分别完成冷启动、热启动，共四次唤起通过；热启动 PID 保持不变，显示未配对连接页，无崩溃。测试设备与预览已关闭，证据位于 `.scratch/yuri-rebrand/deep-link-evidence/`。
- 尚未验证已配对后的目标页面导航、Android 设备实际唤起、真机、与旧应用并存时的系统 scheme 选择，以及桌面安装后的系统分发。
- 本次 dead-code 已运行并审阅，未新增 deep-link 模块未使用项；生成资源及既有未使用报告与基础验收一致。
- 补充后精确旧名审计通过：93 处批准命中、0 未批准、0 失效例外。
- 系统注册变更需要新版原生安装包，不能仅靠 UI OTA 生效；多应用共存时由系统/default-app 选择接收者。
- 本补充未重跑下方整仓测试；下方完整计数属于基础 rebrand 验证，后续改动使用上述定向验证。

## 已验证

| 范围 | 结果 |
| --- | --- |
| 最终全仓测试 | `bun run test:vitest` 退出码 0；1179 文件通过、12 文件跳过；11685 用例通过、56 跳过；耗时 492.08 秒 |
| 品牌生成 | 自包含 `build_b.py` 重建的 14 个 SVG/PNG/JSON 文件与用户交付稿逐字节一致；`trace_b.py` 复现同一轮廓数据 |
| 依赖 | `bun install --frozen-lockfile --ignore-scripts` 通过，无锁文件改动；第一方 workspace 依赖边和 CLI bin 入口解析通过 |
| 类型检查 | 根 `bun run type-check` 的六个 workspace 全部通过 |
| Workspace 构建 | 根 `bun run build` 通过，UI、Web、Electron、Mobile、VS Code 构建退出码均为 0；Web/Mobile/VS Code 输出目录无旧品牌路径 |
| lint | 根 `bun run lint`（包含精确旧名门禁和 repository neutrality）通过，0 error；Web/UI/VS Code 分别有 1/151/19 个 warning |
| 文档站 | 369 页、41 条链接校验通过 |
| VS Code | 根 workspace 模式 40 文件、313 测试通过；完整构建与 VSIX 打包通过 |
| Shared UI | 831 文件、7821 用例通过、45 跳过；随后 OTA 身份契约定向 54 用例通过；真实 Chromium 覆盖 Blob 迁移、事务失败重试、防复活 |
| Electron | 35 文件、241 测试通过；真实 Electron 覆盖旧 origin 的 Blob/草稿/转录、失败续传、新库优先、删除不复活和作用域保留；native bundle 与图标资源生成通过 |
| 桌面 Host 接线 | 显式 source/target Host importer 已接入启动协调入口；10 项 Host/桌面集成、7 项 Electron 回归通过，覆盖 Preview/Dev 隔离、SQLite WAL、凭据、新状态优先及失败重试 |
| 移动原生 | 51 测试通过、1 Photos 实证跳过；Android APK 与 iOS Simulator 主应用和三个扩展构建通过 |
| 移动运行时 | 独立 iOS 26.5 模拟器安装、启动、主屏图标与连接页验证通过；两种冷启动深链未崩溃；已关闭测试设备 |
| Relay | 103 测试与真实编译的 Relay E2E 通过 |
| Web | 全包曾通过 3043 测试并发现一项项目配置路径失败；该项修复后定向 16 文件、418 测试通过，3 skipped；完整 Web 构建通过 |
| 更新服务 | 最终身份隔离版 10 文件、101 测试通过；移动身份与桌面身份/epoch 独立，发布脚本语法和 detectability fixtures 通过 |
| 旧名审计 | `bun run check:legacy-brand` 通过：83 处精确审核的迁移/版权命中，0 未批准，0 失效例外 |
| dead-code | 最后一次构建后运行并审阅：1059 unused files（大量为原生工程复制的生成 Web 资源）、752 exports、605 exported types、6 duplicate exports；未机械删除动态入口或生成资源 |

## 已关闭的集成问题

- 全 workspace 首轮验证在实施中启动，遭遇未完成的 mock 修复和 IndexedDB evidence 失败，持续本地拒连后主动终止，不能记作通过。VS Code 的 SDK mock 问题已修复并在根模式验证。
- Desktop 旧 origin 迁移的两项审查缺陷已修复并补真实 Electron 回归，独立复核确认均已关闭。
- SSH 配置已统一为 `remoteYuri`，历史字段只在读取边界迁移。Mobile OTA 请求从真实 `App.getInfo().id` 获取应用身份；Desktop 的 `dev.yuri.desktop` / epoch 2 已与发布服务对齐，Preview 不使用 release updater。
- 桌面旧 Preview/Dev 内嵌 Host importer 已接通并通过集成回归。完整桌面启动尝试因既有旧应用仍在运行被迁移守卫阻止，未关闭用户应用或绕过守卫。
- [旧名审计](LEGACY_BRAND_AUDIT.md)已接入根 lint；合法历史读取和许可证按完整行、位置、次数记录，现已通过，后续迁移修改仍须保持门禁通过。
- 多项目排查未发现 alias/mock 缓存污染；已显式使用 default reporter 展示进度，并在 UI setup 阻止未 mock 网络请求。六项目最小合跑 95 用例和 UI 非 Chromium 7782 用例通过；最终全仓 11685 用例通过，未遗留失败。

## 未验证或未执行

- npm scope、仓库、VS Code publisher、应用身份、签名和外部服务控制权。
- 真机 APNs/通知点击、原生跨应用沙箱数据恢复、实际 VS Code 安装和生产更新可检测性。
- Windows/Linux 安装运行、发布签名和所有平台新旧应用并存的最终人工验收。
- 未进行远端发布、部署、Git 提交或推送。

移动端详细证据见 [`packages/mobile/REBRAND-VALIDATION.md`](../packages/mobile/REBRAND-VALIDATION.md)，扩展迁移与验证见 [`packages/vscode/MIGRATION.md`](../packages/vscode/MIGRATION.md)。本地测试日志和截图位于 Git 忽略的 `.scratch/yuri-rebrand/`，不会自动随分支提交。
