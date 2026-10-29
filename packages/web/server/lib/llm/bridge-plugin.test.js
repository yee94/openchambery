import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Effect } from 'effect';
import { ModelResolver } from '@opencode/core/model-resolver';
import { PluginHooks } from '@opencode/core/plugin/hooks';
import * as compatible from '@opencode/ai/providers/openai-compatible';
import bridge, { generateBridgeResponse } from './bridge-plugin.js';

const servers = [];
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } });

async function fixture(reply) {
  const requests = [];
  const headers = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    headers.push(req.headers);
    res.setHeader('content-type', 'text/event-stream');
    const delta = { ...reply, ...(reply.tool_calls ? { tool_calls: reply.tool_calls.map((call, index) => ({ ...call, index })) } : {}) };
    res.end(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason: reply.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_tokens_details: { cached_tokens: 80 } } })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const model = { id: 'fixture', providerID: 'fixture', package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: `http://127.0.0.1:${server.address().port}/v1` }, capabilities: { input: ['text'], output: ['text'], tools: true }, headers: {}, body: {}, variants: [] };
  const credential = { type: 'key', key: 'fixture-only' };
  const resolve = vi.fn(ref => ModelResolver.withVariant(model, ref.variant).pipe(
    Effect.flatMap(selected => ModelResolver.fromCatalogModel(selected, credential, { loadPackage: () => Effect.succeed(compatible) })),
    Effect.map(runtime => ({ model: runtime, ref })),
  ));
  const trigger = vi.fn((_domain, _name, event) => Effect.succeed(event));
  const runEffect = effect => Effect.runPromise(effect.pipe(
    Effect.provideService(ModelResolver.Service, { resolve }),
    Effect.provideService(PluginHooks.Service, { trigger }),
  ));
  const run = input => runEffect(generateBridgeResponse(input));
  const input = { providerID: 'fixture', modelID: 'fixture', cacheKey: 'lane-a', messages: [{ role: 'system', content: 'Only this system' }, { role: 'user', content: 'Only this user' }] };
  return { input, requests, headers, model, credential, resolve, trigger, run, runEffect };
}

