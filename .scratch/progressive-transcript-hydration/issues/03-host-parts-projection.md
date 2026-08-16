# 03 — Host 首包 parts 投影与 slim 契约

**What to build:** 首包对 parts 做投影，只带用户可见所需的最小内容，并逐 part 标注完整度，使下游永远能区分「瘦身」与「完整」。

**Blocked by:** 02 — Host 首包页宽与轮数解耦（done）；04 — 客户端 slim/full 合并优先级（done，已先落地）

**Status:** done

> **顺序更正（已生效）**：首包判据是「`before` 缺席」，而 **recovery 与 materialize 也不带 `before`**，所以它们同样会收到瘦身 parts。若本工单先于 04 落地，今天的客户端会把瘦身 part 当成完整内容写入，**工具输出会真实退化**。因此 04 已先落地。原 spec 把 04 排在 03 之后，是错的。

- [x] 保留 user parts 与 assistant 最终 text 正文。
- [x] tool / reasoning 只保留摘要字段（part id、类型、工具名、状态、标题）；丢弃 `state.output` 正文、大 metadata、长 reasoning 正文。
- [x] 每个被投影的 part 携带明确的 slim 标记（`slim: true`）；未标记即完整。响应新增 `partsProjection: "slim-v1"`。
- [x] 投影只作用于首包路径（`before === undefined`）；向上翻页与既有 reconcile 路径返回契约不变。
- [x] 上游暂时性失败继续映射 502/503（`mapServiceError` 未改动）。
- [x] 日志不记录消息正文与 parts 内容（该模块无任何 console/logger 调用）。
- [x] `session-turn-pages/DOCUMENTATION.md` 记录首包页宽与投影契约。

## 实现要点

- `service.js`：`projectSlimParts` + `SLIM_PARTS_PROJECTION`，投影跑在 `selectTurnRecords` **之后**，因此 `turnCount` / `complete` / cursor 编码全部由未投影记录派生，不会位移。
- 无收益的记录保持原对象引用，下游基于引用的变更检测仍然有效。
- `routes.js`：`isFirstPacket = before === undefined` 处应用。
- `packages/vscode/src/session-turn-page-runtime.ts` 已镜像同一投影，`bridge-session-turn-page-runtime.ts` 同点接入。

## 验证

- Host turn-pages：90 passed / 0 failed。
- `packages/ui` displayParts：17 passed。
- `packages/vscode` `type-check`：无错误。
