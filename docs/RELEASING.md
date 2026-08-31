# 发布运行手册

本手册覆盖 OpenChamber 的正式 GitHub Release。正式 Release 由 `.github/workflows/release.yml` 创建，Android APK/AAB 由它调用的 `.github/workflows/mobile-release.yml` 上传。iOS 外测打板（关联外测组 + Beta App Review）不是默认新版本的一部分。

用户说「发 beta / 更新 beta / 推新版本」时，**默认打 `v*`**，保证 macOS / Windows / Linux / APK 等安装包都在。不要因为 `mobile-release-plan` 是 `ota` 就改打 `mobile-beta/v*`——那条流水线只有 web bundle，没有桌面和 APK。

## 先选产物

1. 看工作区与最近 tag：改动落在哪些包，用户要更新的是手机、桌面，还是两边。
2. 在仓库根目录跑：

   ```bash
   node scripts/mobile-release-plan.mjs --json
   ```

   这份计划用来判断 iOS 要不要上 TestFlight，**不是**用来丢掉桌面或 APK。
3. 按结果选 tag：

| 情况 | 产物 | Tag | 触发 |
|---|---|---|---|
| 默认新版本，纯 web 变更（`mode: "ota"`） | 桌面 macOS/Win/Linux + Android APK/AAB + npm + 同版本 OTA。**不上 iOS / TestFlight**。 | `vX.Y.Z-beta.N` | `release.yml`（含 `mobile-native-targets`） |
| 新版本含原生壳变更（`mode: "native"`，即 break change） | 上行全部 + iOS 内测 TestFlight；端内检测抬 `minShellReleaseVersion` 引导重装 | `vX.Y.Z-beta.N` | `release.yml`（`build_ios` 由 plan mode 决定） |
| 用户明确只要已装手机 App 的 web 热更、不要任何安装包 | 仅 web bundle OTA（无 iOS） | `mobile-beta/vX.Y.Z-beta.N` | `mobile-beta-ota.yml` |
| 稳定版 | 桌面 + Android APK/AAB + npm + 同版本 OTA + iOS TestFlight（关联外测组 + Beta App Review） | `vX.Y.Z` | `release.yml`（`build_ios: true`） |
| 仅 Relay 服务（npm + Docker） | 只发 `@openchambery/relay-server` 与 Relay Docker。**不**触发桌面、Android、iOS/TestFlight、OTA。 | `relay/vX.Y.Z` 或 `relay/vX.Y.Z-beta.N` | `relay-release.yml`（复用 `relay-docker.yml`） |
| 稳定通道同等判定 | 上表把 `beta` 换成 `stable`，默认新版本用无后缀 `vX.Y.Z`；仅热更用 `mobile-stable/vX.Y.Z` | 同上 | 同上 |

**TestFlight 跟随「是否需要原生壳」，不跟随 tag**：`mode: native` 的 beta 与所有稳定版上传 iOS（beta 仅内测，稳定版关联外测组）；`mode: ota` 的 beta 不碰 iOS。**端内一键更新 vs 跳转重装由 `activeBundle.minShellReleaseVersion`（版本语义）决定，与 OTA 发布是两条独立链路**：只有 `mode: native` 把下限写成**本轮发布版本号**；`github.run_number` / `nativeBuild` 只用于 TestFlight/商店记账，**不再参与端内更新判定**。稳定版也不因发了安装包而抬门。

默认 `v*` 仍会产出桌面与 APK；同版本 web bundle 由 `mobile-native-targets` 写入 OTA 通道。`mobile-beta/v*` / `mobile-stable/v*` 才是「只有 OTA、没有安装包」。`relay/v*` 是独立命名空间，只发 Relay npm 与 Docker，不会走 `release.yml`。

仅当用户明确只要 OTA、不要安装包时，才只打 OTA tag，且不要同时打 `v$VERSION`。OTA 版本必须**高于**当前通道 `activeBundle.releaseVersion`。`version:bump` 与 `CHANGELOG.md` 两路都要写。

资格细则与 OTA 步骤见下文 `Mobile OTA releases`。

## 发布前检查

设定版本号：

```bash
VERSION=1.15.8
```

1. 用统一脚本更新各发布包版本：

   ```bash
   bun run version:bump -- "$VERSION"
   ```

2. 在 `CHANGELOG.md` 的 `[Unreleased]` 下方新增正式版本段落：

   ```md
   ## [1.15.8] - YYYY-MM-DD

   - 面向用户的改动说明。
   ```

   `release.yml` 会校验此段落；版本号、tag 和 changelog 标题应保持一致。

