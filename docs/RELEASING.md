# 发布运行手册

本手册覆盖 OpenChamber 的正式 GitHub Release。正式 Release 由 `.github/workflows/release.yml` 创建，Android APK/AAB 由它调用的 `.github/workflows/mobile-release.yml` 上传，iOS IPA 会上传到 TestFlight。

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

`release.yml` 在 `v*` tag push 后创建 Draft Release、构建桌面端和移动端、上传产物，再将 Draft Release 发布为正式 Release。Android 流程会生成签名 APK/AAB 并上传到对应 GitHub Release，iOS 流程会上传 IPA 到 TestFlight。

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

Android 客户端通过 `https://api.github.com/repos/yee94/openchamber/releases/latest` 获取最新稳定 Release，并使用第一个 `.apk` asset 的 `browser_download_url` 作为下载地址。

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

`finalize-release` 要求 Draft Release **恰好 21 个**资产，且 Android 版本化文件名必须匹配**当前这次** workflow 的 `github.run_number`：

- `OpenChamber-$VERSION-$RUN_NUMBER-android.aab`
- `OpenChamber-$VERSION-$RUN_NUMBER-android.apk`

同名资产（如 `app-release.apk`、桌面安装包、`latest*.yml`、`.vsix`）上传时会被覆盖；但 Android 版本化文件名包含 `run_number`，**不会**被后续运行覆盖。

因此，只要同一版本经历过多次 Release 运行（先 `workflow_dispatch` 再 tag push、或多次手动重跑），旧的 `-NN-android.*` 会留在 Draft 上。典型报错：

```text
Expected exactly 21 release assets, found 23: ... OpenChamber-1.16.32-72-android.aab, ... OpenChamber-1.16.32-73-android.aab ...
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

3. 清理后资产数应为 21，再只重跑失败的 `finalize-release`（不必整条 Release 全量重跑）：

   ```bash
   gh run rerun <run-id> --repo yee94/openchamber --failed
   ```

4. 若再次全量重跑同版本 Release，会再次产生新的 `run_number` 并追加新的 `-NN-android.*`。**重跑前先删掉旧的版本化 Android 资产**，或接受还要再做一次步骤 2–3。

**预防：**

- 同一 `$VERSION` 优先只走一次入口：tag push **或** 一次 `workflow_dispatch`，不要先手动 dispatch 再建同版本 tag。
- 若某次运行已成功上传 Android、但桌面端失败：优先 `gh run rerun <run-id> --failed`（同一 `run_number`，不会追加新的 `-NN-android.*`），不要另开一次同版本 Release。
- 发布后若 `isDraft=true`，先看 `finalize-release` 是否卡在资产数量/旧 build number，而不是立刻切下一个 patch 版本。

### Windows / Linux `Install dependencies` 失败（镜像解包）

桌面构建偶发在 `bun install` 阶段失败，日志常见从 `mirrors.tencent.com/npm/...` 拉取 `app-builder-bin` 后解包失败。这会导致该平台产物缺失，`finalize-release` 被跳过，Draft 保留。

处理：对**同一次** run 执行 `gh run rerun <run-id> --failed`。若 Android 已上传成功，这种同 run 重跑不会改 `run_number`，一般不会触发上一节的资产膨胀问题。
