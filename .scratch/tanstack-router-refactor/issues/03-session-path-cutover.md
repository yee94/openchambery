# 03 — 会话打开走 path（Web 垂直切片）

**What to build:** 在 Web/Desktop 主壳上，用户打开或切换 session 时，地址栏（或等价 location）变为 `/session/$sessionId`，聊天主区显示该会话。Router 成为 sessionId 的导航权威；不再写入 `?session=`。冷启动 `/` 可 replace 到 last session 或 `/new`（按既定产品规则）。

**Blocked by:** 02 — Path 契约与 useAppNavigation 语义 API

**Status:** done

- [x] TDD：serialize/parse 与 updateBrowserURL 输出 `/session/$id`（path，非 query）。
- [x] `setCurrentSession` → 既有 `useRouter` 订阅 → `updateBrowserURL` 现写 path（sidebar/编号导航等无需逐点改）。
- [x] `parseRoute` / `hasRouteParams` 读 path，刷新可从 `/session/$id` 恢复（index 可解析前提下；逻辑沿用既有 resolve）。
- [x] 业务 URL 序列化不再写 `?session=` / `?tab=` / `?settings=`。
- [x] 聚焦测试改为 path 语义；`bun test` router 相关 42 pass。

## Notes

- Bridge 仍是 `useRouter` + store 订阅（Ticket 08 再删）；序列化/解析已 path 化。
- 冷启动 `/` → lastSession/`/new` 的 replace 策略留给后续 ticket（当前无 route params 时行为与旧「等用户导航再写 URL」一致）。
- Settings/tab 的 path 写出已随 serialize 生效；完整 overlay remount 验收属 05。
