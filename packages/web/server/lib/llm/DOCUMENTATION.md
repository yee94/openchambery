# Yuri clean LLM gateway

The Assistant and small-model utilities share `createChatCompletion`. The Host
always connects to the selected **external OpenCode service**. It does not embed,
start or replace OpenCode to provide inference.

## Ownership and security

- `bridge-client.js` writes one self-contained built-in plugin to a Yuri-owned
  temporary `.opencode/plugins` directory. Official client `plugin.list` activates
  that isolated Location. No global/project OpenCode configuration is changed.
- Calls use the official authenticated `client.rpc(LlmBridge)` transport, scoped
  to that directory. `ready` verifies protocol version 2 and runtime service availability; only RPC-not-ready
  startup errors receive a bounded readiness retry. Generation is not rerun for
  arbitrary transport errors, because a response may already have been produced.
- `bridge-plugin.js` runs **inside external OpenCode**. It reads that Location's
  live `ModelResolver.Service` through the RPC caller's Location context. The
  external service itself resolves the selected model/variant, active integration
  credential, OAuth refresh, native/legacy driver and provider overlays. The bridge
  uses `@opencode/ai` single-call inference, never a parallel model resolver. Credentials never cross
  the inference RPC or enter the Host's inference result. Upstream exceptions are
  replaced with a fixed error and allowlisted failure category/HTTP status rather
  than leaking private content, response bodies, headers or credentials. Defects
  are sanitized too; cancellation remains interruption, not a provider failure.
- Only caller-provided system/messages/tools enter inference. Session history,
  agents, AGENTS.md, Skills, context/generate hooks, native tools and the OpenCode
  Agent loop are not used. Model body overrides cannot replace context or tools.
- The existing `model.request`, `http.request` and `http.response` transport hooks
  DO run against the same live host registry. They retain provider endpoint,
  authorization, request/response and legacy AI SDK adaptation without invoking
  context-building hooks. A stable synthetic `ses_` identity supplies cache/header
  affinity; it is never persisted. Provider hooks may attempt a Session lookup,
  receive not-found and use their existing fallback. The Host never creates,
  prompts, generates through, or writes a Session for inference.
- The plugin only returns proposed native calls. Yuri's existing pi Agent owns
  execution, permissions, sequencing, terminal-operation gates and cancellation.
  A completed side effect is never replayed by inference recovery.

## Supported providers and deployment

There is no Yuri provider/package allowlist or blanket OAuth rejection. All
configured text-inference providers use the external service's own resolver and
driver loading, including OpenAI/Codex OAuth, OpenCode, API-key, ambient-credential
and legacy AI SDK providers. Whether a particular model accepts text/tools/media
and the active account has access remains the upstream provider's contract.
This is a generic integration path, not evidence that every vendor/account has
been tested. There is **no fallback** to session.generate or a second model.

The bridge currently relies on internal `ModelResolver` and `PluginHooks` service
contracts, keyed by the compatible OpenCode runtime. Missing services fail
explicitly; protocol version alone does not prove compatibility with every future
OpenCode release. The bundled SDK normalizes the host model's wrapper while
retaining the host-owned route implementation; calls back into the host route
restore its original model wrapper so nominal SDK schemas remain valid. It never instantiates an embedded
OpenCode host. Requests use stateless HTTP, including for providers whose durable
Agent sessions prefer WebSocket; providers requiring WebSocket-only operation are
not established by this path.

The external service must be able to read the isolated plugin directory. A
service on another machine/container without a shared filesystem cannot load a
Host-local plugin and fails visibly; it needs a separately provisioned bridge
on its own filesystem. No automatic remote installation or global config edit
is performed. Web, Electron, hosted mobile and Capacitor clients use the Host's
same bridge. VS Code's extension-owned runtime does not gain a local Host.

`build:llm-bridge` generates `bridge-plugin.bundle.js` with the inference SDK and service tags, not a driver registry.
It is ignored in source control and included in the web package's `server`
files. Web build, prepack and development API scripts build it. At runtime the
Host copies its bytes into the temporary directory, including when the Host
source lives in Electron ASAR; external OpenCode needs no access to ASAR or
Yuri's node_modules. The bundle has no machine-specific source directory.
Shutdown removes the owned directory; a failed staging operation cleans up.

## Completion contract

- `GET /api/yuri/llm/models` uses official provider.list/model.list.
- `POST /api/yuri/llm/chat/completions` remains non-streaming. `stream:true` is
  rejected. No fake token callbacks or post-hoc SSE are emitted.
- Messages retain structured roles: system/user/assistant/tool. Native tool
  calls carry their original IDs and JSON arguments; tool results retain name
  and tool_call_id. The Assistant supplies its actual tool JSON schemas.
  The contact harness may internally defer tool-name validation to its bounded
  correction loop (`validateToolCalls: false`); HTTP body fields cannot disable
  validation, and the harness validates/normalizes every call before execution.
- Results retain text, tool calls, finish reason, input/output/cache-read usage.
  Empty text with valid tool calls is success. Truly empty results are errors;
  content-filter/error/length endings cannot masquerade as complete output.
- Each contact retains a stable assistant-scoped cache key, including tool
  follow-ups and result summaries. Cache affinity is not session history. It
  never appends other conversations. No inference response cache is stored.
- Text files stay bounded inline descriptions. Supported vision inputs become
  native image parts. Data URLs are validated and capped at 20 MiB per file;
  unsupported image models receive descriptions, never image bytes.

There is no default inference deadline. An explicit internal `timeoutMs` may
bound a caller; manual AbortSignal cancellation reaches RPC and the LLM effect.
Only truly empty responses receive backoff (500ms exponential, capped at 30s).
Utilities stop after two retries; contacts opt into recovery until cancellation.
Authentication/configuration/protocol/transport errors are not blindly retried.
Provider-owned deadlines and Host process loss remain possible failures.

## Validation

Focused tests cover clean wire messages, native empty-text tool calls, usage,
model override rejection, host-resolved OAuth, transport-hook body replacement, sanitized RPC errors,
session-free routing, long-running cancellation and retained side effects.
`experiments/llm-provider-bridge/production-smoke.mjs` calls the real small-model
session-title path and the real pi Agent through the production gateway, external
OpenCode RPC and a selected real provider. OpenAI/Codex and DeepSeek both passed
25 rounds with 24 native calls and eight verified file edits/readbacks. The script
forbids Host Session API access and compares global config hashes before/after.
`provider-smoke.mjs` checks one model per currently connected provider and reports
each failure separately; it is not an exhaustive all-model certification.
The current connected-provider run passed 16 of 18 selected models. OpenCode
returned quota HTTP 402 and direct DeepSeek returned authentication HTTP 401;
the official stateless generation API independently returned the same statuses.
Neither failure is hidden by an automatic account/model switch.
This does not establish real-device UI, OAuth expiry behavior against every vendor, remote provisioning, streaming,
packaged Electron startup or crash-recovery correctness.
