# Spec — 渐进式 Transcript 加载与端侧按消息缓存

**Status:** ready-for-agent
**Area:** session sync / transcript / host turn-pages
**Related:** `.scratch/session-transcript-query/`（01–04、07–10 done；05 anchor reconcile、06 replay barrier 仍 ready-for-agent）

---

## Problem Statement

用户打开一个「跑了很久」的会话时，长时间看不到消息。

现象在 `chatRenderMode = sorted`（整理后显示）下最明显，但根因有两层，必须分开看：

1. **看不见（渲染层）** — sorted 模式下正文只在「终止形态」才落地：模型 `finish === 'stop'` 且没有待续工具调用。任务还在跑、工具还在滚的时候，中间过程被收进 Activity，正文一直不画。用户感觉「消息没加载出来」，其实是「正文被有意藏着」。这是既定语义，不是缺陷。

2. **真的慢（加载层）** — 这才是要修的。首屏拉取按「authored user 轮次」聚合：本机 6 轮、Relay 2 轮（`session-message-policy.ts`），Host 侧每页固定 `scanLimit=100`（`routes.js`，env `OPENCHAMBER_SESSION_TURN_SCAN_LIMIT` 可调 10..200），整段套在 45s 超时里。

   **主要成本是首包的轮数预算，不是页宽，也不是翻页次数。**（该结论由 issue 01 实测更正，原先写的是「页宽」。）`service.js` 的扫描循环在攒够轮界后立即停止（`countAuthoredBoundaries(accumulated) >= turnBudget` → `break`），首次 fetch 用 `before=undefined` 直接命中最新一页。客户端最终收到的是按轮数裁剪后的窗口，**这个窗口的大小与页宽无关**：页宽只决定 Host↔OpenCode 之间怎么分块读。

   实测基准会话 `ses_ffed3d847ffeSinkJbqEGx3SnL`（817 条消息 / 4113 parts / 19 MB，assistant:user ≈ 17:1）：turns=6 对应最新 56 条 = **3728 KB**；turns=1 对应最新 5 条 = **27 KB**，相差 138 倍。而首包成分里 **2 个用户内联 base64 截图独占 2529 KB（68%）**，111 个 tool part 合计 1014 KB（27%）。完整数据见 `issues/01`。

两层叠加的结果：**用户最想要的东西（最后的结论 + 能继续输入）恰恰被排在最后面才可用**。

还有第二次伤害：transcript 只活在内存里。TanStack Query 的 `gcTime` 是 5 分钟，之上叠了一层按会话数的 LRU（VS Code 4 / 移动端 12 / 桌面默认 40）。刷新页面、重启 Electron、或会话被 LRU 挤掉之后，同一段历史要整页重拉一次。端侧目前只持久化会话摘要（`session_summary`：标题/状态/时间，不含正文）、输入草稿与附件；普通对话正文没有任何落盘。

---

## Solution

把 transcript 加载从「一次拿满 N 轮」改成**按用户价值排优先级的渐进式水合**，并在端侧建立**按消息**的持久缓存，让第二次打开不必整页重拉。

用户视角的目标：

- 打开会话后立刻看到**最后一轮**：自己发的那条 + 最终结论（若仍在跑，则是一行 Activity 壳），输入框立即可用。
- 更早的历史在后台自动往上补，不打断阅读，不跳动视图。
- 工具调用的完整输出只在**用户主动展开** Activity 时才取。
- 再次打开同一会话时，先用本地缓存瞬间画出来，然后只对「真正变了的那几条」做差量更新，而不是整页覆盖。

### 关键前提修正：不改走 v2

本方案曾计划把首包改走 SDK v2 的 `/api/session/{sessionID}/message`（`order: "asc" | "desc"`）。**核对 SDK 类型后否决，理由如下**，避免后续实现再走一遍这条弯路：