3. 执行发布前验证：

   ```bash
   bun run release:prepare
   ```

4. 检查提交内容，创建发布提交和 tag：

   ```bash
   git status
   git diff --check
   git add package.json packages/ui/package.json packages/web/package.json packages/electron/package.json packages/vscode/package.json CHANGELOG.md
   git commit -m "release: v$VERSION"
   git tag "v$VERSION"
   ```

## 触发发布

tag 是正式发布的标准入口。精确推送当前 tag，避免把本地历史 tag 一并推送：

```bash
git push origin main
git push origin "v$VERSION"
```

`release.yml` 在 `v*` tag push 后创建 Draft Release、构建桌面端和 Android、上传产物，将 `@openchambery/web` 与 `@openchambery/relay-server` 发布到 npm，再将 Draft Release 发布为正式 Release。Android 流程会生成签名 APK/AAB 并上传到对应 GitHub Release。同版本 web bundle 由 `mobile-native-targets` 写入 OTA。**iOS/TestFlight 由 `mobile-release-plan` 的 mode 决定**：`mode: native` 的 beta 与所有稳定版构建并上传 iOS（beta 走内测、不关联外测组、不提 Beta App Review；稳定版额外关联外测组）；`mode: ota` 的 beta 与 `mobile-beta/*` OTA-only tag 不构建 iOS。iOS 上传失败会拖住 `mobile-native-targets`（同版本 OTA 发布），用 `gh run rerun <run-id> --failed` 重跑即可。

npm 发布需要仓库 Secret `NPM_TOKEN`（对 `@openchambery` scope 有 publish 权限）。稳定版发到 `latest`；含 `-` 的 prerelease 使用 `--tag beta`，不会覆盖 `latest`。`dry_run=true` 会跳过 npm 发布。SSH 远程预装与 `scripts/install.sh` 安装的都是 `@openchambery/web`。完整 `v*` 仍会同时发布 `@openchambery/web` 与 `@openchambery/relay-server` 以及 Relay Docker；只发 Relay 时改用 `relay/v*`（见下文）。

### Beta / prerelease

这是 Agent / 发布命令的强制规矩，不只是建议。带 semver 预发布后缀的版本（任意含 `-` 的版本，推荐 `X.Y.Z-beta.N`，如 `1.16.94-beta.2`）必须与稳定自动更新通道隔离。

**判定**

| 形式 | 类型 | 自动更新 |
|---|---|---|
| `1.16.95` | 稳定正式版 | 可以进入 `/releases/latest` 与 Vercel update feed |
| `1.16.95-beta.1` / `1.16.95-rc.1` | prerelease | **禁止**进入稳定自动更新 |

**发布时必须**

1. 使用 `X.Y.Z-beta.N`（或其它 semver prerelease）形式；禁止把 beta 内容打成无后缀的 `X.Y.Z`。
2. 依赖 `release.yml`：含 `-` 的版本创建/发布 GitHub Release 时设置 `prerelease: true`，从而**不会**成为 `/releases/latest`。
3. 依赖 finalize-release **跳过** `deploy/update-service/release-manifest.json` 写入；`write-release-manifest.mjs` 对 prerelease 直接 exit 0。Agent 不得手工把该 manifest 改成 beta 版本并推送。
4. 保持 Electron `autoUpdater.allowPrerelease = false`（稳定客户端不订阅 prerelease）。
5. beta `v*` 是否上传 iOS 由 plan mode 决定：`mode: native`（需要原生壳）**必须**上传 iOS 到 TestFlight 内测；`mode: ota`（常规 web-only beta）**不构建、不上传 iOS**。**禁止**把 prerelease 构建关联到已有外测组或提交 Beta App Review（外测组仅稳定版）。iOS 上传失败只影响内测可见性，重跑 `--failed` 即可；桌面 / APK / npm 不受影响。

**发布时禁止**

- `gh release edit v…-beta… --latest`，或去掉 beta 的 prerelease 标记（除非用户明确要求把该版本升格为正式版）。
- 把 beta 版本写入 `release-manifest.json`，或手动上传/覆盖稳定通道上的 `latest.yml` / `latest-mac.yml` / `latest-linux*.yml` 指向 beta。
- 假设 “版本号里有 beta 字样就够了”——GitHub Latest 与 Vercel desktop feed 只认 **是否 prerelease**，不认名字。

**通道说明**

