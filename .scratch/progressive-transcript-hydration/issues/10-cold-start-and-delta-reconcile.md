# 10 — 冷启动缓存首画与差量对账

**What to build:** 冷启动/切回会话时先用本地缓存瞬间画出内容，再与 Host / SSE 逐条比对哈希，只补不一致的消息，避免整页覆盖。

**Blocked by:** 08 — 端侧 transcript store 接口与契约测试；05 — 三阶段水合与骨架离场判据

**Status:** completed — cold-start durable seed、authoritative reconcile、full-over-slim、Activity message materialization

- [x] `TranscriptQueryAdapterDeps.durableStore?`：无 store 或 store 失败时，既有网络路径完全工作。
- [x] `ensureInitial` 在 Query canonical 为空时先 `readSession`；命中后走 `durable-seed` / `materialize-snapshots` 写入 QueryCache，先通知 UI。分页保持 `unknown`，不伪装 `complete:true`。
- [x] 缓存命中后仍走 transport-page Query/retry，再 `http-page purpose: initial` 合并。测试锁定：本地先画、权威尾页仍调用一次；controller 不得把本地页当成完整 authority。
- [x] 已改变且已 applied 的 HTTP / materialize / 非 delta SSE 将 Query 中已 settle 行按 scope 串行写入 durable store。流式 delta、optimistic、未 applied 命令不写盘。
- [x] `message.removed` / `remove-message` → `removeMessage`；destructive reset 先 `clearSession`；`purgeGeneration` → `clearGeneration`。QueryCache LRU `purgeSession` 不删 durable。
- [x] Hash / slim/full / settled 复用 ticket 08 store；QueryCache 数据层对同一 part ID 的 incoming slim 保留 existing full（initial / materialize / recovery / durable-seed）。完整数据仍可覆盖 slim；删除走既有 remove 事件。
- [x] 权威 fetch 失败时缓存留在视图且 boundary 仍为 `unknown`，`getRequestState` 可观察 error；成功后释放 `authorityFlights`，空成功与错误可区分。
- [x] `fetchPreviousPage` 在仅有 durable seed（controller 未建或 boundary=`unknown`）时先走权威 initial，再按权威 cursor prepend；并发 ensure/翻页共用一次尾页请求。
- [x] `mountProductionTranscriptStack` 默认创建 runtime durable adapter；可选 injected `durableStore` 仍优先。stack `destroy` 不清用户 durable cache。
- [x] HTTP adapter 经 `runtimeFetch` 调用 `/api/openchamber/transcript-cache`；501 = miss/disabled，其他失败抛出由 Query 降级。
- [x] runtime 每次操作选择后端：Electron + `isDesktopLocalOriginActive()` → HTTP/SQLite；Web / VS Code / Capacitor / remote desktop → IndexedDB。`clearGeneration` 同步清两个后端。
- [x] Electron `startWebUiServer` 注入 `transcriptCacheDbPath` 到 `userData/transcript-cache.sqlite`。共享 UI 不引用 Electron，也不对 remote host 发送 transcript body。
- [ ] 三阶段水合 / 骨架离场（仍归 05）与按条补取协议（05 anchor / `resetRequired`）未在本切片展开。
- [x] Activity message materialization：展开 Activity 走 `materializeTranscriptMessage` → Query `materializeMessage`（`session.message` + `materialize-snapshots`）；成功 full 进入本切片 durable 写入队列。

## 本切片行为

`packages/ui/src/sync/transcript-durable-store-query.ts` 提供 scope 映射、SSE 分类、按 scope 串行队列（`clearGeneration` 为 generation barrier）。

`ensureInitial` 捕获 transport+generation；await 后再核对 live identity，迟到结果丢弃，不写入新 scope。

`mergeSessionTranscript({ type: "durable-seed" })` 是明确的首画路径：空 canonical 写成 `complete: false` + `cursor: null` 的尾页，`boundaryFromTranscriptData` 为 `unknown`。既有 HTTP `initial` / `materialize` / `reconcile-page` 的 page contract 不变。seed 未真正写入 Query 时回退既有 `controller.ensureInitial()`。

生产默认 `createRuntimeTranscriptDurableStore`：仅 Electron 本地 origin 走 HTTP/SQLite；其余走 IndexedDB。`clearGeneration` 双后端清理。stack destroy 不删盘。

权威对账仍走既有 transport-page / `http-page purpose: initial` / `reconcile-page`；Query 对同一 part ID 的 incoming slim 保留 existing full。Activity 按消息补全成功后的 full 记录同样进入上述串行 durable 队列。

## 验证

- 根级 `bun run test` 通过：UI 4272；Web 1446 passed / 1 skipped + relay e2e 1。
- 根级 type-check / lint 通过。
- Electron `bun run test:transcript-durable-indexeddb` 通过。
