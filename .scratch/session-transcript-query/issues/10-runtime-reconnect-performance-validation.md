# 10 — 完成运行时断流恢复与性能验收

**What to build:** 在开发环境执行可重复的长时间后台断流场景：固定 checkpoint、断开 event stream、生成超过单个 reconcile page 预算的多轮消息、恢复连接并追赶 latest head。记录正确性、Query task 收敛和高频 SSE 性能证据。

**Blocked by:** 09 — 原子切换 transcript 到 QueryCache 单写

**Status:** done

- [x] Replay events 先于 ready，ready 后补偿按设计启动。
- [x] 最终 message ID 恰好一次，parts 完整，cursor/complete 与 Host 一致。
- [x] Reconcile continuation、多轮 latest-head 追赶和 resetRequired 场景均有运行时证据。
- [x] 所有 transcript Query task 完成后 fetching count 归零。
- [x] Token delta 只更新目标 message/parts observer，记录代表规模的操作计数或性能 trace。
- [x] 验证报告列出已覆盖平台与仍待执行的平台运行时检查。

**Evidence:** `.scratch/session-transcript-query/reports/10-runtime-evidence.md`

**Remaining uncertainty:** 真实浏览器 visibility/bfcache、Electron suspend/resume、VS Code webview long-gap（limit=4）、Capacitor network suspension 仍为平台 smoke，未在本 ticket 宣称 event-loop/paint correctness。