- 桌面 Vercel `/desktop/latest*.yml` 代理 `https://github.com/yee94/openchamber/releases/latest/download/…`。
- Android 最新 APK 同样读 `/releases/latest`。
- Web / VS Code / Capacitor 的 JSON 更新检查读 `release-manifest.json`（只应含最新稳定版）。
- 用户从 Release 页**手动下载** beta 安装包不受影响；被隔离的只有稳定客户端自动更新。

**误发恢复**

若 beta 已变成 Latest 或已污染 update feed：

```bash
gh release edit "v$BETA_VERSION" --prerelease --repo yee94/openchamber
gh release edit "v$STABLE_VERSION" --latest --repo yee94/openchamber
# 如 release-manifest.json 已被写成 beta，改回最新稳定版并推送 main
```

然后确认：

```bash
gh api repos/yee94/openchamber/releases/latest --jq .tag_name   # 应为稳定版
curl -sS https://openchamber-update.vercel.app/desktop/latest-mac.yml | head -3
```

Agent 入口命令：`.opencode/commands/release.md`。

### Relay-only releases（`relay/v*`）

只发布 `@openchambery/relay-server` 与 Relay Docker 时，打独立 tag，不要打普通 `v*`。`relay/v*` **不会**创建 GitHub Release，也**不会**跑桌面、Android、iOS/TestFlight 或 OTA。

| Tag | npm dist-tag | Docker | 其它产物 |
|---|---|---|---|
| `relay/vX.Y.Z` | `latest` | `relay-docker.yml` 多平台镜像（`:version` + `:latest`） | 无 |
| `relay/vX.Y.Z-beta.N`（任意含 `-` 的 prerelease） | `beta` | 同上 | 无 |

版本从 tag 解析（去掉 `relay/v` 前缀），必须**严格等于** `packages/relay-server/package.json` 的 `version`。根目录 `package.json` 不必一致。普通 `v*` 路径仍要求根版本与 Relay 包版本一致。

```bash
VERSION=1.19.0-beta.37
# 先让 packages/relay-server/package.json 的 version 等于 $VERSION 并提交
git tag "relay/v$VERSION"
git push origin "relay/v$VERSION"
```

`relay-release.yml` 会校验 tag / 包版本、要求 `NPM_TOKEN`，再并行发布 npm 与 Docker。Docker 复用 `.github/workflows/relay-docker.yml`（`linux/amd64` + `linux/arm64`），并关闭根版本匹配。Secrets / variables 与完整 release 相同：`NPM_TOKEN`、`DOCKERHUB_TOKEN`、`DOCKERHUB_USERNAME`。

手动验证（不发 npm、Docker 只构建不推送）：

```bash
gh workflow run relay-release.yml \
  --repo yee94/openchamber \
  --ref main \
  -f version="$VERSION" \
  -f dry_run=true
```

查看运行：

```bash
gh run list --repo yee94/openchamber --workflow relay-release.yml --limit 3
gh run watch <run-id> --repo yee94/openchamber
```

仅镜像重发、不发 npm 时，仍可直接跑 `Relay Docker` workflow，或 `release.yml` 的 `relay_only`（那两条会校验根版本与 Relay 包版本都匹配）。

### iOS 外测自动发布

在 GitHub 仓库的 **Settings → Secrets and variables → Actions → Variables** 设置：

- `TESTFLIGHT_EXTERNAL_BETA_GROUP_ID`：App Store Connect 外测群组 UUID。

稳定版 `mobile-release.yml` 会把 iOS 构建关联到这个固定外测群组。群组的 TestFlight Public Link 保持不变；Apple 批准新的 Beta App Review 后，该链接会自动提供最新获准构建。prerelease / `-beta` 构建只上传到 TestFlight 内测，不写入该外测组。

CI 每次关联新构建后保留外测组最近三个构建，并通过 App Store Connect API 移除更旧的组关联。Apple 的 TestFlight App Review 采用滚动 24 小时提交额度；额度耗尽时构建保持在外测组并记录为 `deferred-submission-limit`，GitHub Release 继续完成，后续构建在额度恢复后重新提交。

手动运行 `release.yml` 时，提供版本号；该 workflow 会执行桌面端和 Android 发布。`dry_run=true` 会保留 Draft Release，用于验证构建和产物：

```bash
gh workflow run release.yml \
  --repo yee94/openchamber \
  --ref main \
  -f version="$VERSION" \
  -f dry_run=true
```

Android 构建依赖以下 GitHub Secrets：

