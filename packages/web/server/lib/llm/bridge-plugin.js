import { Cause, Context, Effect, Stream } from 'effect';
import { createHash } from 'node:crypto';
import { HttpClientRequest, HttpClientResponse } from 'effect/http';
import { AIClient, LLM, LLMRequest, LanguageModel, HttpOptions, Message, Media } from '@opencode/ai/effect';
import { ModelResolver } from '@opencode/core/model-resolver';
import { PluginHooks } from '@opencode/core/plugin/hooks';
import { LlmBridge, LLM_BRIDGE_VERSION } from './bridge-contract.js';

const sensitiveBodyKeys = ['messages', 'input', 'system', 'instructions', 'tools', 'tool_choice'];
const unavailable = () => Object.assign(new Error('External OpenCode clean inference runtime is unavailable or incompatible'), { code: 'unavailable' });
const providerFailureData = error => {
  const reason = error?.reason;
  const known = new Set(['Authentication', 'RateLimit', 'QuotaExceeded', 'InvalidRequest', 'ProviderConfiguration', 'UnsupportedOperation', 'NoRoute', 'ContentPolicy', 'ProviderInternal', 'Transport', 'Timeout', 'InvalidProviderOutput', 'UnknownProvider']);
  return {
    reason: known.has(reason?._tag) ? reason._tag : 'UnknownProvider',
    ...(Number.isInteger(reason?.http?.status) ? { status: reason.http.status } : {}),
    ...(!known.has(reason?._tag) ? { diagnostic: error?.message?.includes('Schema validation failed') ? 'runtime_schema_mismatch'
      : error?.message?.includes('Service not found') ? 'missing_runtime_service'
        : error?.name === 'TypeError' ? 'type_error' : error?.name === 'ReferenceError' ? 'reference_error' : 'unclassified' } : {}),
  };
};

const toMessage = (message) => {
  if (message.role === 'tool') return Message.tool({ id: message.tool_call_id, name: message.name, result: { type: 'text', value: message.content } });
  if (message.role === 'assistant') return Message.assistant([
    ...(message.content ? [Message.text(message.content)] : []),
    ...(message.tool_calls ?? []).map(call => ({ type: 'tool-call', id: call.id, name: call.function.name, input: JSON.parse(call.function.arguments) })),
  ]);
  const content = [Message.text(message.content)];
  for (const part of message.parts ?? []) {
    if (part.mime?.startsWith('image/')) {
      const comma = part.url.indexOf(',');
      content.push(Message.media(Media.base64(part.url.slice(comma + 1), part.mime)));
    } else content.push(Message.text(`[file: ${part.filename || part.mime}] ${part.url}`));
  }
  return Message.user(content);
};

// RPC effects run in the external service's Location context. Never build a parallel runtime.
const hostRuntime = Effect.context().pipe(Effect.flatMap(context => {
  const resolver = Context.getOption(context, ModelResolver.Service);
  const hooks = Context.getOption(context, PluginHooks.Service);
  return resolver._tag === 'Some' && typeof resolver.value.resolve === 'function'
    && hooks._tag === 'Some' && typeof hooks.value.trigger === 'function'
    ? Effect.succeed({ resolver: resolver.value, hooks: hooks.value })
    : Effect.fail(unavailable());
}));

