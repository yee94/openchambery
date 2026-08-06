# 01 — 建立 TranscriptRepository seam

**What to build:** 为 session transcript 建立统一模型接口，覆盖消息/parts 读取、分页状态、initial/prepend/recovery/materialize、SSE merge、optimistic 与 reset 命令。现有 child-store 行为通过 store adapter 接入该接口，为后续 Query 实现提供稳定替换点。

**Blocked by:** None — can start immediately

**Status:** done

- [x] Repository contract 能表达 transcript data、pagination state 和全部 transcript commands。
- [x] Store adapter 通过现有聚焦测试，用户可观察行为保持一致。
- [x] 新增 transcript 消费者统一依赖 repository contract。（seam + 测试就绪；生产消费者迁移属 Ticket 02/03）
- [x] Owning documentation 记录 repository 的所有权边界。
