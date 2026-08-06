# 08 — 实现 QueryCache transcript LRU 与 destructive reset

**What to build:** 将 transcript 生命周期收敛到 QueryCache。Active transcript 保留全部已加载页；inactive transcript 按平台容量和 dataUpdatedAt 淘汰；delete、revert、unrevert、session eviction 与 runtime switch 取消相关 queries 并重建权威 tail。

**Blocked by:** 04 — 实现 canonical Transcript InfiniteQuery repository

**Status:** done

- [x] Desktop、mobile、VS Code 使用各自现有 session 容量目标。
- [x] Observer 活跃的 transcript 保持完整 pages。
- [x] 淘汰会清理 canonical、transport-page、tail/reconcile task 和 checkpoint keys。
- [x] Destructive mutations 清理旧 cursor 链并 ensure 新 tail。
- [x] LRU 操作计数和长时间缓存增长测试覆盖容量边界。

## Implementation notes

- `packages/ui/src/sync/session-cache-limits.ts` — shared VS Code=4 / mobile=12 / default=40.
- `packages/ui/src/sync/session-transcript-query-cache.ts` — key families, active registry, budget, purge, destructive reset.
- Query adapter wires retain on `subscribe`, enforce after ensure/write, `destructiveReset` / `purgeSession` / `getCacheBudget`.
- Production binding remains store adapter (Ticket 09 cutover).
- Ticket 07 should import key-family helpers from `session-transcript-query-cache.ts` / `queryKeys.sessionTranscript.*`.