- `ANDROID_KEYSTORE_BASE64`
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`

## 发布验证

查看 Release workflow：

```bash
gh run list --repo yee94/openchamber --workflow release.yml --limit 3
gh run watch <run-id> --repo yee94/openchamber
```

发布完成后确认 Release 状态和 Android 资源：

```bash
gh release view "v$VERSION" --repo yee94/openchamber
gh release view "v$VERSION" --repo yee94/openchamber --json isDraft,isPrerelease,assets
```

正式 Release 应满足以下结果：

- `isDraft` 为 `false`。
- assets 包含 `.apk` 和 `.aab`。
- 最新稳定 Release 的 APK asset 具有 `.apk` 后缀。
- npm 上存在 `@openchambery/web@$VERSION` 与 `@openchambery/relay-server@$VERSION`（稳定版在 `latest`，prerelease 在 `beta`）。

Android 客户端通过 `https://api.github.com/repos/yee94/openchamber/releases/latest` 获取最新稳定 Release，并使用第一个 `.apk` asset 的 `browser_download_url` 作为下载地址。

iOS 客户端通过更新 API 或 GitHub 回退获取版本信息后，使用固定外测 Public Link 安装：`https://testflight.apple.com/join/ZCENBHtm`。CI 每次上传会把新构建关联到 App Store Connect 外测群组；Apple 批准 Beta App Review 后，该链接自动提供最新获准构建。

## 常见恢复路径

### `Extract changelog for release` 失败

补充匹配版本号的 `CHANGELOG.md` 段落，提交并推送到 `main`，然后手动重跑 `release.yml`。该 workflow 会在当前 `main` 提交上构建同版本 Release。

**手动重跑命令**（当前 workflow 接受必填 `version` 与可选 `dry_run`）：

```bash
gh workflow run release.yml \
  --repo yee94/openchamber \
  --ref main \
  -f version="$VERSION"
```

**日志查看**（避免上下文污染，不在此对话里拉取和解析 log 原文）：

```bash
gh run list --repo yee94/openchamber --workflow release.yml --limit 3
gh run view <run-id> --repo yee94/openchamber
# 只看失败步骤的日志摘要，不拉全量 log
gh run view <run-id> --repo yee94/openchamber --log-failed | tail -50
```

### Android job 未执行

tag push 会包含 mobile-release。手动触发时使用 `release_scope=all`。运行详情中的 `mobile-release` job 应显示 `success`，其中的 `Upload Android artifacts to GitHub Release` 步骤应显示 `success`。

### Android APK 未出现在 Release assets 中

检查 `mobile-release` 的 `Build signed Android release`、`Upload Android artifacts` 和 `Upload Android artifacts to GitHub Release` 三个步骤。前两个步骤产出 APK/AAB，第三个步骤通过 `gh release upload` 附加到 Release。

### `finalize-release` / `Verify complete release asset inventory` 失败

`finalize-release` 要求 Draft Release **恰好 16 个**资产（mac/win/linux 安装包与 `latest*.yml`，加上 `app-release.aab` / `app-release.apk` 与当前 `run_number` 的版本化 Android 两个文件），且 Android 版本化文件名必须匹配**当前这次** workflow 的 `github.run_number`：

- `OpenChamber-$VERSION-$RUN_NUMBER-android.aab`
- `OpenChamber-$VERSION-$RUN_NUMBER-android.apk`

同名资产（如 `app-release.apk`、桌面安装包、`latest*.yml`）上传时会被覆盖；但 Android 版本化文件名包含 `run_number`，**不会**被后续运行覆盖。

因此，只要同一版本经历过多次 Release 运行（先 `workflow_dispatch` 再 tag push、或多次手动重跑），旧的 `-NN-android.*` 会留在 Draft 上。典型报错：

```text
Expected exactly 16 release assets, found 18: ... OpenChamber-1.16.32-72-android.aab, ... OpenChamber-1.16.32-73-android.aab ...
```

**v1.16.32 实况：** 第一次 `workflow_dispatch` 已上传 build `72` Android 资产；后续 tag push 运行号变成 `73` 又上传一套；`finalize` 因多出旧资产失败，Draft 无法转正式。

**恢复步骤：**

1. 确认 Draft 仍在，并找出应保留的最新 Android build number（通常等于失败那次 run 的 `run_number` / 日志里的 `BUILD_NUMBER`）：

   ```bash
   gh release view "v$VERSION" --repo yee94/openchamber
   gh run view <run-id> --repo yee94/openchamber --log-failed | tail -80
   ```

