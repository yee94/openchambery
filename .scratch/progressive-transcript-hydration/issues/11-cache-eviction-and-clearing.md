# 11 — 缓存回收与清除入口

**What to build:** 给端侧缓存加上字节预算回收与用户可控的清除入口，保证磁盘不会无限增长，并让隐私敏感用户能移除留在本机的内容。

**Blocked by:** 09 — IndexedDB 与 SQLite 适配器

**Status:** UI/core 已完成（字节预算 LRU、活跃 scope 保护、`clearAll` / `clearCurrentRuntimeTranscriptCache`、Settings 清除入口）。

- [x] 回收按**字节预算** LRU，依据 `last_referenced_at`，**不按条数**。
- [x] 超出预算时按 `last_referenced_at` 由旧到新回收，回收后时间轴仍自洽（不留悬空索引）。
- [x] 提供清除本地会话缓存的入口，清除后不影响服务端历史。
- [x] 清除与回收都按 `transport + directory + session` 边界执行，不误伤其它运行时。
- [x] 回收不得删除正在被当前视图引用的消息。

核心（无 Settings UI）已落地：

- [x] `TranscriptDurableStore.clearAll`：清空当前 backend 的全部 transcript rows，保留其他应用存储。Memory / IndexedDB / HTTP / runtime 均实现。`destroy` 仍只用于生命周期测试。
- [x] `clearCurrentRuntimeTranscriptCache`：Electron local origin → HTTP/SQLite，其他 runtime → IndexedDB。`clearGeneration` 仍双后端清理。
- [x] 成功 durable write 后在同一 scope queue 内 `evictToBytes`；`activeRegistry.listRetained()` 转为 protect；hash skip 不扫描。
- [x] 预算已满时受保护 scope 全部留存并返回 `remainingBytes`。