- **收益是幻觉。** 旧端点 `/session/{sessionID}/message` 在 `before=undefined` 时返回的就是最新一页（`service.js` 顶部注释：pages are chronological old→new，*including the latest slice*）。`order=desc` 想要的「先拿最新一小段」，旧端点用 `limit` 就能达到——真正要调的是 `limit`，不是端点。
- **v2 没有 `directory` / `workspace`。** `V2SessionMessagesData.query` 只有 `{limit, order, cursor}`；`V2SessionMessageData.query` 更是 `never`。而 Host 是多目录的，旧端点的 `directory` / `workspace` 是当前定位手段。（旁证：`V2ModelListData` 明确带 `location.directory`，说明 v2 支持 directory 的端点会显式声明；messages 没有。另注：`message-queue/opencode-adapter.js` 现在向 `client.v2.session.message` 传 `directory`，按类型该参数会被丢弃。）
- **响应形状不兼容，需要新写映射层。** v2 返回 `{data: SessionMessage[], cursor:{previous?,next?}}`，`SessionMessage` 是 8 个变体的判别联合（user / assistant / system / shell / synthetic / compaction / agentSwitched / modelSwitched），assistant 内部还有 text / reasoning / tool 三种 content。旧端点直接返回 `Array<{info: Message, parts: Part[]}>`，即全链路现有契约。仓库内**没有**任何 v2→`{info, parts}` 映射可复用。
- **cursor 与 order 互斥。** 类型注释写明 `Do not combine with order`，翻页语义还得再设计一套。
- **它也不解决肥消息。** v2 assistant 依然内联 `content` 数组，单条巨型消息的上游序列化成本一样存在。

**结论：首屏优化留在现有旧端点上做**，靠「调小首包 `limit` + Host 侧 parts 投影」两件事拿到绝大部分收益，成本和风险都远低于换端点。v2 迁移若将来仍要做，应作为独立议题，且前置条件是上游补齐 directory 支持。

---

## User Stories

### 首屏与可用性

1. As a 打开长任务会话的用户, I want 一进来就看到最后一轮的用户消息和结论, so that 我不用等整段历史就知道发生了什么。
2. As a 想立刻追问的用户, I want 输入框在首屏落地时就可用, so that 我能马上根据结论继续提问，而不是等历史加载完。
3. As a 会话仍在跑的用户, I want 看到一行明确的运行中壳（第几步 / 是否在跑）, so that 我知道系统在工作而不是卡死。
4. As a `sorted` 模式用户, I want 中间工具过程继续收在 Activity 里, so that 我的阅读界面保持干净，既有语义不被这次改动破坏。
5. As a Relay 用户, I want 首屏同样先给最后一轮, so that 弱网下我也能尽快开始输入。
6. As a VS Code / 移动端用户, I want 受限运行时也遵循同一优先级, so that 小屏和低内存环境不会退化成整页等待。

### 渐进补齐

7. As a 用户, I want 更早的历史在后台自动向上补齐, so that 我往上滚时内容已经在那里。
8. As a 正在阅读的用户, I want 后台补历史时视图不跳动, so that 我不会读到一半被顶走。
9. As a 停在底部的用户, I want 补历史时仍然钉在底部, so that 结论和输入框始终在眼前。
10. As a 已经上翻的用户, I want 保持我当前的阅读锚点, so that 后台加载不会把我拽回底部。
11. As a 用户, I want 折叠的 Activity 在补数据时不改变高度, so that 页面不会因为水合而抖动。
12. As a 想看某个工具细节的用户, I want 展开时才拉取完整输出, so that 我不为自己没看的内容付等待成本。
13. As a 展开了大输出的用户, I want 展开后有明确的加载态, so that 我知道内容正在取而不是空的。

### 缓存与二次打开

14. As a 回到旧会话的用户, I want 立刻看到上次已经加载过的内容, so that 我不必再等一次整页拉取。
15. As a 刷新页面的用户, I want 已读历史仍在, so that 刷新不等于重置。
16. As a 重启桌面端的用户, I want 冷启动也能先画出缓存内容, so that 启动后第一眼就有内容。
17. As a 频繁切会话的用户, I want 被 LRU 挤出内存的会话仍能从本地快速恢复, so that 切回去不触发整页重新拉取。
18. As a 用户, I want 缓存只对「真正变了的消息」做更新, so that 未变化的内容不被整页覆盖、不闪烁。
19. As a 用户, I want 服务端已删除的消息在本地也消失, so that 我不会看到幽灵内容。
20. As a 长期使用的用户, I want 本地缓存有容量上限并自动回收, so that 磁盘不会无限增长。
21. As a 隐私敏感用户, I want 能清除本地会话缓存, so that 我可以控制留在这台机器上的内容。
22. As a 多运行时用户, I want 缓存按 transport + directory + session 隔离, so that 切换运行时不会串数据。