// No Session creation, context builder, instruction hooks or tool executors belong here.
export const generateBridgeResponse = input => Effect.gen(function* () {
  const { resolver, hooks } = yield* hostRuntime;
  const model = yield* resolver.resolve({ providerID: input.providerID, id: input.modelID, ...(input.variant ? { variant: input.variant } : {}) });
  if (!model) return yield* Effect.fail(unavailable());
  if ([model.model.defaults?.http?.body, model.model.route.defaults?.http?.body].some(body => sensitiveBodyKeys.some(key => Object.hasOwn(body ?? {}, key)))) {
    return yield* Effect.fail(unavailable());
  }
  // This ID is cache affinity only; it does not create a durable OpenCode Session.
  const scope = { sessionID: `ses_${createHash('sha256').update(input.cacheKey).digest('hex')}`, agent: 'yuri-inference', model: model.ref, kind: 'generate' };
  const base = LLM.request({
    // The host and bundled SDK have distinct constructors; preserve the host's route, normalize its value wrapper.
    model: LanguageModel.make(model.model),
    system: input.messages.filter(message => message.role === 'system').map(message => message.content).join('\n\n'),
    messages: input.messages.filter(message => message.role !== 'system').map(toMessage),
    tools: input.tools ?? [],
    promptCacheKey: input.cacheKey,
    ...(model.cache?.ttl === undefined ? {} : { cache: { ttl: model.cache.ttl } }),
    http: { headers: { 'x-opencode-session': input.cacheKey, 'x-session-affinity': input.cacheKey, 'X-Session-Id': input.cacheKey, 'X-Magpie-Session': input.cacheKey } },
    ...(input.maxOutputTokens ? { generation: { maxTokens: input.maxOutputTokens } } : {}),
  });
  // Only transport hooks run. Context/generate hooks could append Agent instructions.
  const adapted = yield* hooks.trigger('session', 'model.request', { ...scope, baseURL: base.model.route.endpoint.baseURL, headers: { ...base.http?.headers } });
  const route = adapted.baseURL !== undefined && adapted.baseURL !== base.model.route.endpoint.baseURL
    ? base.model.route.with({ endpoint: { baseURL: adapted.baseURL } }) : base.model.route;
  // Provider transports may construct requests with their own SDK's nominal model schema.
  // Cross that boundary with the original host wrapper, not the bundled SDK wrapper.
  const hostModel = route === model.model.route ? model.model : model.model.constructor.update(model.model, { route });
  const hostRequest = request => ({ ...request, model: hostModel });
  const bridgedRoute = {
    ...route,
    body: { ...route.body, from: request => route.body.from(hostRequest(request)) },
    prepareTransport: (body, request, options) => route.prepareTransport(body, hostRequest(request), options),
    streamPrepared: (prepared, request, runtime, options) => route.streamPrepared(prepared, hostRequest(request), runtime, options),
  };
  const request = LLMRequest.update(base, {
    model: LanguageModel.update(base.model, { route: bridgedRoute }),
    http: new HttpOptions({ ...base.http, headers: adapted.headers }),
  });
  const result = yield* LLM.generate(request, {
    http: (req, handler) => Effect.gen(function* () {
      const original = yield* HttpClientRequest.toWeb(req);
      const before = yield* hooks.trigger('session', 'http.request', { ...scope, request: original });
      const sent = before.request === original
        ? HttpClientRequest.setBody(HttpClientRequest.fromWeb(original), req.body)
        : before.request.body
          ? HttpClientRequest.bodyUint8Array(HttpClientRequest.fromWeb(before.request),
            new Uint8Array(yield* Effect.promise(() => before.request.clone().arrayBuffer())), before.request.headers.get('content-type') ?? undefined)
          : HttpClientRequest.fromWeb(before.request);
      const response = yield* handler(sent);
      const after = yield* hooks.trigger('session', 'http.response', {
        ...scope, request: before.request,
        response: new Response([204, 205, 304].includes(response.status) ? null : yield* Stream.toReadableStreamEffect(response.stream), { status: response.status, headers: response.headers }),
      });
      return HttpClientResponse.fromWeb(sent, after.response);
    }),
  }).pipe(Effect.provide(AIClient.layer));
  return {
    text: result.text,
    toolCalls: result.toolCalls.map(call => ({ id: call.id, name: call.name, arguments: call.input })),
    finishReason: result.finishReason.normalized,
    usage: { inputTokens: result.usage?.inputTokens ?? 0, outputTokens: result.usage?.outputTokens ?? 0, cacheReadInputTokens: result.usage?.cacheReadInputTokens ?? 0 },
  };
});

export default {
  id: 'yuri.llm.bridge',
  effect: ctx => ctx.rpc.register(LlmBridge, {
    ready: () => hostRuntime.pipe(Effect.as({ version: LLM_BRIDGE_VERSION })),
    generate: (input, call) => generateBridgeResponse(input).pipe(Effect.catchCause(cause => {
      if (Cause.hasInterrupts(cause)) return Effect.failCause(cause);
      // Upstream failures and defects can contain credentials or private prompts. Never forward or log them.
      const error = Cause.squash(cause);
      return Effect.fail(call.error(error?.code === 'unavailable' ? 'unavailable' : 'generation_failed',
        error?.code === 'unavailable' ? unavailable().message : 'LLM provider generation failed',
        error?.code === 'unavailable' ? {} : providerFailureData(error)));
    })),
  }),
};
