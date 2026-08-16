# 14 — 降低首包轮数预算（首屏最大杠杆）

**What to build:** 把本机首屏的 authored-user 轮数预算从 6 降到 3，让首包只覆盖最近几轮。更早的历史沿用既有 prepend 通道。

**Blocked by:** 01 — 实测确认轮数是唯一能压缩首包的旋钮（done）；03 — Host parts 投影（done，与本工单叠加）

**Status:** done

## 为什么是轮数而不是页宽

issue 01 实测结论：客户端收到的是**按轮数裁剪后的窗口**，其大小由 `turns` 决定，与上游页宽无关。页宽那条路已经试过并被否证（见 issue 02 与 turn-pages `DOCUMENTATION.md` 的反向指引）。

## 实测数据（基准会话 `ses_ffed3d847ffeSinkJbqEGx3SnL`，817 条消息）

轮界位置（最新第几条）：#1=5、#2=33、#3=35、#4=37、#5=53、#6=56。
两个内联 base64 截图位于最新第 **37** 与第 **56** 条（1190 KB / 1339 KB）。

| 轮数 | 最新 N 条 | 原始 KB | 投影后保留 KB | 被投影的 parts | 是否带上截图 |
|---|---|---|---|---|---|
| 1 | 5 | 27 | 2 | 10 | 否 |
| 2 | 33 | 714 | 12 | 114 | 否 |
| **3** | **35** | **726** | **15** | **115** | **否** |
| 4 | 37 | ~1900 | ~15 | ~116 | 是（1 张） |
| 6 | 56 | 3728 | ~2553 | 158 | 是（2 张） |

「投影后保留 KB」= 扣除 tool / reasoning 正文后的内容，另需加上约 115 个摘要 part 的开销（每个约 150 字节，合计约 17 KB）。

**turns=3 的首包内容约 15 KB + 摘要约 17 KB ≈ 32 KB，对比 turns=6 投影后约 2553 KB。**

关键在于 turns=6 会一路回溯到第 56 条，把两张内联截图一起拖进关键路径；turns=3 只到第 35 条，天然避开。这也让 issue 13（按需取附件正文）从「必须做」降级为「特定场景才需要」。

## 实际改动

- `session-message-policy.ts`：`INITIAL_TURN_LIMIT_LOCAL` 6 → 3。Relay 保持 2（本来就低）。prepend / loadMore 保持 4，不变。
- 首屏预算现在**小于** prepend 页（3 < 4），这是刻意的：回溯得越远，越容易把长工具轮次和内联附件拉上关键路径。常量注释里记录了实测数字与原因。
- 未新增任何机制。更早的历史沿用既有 prepend 通道。

## 验证

- `session-message-policy.test.ts`：4 passed（断言从 6 改为 3，并补注为何首屏刻意小于 prepend 页）。
- 定向套件 `session-message-policy` + `displayParts` + `transcript-merge`：39 passed / 0 failed。
- `packages/ui` 全量 `type-check`：0 errors。
- 全目录 `bun test src/sync`：1180 pass / 146 fail。**146 个全部为既有失败，已用回滚验证**：把常量改回 6 再跑，计数完全相同（1180 / 146），差异仅在 expect 调用数（4135 vs 4131，来自本工单新增的断言）。失败集中在 event pipeline、input-store attachments、skill invocation、session-navigation、worktree routing、draft 生命周期，均与轮数无关，且单文件运行时通过——属全目录运行的测试污染。

## 尚未验证

- 只验证了字节与轮界位置，**没有端到端墙钟耗时**（需要带鉴权的活服务端；本机 5 个 OpenCode 实例对 `/session` 均返回 401）。
- 单会话样本。轮界密度（该会话 assistant:user ≈ 17:1）会随会话不同而变化。
- 单会话样本的 UX 影响未做真人验证（见下方「风险已被既有机制覆盖」，属代码级确认而非实测）。

## 风险已被既有机制覆盖（已确认）

原先担心「首屏只有 3 轮，用户会觉得历史不见了」。查证后这个风险已被两套既有机制覆盖，**不需要新建 P1 补史机制**：

1. **短视口自动补史。** `useChatTimelineController.ts` 的 `shouldAutoFillEarlierHistory` 在 `scrollHeight <= clientHeight + 48`（即 transcript 撑不满视口）时持续向上加载 Host 页，直到撑满。它由 TanStack Query 持有飞行，`auto-fill-busy` 可重试 40 次，失败或无增长后置 `fillBlocked` 防止风暴。所以「3 轮撑不满屏」不会留下半屏空白。
2. **视口保护已存在。** 历史加载走 `beginHistoryViewportPreservation()` / `endHistoryViewportPreservation()`，程序化触发与用户主动「加载更早」是同一条通路，因此继承同样的锚定行为——这正是 issue 06 想要的不变量，已经实现。

**一处需要注意：** `shouldAutoFillEarlierHistory` 在 `isMobile` 时直接返回 false，移动端没有自动补史。移动端本机首屏因此从 6 轮降到 3 轮后会略短，需靠用户滚动补齐。考虑到移动端走 Relay 时本来就是 2 轮，3 轮仍高于既有的 relay 基线，判定可接受。

顺带发现一处既有的注释漂移（未改）：`HISTORY_INTERACTION_MAX_PAGES` 上方注释写「One Host 3-turn page」，而 `HISTORY_TURN_LIMIT_LOCAL` 实际是 4。
