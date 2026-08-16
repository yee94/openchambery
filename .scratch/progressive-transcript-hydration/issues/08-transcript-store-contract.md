# 08 — 端侧 transcript store 接口与契约测试

**What to build:** 定义一个与存储介质无关的按消息 transcript store，作为独立可单测模块，并配一套契约测试供各适配器复用。

**Blocked by:** None — can start immediately

**Status:** completed — durable store contract + Memory / IndexedDB / HTTP adapters

- [x] 接口覆盖：读时间轴、按 id 读消息、差量写入、按字节回收、清除。
- [x] 主键为 `transport + generation + directory + sessionID + messageID`；**不用内容哈希做主键，不用 `messageOrder` 做主键**。
- [x] 排序用 `time.created` + `messageID` 的稳定复合键（见下方证据；**不用上游 `seq`，不用 `messageOrder` 下标，不用 messageID 单独排序**）。
- [x] 哈希只用于变更检测：内容未变则跳过写入、跳过重取；不参与定位与排序。
- [x] 记录形状：`Message` + `Part[]` + 逐 part slim/full（`displayParts.isSlimPart`）+ 派生 content hash / byte size。轻索引与内容表是适配器内部事，契约只断言外部可观察行为。
- [x] 只持久化已 settle 的消息；进行中的 assistant 最多存未完成壳，永不作为完整记录。`upsertSettled` 拒绝未 settle 的 assistant。
- [x] 逐 part 记录 slim / full，完整记录优先于 slim 记录；缓存中的瘦身记录不得冒充完整内容。
- [x] 契约测试可对任一适配器运行，断言外部可观察行为而非内部字段。Memory store 已先跑通。

## 排序键决定（取代原稿「用 seq」）

原稿写「排序用 `seq`，与上游 `session_message` 对 `(session_id, seq)` 的唯一索引一致」。**客户端不能这么做。**

### 证据

1. **客户端 `Message` 没有 `seq`。** `@opencode-ai/sdk/v2` 的 `UserMessage` / `AssistantMessage`（`Message = UserMessage | AssistantMessage`）字段是 `id`、`sessionID`、`role`、`time.created`（assistant 另有可选 `time.completed` / `finish`）。类型定义里没有 `seq`。端侧拿到的权威行就是这个形状。
2. **上游自己的扫描顺序也不是客户端可见的 seq。** issue 01 只读查询 OpenCode 库时，最新 N 条用的是 `ORDER BY time_created DESC, id DESC`，对应索引 `message_session_time_created_id_idx`。这与「按创建时间、再用 id 打破并列」一致。
3. **`messageOrder` 是内存派生数组，不是持久键。** `TranscriptData.messageOrder` 是 Query / repository 投影出来的 oldest → newest id 列表。把它的下标当排序键，等于把某一次 hydrate 的数组位置冻进磁盘，翻页、删除、回收之后无法重放。
4. **messageID 单独排序会与对话顺序打架。** `conversation-order.ts` 写明 id 只是身份，不是 before/after。`conversation-order-writers.test.ts` 的夹具就是「更早的高 id 行 + 更晚的低 id 轮次」——按 id 字典序会把后发的消息排到前面。

### 决定

- 持久排序键 = `(time.created, messageID)`。`created` 为主序，`messageID` 只打破同一毫秒的并列。
- 消息身份 = 完整 scope（`transport` + `generation` + `directory` + `sessionID`）+ `messageID`。
- 哈希只做变更检测：同身份同 hash 的 `upsertSettled` 返回 `skipped` / `unchanged`，并刷新 `lastAccessedAt`。
- 适配器（09）必须复用这套键，不得改回 `seq`、`messageOrder` 下标或纯 id 排序。

## 接口（Memory 已实现，供 09 复用）

`packages/ui/src/sync/transcript-durable-store.ts`

- `readSession` / `readMessage` / `upsertSettled` / `removeMessage`
- `clearSession` / `clearGeneration` / `evictToBytes({ protect })` / `destroy`
- 删除与回收后 `readSession` 只返回仍在的行，并按复合键重排，不留悬空索引。

契约套件：`transcript-durable-store.contract.ts`（round-trip、幂等 hash、slim/full、settled、scope/generation 隔离、删除、回收与保护 scope、destroy）。Memory 入口：`transcript-durable-store.test.ts`。IndexedDB / HTTP 适配器复用同一契约，见 09。

## 验证

- 根级 `bun run test` 通过：UI 4272；Web 1446 passed / 1 skipped + relay e2e 1。
- 根级 type-check / lint 通过。
- Electron `bun run test:transcript-durable-indexeddb` 通过。
