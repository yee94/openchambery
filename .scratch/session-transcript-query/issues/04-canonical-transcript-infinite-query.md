# 04 — 实现 canonical Transcript InfiniteQuery repository

**What to build:** 实现 Query-backed TranscriptRepository。每个 runtime/directory/session 使用一个 page-local normalized InfiniteData；底层 transport-page Query 管 HTTP 去重与分类重试；InfiniteQuery 管 initial、fetchPreviousPage、cursor、loading、error 与 immutable pages；sync merge 通过 structuralSharing 和 setQueryData 提交。

**Blocked by:** 01 — 建立 TranscriptRepository seam

**Status:** done

- [x] Query key 包含 transport、generation、normalized directory 和 session ID。
- [x] Initial tail 与 fetchPreviousPage 使用真实 QueryClient/InfiniteQueryObserver 测试。
- [x] 同页并发请求共享 flight，网络/timeout/502/503/504 按策略重试。
- [x] 分页失败保留已有 pages，complete 成功页关闭 hasPreviousPage。
- [x] SSE/HTTP 竞态按 live revision 和现有 merge strategy 收敛。
- [x] Transcript、pagination、message、parts observers 保持窄订阅与引用稳定。
