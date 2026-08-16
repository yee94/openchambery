# 13 — 首包内联附件投影

**What to build:** 首包不再内联携带附件正文（base64），只带引用与元信息；正文等 UI 真要渲染时按需取。

**Blocked by:** 04（done）；**07 — 按需补全基础设施（必须先落地，见下方调查结论）**

**Status:** 已完成。Host / VS Code 首包投影、message 级补全、Composer 恢复与客户端图片按可见范围消费均已接通。

> ## 已被 issue 14 降级
>
> 首包轮数从 6 降到 3 之后，窗口只到最新第 35 条，而两个内联截图在第 **37** 与第 **56** 条——**天然避开了**，首包不再包含任何附件。
>
> 因此本工单从「当前最大收益项」变成「大附件恰好落在最新一两轮时才需要」。下面按 turns=6 计算的 68% 占比是**降级前**的数据，保留作为历史依据。

## 为什么曾是最大项（turns=6 时期）

issue 01 实测基准会话 `ses_ffed3d847ffeSinkJbqEGx3SnL` 的首包（turns=6，最新 56 条，共 3728 KB）：

| part 类型 | 个数 | KB | 占比 |
|---|---|---|---|
| **file** | **2** | **2529** | **68%** |
| tool | 111 | 1014 | 27% |
| reasoning | 47 | 161 | 4% |
| 其它 | 130 | 24 | <1% |

那 2 个 `file` 是用户贴的截图，以 base64 内联在 user 消息里，单张 1190 KB / 1339 KB，`mime=image/png`。

03 号投影只处理 tool / reasoning（省 32%），并按设计放行 user 行，所以这 68% 一点没省。**先做这个，收益大于已落地的 02 与 03 之和。**

## 要做的事

- [x] `file` part 首包只保留引用与元信息：part id、`mime`、`filename`、尺寸/字节数；正文 URL 进入按需补全路径。
- [x] 沿用 03 的 slim 契约：投影出的 part 带 `slim` 标记，客户端据此保留图片 visual slot。
- [x] 只作用于首包路径（`before === undefined`）；向上翻页与 reconcile 契约保持原有行为。
- [x] 客户端按需取正文：图片 visual slot 进入可见渲染范围后，通过既有 message 级 `materializeTranscriptMessage` 补全。
- [x] 占位保持固定 `aspect-video`。当前投影缺少可信宽高时采用这一受控比例，slim→full 复用 part identity 与同一 visual slot。
- [x] `packages/vscode` 已有对等首包 file projection。
- [x] Host 投影注释、UI identity / viewport / fallback 代码与本 ticket 共同记录附件投影契约。

## 客户端消费策略（2026-08-16）

- 可见 Chat viewport 使用 `useIntersectionObserver` 启动一次 message 级补全；同一 message 的并发请求继续由 repository single-flight 合并。
- 辅助 surface 缺少 Chat scroll 生命周期时在挂载后启动一次补全，避免扫描或预取整段 transcript。
- slim image 即使没有 URL 也进入 dedupe 与渲染；loading、failure、retry 都留在固定 `aspect-video` slot 内。
- full image 到达后按稳定 part id 替换 slot 内容，并继续使用现有 gallery / popup。
- 非图片 file part 继续保留 filename、mime 与 size 驱动的 chip 表达。

## 调查结论：这不是自足的 Host 改动（2026-08-15）

`file` part 的实际结构是 `{type, mime, filename, url}`，那 1.2–1.3 MB 全在 `url` 里，形如 `data:image/png;base64,...`。剥掉它会打到**三个**消费方，其中两个是静默失败：

1. **图片渲染直接丢 part。** `FileAttachment.tsx:863` 的过滤条件是
   `dedupedFileItems.filter(f => f.mime?.startsWith('image/') && f.url)`。
   没有 `url` 的图片不是显示破图标，而是**整个消失**，正文到了再弹回来 —— 布局跳动，与 06 的视图稳定性直接冲突。
   （非图片 file part 走 `otherFiles`，只显示 filename/mime 的 chip，不受影响。）
2. **编辑消息时附件静默丢失。** `message-composer-restoration-sources.ts` 从已发送的 file part 读 `url` 重建 blob（`values.set(attachmentRefID, blob)`）。首包剥掉之后，用户编辑一条带图的旧消息，附件就没了。**比图片消失更严重。**
3. **图片弹窗 / gallery** 同样依赖 `file.url`（`imageGallery`、`handleImageClick` 都在 `!file.url` 时提前返回）。

### 本地缓存不能救（已否证）

原以为可以直接查本地内容寻址缓存补正文（`filePartDedupeKey` 用 `image:${filename}|${mime}` 作身份，看着像）。查证结果：那套 blob 存储（`message-queue-server-attachment-adapter.ts`、`message-composer-restoration-sources.ts`）服务的是**草稿 / 编辑队列 / composer 恢复的出站附件**，按 `attachmentID` 索引，**不是已发送 transcript 附件的内容缓存**。所以补正文只能走网络。

### 网络通路存在，但不能同步用

`transcript-repository-production.ts:92-131` 已有先例：取完页后用 `findMissingAssistantParentUserIDs` 找缺失的 user 行，再 `loadSessionMessage` → `scopedClient.session.message({sessionID, messageID})` 逐条补回，`loadSessionMessage` 自带去重。SDK **没有**取单个 part 的接口，粒度只能到单条消息。

但该先例是 `await` 在返回之前的。直接套用会把 2.5 MB 放回关键路径，正好抵消本工单的收益。要拿到收益必须「先返回瘦身页，再异步补全并写回」，这就带来：

- 跨 runtime 切换的 generation 守卫（`getRuntimeGeneration` / `getRuntimeKey` 已有先例可循）；
- 与 SSE 写入的排序（04 的 hold 保证 full 不被 slim 覆盖，但冷启动时本地没有 full，所以必须真的取回来）；
- 上面三个消费方统一走同一个「按需取附件正文」入口，否则任一处漏掉就是静默数据丢失。

### 结论

**先做 07 的按需补全基础设施，再做本工单。** 单独落地 Host 侧投影会造成用户可见回归（冷启动图片消失 + 编辑丢附件），因此本工单不应作为「快速收益」抢先落地。Host 侧那段投影本身很短（与 03 的 `projectToolPart` 同构），成本几乎全在客户端的按需补全与三处消费方的收敛。

## 验证

- 首包字节数在基准会话上应从 3728 KB 降到 ~1200 KB（叠加 03 的投影后 ~200 KB 量级）。
- 复现脚本见 `issues/01`「复现」一节，可直接对比投影前后。
