import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL, fileURLToPath } from 'node:url';

const source = process.env.OPENCODE_SOURCE;
if (!source) throw new Error('OPENCODE_SOURCE is required');
const { OpenCode } = await import(pathToFileURL(path.join(source, 'packages/client/src/promise/index.ts')).href);
const registration = JSON.parse(await fs.readFile(path.join(process.env.HOME, '.local/state/opencode/service.json'), 'utf8'));
const client = OpenCode.make({ baseUrl: registration.url, headers: { Authorization: `Basic ${Buffer.from(`opencode:${registration.password}`).toString('base64')}` } });
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yuri-bridge-probe-'));
const agentDir = path.join(directory, '.opencode/agent');
await fs.mkdir(agentDir, { recursive: true });
await fs.mkdir(path.join(directory, '.opencode/plugins'), { recursive: true });
await fs.copyFile(fileURLToPath(new URL('./plugin.mjs', import.meta.url)), path.join(directory, '.opencode/plugins/bridge.js'));
await fs.writeFile(path.join(agentDir, 'bridge.md'), '---\nmode: primary\nhidden: true\npermissions:\n  - action: "*"\n    resource: "*"\n    effect: deny\n---\nGenerate only; never execute tools.\n');
const providerID = process.env.PROVIDER_ID || 'magpie-astra';
const modelID = process.env.MODEL_ID || 'deepseek-v4.1-flash';
const tools = ['record_read', 'record_update'].map(name => ({ type: 'function', function: { name, description: name === 'record_read' ? 'Read one record by id' : 'Change the record model from old to new, after reading it', parameters: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'], additionalProperties: false } } }));
const records = Array.from({ length: 8 }, (_, i) => ({ id: i + 1, model: 'old', next: i === 7 ? null : i + 2 }));
const reads = new Set();
const writes = new Set();
const verified = new Set();
const messages = [{ role: 'system', content: 'You are an application-owned agent. Use native tools, never simulate results. Follow the requested sequence and stop only after checking every record. Use one tool call per turn.' }, { role: 'user', content: 'Start with record 1. Read it, update model to new, then read again to verify before following next. Follow all records until next=null. Finish with exactly VERIFIED_8.' }];
let sessionID;
let bareEmptyWithTools = 0;
try {
  for (let i = 0; ; i++) {
    try { await client.agent.get({ agentID: 'bridge', location: { directory } }); break; }
    catch (error) { if (i >= 20) throw error; await new Promise(resolve => setTimeout(resolve, 250)); }
  }
  const plugins = await client.plugin.list({ location: { directory } });
  const list = plugins.data ?? plugins;
  console.log(JSON.stringify({ experimentPlugin: list.find(p => p.id === 'yuri-llm-bridge-experiment')?.state?.status ?? 'not-listed' }));
  assert.ok(list.some(p => p.id === 'yuri-llm-bridge-experiment' && p.state?.status !== 'failed'), 'Experimental plugin must be active');
  const created = await client.session.create({ title: '[experiment] native tool bridge', agent: 'bridge', model: { providerID, id: modelID }, location: { directory } });
  sessionID = created.id;
  if (process.env.CAPTURE_PROMPT_FILE || process.env.CAPTURE_TEXT_PROTOCOL) {
    const { prompt } = process.env.CAPTURE_PROMPT_FILE
      ? JSON.parse(await fs.readFile(process.env.CAPTURE_PROMPT_FILE, 'utf8'))
      : { prompt: 'You generate responses for an application-owned assistant. Native tools are denied. The application executes yuri-tool JSON fences in your response. Emit the requested tool call as plain text, not a native function call. Available application tool: edit, arguments {path:string,edits:[{oldText:string,newText:string}]}. Use exactly ```yuri-tool\\n{"name":"edit","arguments":{...}}\\n``` for the next operation.\n\nUser: Read task-1.json, change model from old to new, read it again to verify, then follow next.\n\nAssistant: ```yuri-tool\n{"name":"read","arguments":{"path":"task-1.json"}}\n```\n\nUser: Yuri tool result name=read call=call_1: {"isError":false,"content":"{\\"id\\":1,\\"model\\":\\"old\\",\\"next\\":2}"}' };
    await fs.writeFile(path.join(directory, 'input.json'), JSON.stringify({ captureOnly: true }), { mode: 0o600 });
    for (let trial = 1; trial <= 5; trial++) {
      await fs.rm(path.join(directory, 'output.json'), { force: true });
      const bare = await client.session.generate({ sessionID, prompt });
      const result = JSON.parse(await fs.readFile(path.join(directory, 'output.json'), 'utf8'));
      console.log(JSON.stringify({ captureOnly: true, trial, bareTextLength: bare.text.length, toolNames: result.toolCalls.map(c => c.function.name), finishReason: result.finishReason, outputTokens: result.usage?.completion_tokens }));
    }
  } else for (let round = 1; round <= 40; round++) {
    await fs.writeFile(path.join(directory, 'input.json'), JSON.stringify({ messages, tools }), { mode: 0o600 });
    await fs.rm(path.join(directory, 'output.json'), { force: true });
    const start = Date.now();
    const bare = await client.session.generate({ sessionID, prompt: 'Use the application-supplied request.' });
    const result = JSON.parse(await fs.readFile(path.join(directory, 'output.json'), 'utf8'));
    if (!bare.text && result.toolCalls.length) bareEmptyWithTools++;
    console.log(JSON.stringify({ round, ms: Date.now() - start, bareTextLength: bare.text.length, textLength: result.text.length, toolNames: result.toolCalls.map(c => c.function.name), finishReason: result.finishReason, outputTokens: result.usage?.completion_tokens }));
    assert.ok(result.text || result.toolCalls.length, 'Empty structured response');
    messages.push({ role: 'assistant', content: result.text || null, ...(result.toolCalls.length ? { tool_calls: result.toolCalls } : {}) });
    if (!result.toolCalls.length) {
      assert.match(result.text.trim(), /\bVERIFIED_8\b/);
      assert.equal(writes.size, 8); assert.equal(verified.size, 8);
      assert.ok(records.every(record => record.model === 'new'));
      console.log(JSON.stringify({ passed: true, rounds: round, mutations: writes.size, verified: verified.size, bareEmptyWithTools, providerID, modelID, reuse: 'Running OpenCode configuration, credentials and HTTP hooks; no credentials copied' }));
      break;
    }
    for (const call of result.toolCalls) {
      const args = JSON.parse(call.function.arguments);
      assert.ok(Number.isInteger(args.id) && args.id >= 1 && args.id <= 8);
      const record = records[args.id - 1];
      if (!reads.has(record.id) && record.id > 1) assert.ok(verified.has(record.id - 1), 'Previous record must be verified before following next');
      if (call.function.name === 'record_update') {
        assert.ok(reads.has(record.id)); assert.ok(!writes.has(record.id), 'Mutation replay');
        record.model = 'new'; writes.add(record.id);
      } else {
        assert.equal(call.function.name, 'record_read'); reads.add(record.id);
        if (writes.has(record.id)) verified.add(record.id);
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(record) });
    }
    assert.ok(round < 40, 'Experimental safety limit reached');
  }
} finally {
  if (sessionID) await client.session.remove({ sessionID });
  await fs.rm(directory, { recursive: true, force: true });
}
