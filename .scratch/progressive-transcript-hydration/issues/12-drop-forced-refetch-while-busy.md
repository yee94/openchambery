# 12 — 运行中不再强制整页重取

**What to build:** 会话仍在运行、且本地已有带 user 边界的缓存时，不再为「刷新 live」强制重打整页 HTTP。运行中以 SSE 为准，不与之抢。

**Blocked by:** ~~05 — 三阶段水合与骨架离场判据~~ → 实际不依赖 05，本改动是独立的一处条件删除。

**Status:** done

- [x] 运行中且本地缓存可用（含 user 边界）时不触发整页强制重取。
- [x] 运行中的内容更新完全由 SSE 驱动，不因跳过重取而丢失更新。
- [x] 缓存不可用或缺少 user 边界时，仍按既有路径拉取，行为不变。
- [x] 该抑制只作用于「运行中刷新」，不影响用户主动发起的重载与错误重试。

## 改了什么

`session-actions.ts` 的 `fetchMessagesForSessionInternal` 里删掉了：

```ts
const liveStatus = cachedState.session_status?.[sessionID]?.type
const sessionIsLive = liveStatus === "busy" || liveStatus === "retry"
const lastMessage = cachedMessages[cachedMessages.length - 1]
const tailLooksLikeInFlightSend = Boolean(lastMessage && isUserRole(lastMessage))
const mustRefetchLiveStaleCache = sessionIsLive && !tailLooksLikeInFlightSend
```

以及缓存复用早退条件里的 `!mustRefetchLiveStaleCache`。

原行为：会话 busy/retry 且尾部不是 user 消息（也就是任务正在跑的常态）时，跳过缓存复用，强制重打整页 turn page。这正是首屏最贵的一次请求——实测基准会话 turns=6 是 3728 KB。

其余复用前置条件**全部保留**：必须有该 scope、必须有 authored user 边界（或 boundary 为 `exhausted`）、必须有已知 boundary、且 request 不处于 error。所以缓存不完整或上次失败时行为不变。

## 为什么安全（不是猜的）

原逻辑的顾虑是「live 时缓存可能漏了 SSE 事件」。这个顾虑已有两条专门通路覆盖，都走 reconcile API 而不是宽页：

1. `session-transcript-reconnect-compensation.ts` 的模块文档写明 immediate set =
   「active repository/Query observers ∪ viewed ∪ **busy/retry**」，即 busy 会话在重连时必定被补偿。
2. `transcript-repository-observers.ts:80` 在会话**首次被观察**时触发 `ensureTranscriptOnObserve`，
   覆盖「缓存旧了、期间 app 在后台」这种情况（controller 内部用 `staleOnObserve` 集合判定）。

生产路径已完成 Query cutover（`transcript-repository-production.ts` 头部注明 Ticket 09 atomic cutover），补偿控制器在该路径上是激活的。

## 验证

- `src/sync/session-actions.test.ts`：94 passed / 0 failed。
- `packages/ui` 全量 `type-check`：0 errors。
- 新增用例 `opening a busy session reuses a complete cache instead of refetching the page`，断言 busy + assistant 尾部 + 完整缓存时 `host.session.turnPage` 调用数为 **0**。
  **已做空转验证**：临时恢复 busy 强制重取后该用例失败，确认它真的在钉这个行为。
- 既有用例 `a failed pull preserves the last known boundary without clearing transcript` 原先是借「busy + assistant 尾部」来强制发起一次拉取的。该手段随本改动失效，已改为用「缓存只有 assistant 尾部、缺 authored user 边界」来强制拉取——测试**本意（失败拉取不清空 boundary 与 transcript）未变**，只换了触发方式。
- 文档：`packages/ui/src/sync/DOCUMENTATION.md` 记录新的缓存复用判据与安全依据。
