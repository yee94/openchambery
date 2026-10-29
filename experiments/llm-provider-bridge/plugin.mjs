import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export default {
  id: 'yuri-llm-bridge-experiment',
  async setup(ctx) {
    await ctx.session.hook('http.request', async (event) => {
      if (event.kind !== 'generate' || event.agent !== 'bridge') return;
      const input = JSON.parse(await readFile(path.join(ctx.location.directory, 'input.json'), 'utf8'));
      if (input.captureOnly) return;
      const body = await event.request.clone().json();
      // Protocol-specific experiment: reuse the selected provider's URL/auth/hooks,
      // replacing only the Chat Completions payload owned by the application.
      if (!Array.isArray(body.messages)) throw new Error('This experiment requires Chat Completions');
      body.messages = input.messages;
      body.tools = input.tools;
      body.tool_choice = 'auto';
      event.request = new Request(event.request, { body: JSON.stringify(body) });
    });
    await ctx.session.hook('http.response', async (event) => {
      if (event.kind !== 'generate' || event.agent !== 'bridge' || !event.response.ok) return;
      const text = await event.response.clone().text();
      const frames = text.trim().startsWith('{') ? [JSON.parse(text)] : text.split(/\r?\n/)
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trim()).filter(value => value && value !== '[DONE]')
        .map(value => JSON.parse(value));
      const result = { text: '', toolCalls: [], finishReason: null, usage: null };
      for (const frame of frames) {
        if (frame.usage) result.usage = frame.usage;
        const choice = frame.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) result.finishReason = choice.finish_reason;
        const message = choice.message ?? choice.delta;
        if (typeof message?.content === 'string') result.text += message.content;
        for (const [position, call] of (message?.tool_calls ?? []).entries()) {
          const index = call.index ?? position;
          const item = result.toolCalls[index] ??= { id: '', type: 'function', function: { name: '', arguments: '' } };
          if (call.id) item.id = call.id;
          if (call.function?.name) item.function.name += call.function.name;
          if (call.function?.arguments) item.function.arguments += call.function.arguments;
        }
      }
      await writeFile(path.join(ctx.location.directory, 'output.json'), JSON.stringify(result), { mode: 0o600 });
    });
  },
};
