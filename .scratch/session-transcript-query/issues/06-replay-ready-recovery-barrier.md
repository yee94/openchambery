# 06 — 建立 replay → ready recovery barrier

**What to build:** 调整 event stream 重连协议，使服务端按顺序发送 replay events 和 ready barrier。客户端在 disconnect/visibility hidden 时捕获恢复上下文，并在每次 ready 后发布一次可订阅的 compensation trigger。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [x] WS replay events 在 ready barrier 前按序送达客户端 reducer。
- [x] SSE/WS reconnect、visibility restore、system resume 共用同一 compensation trigger。
- [x] 每次真实重连只发布一次 trigger。
- [x] Trigger 携带 last event、断线时点和 runtime generation 上下文。
- [x] Protocol 与 pipeline 测试覆盖 replay、ready、重复连接和 runtime switch。