### 正确性与失败处理

23. As a 用户, I want 加载失败明确显示为失败, so that 我不会把错误当成「这个会话是空的」。
24. As a 用户, I want 骨架消失之后不因为后到的空响应又退回骨架, so that 界面不来回横跳。
25. As a 用户, I want 正在流式输出的内容永远不被瘦身版本覆盖, so that 我不会看到已经出现的文字又消失。
26. As a 用户, I want 缓存里的瘦身记录不被当成完整内容, so that 展开时我拿到的是真正的完整输出。
27. As a 任务运行中的用户, I want 系统不为了「刷新」再打一次整页拉取, so that 运行中的会话不会被自找的等待拖慢。
28. As a 用户, I want 一条消息加载失败不影响其它已完整的消息, so that 局部故障不会清空整个会话。
29. As a 切换运行时的用户, I want 旧运行时的在途请求不写进新运行时的视图, so that 我不会看到错误来源的数据。

---

## Implementation Decisions

### 1. 三阶段水合模型（客户端）

在 TranscriptRepository 之上引入显式的水合阶段，而不是散落在各调用点：

- **P0 结论优先** — 只求最后一轮：当前 user 消息 + 最后一条 assistant（终止形态则给最终正文，否则给 Activity 壳）。满足即可离开骨架、开放输入框。
- **P1 背景补史** — 复用既有的向上分页（prepend）通道补更早轮次，节流提交，不阻塞 P0 已画内容。
- **P2 按需补全** — tool / reasoning 的完整正文，在 Activity 展开或空闲时按消息补齐。

阶段状态属于 repository 的可观测输出，UI 只读不推。离开骨架的判据是 P0 达成，不是整页返回。

### 2. Host 首包：降低首包轮数 + parts 投影（沿用现有端点）

不换端点、不动 `service.js` 的扫描算法，只改「首包要多少轮」和「首包带多少内容」。

> **本节已按 issue 01 实测更正。** 原写法是「缩小页宽」，方向错了：页宽不改变客户端收到的字节，只改变 Host↔OpenCode 的分块方式。实测会话第 6 个轮界落在最新第 56 条，页宽 100 时一次请求就够，改成 24 反而要 3 次串行往返，而客户端拿到的字节完全一样。已落地的 02 号因此需要重估（见 `issues/02`、`issues/01` 结论 2）。

- **首包降轮数，而不是降页宽。** 轮数是唯一能直接压缩客户端首包的旋钮。页宽保持既有默认，避免无谓的额外往返。**已落地（issue 14）**：本机首屏 6 → 3 轮。实测该会话 turns=3 的首包内容约 15 KB + 摘要约 17 KB ≈ 32 KB，对比 turns=6 投影后约 2553 KB。关键在于 turns=6 会回溯到第 56 条、把两张内联截图拖进关键路径，turns=3 只到第 35 条，天然避开——这也让 issue 13 从「必须做」降级。
- **页宽仅在「轮界密度高」的会话里才有意义**，即最新一页里轮界数远超预算时。长任务会话恰好相反（assistant:user ≈ 17:1），所以不要把页宽当通用杠杆。既有的 `max_scan_pages` / `max_scan_messages` / `duplicate_cursor` 护栏全部保留不变。
- **首包对 parts 做投影**：保留 user parts 与 assistant 最终 text；tool / reasoning 只保留摘要字段（part id、类型、工具名、状态、标题）。丢弃 `state.output` 正文、大 metadata、长 reasoning 正文。实测该投影省下首包的 **32%**（1175 / 3728 KB）。
- **内联 `file` part 是首包最大的单项成本，必须一并处理。** 实测 2 个用户贴的 base64 截图占首包 **68%**（2529 KB，单张 1.2–1.3 MB，`mime=image/png`）。现有投影按设计放行 user 行，因此这部分一点没省——**这是目前最大的可得收益，而 02/03 都没碰**。首包应只带附件的引用与元信息（id、mime、filename、尺寸），正文等 UI 真要渲染时再取。需要单独一个工单。
- 响应必须逐 part 标注 `slim` 来源，Host 不得让投影结果看起来像完整内容。
- 投影只作用于首包路径；向上翻页与既有 reconcile 路径的返回契约不变。
- 上游暂时性失败继续映射 502/503；日志不记录消息正文与 parts 内容（沿用现有 turn-pages 约定）。

