import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { makeOpenCodeV2Client } from '../../packages/web/server/lib/opencode/v2-client.js';
import { createChatCompletion } from '../../packages/web/server/lib/llm/completions.js';
import { loadConnectedCatalog } from '../../packages/web/server/lib/llm/catalog.js';
import { stopLlmBridgeDirectory } from '../../packages/web/server/lib/llm/bridge-client.js';

const registration = JSON.parse(await fs.readFile(path.join(os.homedir(), '.local/state/opencode/service.json'), 'utf8'));
const headers = { Authorization: `Basic ${Buffer.from(`opencode:${registration.password}`).toString('base64')}` };
const sdk = makeOpenCodeV2Client({ baseUrl: registration.url, authHeaders: headers });
const client = { ...sdk, session: new Proxy({}, { get() { throw new Error('Host Session APIs are forbidden'); } }) };
const catalog = await loadConnectedCatalog(client);
const selected = process.env.PROVIDER_IDS?.split(',');
const results = [];
try {
  for (const providerID of catalog.connected.filter(id => !selected || selected.includes(id))) {
    const models = catalog.models.filter(model => model.providerID === providerID);
    const model = models.find(model => /deepseek-v4.1-flash|gpt-6.1-sol$|gpt-5-nano$/.test(model.modelID)) ?? models[0];
    if (!model) { results.push({ providerID, status: 'no-model' }); continue; }
    try {
      const result = await createChatCompletion({
        clientFactory: () => client, buildOpenCodeUrl: () => registration.url, getOpenCodeAuthHeaders: () => headers,
        body: { providerID, modelID: model.modelID, messages: [{ role: 'system', content: 'Reply exactly OK.' }, { role: 'user', content: 'Connectivity test.' }] },
      });
      if (!result.completion.choices[0].message.content.trim()) throw new Error('empty-output');
      results.push({ providerID, modelID: model.modelID, status: 'passed' });
    } catch (error) {
      results.push({ providerID, modelID: model.modelID, status: 'failed', code: error.code || 'unknown', ...(error.providerFailure ? { providerFailure: error.providerFailure } : {}) });
      process.exitCode = 1;
    }
    console.log(JSON.stringify(results.at(-1)));
  }
  console.log(JSON.stringify({ scenario: 'connected-provider-matrix', results }));
} finally { await stopLlmBridgeDirectory(); }
