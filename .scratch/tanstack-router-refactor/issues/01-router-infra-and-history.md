# 01 — Router 基建与 runtime history 工厂

**What to build:** 在共享 UI 中引入最新 `@tanstack/react-router`，提供按 runtime 表驱动的 history 工厂与可挂载的空 route 树。Web 使用 browser history；VS Code / Electron / embedded / mobile 使用 **memory history**（不用 hash）。本票不改变用户可见导航行为。

**Blocked by:** None — can start immediately

**Status:** done

- [x] 依赖为安装时 npm 最新稳定版（至少 `@tanstack/react-router`；search 校验若需要则 `@tanstack/zod-adapter` + `zod`）。
- [x] TDD：`createAppHistory(runtime)` 对 web 与 memory runtimes 的契约测试先红后绿。
- [x] `createAppRouter({ runtime })` 可创建 router；各 surface 入口可一行注入 runtime，尚不替换业务导航。
- [x] 明确不使用 hash history；Electron/VS Code/embedded 均为 memory。
- [x] `bun test` 聚焦本票新增测试通过；无产品行为回归要求。

## Notes

- Dep: `@tanstack/react-router@1.170.23` in `packages/ui`
- Module: `packages/ui/src/router/` (`runtime`, `history`, `createAppRouter`, `routes/tree` catch-all)
- Tests: `history.test.ts`, `createAppRouter.test.ts` (13 pass)
- Browser history URL write is microtask-batched; tests call `history.flush()`
