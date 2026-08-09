# 08 — 删除旧 query router

**Status:** done（行为层）

- [x] serialize/parse 不再产出/消费 `?session=`/`?tab=`/`?settings=` 路由
- [x] 业务写路径经 path serialize
- [x] `lib/router` + `useRouter` **保留为 store→path 桥**（非 query）；物理删除 dual-source 属后续当 call site 全改 createAppNavigation 后
- [x] ROUTE_PARAMS 标记 deprecated；无生产序列化使用
- [x] OAuth path 仍独立（e2e E8 场景）
