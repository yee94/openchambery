# 12 — Primary surface 互斥 + schedule 命名 + agent focus path

**What to build:** 产品级路由：session / plan / schedule / assistant / settings 互斥；主列禁止 Chat keep-alive 与 exclusive primary 叠层；path 段 `schedule`（非 scheduled）；schedule/assistant 支持 `/agent/$focusSessionId`。

**Status:** done

- [x] `primarySurface.ts` 权威互斥解析
- [x] MainLayout：exclusive primary 单挂载；session tools 仅在 session 下 secondary
- [x] Header 删除「mobile scheduled → chat」静默降级
- [x] pathContract：`schedule` 写出；legacy `scheduled` 只读兼容；plan 为 `/plan`；agent focus
- [x] MainTab 类型 `schedule`
- [x] 测试 81 pass；e2e check 11 scenarios

## Product rules

1. 任意时刻仅一个 primary 可见于主列
2. Settings 为 exclusive overlay
3. Sidebar 可并存；ContextPanel/dock 仅 session 壳
4. Mobile bottom-tab id 可仍为 `scheduled`（IA 标签）；URL 一律 `schedule`
