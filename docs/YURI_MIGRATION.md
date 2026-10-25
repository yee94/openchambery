# Yuri 身份迁移与发布状态

## 发布阻塞

本次为新原生应用身份迁移，必须交付完整安装器，不能先投放纯 Web OTA。尚未验证外部所有权，未执行部署、上传、仓库重命名或商店注册。

| 对象 | 候选身份 / 配置 | 发布前证据（发布维护者负责） |
| --- | --- | --- |
| GitHub | `yee94/yuri` | 仓库控制权、Release 权限、重定向与下载验收 |
| npm | `@yuri` | scope 控制权与每个公开包发布权限 |
| VS Code | `yee94.yuri` | publisher 控制权、Marketplace/Open VSX 记录 |
| 移动原生应用 | `com.yee94.yuri` 及平台扩展后缀 | Apple/Android 应用记录、签名、App Group、Keychain、APNs topic |
| 桌面原生应用 | `dev.yuri.desktop` | 桌面签名、安装器及独立 Preview 身份验证 |
| 更新源 | `YURI_OTA_BASE_URL`（CI）、`OTA_BASE_URL`（脚本） | 权威源与镜像域名控制权、TLS、两后端可检测性 |
| EdgeOne 代理 | `YURI_OTA_UPSTREAM_ORIGIN`（部署环境） | 已验证的权威更新 origin；缺失时返回失败 |
| Relay/Push | 各自部署配置 | DNS、镜像权限、推送凭据、端到端连接 |

`example.com` 地址只作示例，不能发布。完成以上证据及原生产物验收后，才可设置仓库变量 `YURI_RELEASE_IDENTITIES_VERIFIED=true` 解锁发布工作流。密钥仍由现有 Secret 管理。发布前为两个后端配置 `OTA_DETECTABILITY_BASES`（逗号分隔）；没有默认线上域名。

## 更新隔离契约

- OTA 请求中的 `applicationId` 来自已安装原生壳：`ios` / `android` 必须为 `com.yee94.yuri`，`desktop` 必须为 `dev.yuri.desktop`；Capgo 使用真实 `app_id`。更新服务不根据版本号推断身份，桌面不能使用移动身份。Preview 禁用 release updater，其身份也不能通过桌面发布门禁。
- 发布脚本为移动 `activeBundle` 写入 `com.yee94.yuri`，为 `activeBundle.desktop` 写入独立的 `dev.yuri.desktop` 和 `minShellApiVersion: 2`，响应 bundle 保留选中平台的身份及 epoch。历史 desktop 记录缺失这些字段时不继承移动字段，返回重新安装要求；同一 manifest 的有效移动包仍可使用。
- 两类请求的 `shellApiVersion` 及其选中 manifest 的 `minShellApiVersion` 均至少为 2，较高的 bundle epoch 继续要求对应新壳。移动发布脚本从 Capacitor 配置读取并校验；Capgo 自动检查未携带自定义 epoch 时，仅新移动 `app_id` 对应初始 epoch 2。桌面 ZIP 的 `desktop-ota.json` 必须为 `applicationId: dev.yuri.desktop`、`shellApiVersion: 2`，否则发布失败。
- 桌面复用上一版本 shell floor，要求 applicationId、epoch 与 shell fingerprint 同时匹配；纯 OTA 发布无法跨壳变更。保留桌面原生版本门禁，以及安装端对 ZIP shell fingerprint 的验证。detectability 使用真实平台身份和 epoch，另测移动身份冒充桌面、缺失身份、Preview 身份及旧 epoch 的拒绝行为。
- 旧壳、缺失身份与错误身份返回 `install_native_required` / `ota.incompatible`，不包含可下载的 bundle。Capgo 得到 `major: true, breaking: true`。新版本不能通过旧壳 OTA 获得新身份。
- 保留 major × channel、shell floor、checksum、rollout 与不自动降级约束；身份门禁在 OTA 判定之前执行。
- 切换顺序：先在旧入口部署拒绝跨身份 OTA 的服务，再验证新安装器，随后投放带身份的新 bundle，最后对两后端运行可检测性检查。旧客户端无法自动跨沙箱升级，需从已验证发布入口安装新壳。入口尚未验证时不编造安装链接。

## 数据与验收

新数据优先，迁移成功前保留旧数据。移动 bundle ID 与扩展 publisher 改变后，凭据、App Group 和应用沙箱不能假定自动继承。发布验收必须包括旧应用导出/新应用导入、重新配对、Electron 旧 origin 草稿与附件、新旧并存、Preview 隔离及真实设备启动。相关实现和逐平台证据由各 runtime owner 交付；本文不将静态改名视为上述验收通过。

## 遗留审计例外

可执行门禁：`bun run check:legacy-brand`（根 lint 自动执行）。逐位置、逐完整行与计数的权威例外清单为 `docs/legacy-brand-exceptions.json`；维护规则见 [旧品牌审计](LEGACY_BRAND_AUDIT.md)。下表仅解释法律与归属类别，不构成目录级豁免。

| 位置 | 类别 / 精确范围 | 负责人 | 退出条件 |
| --- | --- | --- | --- |
| `LICENSE` | 原 MIT 版权作者与许可文本 | 法务/维护者 | 法律要求持续有效，不改写作者历史 |
| `packages/vscode/LICENSE` | 扩展既有版权与许可文本 | 法务/维护者 | 法律要求持续有效，不改写作者历史 |
| 本地 `.scratch/yuri-rebrand/` | 事项旧→新映射与历史盘点，不发布为产品默认配置 | 事项维护者 | 本地事项归档 |

其余 runtime 迁移读取与测试夹具由拥有模块的 agent 在全仓审计中逐项登记，不能以整模块白名单替代审计。旧产品截图不再用于当前 README；新的 UI 截图需在实际 Yuri 产物上重拍。品牌源及重建流程见 `assets/brand/yuri/README.md`。