2. 删除同版本下**过期**的 Android 版本化资产（保留最新 `run_number` 那一套，以及 `app-release.aab` / `app-release.apk`）：

   ```bash
   # 列出资产与 id
   gh api "repos/yee94/openchamber/releases/tags/v$VERSION" --jq '.assets[] | {id,name}'

   # 删除过期的版本化 Android 资产（示例：去掉 72，保留 73）
   gh api -X DELETE "repos/yee94/openchamber/releases/assets/<asset-id>"
   ```

3. 清理后资产数应为 16，再只重跑失败的 `finalize-release`（不必整条 Release 全量重跑）：

   ```bash
   gh run rerun <run-id> --repo yee94/openchamber --failed
   ```

4. 若再次全量重跑同版本 Release，会再次产生新的 `run_number` 并追加新的 `-NN-android.*`。**重跑前先删掉旧的版本化 Android 资产**，或接受还要再做一次步骤 2–3。

**预防：**

- 同一 `$VERSION` 优先只走一次入口：tag push **或** 一次 `workflow_dispatch`，不要先手动 dispatch 再建同版本 tag。
- 若某次运行已成功上传 Android、但桌面端失败：优先 `gh run rerun <run-id> --failed`（同一 `run_number`，不会追加新的 `-NN-android.*`），不要另开一次同版本 Release。
- 发布后若 `isDraft=true`，先看 `finalize-release` 是否卡在资产数量/旧 build number，而不是立刻切下一个 patch 版本。

### `finalize-release` / `Publish release` 失败（`tag_name already_exists`）

症状日志：

```text
↪️ Using release <draft-id> for tag vX.Y.Z instead of duplicate draft <new-id>
error finalizing release: ... "already_exists","field":"tag_name"
```

根因：`softprops/action-gh-release` 在 `draft: false` + 仅 `tag_name` 时可能**新建**一个空的 published Release，再试图 undraft 已有资产的 draft，于是同 tag 撞车。仓库里会出现：

- 一个 **draft**（含完整桌面/Android 资产，名称通常为 `OpenChamber vX.Y.Z`）
- 一个 **published 空 Release**（0 assets，名称常为 `vX.Y.Z`）

当前 workflow 已改为对 `create-release` 输出的 `release_id` 做 `PATCH draft=false`，避免再创建。

若历史 run 已留下重复 Release：

```bash
# 列出同 tag 的 draft / published
gh api repos/yee94/openchamber/releases --jq '.[] | select(.tag_name=="v'"$VERSION"'") | {id,tag:.tag_name,name,draft,assets:(.assets|length)}'

# 删除空的 published 重复项
gh api -X DELETE "repos/yee94/openchamber/releases/<empty-published-id>"

# 将含资产的 draft 正式发布（beta 保持 prerelease=true）
gh api --method PATCH "repos/yee94/openchamber/releases/<draft-id>" -F draft=false -F prerelease=true
```

不要对已成功上传资产的同版本再开一次全量 Release；修好重复项后，后续新版本走正常 tag push 即可。
### Windows / Linux `Install dependencies` 失败（镜像解包）

桌面构建偶发在 `bun install` 阶段失败，日志常见从 `mirrors.tencent.com/npm/...` 拉取 `app-builder-bin` 后解包失败。这会导致该平台产物缺失，`finalize-release` 被跳过，Draft 保留。

处理：对**同一次** run 执行 `gh run rerun <run-id> --failed`。若 Android 已上传成功，这种同 run 重跑不会改 `run_number`，一般不会触发上一节的资产膨胀问题。

## Mobile OTA releases (beta + stable)

Capacitor 移动端支持 **web bundle OTA**（Capgo-style，自托管在 update-service / EdgeOne）。原生壳变更仍走完整 `v*` 发布。**beta 与 stable 两个通道均已 OTA 可用**：各自独立 manifest，壳在 `mobile:sync` 时通过 `OPENCHAMBER_OTA_CHANNEL` 烘焙通道。

### Tag 命名空间

| Tag | 含义 | Workflow |
|---|---|---|
| `mobile-beta/vX.Y.Z-beta.N` | 仅发布 **beta** 通道 web bundle OTA | `.github/workflows/mobile-beta-ota.yml`（name: Mobile OTA Release） |
| `mobile-stable/vX.Y.Z` | 仅发布 **stable** 通道 web bundle OTA | 同上 |
| `vX.Y.Z-beta.N` / `vX.Y.Z` | 完整原生壳 + 桌面等正式发布 | `.github/workflows/release.yml` → `mobile-release`（`ota_channel`：beta / stable） |
| `relay/vX.Y.Z` / `relay/vX.Y.Z-beta.N` | 仅发布 Relay npm + Docker | `.github/workflows/relay-release.yml`（调用 `relay-docker.yml`） |

