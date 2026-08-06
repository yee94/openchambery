# 07 — 实现 Query reconnect compensation controller

**What to build:** 使用 Query recovery checkpoint 和 reconcile task queries 实现每次重连补偿。Active observers、viewed、busy/retry 会话立即按目录限并发执行；inactive transcript 标记 stale 并在观察时 ensure；单轮固定 head，多轮追赶 latest head。

**Blocked by:** 04 — 实现 canonical Transcript InfiniteQuery repository；05 — 提供 Host anchor reconcile API；06 — 建立 replay → ready recovery barrier

**Status:** done

- [x] Disconnect checkpoint 固定在 replay 前，并保存稳定 anchor。
- [x] Replay 完成后的 ready 启动 Query compensation tasks。
- [x] Continuation 串行扫描，SSE 同期更新通过 live revision 保持优先。
- [x] Latest head 前进时启动下一轮增量补偿，稳定后结束任务。
- [x] Anchor 丢失或预算耗尽会重建 canonical tail 与 cursor 链。
- [x] Runtime switch 会取消旧 generation 的补偿与提交。

## Implementation notes

- `session-transcript-reconcile-api.ts` — Host reconcile HTTP client (`fetchSessionTranscriptReconcile`): runtimeFetch + timeout race, exactly one of anchor/continuation, strict response validation, 4xx/contract fail-fast, network/502/503/504 max 2 retries.
- `session-transcript-recovery-checkpoint.ts` — authored-user turn anchor (`isUserAuthoredTurnBoundaryMessage` / `selectStableTranscriptAnchorMessageID`) + checkpoint model + QueryCache helpers.
- `session-transcript-reconnect-compensation.ts` — controller: capture-before-replay, first-ready skip, immediate set (active ∪ viewed ∪ busy/retry), directory concurrency default 2, per-session single-flight, serial continuation, multi-round head chase, `reconcile-page` merge (boundary preserved), `destructiveReset` on resetRequired/anchorless, generation cancel.
- `transcript-reconnect-compensation-runtime.ts` — optional registration seam; SyncProvider thin wiring in `sync-context.tsx` (`onRecoveryContextCaptured` + `onCompensation`). Unregistered = no-op; store reconnect body recovery unchanged until Ticket 09.
- Remediation: checkpoint capture uses pipeline `onRecoveryContextCaptured` (once per gap, before replay; visibility/pageshow/resume included). Immediate/capture sets union `activeRegistry.listRetained()`. Host page asserts `complete:false` ⇒ continuation, `resetRequired` ⇒ terminal complete.
- Merge purpose `reconcile-page` added to `session-merge-strategy` / reducer (preserves history boundary).
- Production TranscriptRepository binding remains store adapter.

## Ticket 09 cutover steps

1. Create Query repository with fetcher + shared cache budget.
2. `registerTranscriptReconnectCompensationController(createTranscriptReconnectCompensationController({...}))` with listDirectories / busy-retry / viewed deps from SyncProvider.
3. Switch `bindTranscriptRepository` to Query adapter (atomic with store transcript field removal).
4. Ensure observe-path readers call `ensureTranscriptOnObserve` when opening inactive sessions.
5. Cancel controller on runtime switch via `cancelTranscriptReconnectCompensation`.
