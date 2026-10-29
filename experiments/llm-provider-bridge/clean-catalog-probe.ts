// Direct single-call LLM experiment. No Session APIs or session hooks are used.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const source = process.env.OPENCODE_SOURCE;
if (!source) throw new Error('OPENCODE_SOURCE is required');
const load = (file: string) => import(pathToFileURL(path.join(source, file)).href);
const { Effect } = await load('packages/core/node_modules/effect/dist/index.js');
const { OpenCode } = await load('packages/client/src/promise/index.ts');
const { ModelResolver } = await load('packages/core/src/model-resolver.ts');
const { Provider } = await load('packages/core/src/provider.ts');
const { LLM, Message, AIClient } = await load('packages/ai/src/effect.ts');
const registration = JSON.parse(await fs.readFile(path.join(process.env.HOME, '.local/state/opencode/service.json'), 'utf8'));
const client = OpenCode.make({ baseUrl: registration.url, headers: { Authorization: `Basic ${Buffer.from(`opencode:${registration.password}`).toString('base64')}` } });
const providerID = process.env.PROVIDER_ID || 'magpie-astra';
const modelID = process.env.MODEL_ID || 'deepseek-v4.1-flash';
const providerResult = await client.provider.get({ providerID });
const provider = providerResult.data ?? providerResult;
const catalog = await client.model.list();
const model = catalog.data.find(item => item.providerID === providerID && item.id === modelID);
assert.ok(model, 'Model must exist in the live catalog');
const settings = Provider.mergeOverlay(provider.settings, Provider.modelSettings(model.settings));
assert.ok(settings?.apiKey || settings?.authToken || settings?.accessToken, 'This probe requires configured authentication in model/provider settings; OAuth-only models are not proven');
const runtimeModel = await Effect.runPromise(ModelResolver.fromCatalogModel({ ...model, settings }, undefined, {
  loadPackage: specifier => Effect.tryPromise(() => import(pathToFileURL(Bun.resolveSync(specifier, path.join(source, 'packages/core'))).href)),
}));
const markerA = `ALPHA_${randomUUID()}`;
const markerB = `BETA_${randomUUID()}`;
const stable = `clean-${randomUUID()}`;
const system = 'Return exactly the marker in the user message. Do not add commentary.';
const prefix = 'Synthetic fixed cache probe, no relevant facts here. '.repeat(300);
const usageRows = [];
for (const [lane, marker, other] of [['A', markerA, markerB], ['B', markerB, markerA], ['A', markerA, markerB]]) {
  let audited = false;
  const result = await Effect.runPromise(LLM.generate({
    model: runtimeModel,
    system,
    messages: [Message.user(`${prefix}\nMarker: ${marker}`)],
    tools: [],
    promptCacheKey: `${stable}-${lane}`,
    http: { headers: { 'x-opencode-session': `${stable}-${lane}`, 'X-Magpie-Session': `${stable}-${lane}` } },
  }, { http: (request, handler) => Effect.gen(function* () {
    assert.equal(request.body._tag, 'Uint8Array');
    const raw = new TextDecoder().decode(request.body.body);
    assert.ok(raw.includes(marker)); assert.ok(!raw.includes(other));
    const body = JSON.parse(raw);
    assert.equal(body.messages.length, 2);
    assert.deepEqual(body.messages.map(message => message.role), ['system', 'user']);
    assert.equal(body.messages[0].content, system);
    assert.equal(body.tools?.length ?? 0, 0);
    audited = true;
    return yield* handler(request);
  }) }).pipe(Effect.provide(AIClient.layer)));
  assert.ok(audited);
  assert.equal(result.text.trim(), marker);
  const row = { lane, exactReply: true, wireContextExact: true, finishReason: result.finishReason, inputTokens: result.usage?.inputTokens, cacheReadInputTokens: result.usage?.cacheReadInputTokens, outputTokens: result.usage?.outputTokens };
  usageRows.push(row);
  console.log(JSON.stringify(row));
}
console.log(JSON.stringify({ passed: true, sessionGenerateCalls: 0, createdSessions: 0, contextIsolationChecks: usageRows.length, providerID, modelID, authScope: 'Configured model/provider settings only; no OAuth refresh verification' }));

