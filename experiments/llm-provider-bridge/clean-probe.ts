import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const source = process.env.OPENCODE_SOURCE;
if (!source) throw new Error('OPENCODE_SOURCE is required');
const load = (file: string) => import(pathToFileURL(path.join(source, file)).href);
const { Effect } = await load('packages/core/node_modules/effect/dist/index.js');
const { EmbeddedHost } = await load('packages/sdk/src/internal/host.ts');
const { LocationServiceMap } = await load('packages/core/src/location-service-map.ts');
const { ModelResolver } = await load('packages/core/src/model-resolver.ts');
const { Plugin } = await load('packages/core/src/plugin/service.ts');
const { LLM, Message } = await load('packages/ai/src/effect.ts');
const providerID = process.env.PROVIDER_ID;
const modelID = process.env.MODEL_ID;
if (!providerID || !modelID) throw new Error('PROVIDER_ID and MODEL_ID are required');
const host = await Effect.runPromise(EmbeddedHost.create({ log: { level: 'error' } }));
try {
  const locations = await host.runtime.runPromise(LocationServiceMap.Service);
  await host.runtime.runPromise(Effect.scoped(Effect.gen(function* () {
    const context = yield* locations.contextEffect({ directory: process.cwd() });
    yield* Effect.gen(function* () {
      yield* Plugin.awaitActivation;
      const inventory = yield* (yield* Plugin.Service).list();
      console.log(JSON.stringify({ event: 'plugins', active: inventory.filter(p => p.state.status === 'active').length, failed: inventory.filter(p => p.state.status === 'failed').map(p => p.id) }));
      const resolver = yield* ModelResolver.Service;
      const resolved = yield* resolver.resolve({ providerID, id: modelID });
      assert.ok(resolved, 'Configured model must resolve');
      console.log(JSON.stringify({ event: 'resolved', providerID, modelID }));
      const seen = [];
      const audit = (expected: string, forbidden: string) => (request, handler) => Effect.gen(function* () {
        assert.equal(request.body._tag, 'Uint8Array');
        const raw = new TextDecoder().decode(request.body.body);
        assert.ok(raw.includes(expected), 'Caller context must reach the wire');
        assert.ok(!raw.includes(forbidden), 'Other conversation context must not reach the wire');
        const body = JSON.parse(raw);
        assert.deepEqual(body.messages.map(m => m.role), ['system', 'user']);
        assert.equal(body.messages.length, 2);
        assert.equal(body.tools?.length ?? 0, 0);
        seen.push({ roles: body.messages.map(m => m.role), messageCount: body.messages.length });
        return yield* handler(request);
      });
      const markerA = `ALPHA_${randomUUID()}`;
      const markerB = `BETA_${randomUUID()}`;
      const system = 'Return exactly the marker in the user message. Do not add commentary.';
      const stable = `clean-bridge-${randomUUID()}`;
      // Large constant synthetic prefix makes provider cache accounting observable.
      const prefix = 'Synthetic cache probe, irrelevant fixed context. '.repeat(300);
      for (const [lane, marker, other] of [['A', markerA, markerB], ['B', markerB, markerA], ['A', markerA, markerB]]) {
        const result = yield* LLM.generate({
          model: resolved.model,
          system,
          messages: [Message.user(`${prefix}\nMarker: ${marker}`)],
          tools: [],
          promptCacheKey: `${stable}-${lane}`,
          http: { headers: { 'x-opencode-session': `${stable}-${lane}`, 'X-Magpie-Session': `${stable}-${lane}` } },
        }, { http: audit(marker, other) });
        assert.equal(result.text.trim(), marker);
        console.log(JSON.stringify({ event: 'clean-call', lane, exactReply: true, finishReason: result.finishReason, inputTokens: result.usage?.inputTokens, cacheReadInputTokens: result.usage?.cacheReadInputTokens, outputTokens: result.usage?.outputTokens }));
      }
      assert.equal(seen.length, 3);
      console.log(JSON.stringify({ passed: true, sessionGenerateCalls: 0, createdSessions: 0, sessionHooksInvokedByBridge: 0, wireIsolationChecks: seen.length, modelResolvedFromExistingConfiguration: true }));
    }).pipe(Effect.provide(context));
  })));
} finally { await host.close(); }
