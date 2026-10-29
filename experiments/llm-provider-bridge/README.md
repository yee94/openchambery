# OpenCode Provider 复用实验

此目录保留隔离可行性实验与产品链路验收脚本，不更改用户全局配置。

## 当前产品链路验收

`production-smoke.mjs` 实际调用 Yuri 摘要和助手业务，经外部 OpenCode 的
认证 RPC 完成八个文件的逐次修改/回读。`PROVIDER_ID` / `MODEL_ID` 可选择
已连接模型；默认测试 DeepSeek，也可选择 OpenAI/Codex OAuth 模型。
`provider-smoke.mjs` 对当前已连接的每个 Provider 选择一个模型做最小真实调用；
可用 `PROVIDER_IDS` 逗号分隔限定范围。失败逐条报告，不自动切换供应商。

产品桥接直接复用外部实例的 ModelResolver 和传输 hooks，不再维护驱动白名单，
也不拒绝 OAuth。它不触发 Agent 上下文 hooks、不创建 Session；供应商传输 hook
可能按合成身份做一次不存在的 Session 查找并使用既有 fallback。下文均是早期
实验记录，不能替代 `packages/web/server/lib/llm/DOCUMENTATION.md` 的当前契约。

## 新实验：不经过 Session 的干净推理

`clean-catalog-probe.ts` 已真实跑通：通过运行中服务的模型/Provider API 读取
有效配置，在内存合并模型设置，再使用 `ModelResolver.fromCatalogModel` 和
`@opencode/ai` 的 `LLM.generate` 直接调用模型。**不创建 Session、不调用
session.generate、不触发 session 上下文/HTTP hooks。** 不读取 Provider 凭据文件。

实测 Astra 的 DeepSeek V4.1 Flash：

- A/B/A 三次上下文隔离检查通过：发往所配置 Provider 的原始请求只有指定的
  system/user 两条消息，没有另一会话的随机标记、额外 system 或工具。
- 首次缓存实验为 `0/3072`、`3008/3073`、`3008/3072`（缓存读取/输入 token）。
  不同会话共享同一合成前缀也能命中；缓存命中不是隐式增加其他会话消息。
- 随后的原生工具任务完成 25 轮，八条内存记录各修改一次并回读验证。
  每轮检查出站消息数量、精确 system、工具集合及前面测试会话标记不混入。
  24 轮正文为空但有有效原生工具调用，正常继续，没有盲目重试。
- 工具任务最后一轮缓存读取 `1856/1988`，约 93.4%；这是该轮测量，
  不代表平均命中率或所有 Provider 都有同等缓存行为。

当前认证范围仅验证 **Provider/model settings 中已有认证配置** 的模型。
此脚本没有证明 OAuth 自动刷新，也没有继承 session hooks 中的供应商鉴权适配。
例如 Copilot 的请求头适配、ChatGPT 的会话亲和 header 位于 session hooks；
不能简单宣称所有模型均可无损切换到这条路径。正式实现需要将认证/供应商
传输适配与 Agent 上下文改写分离，并确保敏感设置只留在 Host 内存。

检查的是应用到所配置 Provider 的出站请求，不是中转网关到最终厂商的请求；
网关内部行为不在此次上下文隔离断言的覆盖范围。

```sh
OPENCODE_SOURCE=/path/to/compatible-opencode \
PROVIDER_ID=your-provider MODEL_ID=your-model \
bun experiments/llm-provider-bridge/clean-catalog-probe.ts
```

若 checkout 的 Effect 依赖未同步，可用 Python 3.12+ 的 `prepare-sandbox.py`
复制源码到 OS 临时目录，下载源码声明的三个 Effect 包并验证注册表提供的完整性摘要，
其余已安装依赖只读复用；原 checkout 的源码、依赖、manifest 和 lockfile 不变：

```sh
OPENCODE_SOURCE=/path/to/opencode python3 experiments/llm-provider-bridge/prepare-sandbox.py
# 将输出的临时源码目录作为上述调用的 OPENCODE_SOURCE。
```

单独的嵌入式宿主 `clean-probe.ts` 仍未通过：对齐依赖后可启动，但直接获取
Location 服务时插件 inventory 为空，无法解析所需模型。这条宿主初始化路线
没有验证成功，不能与已通过的 catalog + direct LLM 路线混为一谈。

## 问题与结论

目标是由应用完整掌控 Agent 的消息、工具 schema、工具执行和循环，同时复用
OpenCode 的模型配置、当前认证和 Provider 插件，不复制 Provider 密钥。