OTA tag 会创建 **GitHub prerelease**（`mobile-beta/v…` 或 `mobile-stable/v…`），仅作灾难恢复归档（zip + 对应 channel json）。**禁止**成为 `/releases/latest`，也**禁止**写入稳定桌面/Android 自动更新 feed。

### 客户端可检测性验证（detectability probe）

每次 OTA 发布部署后，CI 会用 `scripts/mobile-ota/verify-detectability.mjs` 对 **Vercel 与 EdgeOne 两个客户端入口** 探活 `POST /v1/mobile/update/check`，任一失败即让发布 fail（带 ~3 分钟边缘缓存重试）。脚本先断言**双 fixture**（新式版本门 / 存量无门），再打线上。设备优先打 EdgeOne，只探 Vercel 会漏掉国内入口的 resolver 回归。

**Fixture A**（manifest 带 `minShellReleaseVersion: "1.18.3"`，active `1.18.3-beta.2`）：

1. **旧 iOS 壳**：`nativeVersion: "1.18.2"`（剥离）+ `currentBundleId: "builtin"` → `install_native_required`
2. **旧 Android 壳**：`currentBundleId: "1.18.2-beta.50"` → `install_native_required`
3. **新壳**：`currentBundleId: "1.18.3-beta.1"`、`nativeBuild: 21`（故意很小）→ `apply_ota`（证明 build 号不再参与判定）
4. **已在包上**：`currentBundleId: "1.18.3-beta.2"`（= active releaseVersion）→ `none`

**Fixture B**（存量 manifest，无 `minShellReleaseVersion`）：`nativeBuild: 21` + 旧 web 版本 → `apply_ota`（无门放行；即便遗留 `platforms.*.minNativeBuild` 也不再抬门）。

线上探活的四画像沿用同一套版本门语义：有 `minShellReleaseVersion` 时旧壳重装，无门时旧壳 `apply_ota`；`nativeBuild` 故意填小以回归「两把计数器错位」类误判。

这保证「发布了」等于「客户端检测得到」：灰度桶、版本门抬升、降级保护、iOS 剥离版本号等任一环节回归都会在发布时暴露，而不是等用户设备发现。本地可手动跑同款验证（`--fixtures-only` 只验画像表）。

### 通道烘焙（shell channel）

- `packages/mobile/capacitor.config.ts` 在构建时读 `OPENCHAMBER_OTA_CHANNEL`：`stable` → stable，其它/缺省 → beta。写入 `OpenChamberOTA.channel` 与 `CapacitorUpdater.defaultChannel`。
- `release.yml` 调用 `mobile-release` 时：含 `-` 的 prerelease → `ota_channel: beta`；纯 semver → `ota_channel: stable`。
- 默认构建（TestFlight / 侧载）保持 beta；商店稳定壳走 stable。
- 运行时覆盖（用户开关）：设置 → 关于里的「加入 Beta 更新渠道」开关把 `otaChannelOverride`（`useUIStore`，localStorage 持久化）写入 `beta`/`stable`，检查请求按 `override ?? 烘焙值` 生效。设备从 beta bundle 切回 stable 时，更新服务允许跨渠道回退（决策带 `isChannelRollback: true`，见 `deploy/update-service/README.md`），客户端确认后走正常 OTA 下载/重启流程。

### OTA 资格（eligibility）

打 `mobile-beta/*` / `mobile-stable/*` 前在仓库根目录运行：

```bash
node scripts/mobile-release-plan.mjs --json
```

- `mode: "ota"`：允许 OTA。
- `mode: "native"`：必须改用普通 `v*` tag。

判定规则：

1. **Native fingerprint**：相对最近的 `vX.Y.Z` / `vX.Y.Z-beta.N` tag，`packages/mobile/ios/**` 与 `packages/mobile/android/**` 是否有变更。下列 **生成物** 不计入 fingerprint：
   - `ios/App/App/capacitor.config.json`
   - `ios/App/Podfile.lock`
   - `android/app/src/main/assets/capacitor.config.json`
   - `android/capacitor.settings.gradle`
   - `android/app/capacitor.build.gradle`
   - `capacitor.config.ts` **也不**计入（可热更新 OTA 配置）；桥接安全由 contracts 保证。`android/variables.gradle` **计入** fingerprint（手写配置）。
