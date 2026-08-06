# 03 — 迁移 transcript 写入路径到 repository

**What to build:** initial、prepend、recovery、materialize、SSE、optimistic、revert/reset 统一调用 TranscriptRepository commands。Store adapter 将命令映射到当前 sync merge 和 child-store commit，保持现有运行行为。

**Blocked by:** 01 — 建立 TranscriptRepository seam

**Status:** done

- [x] 所有 transcript HTTP 成功页通过 repository command 提交。
- [x] SSE message/part events 通过 repository command 合并。
- [x] optimistic add/confirm/remove 与 destructive reset 通过 repository command 执行。
- [x] 全仓 transcript 直接写入搜索只剩 repository adapter 和 reducer 内部实现（外加 loader 纯 reduce 后的 commit-reduced 入口）。
