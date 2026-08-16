# 05 — 三阶段水合与骨架离场判据

**What to build:** 在 TranscriptRepository 上引入显式的水合阶段（P0 结论优先 / P1 背景补史 / P2 按需补全），把「骨架何时离场」从「整页返回」改成「P0 达成」。

**Blocked by:** 04 — 客户端合并规则：slim 永不降级 full

**Status:** 已完成。repository 阶段输出、ChatContainer P0 gate、运行中壳与 Activity 按需展开已接通。

> 查证结论（issue 14 期间）：
>
> - **P0 已由降轮数近似达成**（issue 14：本机首屏 6 → 3 轮，首包约 32 KB）。是否还需要「P0 = 严格只要最后一轮」需重新权衡收益。
> - **P1 背景补史大部分已存在**：`shouldAutoFillEarlierHistory` 在 transcript 撑不满视口时自动向上补页，由 TanStack Query 单飞持有，带 `fillBlocked` 防抖。**不要重建。**
> - 仍然缺失且值得做的是：显式的、可观测的阶段状态（`P0/P1/P2`）作为 repository 输出，以及「骨架离场判据 = P0 达成而非整页返回」。这两条是本工单的真实剩余价值。
> - 移动端无自动补史（`isMobile` 直接返回 false），若要覆盖需单独决定。

- [x] P0 只求最后一轮：当前 user 消息 + 最后一条 assistant（终止形态给最终正文，否则给 Activity 壳）。
- [x] P0 达成即离开骨架并开放输入框，不等待整页返回。
- [x] 「最新一轮很肥 + 历史很长」时 P0 仍先满足。
- [x] P1 复用既有向上分页（prepend）通道补更早轮次，节流提交，不阻塞 P0 已画内容。
- [x] 会话仍在跑时，P0 呈现明确的运行中壳（第几步 / 是否在跑），不是空白。
- [x] 阶段状态是 repository 的可观测输出，UI 只读不推。
- [x] 骨架一旦离开，不因后到的空读回退；加载失败明确显示为失败，不呈现为空会话。
- [x] `packages/ui/src/sync/DOCUMENTATION.md` 记录水合阶段与合并优先级。

核心（无 Chat/Activity UI）已落地：

- [x] `getHydrationState`：`phase: idle|p0|p1|p2` + `p0Satisfied`。阶段只由 HTTP / prepend / `materializeMessage` 生命周期推进。
- [x] P0 判据：最新 authored user 可读，且同轮 assistant 有可显示 parts，或进行中 assistant row 可作为 Activity 壳。纯 user tail 未满足。
- [x] 初始 HTTP / durable seed 满足 P0 立即 `p0`；prepend active 或已加载更早 authored turn 为 `p1`；按 message materialize active 为 `p2`。完成后回到最高已满足阶段。
- [x] `useSessionTranscriptHydration` / `getTranscriptHydrationState` / `readTranscriptHydrationState`。QueryCache 仍是 sole production authority；runtime generation purge 重置 latch。

UI 接线：

- [x] `ChatContainer` 直接消费 `useSessionTranscriptHydration`，durable seed 与 authority tail 共用 `p0Satisfied` 离场判据。
- [x] P0 latch、已画 transcript retention、hosted/pending rows 共同保持 viewport 与 composer 连续。
- [x] 纯 user tail 在 live busy 状态下进入既有运行壳；ready empty snapshot 保留原始空会话路径。
