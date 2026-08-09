# 11 — 域内子 type path + session id 直接定位加载

**What to build:** 补齐 scheduled history/tasks、assistant id、settings entity、diff scope、files/diagram file 等 path 子类型；path 打开 session 时用 id 在 seed/cache 列表中直接解析 directory，不必死等 hasLoaded。

**Blocked by:** 01–10 path 基建

**Status:** done

- [x] pathContract 支持 scheduled/history、tasks/$project/$task、assistant/$id、settings/$slug/$entity、?scope=
- [x] NavigationIntent / createAppNavigation 携带子域字段
- [x] findSessionById / resolveSessionDirectoryForRoute；useRouter 不再要求 hasLoaded 才 setCurrentSession
- [x] ScheduledTasksWorkspace：view 切换写 path；冷启动/popstate 读 path
- [x] serialize 同步时保留 path 上已有子类型（避免被 store 同步冲掉）
- [x] 单测 + e2e E10/E11 场景

## Notes

- UI 全量双向绑定（assistant store、settings entity stores）仍可继续把选择写进 path；契约与 scheduled history 已接通。
- 服务端 by-id API 仍可后续加；客户端 seed 短路已覆盖常见冷启动。