const records = Array.from({ length: 8 }, (_, i) => ({ id: i + 1, model: 'old', next: i === 7 ? null : i + 2 }));
const reads = new Set();
const writes = new Set();
const verified = new Set();
const tools = ['record_read', 'record_update'].map(name => ({ name, description: name === 'record_read' ? 'Read one record' : 'Change model to new after reading the record', inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'], additionalProperties: false } }));
const messages = [Message.user('Start at record 1. Read, update model to new, then read again to verify before following next. Follow all records until next=null. Use exactly one tool call per turn. Finish with VERIFIED_8 only after all records are verified.')];
const ownSystem = 'You are a custom application Agent. Use native tools, never simulate results. Complete the user task based only on actual tool results.';
let wireChecks = 0;
let completed = false;
let emptyTextWithTools = 0;
for (let round = 1; round <= 40; round++) {
  const result = await Effect.runPromise(LLM.generate({
    model: runtimeModel, system: ownSystem, messages, tools,
    promptCacheKey: `${stable}-tools`,
    http: { headers: { 'x-opencode-session': `${stable}-tools`, 'X-Magpie-Session': `${stable}-tools` } },
  }, { http: (request, handler) => Effect.gen(function* () {
    assert.equal(request.body._tag, 'Uint8Array');
    const raw = new TextDecoder().decode(request.body.body);
    const body = JSON.parse(raw);
    assert.equal(body.messages[0].role, 'system');
    assert.equal(body.messages[0].content, ownSystem);
    assert.equal(body.messages.length, messages.length + 1);
    assert.deepEqual(body.tools.map(tool => tool.function.name), ['record_read', 'record_update']);
    assert.ok(!raw.includes(markerA) && !raw.includes(markerB));
    wireChecks++;
    return yield* handler(request);
  }) }).pipe(Effect.provide(AIClient.layer)));
  assert.ok(result.text || result.toolCalls.length);
  if (!result.text && result.toolCalls.length) emptyTextWithTools++;
  console.log(JSON.stringify({ event: 'native-tool-round', round, toolNames: result.toolCalls.map(call => call.name), finishReason: result.finishReason, inputTokens: result.usage?.inputTokens, cacheReadInputTokens: result.usage?.cacheReadInputTokens }));
  messages.push(result.message);
  if (!result.toolCalls.length) {
    assert.match(result.text, /\bVERIFIED_8\b/);
    assert.equal(writes.size, 8); assert.equal(verified.size, 8);
    assert.ok(records.every(record => record.model === 'new'));
    completed = true;
    break;
  }
  for (const call of result.toolCalls) {
    const args = call.input;
    assert.ok(Number.isInteger(args.id) && args.id >= 1 && args.id <= 8);
    const record = records[args.id - 1];
    if (!reads.has(record.id) && record.id > 1) assert.ok(verified.has(record.id - 1));
    if (call.name === 'record_update') {
      assert.ok(reads.has(record.id)); assert.ok(!writes.has(record.id), 'No duplicate mutation');
      record.model = 'new'; writes.add(record.id);
    } else {
      assert.equal(call.name, 'record_read'); reads.add(record.id);
      if (record.model === 'new') verified.add(record.id);
    }
    messages.push(Message.tool({ id: call.id, name: call.name, result: { type: 'text', value: JSON.stringify(record) } }));
  }
}
assert.ok(completed, 'Experimental safety limit reached, not completed');
console.log(JSON.stringify({ event: 'native-tool-PASS', sessionGenerateCalls: 0, createdSessions: 0, wireChecks, writes: writes.size, verified: verified.size, emptyTextWithTools }));
