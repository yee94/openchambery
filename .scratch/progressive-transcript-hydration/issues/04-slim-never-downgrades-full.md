# 04 — 客户端合并规则：slim 永不降级 full

**What to build:** 在客户端合并层确立身份与优先级规则，保证瘦身页永远不会覆盖已经拿到的完整内容，也不会删除既有 part。

**Blocked by:** None — **必须先于 03 落地**

**Status:** done（显示层；数据层经实验确认无需改动，见下）

> 顺序更正：客户端必须先具备「slim 不覆盖 full」的合并能力，Host 才能开始投影。否则 recovery / materialize（同样不带 `before`，因而同样会拿到瘦身页）会把工具输出写坏。先实现容忍与优先级，再开投影。

- [x] 合并以 `partID` 为身份定位。
- [x] slim part 不覆盖 full part；SSE 实时 part 优先于 HTTP 投影页。
- [x] 合并为 insert-only：未出现在瘦身页中的已有 part 不被删除（既有 `mergePartsForDisplay` 语义，未改）。
- [x] 乱序到达（slim 页晚于 SSE full）仍收敛到 full。
- [ ] 失败不表现为权威空成功；单条消息失败不清空其它消息 —— 既有行为，本工单未新增覆盖。
- [ ] 切换运行时后，旧运行时的在途响应不写入新视图 —— 既有行为，本工单未新增覆盖。

## Implementation notes

- 落点是 `packages/ui/src/sync/displayParts.ts`，文档中自述为该不变量的唯一所有者。原逻辑只处理 part **缺失**（滞后页漏掉 SSE 已收的 tool），不处理 part **变瘦**。
- 关键风险点在已 settle 的 assistant：`allowsAuthoritativeShrink` 对其返回 `true`，incoming 会被逐字采纳——正是瘦身页会抹掉完整工具输出的地方。因此完整度的保持**必须跨越 settle 边界**，与 presence 的保持不同。
- 新增 `isSlimPart(part)`（读 Host 的 `slim` 标记）与内部 `preferFullOverSlim`：incoming 中的 slim part 若在 previous 里存在同 id 的 full part，则沿用 full。未打标记的 part 按定义即为 full，因此旧版 Host 永远不会进入该路径。
- 新增 `stabilize` 辅助，替代原先重复的引用稳定判断；全量升级回 previous 时返回原数组引用，避免快照与 turn projection 重建。

## Validation

- `packages/ui` 用的是 `bun test`（不是 vitest）。`src/sync/displayParts.test.ts`：17 passed / 0 failed（原 11 个全绿，新增 6 个覆盖投影场景）。
- `packages/ui` 全量 `type-check`：0 errors。
- `session-transcript-long-gap.runtime.test.js` 的失败**已验证与本改动无关**，证据有三条，不再是推测：
  1. 该文件中 `slim` 出现 0 次，而 `preferFullOverSlim` 仅在 incoming 存在 slim 标记时才分支，因此本改动对它是恒等变换；
  2. 失败断言的是 `messageOrder` 的**消息顺序**（msg_07–10 的位置），而 `messageOrder` 由 `transcript-merge.ts` / `transcript-repository.ts` 拥有，两者均未被本改动触碰；
  3. `mergePartsForDisplay` 的非测试消费方只有 `turns/streamingTailEntry.ts`（渲染层），不在 `messageOrder` 的构建链上。
- 全目录 `bun test src/sync/` 另有 `session-worktree-store` / `session-delete-undo` 的多个失败，均属 worktree 路由与 attachment 清理，与 parts 合并无关；单文件运行时不复现，疑为目录级测试污染。**本工单未处理，也未引入。**

## 数据层：已调查，确认无需改动

曾怀疑 store 层缺少同样的保护会导致「渲染层持有 full、但落库已被瘦身覆盖，remount 后输出丢失」。**该问题不存在，已用实验否证：**

- 临时移除渲染层 hold 后，直接探测 `mergeSessionTranscript` 两次 http-page（先 full 后 slim/recovery）之后的落库内容，结果仍为 `{"status":"completed","output":"LONG"}`。
- 原因是页 reducer 对 tool `state` 做**逐字段**合并而非整 part 替换，因此省略 `output` 的投影页不会抹掉已存的 `output`。
- 期间一度在 `transcript-merge.ts` 加了冗余 guard 并抽出 `slim-parts.ts` 共享模块，配套的两个测试经中和验证为**空转**（移除 guard 仍通过），故已全部回滚；`displayParts.ts` 恢复自包含。结论写入 `session-turn-pages/DOCUMENTATION.md`，避免后人重复投入。
