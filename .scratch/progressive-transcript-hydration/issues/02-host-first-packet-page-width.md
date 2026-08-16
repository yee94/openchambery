# 02 — Host 首包页宽与轮数解耦

**What to build:** 让首屏请求使用独立的小页宽，不再沿用向上翻页的默认 `scanLimit`。首包目标是尽快覆盖最近一轮（P0），而不是一次装满 6 轮。不改 `service.js` 的扫描/游标算法。

**Blocked by:** 01 — 已跑完，**结论否证了本工单的前提**

**Status:** reverted — 前提被 issue 01 实测否证，已按方案 A 回滚

> ## 已回滚（2026-08-15）
>
> 按下方证据执行方案 A：
> - `routes.js` 删除 `FIRST_PACKET_MESSAGES_PER_TURN` / `resolveFirstPacketScanLimit`，omitted 时回到 `_inner_scanLimit`（explicit → env → 100）。
> - `bridge-session-turn-page-runtime.ts` 同步回滚，保持双侧 parity。
> - 派生页宽的 3 个测试移除，改为断言「首包与 prepend 同宽 100」「显式覆盖仍生效」。
> - `DOCUMENTATION.md` 的「Upstream page width policy」改写为**反向指引**：记录此路已试过并被实测否证，避免后人重复。
> - 验证：turn-pages 88 passed / 0 failed；`packages/vscode` type-check 无错。
>
> `service.js` 的扫描算法与所有护栏自始至终未被触碰，因此回滚是纯参数层面的。

> ## 前提已被实测否证（issue 01）
>
> 本工单假设「首包那一页固定 100 条是主因，缩小页宽即可变快」。实测数据不支持：
>
> 1. **页宽不改变客户端收到的字节。** 客户端拿到的是按轮数裁剪后的窗口。基准会话 turns=6 → 最新 56 条 → 3728 KB，**无论页宽是 24 还是 100 都一样**。页宽只决定 Host↔OpenCode 之间怎么分块读。
> 2. **本改动很可能是净退化。** 该会话第 6 个轮界落在最新第 56 条（assistant:user ≈ 17:1）。页宽 100 时一次请求就够（100 ≥ 56）；改成 `clamp(6×4,10,100)=24` 之后要 24 / 48 / 72 **三次串行往返**才够。上游扫描量只从 4575 KB 降到约 4000 KB，换不来这 2 次额外往返。
> 3. 原先「窄页通常仍是一次请求」的推断，建立在「一轮约两条消息」的 1:1 密度假设上，对长任务会话不成立——而长任务恰恰是本方案要解决的场景。
>
> **可选处置：**
> - **A（推荐）** 回滚首包派生页宽，恢复 `_inner_scanLimit`，把首屏优化让给「降首包轮数」（真正的杠杆：turns=1 → 27 KB）与内联附件投影（占首包 68%）。
> - **B** 保留代码但让首包策略回落到 env/默认值，仅保留 `_inner_scanLimitEnv` 这一层区分，作为后续「按轮界密度自适应页宽」的接入点。
> - **C** 维持现状 —— 不建议：已知会给长任务会话增加串行往返，而这正是目标场景。
>
> 代码本身正确且测试全绿（83 passed），问题在于它优化的不是瓶颈。

- [x] 首屏路径与向上翻页路径使用各自的页宽，取值来源在代码中显式可见。
- [x] 页宽仍受路由层既有校验约束（10..200），env 覆盖行为不变。
- [x] 页宽变小导致边界不足时，沿用既有循环继续翻页，结果与大页宽等价。
- [x] `max_scan_pages` / `max_scan_messages` / `duplicate_cursor` / `empty_page_with_cursor` 等护栏行为全部不变（未触碰 `service.js`）。
- [x] Relay（2 轮）与本机（6 轮）都遵循同一首包策略，弱网下不退化。
- [x] 既有 `service.test.js` 全绿；新增用例覆盖「小页宽 + 边界不足 → 多翻一页」。

## Implementation notes

- 首包判据是 **`before` 缺席**。`packages/ui/src/sync/session-turn-page-api.ts` 第 4–5 行写明 initial / recovery / materialize 均不带 `before`，只有 prepend 带；无需新增 purpose 参数。
- `routes.js`：拆出 `_inner_scanLimitEnv`（env 显式值，未设或非法为 `null`），使策略能区分「运维显式选了 100」与「没人选过」。`_inner_scanLimit` 语义不变，`getInnerSessionTurnScanLimit()` 与 reconcile 传参均未改。
- 宽度优先级：客户端显式 `scanLimit` → env → 按路径策略。首包 `clamp(turns × 4, 10, 100)`；prepend 维持 100。
- `turns` 上限是 10，所以派生宽度最高 40，100 的上限实际够不到，属防御性。
- `packages/vscode/src/bridge-session-turn-page-runtime.ts` 同步了同一策略；其中原 `_inner_scanLimit` 常量在改动后无人引用，已删除。
- 有意修改的既有断言：`routes.test.js` 原先断言省略 scanLimit + `turns=3` 时为 100，现为 12。

## Validation

- `packages/web/server/lib/session-turn-pages/` 全套：83 passed / 0 failed。
- 完整 web 套件：1403 passed / 1 failed。唯一失败是 `server/lib/relay/relay-server.e2e.test.ts`（`ReferenceError: Bun is not defined`，该用例用 `Bun.spawn` 编译 relay 二进制），与本改动无关，属既有环境问题。
- `packages/vscode` 无 `test` 脚本且未安装 vitest，**VS Code 那份对等实现无法跑测试**；仅通过 `bun run type-check`（通过）验证。另注：`packages/vscode/src/session-turn-page-runtime.test.js` 第 260/376/559/561 行断言 `decodeHostCursor` 返回 `.payload`，而两处实现都返回 `.value`——此不一致早于本次改动，未处理。
- **Ticket 01 的实测没有做**：本改动基于读代码得出的判断，尚无「页宽 vs 首屏耗时」的真实测量。
