# 09 — 原子切换 transcript 到 QueryCache 单写

**What to build:** 将生产 TranscriptRepository 绑定切换到 Query 实现，并在同一集成变更中删除 child-store transcript 数据、分页 boundary、loading refs、prefetch lifecycle、分页 mutation/query wrappers 和旧 loadMore 入口。Session catalog、status、permission、question 保持现有所有权。

**Blocked by:** 02 — 迁移 transcript 读取消费者到 repository；03 — 迁移 transcript 写入路径到 repository；04 — 实现 canonical Transcript InfiniteQuery repository；07 — 实现 Query reconnect compensation controller；08 — 实现 QueryCache transcript LRU 与 destructive reset

**Status:** done (batch 2 core cutover)

- [x] Message、part、cursor、loading、error、optimistic 只有 QueryCache 一个生产权威源（SyncProvider 绑定 Query repository + compensation）。
- [x] Button、scroll、auto-fill 共用 `fetchTranscriptPreviousPage` / Query `fetchPreviousPage`（`cancelRefetch:false`）。
- [x] UI 成功判断读 repository pagination + request state（Chat/Context 已用 `useSessionTranscriptPagination` + `useSessionMessageLoadState`）。
- [x] 生产路径无 `commitReducedTranscriptPage` / `commit-reduced` command；`bindTranscriptRepository(childStores)` 仅 test helper。
- [x] Runtime identity 用 `subscribeRuntimeEndpointChanged`（无 500ms 轮询）；stack 生命周期独立于 directory 切换。
- [x] Binding revision 支持 provider 前订阅 → Query bind 后重订阅；生产 writer 用 `applyTranscriptCommand` / `requireTranscriptRepository`。
- [x] Chat/Context 直接 `fetchTranscriptPreviousPage`；request state 来自 repository；`useSync.loadMore` 已删。
- [x] MemoryDebug 读 Query inventory；dropSessionCaches 非 transcript + purge seam。
- [x] 生产 `State` 无 message/part/boundary；transcript SSE pure reducer；routing/streaming/reconnect 不再扫 store transcript。
- [x] 生产 type-check 通过；owning documentation 与 deepwork 状态更新。
- [ ] 部分 legacy 测试夹具仍在迁移到 repository side-car（不阻塞生产 cutover）。
