# 04 — 工作区 tab 与 search（diff file / plan mode）

**What to build:** 主工作区非 chat 视图通过 path tab 表达；diff file / plan mode 通过 search。

**Blocked by:** 03

**Status:** done

- [x] path tab 全枚举 serialize/parse round-trip（workspaceTabs.test.ts）
- [x] plan → `?mode=plan`；context 不占 path
- [x] illegal tab → chat；diff file search round-trip
- [x] useRouter store 同步已写 path（serializeAppPath）
