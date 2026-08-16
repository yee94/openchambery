# 09 — IndexedDB 与 SQLite 适配器

**What to build:** 按 08 的接口实现两个适配器：Web 用 IndexedDB，Electron / 服务端用 SQLite（与 session index 同目录），两者跑同一套契约测试。

**Blocked by:** 08 — 端侧 transcript store 接口与契约测试

**Status:** completed — IndexedDB、web SQLite、Electron local HTTP/SQLite 与 remote IndexedDB

- [x] IndexedDB 适配器与 Memory 跑同一套 08 契约（两 store 事务驱动；Chromium 上再跑真实 IDB）。
- [x] SQLite 适配器在 `packages/web/server/lib/transcript-cache`（与 session index 同为 Electron `userData`）。UI 不直接引用 better-sqlite3；本地桌面经 `/api/openchamber/transcript-cache` HTTP adapter。
- [x] **不使用 localStorage**（配额不足）。IndexedDB 库名 `openchamber-transcript-durable`。
- [x] SQLite 两表 `transcript_cache_index` / `transcript_cache_content`，身份与 `(time.created, messageID)` 排序对齐 08。
- [x] 附件对象表的内容寻址 + `last_referenced_at` 回收模式作为回收字段的参考实现（索引行持 `contentHash` / `lastAccessedAt` / `byteSize`）。
- [x] 缓存按 `transport + generation + directory + session` 隔离（08 的四元组，比原稿多 `generation`），切换运行时不串数据。
- [x] IndexedDB `onupgradeneeded` 可重复执行：缺 store / index 才建。损坏或打不开时 `database-unavailable`，不阻塞启动（调用方当无缓存）。
- [x] SQLite 无路径 / 501 = disabled；schema mismatch 重建两表。UI HTTP adapter 把 501 当 miss，其他失败抛出让 Query 降级。

## IndexedDB 形状

`packages/ui/src/sync/transcript-durable-store-indexeddb.ts`

两个 object store，同一条 readwrite 事务维护：

- **轻索引 `transcriptIndex`**（`keyPath: id` = scope + messageID）：`sortKey`（`time.created` + `messageID`）、`contentHash`、逐 part / 行级 slim/full、`byteSize`、`lastAccessedAt`、`scopeKey`、`generationKey`。
- **内容 `transcriptContent`**（同一 `id`）：`info` + `parts`。

语义与 Memory 对齐：settled 才写、full 不被 slim 覆盖、同 hash 只刷新访问时间、删除 / 回收后 `readSession` 按复合键重排。半行（有索引无内容或相反）在同事务里修掉。

`fingerprintTranscriptContent` 在事务外算完：`crypto.subtle` 不是 IDB request，放进事务会被 Chromium 自动提交。

隔离测试传 `databaseName`。Bun 契约走 `MemoryTranscriptDurableTwoStoreDriver`（同一事务接口）；真实 Chromium 证据走 Electron 隐藏窗。

## SQLite / HTTP

服务端：`packages/web/server/lib/transcript-cache`。默认 `dbPath` 为 null，远程 Web 不落会话正文。

Electron `startWebUiServer` 注入：

`transcriptCacheDbPath: path.join(app.getPath('userData'), 'transcript-cache.sqlite')`

UI：`transcript-durable-store-http.ts` 只用 `runtimeFetch` 打已落地路由。`transcript-durable-store-runtime.ts` 在 Electron + 本地 origin 选 HTTP，其余选 IndexedDB。`clearGeneration` 同时清两个后端。

## Chromium 证据

三文件结构照 `test-input-draft-indexeddb`：

- `packages/electron/scripts/test-transcript-durable-indexeddb.mjs`
- `packages/electron/scripts/transcript-durable-indexeddb-renderer.ts`
- `packages/electron/scripts/transcript-durable-indexeddb-electron.mjs`

`bun run test:transcript-durable-indexeddb`（`packages/electron`）验证：跨 store 实例重开仍在、完整记录优先、删除与 LRU 回收完整、`destroy` 删库。

## 验证

- 根级 `bun run test` 通过：UI 4272；Web 1446 passed / 1 skipped + relay e2e 1。
- 根级 type-check / lint 通过。
- Electron `bun run test:transcript-durable-indexeddb` 通过。
