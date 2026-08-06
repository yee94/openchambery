# 05 — 提供 Host anchor reconcile API

**What to build:** OpenChamber Host 提供基于稳定 turn anchor 的 transcript reconcile API。服务端从当前 head 回扫到 anchor，支持 continuation、captured/latest head、overlap turn、页/字节/总预算与 resetRequired。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [x] 单页与多页 continuation 都能找到 anchor 并返回完整缺口 records。
- [x] Anchor 所属 overlap turn 覆盖进行中的 assistant parts 与 finish 更新。
- [x] Anchor 丢失和总预算耗尽返回 HTTP 200 + resetRequired。
- [x] Continuation 绑定 runtime、directory、session、anchor、captured head 和 scan cursor。
- [x] Continuation 为 HMAC 签名短时令牌 `ocr2`（默认 TTL 15m；进程级密钥，重启失效）；拒绝 `ocr1`/篡改/错误密钥/过期。
- [x] OpenCode 暂时失败映射 502/503，服务端异常记录完整 stack。
- [x] 日志字段省略授权信息、消息正文和 parts 内容。