### 3. 合并规则：瘦身永不降级

- 合并以 `messageID` / `partID` 为身份，`seq` 只用于排序。
- **slim 不得覆盖 full**；SSE 实时 part 永远优先于 HTTP 投影页。
- 合并为 insert-only 语义：未出现在瘦身页中的已有 part 不被删除；删除只由权威删除事件驱动。
- 失败不得表现为权威空成功；骨架一旦离开，不因后到的空读回退。

### 4. 视图稳定性

- P0 首次落地钉底（结论 + 输入框在视野内）。
- 后台 prepend 时：用户仍在底部则继续钉底；已上翻则维持既有 viewport 锚点。
- 进行中轮次的 Activity 默认收起，高度只在用户主动展开时变化，避免 P2 水合改变已画区域高度。
- 可见的最后一轮照常跟随 SSE 实时更新；折叠区与更早轮次的状态提交做节流/合并，数据可以先写入缓存，UI 不必逐 `part.delta` 同步。

### 5. 端侧按消息持久化

新增 transcript 持久层，**藏在 TranscriptRepository 之后**，不新增跨模块 seam。

- 主键：`transport + directory + sessionID + messageID`。**不用内容哈希做主键，不用 `messageOrder` 做主键。**
- 排序：`seq`（上游 `session_message` 对 `(session_id, seq)` 有唯一索引，是权威顺序源）。
- 哈希：仅用于变更检测——内容未变则跳过写入、跳过重取。不参与定位，不参与排序。
- 两张表：轻索引 `{messageID, seq, hash, slim/full 标记}`；内容表 `{messageID → info + parts}`。
- 只持久化**已 settle** 的消息；进行中的 assistant 最多存一个未完成壳，永不作为完整记录。
- 逐 part 记录 slim / full，缓存中的瘦身记录不得冒充完整内容。
- 回收：按**字节预算** LRU，依据 `last_referenced_at`，不按条数。
- 存储介质：Web 用 IndexedDB；Electron / 服务端用 SQLite，与 session index 同目录。**不使用 localStorage**（配额不足）。
- 冷启动：先用本地时间轴画出最后一轮，输入框立即可用；随后与 Host / SSE 对账，逐条比对哈希，只补不一致的消息。

### 6. 去掉自找的等待

会话仍在运行、且本地已有带 user 边界的缓存时，不再为「刷新 live」强制重打整页 HTTP。运行中以 SSE 为准，不与之抢。

### 参考的既有实现（作为设计依据，不是要改的文件）

- 服务端按消息镜像的成熟先例：assistant 侧已有 message mirror / part mirror / backfill cursor 三件套，键为 `(assistant_id, session_id, message_id[, part_id])` + `ordinal`，本方案沿用其形状但扩展到普通会话。
- 内容寻址 + 引用时间回收的先例：附件对象表以 `object_hash` 为主键、`ON CONFLICT DO UPDATE last_referenced_at`、按 `last_referenced_at` 排序做 GC。
- 上游 OpenCode 2 的哈希用法：内容寻址只用于 instruction blob（`hash → value`、`onConflictDoNothing`、delta 为 `hash | "removed"`），`session_message` 自身**没有** hash 列。本方案与上游保持一致：**id 定位、seq 排序、hash 只判变更**。

---

## Testing Decisions

好的测试只针对外部可观察行为：给定 Host / SSE 的输入序列，断言 repository 对外暴露的 transcript、阶段状态与分页状态；不断言内部字段与调用次数。

**Seams（三个；第三个按验收决定独立可测）**

