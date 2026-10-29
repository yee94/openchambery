// Run with Bun. OPENCODE_SOURCE points to an existing OpenCode checkout with dependencies installed.
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const source = process.env.OPENCODE_SOURCE;
if (!source) throw new Error('OPENCODE_SOURCE is required');
const load = (file: string) => import(pathToFileURL(path.join(source, file)).href);
const { Effect } = process.env.EFFECT_RUNTIME
  ? await import(pathToFileURL(Bun.resolveSync('effect', process.env.EFFECT_RUNTIME)).href)
  : await load('packages/core/node_modules/effect/dist/index.js');
const { EmbeddedHost } = await load('packages/sdk/src/internal/host.ts');
const { OpenCode } = await load('packages/client/src/promise/index.ts');
const { Instance } = await load('packages/core/src/instance/service.ts');
const { SessionContext } = await load('packages/core/src/session/context.ts');
const { Plugin } = await load('packages/core/src/plugin/service.ts');
const { LLMClient, Message, SystemPart } = await load('packages/ai/src/effect.ts');

const host = await Effect.runPromise(EmbeddedHost.create({ log: { level: 'error' } }));
const client = OpenCode.make({ baseUrl: 'http://opencode.local', fetch: host.fetch });
const directory = process.cwd();
const providerID = process.env.PROVIDER_ID;
const modelID = process.env.MODEL_ID;
if (!providerID || !modelID) throw new Error('PROVIDER_ID and MODEL_ID are required');
let sessionID: string | undefined;
let nativeExecutions = 0;
const records = Array.from({ length: 8 }, (_, i) => ({ id: i + 1, model: 'old', next: i === 7 ? null : i + 2 }));
const writes = new Set<number>();
const verifications = new Set<number>();
const messages = [Message.user('Starting with id 1, read each record, change model from old to new, then read it again to verify before following its next id. Use one tool at a time. Follow all 8 records until next is null. Do not claim completion until every record is verified. Finish with exactly VERIFIED_8.')];
const tools = {
  definitions: [
    { name: 'record_read', description: 'Read one record by id.', inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'], additionalProperties: false } },
    { name: 'record_update', description: 'Change one record model to new. Call only after reading it.', inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'], additionalProperties: false } },
  ],
  execute: () => { nativeExecutions++; return Effect.die('OpenCode must never execute application tools'); },
};
try {
  const created = await client.session.create({
    title: '[experiment] custom LLM bridge', location: { directory },
    model: { providerID, id: modelID }, permissions: [{ action: '*', resource: '*', effect: 'deny' }],
  });
  sessionID = created.id;
  const session = await host.runtime.runPromise(host.sessions.get(sessionID));
  const instances = await host.runtime.runPromise(Instance.Service);
  let round = 0;
  for (; round < 40; round++) {
    const start = Date.now();
    const result = await host.runtime.runPromise(Effect.gen(function* () {
      yield* Plugin.awaitActivation;
      const context = yield* SessionContext.Service;
      const selection = yield* context.select(session.id);
      const model = yield* context.resolveModel(selection.session);
      const prepared = yield* context.request.generate({
        session: selection.session, agent: selection.agent.id, model, tools,
        system: [SystemPart.make('You are an application-owned agent. Only record_read and record_update are available. Use native function calls, not markdown or simulated results. Complete the requested operations and verify actual results.')],
        messages,
      });
      const llm = yield* LLMClient.Service;
      return yield* llm.generate(prepared.request, prepared.options);
    }).pipe(instances.provide(session)));
    console.log(JSON.stringify({ round: round + 1, ms: Date.now() - start, textLength: result.text.length, toolNames: result.toolCalls.map((c: { name: string }) => c.name), finishReason: result.finishReason, inputTokens: result.usage?.inputTokens, outputTokens: result.usage?.outputTokens }));
    if (!result.text && result.toolCalls.length === 0) throw new Error('Empty structured response');
    messages.push(result.message);
    if (result.toolCalls.length === 0) {
      assert.equal(result.text.trim(), 'VERIFIED_8');
      break;
    }
    for (const call of result.toolCalls) {
      const args = call.input;
      assert.ok(args && Number.isInteger(args.id) && args.id >= 1 && args.id <= 8);
      const record = records[args.id - 1];
      if (call.name === 'record_update') {
        assert.ok(!writes.has(record.id), 'A mutation must not be replayed');
        record.model = 'new'; writes.add(record.id);
      } else {
        assert.equal(call.name, 'record_read');
        if (record.model === 'new') verifications.add(record.id);
      }
      messages.push(Message.tool({ id: call.id, name: call.name, result: { type: 'text', value: JSON.stringify(record) } }));
    }
  }
  assert.equal(writes.size, 8);
  assert.equal(verifications.size, 8);
  assert.equal(nativeExecutions, 0);
  assert.ok(round < 40);
  console.log(JSON.stringify({ passed: true, rounds: round + 1, writes: writes.size, verified: verifications.size, nativeExecutions, reusedConfiguration: true, note: 'Internal source-level prototype, not a public API integration' }));
} finally {
  if (sessionID) await client.session.remove({ sessionID });
  await host.close();
}