2. **Bridge contracts**：`packages/mobile/contracts/` 声明各自定义插件的 method/event 表面，脚本会与 Swift/Java 源码比对。任一缺失/多余 → `bridge_contract_changed` → 必须原生发布。

### OTA 发布流程

1. 确认 `mobile-release-plan` 为 `ota`。
2. 打并推送 tag（示例）：

   ```bash
   git tag "mobile-beta/v1.18.2-beta.26"
   git push origin "mobile-beta/v1.18.2-beta.26"
   # 或 stable：
   git tag "mobile-stable/v1.18.3"
   git push origin "mobile-stable/v1.18.3"
   ```

3. `mobile-beta-ota.yml`（Mobile OTA Release）：
   - `release-plan`：从 tag 推导 `CHANNEL`（`mobile-beta/` → beta，`mobile-stable/` → stable）与 `VERSION`；再次校验资格；非 ota 则失败并提示改用 `v*`。
   - `build-ota`：`bun run --cwd packages/mobile build`（web 构建 + prepare，**不含** `cap sync`）→ `@capgo/cli bundle zip` → 可选 `CAPGO_PRIVATE_KEY_V2` 加密 → 24 MiB 上限 → `scripts/mobile-ota/assemble-snapshot.mjs --channel $CHANNEL`。默认灰度：双通道均 `100`（可 `workflow_dispatch` 覆盖 `rollout_percent`）。
   - `deploy`：对 `deploy/update-service` 做 Vercel pull / `vercel build --prod` / 将 **完整** snapshot 的 `ota/` 覆盖进 `.vercel/output/static/ota/` / `vercel deploy --prebuilt --prod`，再 curl 校验 **两个** channel manifest（`beta.json` + `stable.json`）以及目标 channel 的 bundle。
   - `archive`：GitHub **prerelease** 挂 zip 与对应 channel json。

端点契约见 `deploy/update-service/README.md`（`/ota/channels/{beta,stable}.json`、`/ota/bundles/<id>.zip`、`POST /v1/mobile/update/check`）。仓库内种子：`deploy/update-service/ota/channels/beta.json` 与 `stable.json`。

### Full-snapshot 部署与并发

Vercel/EdgeOne 部署会 **整包替换** 静态输出。因此每次 assemble / rollout snapshot 必须包含：

- 目标通道的新 manifest + 其 active/rollback zip
- **另一通道** 的线上 manifest 镜像（404 → 写入 null-seed，避免删掉对方通道）+ 其引用的 zip

OTA release 与 rollout 共用 concurrency group `mobile-ota-production`（`cancel-in-progress: false`），串行化所有生产 OTA 部署，避免 beta/stable 交错部署时用过期镜像覆盖新近写入的另一通道。

### 灰度 / 暂停 / 回滚 / 跨通道 promote

GitHub Actions → **Mobile Beta OTA Rollout**（`mobile-beta-rollout.yml`）`workflow_dispatch`：

| action | 作用 |
|---|---|
| `promote` | 设置指定 `channel` 的 `activeBundle.rolloutPercent` |
| `pause` | `rolloutPercent = 0` |
| `rollback` | 将 `rollbackBundleIds[0]` 升为 active，当前 active 退入 rollback 队列（最多保留 2 个） |
| `set-native-target` | 更新 `nativeTargets.ios|android` |
| `set-min-shell-release-version` | 设置或清除 `activeBundle.minShellReleaseVersion`（传空字符串清除）。端内「一键 OTA」vs「跳转重装」的版本门 |
| `set-min-native-build` | **DEPRECATED**。设置 `activeBundle.platforms.<platform>.minNativeBuild`（可升可降）。服务端判定已不再读取该字段；仅保留用于修复线上存量 manifest |
| `promote-channel` | 将 `--from`（通常 beta）已验证的 activeBundle **原样**拷到 `--to`（通常 stable），仅换 `rolloutSalt` / `rolloutPercent`（默认 100）；内容寻址 zip 可复用 |

本地等价（写出 snapshot，再由 CI/人工部署）：

```bash
node scripts/mobile-ota/rollout.mjs --action pause --channel beta --out /tmp/ota-snap
node scripts/mobile-ota/rollout.mjs --action promote --channel stable --percent 25 --out /tmp/ota-snap
node scripts/mobile-ota/rollout.mjs --action rollback --channel beta --out /tmp/ota-snap
node scripts/mobile-ota/rollout.mjs --action promote-channel --from beta --to stable --percent 100 --out /tmp/ota-snap
```

