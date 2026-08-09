# 02 — Path 契约与 useAppNavigation 语义 API

**What to build:** 定义领域 path 契约与唯一导航出口：`goSession` / `goNewSession` / `openSettings` / `closeSettings` / `back` 等。调用语义 API 后，router location 变为 history path（例如 `/session/$id`、`/session/$id/git`、`/settings/providers`），**不是** query 伪路由。本票以 memory router + 单测验证，可不接真实 MainLayout。

**Blocked by:** 01 — Router 基建与 runtime history 工厂

**Status:** done

- [x] TDD seam：path 构建/解析、合法 tab 枚举、非法 tab 落到默认 chat、settings slug 白名单与兜底。
- [x] TDD seam：`createAppNavigation`（语义 API）在 memory history 下改变 `pathname`/`searchStr` 符合契约。
- [x] 默认 chat **不**占 path 段；非 chat tab 使用 `/session/$sessionId/$tab`。
- [x] diff 的 `file`、plan 的 `mode=plan` 以 search 表达（本票已覆盖契约与导航）。
- [x] **不做**旧 `?session=` / `?tab=` / `?settings=` 兼容或 redirect。
- [x] 导航意图类型 `NavigationIntent` 可供后续 deep link / palette / IPC 复用。

## Notes

- `packages/ui/src/router/pathContract.ts` — build/parse/normalize
- `packages/ui/src/router/navigationIntent.ts` — intent union
- `packages/ui/src/router/navigation.ts` — `createAppNavigation(router)`
- Settings slug 复用 `resolveSettingsSlug`（含 legacy section 别名 → 新 slug）
- React hook `useAppNavigation` 留给接 shell 时再挂 RouterProvider