公开插件的 `session.hook('http.request')` / `http.response` 可以完成一个
**Chat Completions 协议专用**的原型：使用隔离临时 Location 中的 deny-all
Agent 调用 `session.generate`，请求 hook 替换消息和工具定义，响应 hook 捕获
完整的正文、原生工具调用、结束原因和用量。工具完全由应用在下一轮前执行，
不进入 OpenCode 的原生工具执行循环。

该路径仍借用了 session.generate 做模型路由，但不再把它的 text 当作完整结果。
不需要修改 OpenCode、重建认证插件宿主或读取 Provider 凭据文件。

## 运行

需要已启动的 OpenCode V2 服务、已安装依赖的 OpenCode 源码以及 Bun。
源码路径只用于导入现有客户端，不安装包：

```sh
OPENCODE_SOURCE=/path/to/opencode \
PROVIDER_ID=your-provider MODEL_ID=your-model \
bun experiments/llm-provider-bridge/live-plugin-probe.mjs
```

模型必须使用 Chat Completions 协议。示例不会自动切换模型、修改模型设置或
真实定时任务。实验工具操作八条内存记录，验证 read → update → read → next，
禁止重复写入；每次新读取前要求上一条记录已验证。最终以真实记录和验证集合
判定完成，而不是只相信模型的完成声明。

临时目录包含合成输入、合成输出、deny-all Agent 和实验插件；会话和目录在
finally 中删除。不打印认证头、工具参数或完整请求/回复。服务自身既有日志和
已启用的其他插件仍遵循用户原有配置。

只捕获不改写的文本协议对照：

```sh
OPENCODE_SOURCE=/path/to/opencode CAPTURE_TEXT_PROTOCOL=1 \
bun experiments/llm-provider-bridge/live-plugin-probe.mjs
```

也可用 `CAPTURE_PROMPT_FILE` 指定自己保存的 `{ "prompt": "..." }` 合成复现输入。
不得用它未经审核捕获或共享真实用户私密上下文。

## 实际证据

- Astra 的 DeepSeek V4.1 Flash：25 轮通过；八条记录均写入一次并回读验证。
  24 轮的 `session.generate.text` 为空，但原始响应包含有效原生工具调用，
  `finish_reason=tool_calls`；没有重试，也没有把空文本当作失败。
- 腾讯通道的 DeepSeek V4.1 Flash：同样 25 轮通过；八次写入、八条回读验证，
  24 轮空正文带有效工具调用。两个 Provider 均使用服务原有配置，未重配密钥。
- 第一遍同样走完 25 轮，但因模型在完成标记前加了说明，过严的逐字回复断言
  失败；后续验收保留标记检查并加强实际记录、写入次数和顺序检查。
- 简短合成文本协议对照 5 次均返回正文、无原生工具调用，未复现此前长上下文
  的空返回。因此不能把本实验的 native-tools 空正文直接认定为此前错误的根因。
- 嵌入式内部源码原型 `probe.ts` 尚未成功启动：源码使用 `effect/http`，
  checkout 中已安装的 Effect 仍是旧 RC，缺少该导出。没有修改外部仓库或其依赖。
- `node --check` 用于实验 JS 语法验证。仓库 `bun run dead-code` 因此 worktree
  没有安装 workspace 依赖而无法加载 `@eslint/js`，不是通过的验证。

## 产品化边界

这个实验**证明配置/认证/插件复用与自定义多轮循环可组合**，不等于完整桥接已完成。

1. 请求和响应处理目前仅支持 Chat Completions；不能宣称支持 Responses、
   Anthropic、Gemini。正式层应使用 OpenCode 的 provider-neutral LLMRequest/
   LLMResponse/LLMEvent，避免再维护一套协议转换。
2. hook 顺序遵循已有插件顺序；后置插件仍可能修改请求/响应，需要冲突检测。
3. 文件作为顺序单调用实验的返回通道，不能产品化。应使用认证 RPC，按 request ID
   隔离并发、取消和清理，不能用共享文件传递用户上下文。
4. 当前响应 clone 被完整读取后才解析，没有证明实时 token 流，也没有实现 SSE
   断帧、部分失败、工具参数增量验证或断流恢复。
5. 未验证 OAuth 过期刷新、variant 覆盖、其他 Provider、多 runtime 或进程重启。
   凭据仍由服务持有，但不能据此声称每种认证都验证过。
6. 无默认任务截止并不等于可靠持续执行。正式实现需要检查点、明确失败分类、
   可取消恢复和已执行副作用的幂等策略；不可无限重试鉴权或协议错误。
7. 在上游开放完整单轮推理 API 前，生产方案需要明确选择并维护桥接边界。
   `probe.ts` 展示的是内部服务接缝而非承诺稳定的公共 SDK。