`release.yml` 在 `mobile-release` 成功后还会跑 `mobile-native-targets`：先把**本轮同版本 web bundle** 写成该通道的 `activeBundle`。壳门下限字段是 `activeBundle.minShellReleaseVersion`（版本语义，端内「一键 OTA」vs「跳转重装」的分界）**只由 `mode: native` 决定**，与是否发布 OTA / 安装包解耦：`mode: ota` 时不新写门（透传既有门），已装且满足门的壳继续走 `apply_ota`；`mode: native` 时写成**本轮发布版本号** `$VERSION`。`github.run_number` 仍用于 `nativeTargets.*.build` / 资产命名，但**不再参与端内更新判定**。`nativeTargets.ios` 仅在本轮实际上传了 iOS（native beta / 稳定版）时前移，`nativeTargets.android` 仅 `mode: native` 时前移。客户端是否打开外链只看检查协议的 `primaryAction` + `native.installUrl`，不要本地拼 GitHub。

稳定版与 beta `v*` 都会前移指针。后续纯 web 的 `mobile-beta/*` / `mobile-stable/*` 仍可单独发更高版本 OTA；assemble 会拒绝比当前 active 更旧的包。

### 加密与体积门禁

- 可选 Secret `CAPGO_PRIVATE_KEY_V2`：存在时对 zip 做 Capgo encryption v2，manifest 写入 `sessionKey` + 加密载荷 checksum（CLI 产出的 opaque 字符串，不可重算）。
- 无密钥时走明文 zip，`checksum` 为 **纯 64 位 hex（无 `sha256:` 前缀）**——原生插件按字面值比较自身摘要，带前缀会导致下载校验失败。脚本会自动剥掉输入的前缀。
- 检查端点对加密 bundle 同时返回 `session_key` 与 `sessionKey` 两个键：Android 解析 `sessionKey`，iOS 解析 `session_key`。
- 回滚加密 bundle 属于已知限制：回滚 zip 只能携带明文摘要，配置了公钥的壳无法校验，会自动回退到上一个成功 bundle。
- zip **必须 < 24 MiB**；超限失败并提示迁移 COS。CI 只部署 Vercel（权威源）；EdgeOne（`openchamber.xiaobe.top`，国内入口）由 git 自动部署 + 边缘反向代理跟随 Vercel，无需 CI 双发。服务端 bundle 分发支持 HTTP Range 断点续传（EdgeOne 代理已透传 `Range` / `Content-Range`，部分响应不落边缘缓存）。
- 反向代理路径为**白名单**：`/ota/channels/*.json`、`/ota/bundles/*.zip`、`/CHANGELOG.md`。前两者是 OTA 快照，第三者承载客户端更新日志——CHANGELOG 若不经代理，EdgeOne 就会一直吐自己 git 部署时的旧文件，客户端更新对话框的「更新内容」会整段消失（按分支发版时必现，因为 `main` 上没有那些段落）。代理路径必须精确匹配，不能放宽成通配符。
- EdgeOne 构建**不得**输出静态 `CHANGELOG.md`（`OPENCHAMBER_UPDATE_SKIP_CHANGELOG_COPY=1`，已写进 `deploy/update-service/edgeone.json`）：EdgeOne 上静态资源会遮蔽同名 edge function，输出了静态文件代理就永远不生效。Vercel 仍需静态文件，它是权威源。

### 通道隔离保证

- OTA 只写 `/ota/channels/{beta,stable}.json` 与 `/ota/bundles/*`，不修改 `release-manifest.json` 或 `/desktop/latest*.yml`。
- `mobile-beta/*` / `mobile-stable/*` GitHub Release 始终 `prerelease: true`，不会成为 Latest。
- 拉取线上 manifest 时：HTTP **404** 可从 generation 0 起步（并仍镜像另一通道）；**5xx / 其它错误必须中止**，禁止静默清空线上通道。

### 灾难恢复

1. GitHub prerelease `mobile-beta/v…` / `mobile-stable/v…` 上的 zip + channel json 可重新 assemble / 手动 overlay。
2. `mobile-beta-rollout.yml` → `rollback` 将上一 generation 的 bundle 重新激活（内容寻址 zip 会从生产拉回 snapshot）。
3. 若 Vercel 部署把旧 bundle 冲掉，assemble/rollout 脚本都会把 **双通道** active + rollback zip 重新拉进 snapshot 再 deploy。
