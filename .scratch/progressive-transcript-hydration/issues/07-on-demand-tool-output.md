# 07 — tool / reasoning 正文按需补全

**What to build:** 被投影掉的完整输出，只在用户主动展开 Activity（或空闲时）才按消息补齐，让用户不为自己没看的内容付等待成本。

**Blocked by:** 04 — 客户端合并规则：slim 永不降级 full

**Status:** 按需补全与 Activity lane UI 已完成；空闲预取未实现。

- [x] 展开 Activity 时才发起完整输出的补取，按消息粒度进行。
- [x] 展开后有明确的加载态，用户能区分「正在取」与「本来就是空的」。
- [x] 补取回来的 full 内容替换对应 slim part，并把该 part 标记为 full。
- [x] 补取失败只影响该条，不清空其它已完整的消息，且可重试。
- [ ] 空闲预取（若实现）不得与用户交互竞争，也不得改变已画区域高度。

核心（无 UI）已落地：

- [x] 生产 Query repository 按 `scope + messageID` 暴露 `materializeMessage`，只读状态 `{idle|loading|ready|error}`；runtime facade 提供 `materializeTranscriptMessage` / `getTranscriptMessageMaterializationState`。
- [x] 复用 `session.message` + `loadSessionMessage` 单飞，flight key 捕获 transport+generation；旧 runtime 迟到结果不写当前 Query。
- [x] 仅当前 message 含 slim tool/reasoning/file 时才请求；成功走 `materialize-snapshots`；失败可重试且保留 existing slim。
- [x] 成功后的 full 记录进入 ticket 10 durable 写入队列；重复展开共享一个 request。
