# 06 — 渐进补史的视图稳定性

**What to build:** 保证后台补史与按需水合不打断阅读：不跳动、不改变已画区域高度、不把用户拽回底部。

**Blocked by:** 05 — 三阶段水合与骨架离场判据

**Status:** 已完成。既有 prepend 锚定、bottom pin、live-tail 更新与新的 P0/Activity gate 已完成定向验证。

> 查证结论（issue 14 期间）：历史加载的视口锚定**已经实现**。`useChatTimelineController.ts` 提供 `beginHistoryViewportPreservation()` / `endHistoryViewportPreservation()`，程序化补史与用户主动「加载更早」走同一条通路，因此共享同一套锚定。短视口自动补史（`shouldAutoFillEarlierHistory`）也已带 `fillBlocked` 防抖与 Query 单飞。
>
> 因此本工单应先**核查**既有行为满足了哪几条，只补真正缺失的部分（重点可能是：`isMobile` 时无自动补史；以及附件/图片占位在正文后到时的高度预留——后者依赖 issue 13）。不要重建锚定机制。

- [x] P0 首次落地钉底，结论与输入框在视野内。
- [x] 后台 prepend 时用户仍在底部则继续钉底；已上翻则维持既有 viewport 锚点。
- [x] 进行中轮次的 Activity 默认收起，高度只在用户主动展开时变化。
- [x] P2 水合不改变已画区域高度，折叠的 Activity 补数据时不抖动。Activity 补全状态与 full rows 仅在展开态渲染；折叠态继续只保留既有 header，并保留 `beginHistoryViewportPreservation` 与 disclosure header 锚点补偿。
- [x] 可见的最后一轮照常跟随 SSE；折叠区与更早轮次的状态提交做节流/合并，数据先落缓存，UI 不逐 `part.delta` 同步。
