# 02 — 迁移 transcript 读取消费者到 repository

**What to build:** Chat、Context Panel、timeline 和 message/parts selectors 通过 TranscriptRepository 读取 transcript 与分页投影。当前 store adapter 继续提供生产数据，使本 ticket 可以独立验证全部读取路径。

**Blocked by:** 01 — 建立 TranscriptRepository seam

**Status:** done

- [x] 主 Chat 与 Context Panel 的 transcript 数据来自 repository observers/selectors。
- [x] pagination、单消息和 parts 使用窄投影，未变化引用保持稳定。
- [x] viewport anchor 与 timeline 继续接收相同消息顺序。
- [x] 全仓 transcript 读取搜索只剩 repository、adapter 和模型内部访问（外加 displayParts/revert 投影与 session 元数据）。
- [x] Remediation: session-assist last message、queue auto-send completion/turn、RevertedMessageDock parts、MessageList session-scoped parts 均经 repository。
