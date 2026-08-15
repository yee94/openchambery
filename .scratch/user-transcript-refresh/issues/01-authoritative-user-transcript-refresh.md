# 01 — 用户强制同步消息，尾部与 OpenCode 对齐

**What to build:** 用户可以从 PC 侧栏某个 session 的右键菜单，或移动端右上角三点菜单，强制把该会话可见尾部对齐到最新 OpenCode。点完必须真的拉权威快照：成功后 message id 集合、conversation order、parts 与最新 OpenCode 页一致（少的补、多的删、同 id 旧正文替换）；失败则旧 transcript 原样保留，并明确失败。进行中的会话不能靠这个动作和 SSE 对打。未打开的 session 只更新缓存，下次点进去才看见对齐后的内容。本机未确认的 optimistic 行按 message id 和解。

**Blocked by:** None — can start immediately

**Status:** done

- [x] PC 侧栏 session 右键出现「同步消息」；不放进项目级「同步会话」。
- [x] 移动端右上角三点沿用现有「刷新」入口，不再在热缓存上空转成功。
- [x] 热缓存或已有 page 时，这次用户刷新必须发出权威 GET，不能把现有 ensure-initial 空转当成成功。
- [x] 刷新成功后，可见尾部与最新 OpenCode GET 页在 message id、conversation order、parts 上一致。
- [x] 刷新失败（网络、Host、空失败）保留刷新前的 transcript，并提示失败；不得先清缓存再暴露空白对话。
- [x] busy / retry 时动作禁用或拒绝，不打断正在进行的 SSE 现场。
- [x] 未打开的 session 可从侧栏右键刷新：只写该会话缓存，不拉起整个目录 bootstrap；当前正在看的会话立即重绘。
- [x] 本机未确认 optimistic 行按 id 对上则保留和解，对不上再撤。
- [x] 不复用「清掉旧链、ensure 失败也不恢复」的 destructive reset 失败语义。
- [x] 不放宽日常自动 initial / materialize 的 insert-only；不修 prepend 按 message id 当名次过滤。
- [x] 契约测试锁住：热缓存必 GET、成功尾部等于 OpenCode 页、失败保留旧数据、busy 拒绝。