1. **TranscriptRepository** — 客户端唯一入口，覆盖三阶段水合、合并优先级、缓存命中与差量对账。
2. **Host turn-page 服务** — 已有可注入的 `fetchPage`，覆盖小页宽首包、parts 投影、页宽变小导致的多翻一页、既有护栏与错误映射。
3. **端侧 transcript store** — 独立可单测模块（按验收决定）。对外是一个与介质无关的接口（读时间轴 / 按 id 读消息 / 差量写入 / 按字节回收），IndexedDB 与 SQLite 各自作为适配器实现，用同一套契约测试跑两遍。Repository 通过注入消费它，不直接触碰介质。

**测试点**

- P0 在「最新一轮很肥 + 历史很长」时仍先满足，且离开骨架不依赖整页返回。
- slim 页不覆盖 SSE 已推送的完整 part；乱序到达仍收敛。
- 冷启动从缓存首画，随后仅对哈希不一致的消息发起补取；未变消息不被覆盖。
- 哈希相同时不写盘、不重取。
- 失败不产生权威空成功；单条失败不清空其它消息。
- 字节预算 LRU 在超限时按 `last_referenced_at` 回收。
- 运行中且缓存可用时不触发整页强制重取。
- 小页宽下边界不足时按既有逻辑继续翻页，`max_scan_pages` / `duplicate_cursor` 等护栏行为不变。
- store 契约测试在 IndexedDB 与 SQLite 两个适配器上结果一致。

**Prior art**

- 客户端：`transcript-repository.test.ts`、`transcript-repository-query-adapter.test.ts`（真实 QueryClient / InfiniteQueryObserver）、`transcript-repository-observers.test.ts`、`session-transcript-query-cache.test.ts`。
- Host：`session-turn-pages` 的 `service.test.js`（注入式 `fetchPage`，含分页/游标/失败用例）。
- 渲染语义：`assistantMessageLifecycle.test.ts`（sorted 正文揭示判据，本次不改语义，仅作回归保护）。

---

## Out of Scope

- **不改 sorted 模式语义。** `canRevealSortedFinalBody` 的终止形态判据保持不变；本方案只让内容更早**可得**，不改变它何时**该显示**。
- **不迁移到 SDK v2 messages 端点。** 理由见「关键前提修正」：v2 缺 `directory`、响应形状不兼容且无现成映射、cursor 与 order 互斥，而收益用旧端点调 `limit` 即可获得。
- **不解决上游单条肥消息的序列化成本。** 缩页宽去掉的是「同页搭载的其它 99 条」；若最新一条自身巨大，上游仍需序列化它。这也是本方案效果的上限。
- 不改 `service.js` 的扫描/游标算法与既有护栏。
- 不改 `session_summary` / 会话索引的职责，它继续只存摘要。
- 不持久化 Assistant 专属链路（已有自己的 mirror）。
- 不改动上游 `../opencode` 仓库。
- 不做端侧全文搜索或离线编辑。
- 不重写 reconcile 全链路；`session-transcript-query` 的 05 / 06 仍按原计划独立推进。

---

## Further Notes

- 与既有工作的关系：`session-transcript-query` 的 01–04 已经把 TranscriptRepository seam 和 InfiniteQuery 建好，本方案是在其上叠加**优先级**与**持久化**，不是替换。05（anchor reconcile API）与本方案的差量对账目标一致，实现时应复用其 anchor / `resetRequired` 语义而不是另造一套。
- 收益分层：Host 首包改造解决「第一次变快」；端侧按消息缓存解决「第二次不用整页重拉」。两者可独立落地，建议按此顺序。
- 风险点：投影引入了「同一条 part 存在两种完整度」的状态，slim/full 标记必须贯穿传输、内存与磁盘三层，任何一层丢失都会导致用户展开时看到被截断的输出。这是本方案最需要测试覆盖的地方。
- 需要更新的文档归属：`packages/ui/src/sync/DOCUMENTATION.md`（水合阶段与合并优先级）、`session-turn-pages/DOCUMENTATION.md`（首包页宽与投影契约）。
- 一个便宜的先手验证：`OPENCHAMBER_SESSION_TURN_SCAN_LIMIT` 是现成 env（10..200）。在动代码前先把它调小实测长任务会话的首屏耗时，可以低成本证伪/证实「页宽是主因」这一判断。
