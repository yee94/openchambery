import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { makeOpenCodeV2Client } from '../../packages/web/server/lib/opencode/v2-client.js';
import { createChatCompletion } from '../../packages/web/server/lib/llm/completions.js';
import { runContactTurn } from '../../packages/web/server/lib/assistants/harness.js';
import { stopLlmBridgeDirectory } from '../../packages/web/server/lib/llm/bridge-client.js';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yuri-inference-acceptance-'));
process.env.YURI_DATA_DIR = directory;
const { createSmallModelService } = await import('../../packages/web/server/lib/small-model/index.js');
const providerID = process.env.PROVIDER_ID || 'magpie-astra';
const modelID = process.env.MODEL_ID || 'deepseek-v4.1-flash';
const registration = JSON.parse(await fs.readFile(path.join(os.homedir(), '.local/state/opencode/service.json'), 'utf8'));
const headers = { Authorization: `Basic ${Buffer.from(`opencode:${registration.password}`).toString('base64')}` };
const sdk = makeOpenCodeV2Client({ baseUrl: registration.url, authHeaders: headers });
const client = { ...sdk, session: new Proxy({}, { get() { throw new Error('A production LLM call must not use Session APIs'); } }) };
const dependencies = { buildOpenCodeUrl: () => registration.url, getOpenCodeAuthHeaders: () => headers, clientFactory: () => client };
const files = ['opencode.json', 'opencode.jsonc'];
const configHash = async () => Promise.all(files.map(async name => {
  try { return createHash('sha256').update(await fs.readFile(path.join(os.homedir(), '.config/opencode', name))).digest('hex'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}));
const before = await configHash();
try {
  await fs.writeFile(path.join(directory, 'settings.json'), JSON.stringify({ summaryModelMode: 'provider', summaryProviderID: providerID, summaryModelID: modelID }));
  const small = createSmallModelService({ ...dependencies, openCodeClientFactory: () => client });
  const summary = await small.generateSmallModelText({ purpose: 'session-title', prompt: '为下面会话写一个简短中文标题：用户要求将缓存读取从逐条查询改为批量查询；助手已经实现批量读取，并通过了 12 项测试。只返回标题。', maxOutputTokens: 256 });
  assert.ok(summary.text.trim());
  assert.match(summary.text, /缓存|批量/);
  console.log(JSON.stringify({ scenario: 'session-summary-title', passed: true, providerID: summary.providerID, modelID: summary.modelID, text: summary.text }));
  for (let i = 1; i <= 8; i++) await fs.writeFile(path.join(directory, `task-${i}.json`), JSON.stringify({ id: i, model: 'old', next: i === 8 ? null : i + 1 }, null, 2));
  let rounds = 0;
  let nativeCalls = 0;
  const result = await runContactTurn({
    assistant: { id: 'acceptance-fixture', providerID, modelID, workspacePath: directory },
    history: [], skillHomeDir: directory,
    userText: '这是隔离测试目录里的八个小配置变更，请你直接完成，不委派。先读取 task-1.json，再把 model 从 old 改为 new，改后读回核对，按 next 字段继续直到 null。只用 read/edit，每次一个调用，不要用 bash/write，也不要重写整个文件。八个文件全部核对后才报告完成。',
    createChatCompletion: async input => {
      rounds++;
      assert.ok(rounds <= 50, 'Acceptance safety limit reached');
      const response = await createChatCompletion({ ...input, ...dependencies });
      nativeCalls += response.completion.choices[0].message.tool_calls?.length ?? 0;
      return response;
    },
  });
  for (let i = 1; i <= 8; i++) assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, `task-${i}.json`), 'utf8')), { id: i, model: 'new', next: i === 8 ? null : i + 1 });
  assert.ok(nativeCalls >= 24);
  assert.ok(result.text.trim());
  assert.deepEqual(await configHash(), before);
  console.log(JSON.stringify({ scenario: 'real-contact-Agent-loop', passed: true, rounds, nativeCalls, verifiedFiles: 8, globalConfigurationUnchanged: true, sessionCalls: 0 }));
} finally {
  await stopLlmBridgeDirectory();
  await fs.rm(directory, { recursive: true, force: true });
}