describe('external runtime provider bridge', () => {
  it('sends only caller context and returns measured usage through the host resolver', async () => {
    const { input, requests, resolve, trigger, run } = await fixture({ role: 'assistant', content: 'summary' });
    expect(await run(input)).toMatchObject({ text: 'summary', toolCalls: [], usage: { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 80 } });
    expect(requests[0].messages).toEqual(input.messages);
    expect(resolve).toHaveBeenCalledExactlyOnceWith({ providerID: 'fixture', id: 'fixture' });
    expect(trigger.mock.calls.map(([, name]) => name)).toEqual(['model.request', 'http.request', 'http.response']);
  });

  it('retains native tool calls when the provider has no assistant text', async () => {
    const { input, requests, run } = await fixture({ role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"id":1}' } }] });
    input.tools = [{ name: 'lookup', description: 'Lookup', inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } }];
    expect(await run(input)).toMatchObject({ text: '', toolCalls: [{ id: 'call_1', name: 'lookup', arguments: { id: 1 } }], finishReason: 'tool-calls' });
    expect(requests[0].tools[0].function.name).toBe('lookup');
  });

  it('rejects model overrides that could inject context', async () => {
    const { input, model, requests, run } = await fixture({ role: 'assistant', content: 'unused' });
    model.body = { messages: [{ role: 'system', content: 'foreign' }] };
    await expect(run(input)).rejects.toMatchObject({ code: 'unavailable' });
    expect(requests).toHaveLength(0);
  });

  it('round-trips native assistant calls and tool results without flattening roles', async () => {
    const { input, requests, run } = await fixture({ role: 'assistant', content: 'verified' });
    input.messages.push(
      { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', function: { name: 'lookup', arguments: '{"id":1}' } }] },
      { role: 'tool', name: 'lookup', tool_call_id: 'call_1', content: '{"value":"found"}' },
    );
    await run(input);
    expect(requests[0].messages[2]).toMatchObject({ role: 'assistant', tool_calls: [{ id: 'call_1', function: { name: 'lookup', arguments: '{"id":1}' } }] });
    expect(requests[0].messages[3]).toMatchObject({ role: 'tool', tool_call_id: 'call_1', content: '{"value":"found"}' });
  });

  it('accepts host-resolved OAuth and applies refreshed authorization through transport hooks', async () => {
    const { input, credential, trigger, headers, run } = await fixture({ role: 'assistant', content: 'authorized' });
    Object.assign(credential, { type: 'oauth', access: 'fixture-oauth-token' });
    trigger.mockImplementation((_domain, name, event) => Effect.sync(() => {
      if (name === 'model.request') event.headers['session-id'] = event.sessionID;
      if (name === 'http.request') event.request.headers.set('authorization', 'Bearer fixture-refreshed-token');
      return event;
    }));
    expect(await run(input)).toMatchObject({ text: 'authorized' });
    expect(headers[0]).toMatchObject({ authorization: 'Bearer fixture-refreshed-token', 'session-id': expect.stringMatching(/^ses_[0-9a-f]{64}$/) });
  });

  it('forwards provider and variant selection without a Yuri package allowlist', async () => {
    const { input, model, resolve, run } = await fixture({ role: 'assistant', content: 'variant' });
    model.variants = [{ id: 'custom', body: { temperature: 0.2 } }];
    await run({ ...input, providerID: 'custom-provider', variant: 'custom' });
    expect(resolve).toHaveBeenCalledExactlyOnceWith({ providerID: 'custom-provider', id: 'fixture', variant: 'custom' });
  });

  it('preserves replacement HTTP request bodies from provider hooks', async () => {
    const { input, trigger, requests, run } = await fixture({ role: 'assistant', content: 'adapted' });
    trigger.mockImplementation((_domain, name, event) => name === 'http.request'
      ? Effect.tryPromise(async () => { const body = await event.request.clone().json(); event.request = new Request(event.request, { body: JSON.stringify({ ...body, provider_marker: true }) }); return event; })
      : Effect.succeed(event));
    await run(input);
    expect(requests[0].provider_marker).toBe(true);
    expect(requests[0].messages).toEqual(input.messages);
  });

  it('retains host model identity after a provider rewrites its endpoint', async () => {
    const { input, trigger, run } = await fixture({ role: 'assistant', content: 'routed' });
    trigger.mockImplementation((_domain, name, event) => Effect.sync(() => {
      if (name === 'model.request') event.baseURL += '/alternate';
      return event;
    }));
    expect(await run(input)).toMatchObject({ text: 'routed' });
  });

  it('reports only allowlisted failure categories and status, not provider error bodies', async () => {
    const { resolve, runEffect, input } = await fixture({ role: 'assistant', content: 'unused' });
    resolve.mockImplementation(() => Effect.fail({ message: 'private credential', reason: { _tag: 'Authentication', body: 'private credential', http: { status: 401, headers: { authorization: 'private credential' } } } }));
    let handlers;
    await Effect.runPromise(bridge.effect({ rpc: { register: (_definition, value) => { handlers = value; return Effect.void; } } }));
    const error = (type, message, data) => ({ type, message, data });
    await expect(runEffect(handlers.generate(input, { error }))).rejects.toEqual({ type: 'generation_failed', message: 'LLM provider generation failed', data: { reason: 'Authentication', status: 401 } });
  });

  it('fails explicitly when the external runtime services are unavailable', async () => {
    await expect(Effect.runPromise(generateBridgeResponse({}))).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('normalizes a model wrapper from a separately bundled host SDK', async () => {
    const { input, resolve, run } = await fixture({ role: 'assistant', content: 'host model' });
    const original = resolve.getMockImplementation();
    resolve.mockImplementation(ref => original(ref).pipe(Effect.map(value => {
      const host = { ...value.model };
      const prepare = host.route.prepareTransport;
      host.route = { ...host.route, prepareTransport: (body, request, options) => {
        expect(request.model).toBe(host);
        return prepare(body, request, options);
      } };
      return { ...value, model: host };
    })));
    expect(await run(input)).toMatchObject({ text: 'host model' });
  });

  it('preserves interruption instead of converting cancellation into a provider error', async () => {
    let handlers;
    await Effect.runPromise(bridge.effect({ rpc: { register: (_definition, value) => { handlers = value; return Effect.void; } } }));
    const controller = new AbortController();
    const error = vi.fn();
    const pending = Effect.runPromise(handlers.generate({}, { error }).pipe(
      Effect.provideService(ModelResolver.Service, { resolve: () => Effect.never }),
      Effect.provideService(PluginHooks.Service, { trigger: () => Effect.never }),
    ), { signal: controller.signal }).catch(value => value);
    controller.abort();
    expect(await pending).toBeInstanceOf(Error);
    expect(error).not.toHaveBeenCalled();
  });

  it.each(['fail', 'die'])('does not expose private upstream %s through RPC', async (failure) => {
    const { resolve, runEffect, input } = await fixture({ role: 'assistant', content: 'unused' });
    resolve.mockImplementation(() => Effect[failure](new Error('private upstream content')));
    let handlers;
    await Effect.runPromise(bridge.effect({ rpc: { register: (_definition, value) => { handlers = value; return Effect.void; } } }));
    const error = (type, message, data) => ({ type, message, data });
    await expect(runEffect(handlers.generate(input, { error }))).rejects.toEqual({ type: 'generation_failed', message: 'LLM provider generation failed', data: { reason: 'UnknownProvider', diagnostic: 'unclassified' } });
  });
});
