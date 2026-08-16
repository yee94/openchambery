# 01 — 验证「首包页宽」是首屏慢的主因

**What to build:** 不改代码，在长任务会话上实测首屏成本，确认页宽是否为主因。结论写回 spec，作为后续所有 Host 改动的依据。

**Blocked by:** None

**Status:** done — **原假设被否证，见结论**

- [x] 选一个「最新一轮挂大量 tool part」的真实会话作为基准场景。
- [x] 对比不同页宽下的响应体大小。
- [x] 记录每次实测需要的上游请求次数。
- [x] 数据显示页宽**不是**主因 → 已在本文件与 spec 中更正结论，并标记 02 需重估。
- [x] 测量方法与原始数据记录在案，可复现。

## 测量方法

无法走 HTTP：本机 5 个 OpenCode 实例（端口 50253 / 54834 / 63236 / 63250 / 63329）对 `/session` 一律返回 401，未去获取用户凭据。

改为只读查询 OpenCode 自己的库，等价于 Host 调用 `session.messages` 时上游要序列化的数据：

```
sqlite3 -readonly ~/.local/share/opencode/opencode.db
```

基准会话取用户反馈的那一个：`ses_ffed3d847ffeSinkJbqEGx3SnL`（「客户端同步消息改动」）。
规模：**817 条消息、4113 个 part、19.0 MB**。
`message` / `part` 均有 session 维度索引（`message_session_time_created_id_idx`、`part_message_id_id_idx`），与 Host 的访问模式一致。

「最新 N 条」按 `ORDER BY time_created DESC, id DESC LIMIT N`，与上游分页方向一致。

## 原始数据

### 页宽 → 上游扫描量

| 页宽 N | parts | KB |
|---|---|---|
| 10 | 54 | 189 |
| 20 | 106 | 325 |
| 24 | 130 | 406 |
| 30 | 174 | 630 |
| 40 | 213 | 1921 |
| 60 | 308 | 3751 |
| 100 | 517 | 4575 |

### 轮界密度（关键）

该会话 **assistant 772 条 / user 45 条 ≈ 17:1**，不是原先推断的「一轮约两条消息」。

user 边界所在的「最新第几条」：

| 边界序号 | 位置 |
|---|---|
| #1 | 5 |
| #2 | 33 |
| #3 | 35 |
| #4 | 37 |
| #5 | 53 |
| #6 | **56** |
| #7 | 143 |

### 客户端实际收到的首包（turns=6 → 最新 56 条，共 3728 KB）

| part 类型 | 个数 | KB | 占比 |
|---|---|---|---|
| **file** | **2** | **2529** | **68%** |
| tool | 111 | 1014 | 27% |
| reasoning | 47 | 161 | 4% |
| step-finish | 49 | 9 | <1% |
| text | 23 | 6 | <1% |
| step-start | 49 | 3 | <1% |
| patch | 8 | 2 | <1% |
| compaction | 1 | 0 | 0 |

那 2 个 `file` 是**用户贴的截图，以 base64 内联在 user 消息里**：1190 KB + 1339 KB，`mime=image/png`。

### 轮数 → 首包大小

| 轮数 | 最新 N 条 | parts | KB |
|---|---|---|---|
| 1 | 5 | 24 | **27** |
| 6 | 56 | 290 | **3728** |

**相差 138 倍。**

## 结论

**1. 页宽不是主因，原假设否证。**
客户端收到的字节由**轮数**决定，与页宽无关：turns=6 就是最新 56 条 ≈ 3728 KB，页宽只改变 Host↔OpenCode 之间怎么分块读。

**2. 02 号改动很可能是净退化，需重估。**
第 6 个边界在最新第 56 条。页宽 100 时一次请求就够（100 ≥ 56）；改成 24 之后要 24 / 48 / 72 三次才够，**1 次变 3 次串行往返**，而客户端拿到的字节一模一样。上游扫描量只从 4575 KB 降到约 4000 KB（72 条），换不来这 2 次额外往返。原先「窄页通常仍是一次请求」的推断，建立在 1:1 轮界密度上，对这个会话不成立。

**3. 03 号投影省 32%，真实但不解决主要成本。**
tool + reasoning = 1014 + 161 = 1175 KB，占 3728 KB 的 32%。投影后仍剩约 2553 KB。

**4. 目前最大的可得收益，两个工单都没碰：内联附件。**
2 个 base64 截图占首包 68%。投影按设计放行 user 行，所以一点没省。要让首包真的变小，`file` part 必须也走投影 / 懒加载（UI 展开或滚到时再取正文）。

**5. 「结论优先」的真正杠杆是轮数，不是页宽。**
首包只交 1 轮 = 27 KB，对比 6 轮 3728 KB。这正是 spec 第一阶段要的量级，而它来自轮数预算，与页宽无关。

## 复现

```sh
S=ses_ffed3d847ffeSinkJbqEGx3SnL
DB=~/.local/share/opencode/opencode.db

# 页宽 → 扫描量
for N in 10 20 24 30 40 60 100; do
  sqlite3 -readonly $DB "
  WITH newest AS (SELECT id FROM message WHERE session_id='$S'
                  ORDER BY time_created DESC, id DESC LIMIT $N)
  SELECT '$N -> parts=' || count(p.id) || ' KB=' || COALESCE(sum(length(p.data))/1024,0)
  FROM newest ne LEFT JOIN part p ON p.message_id=ne.id;"
done

# 轮界位置
sqlite3 -readonly $DB "
WITH newest AS (SELECT id, json_extract(data,'\$.role') role,
                ROW_NUMBER() OVER (ORDER BY time_created DESC, id DESC) rn
                FROM message WHERE session_id='$S'),
     users AS (SELECT rn, ROW_NUMBER() OVER (ORDER BY rn) k FROM newest WHERE role='user')
SELECT k, rn FROM users WHERE k<=7;"

# 首包成分
sqlite3 -readonly $DB "
WITH newest AS (SELECT id FROM message WHERE session_id='$S'
                ORDER BY time_created DESC, id DESC LIMIT 56)
SELECT json_extract(p.data,'\$.type'), count(*), sum(length(p.data))/1024
FROM newest ne JOIN part p ON p.message_id=ne.id GROUP BY 1 ORDER BY 3 DESC;"
```

## 局限

- 只量了**字节与请求次数**，没量端到端墙钟耗时（需要带鉴权的活服务端）。字节是上游序列化成本的合理代表，但不含 OpenCode 自身固定开销。
- 单会话样本。17:1 的 assistant/user 比来自一个长任务会话，短会话的轮界密度会不同，02 的退化幅度也会不同。
