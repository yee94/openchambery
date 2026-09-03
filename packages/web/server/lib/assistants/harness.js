import { Agent } from '@earendil-works/pi-agent-core';
import { splitContactBubbles } from './bubbles.js';

function createAssistantMessageEventStream() {
  const events = [];
  let pending = null;
  let done = false;
  const wake = () => {
    pending?.();
    pending = null;
  };
  return {
    push(event) {
      events.push(event);
      wake();
    },
    end() {
      // Completion is already a typed event (`done` / `error`). Do not push
      // the raw assistant message again — callers read events.at(-1).type.
      done = true;
      wake();
    },
    async *[Symbol.asyncIterator]() {
      let index = 0;
      while (true) {
        while (index < events.length) {
          yield events[index];
          index += 1;
        }
        if (done) return;
        await new Promise((resolve) => { pending = resolve; });
      }
    },
  };
}

export const CONTACT_SYSTEM_PROMPT = [
  "You are OpenChamber's in-app assistant — a personable contact, not a coding agent.",
  'Reply in short chat bubbles: a few sentences each, separated by a blank line.',
  'Do not expose chain-of-thought, tool traces, or editor actions.',
  'Do not pretend to run bash, edit files, or open a workspace unless a later OpenChamber card tool is attached.',
].join(' ');

const emptyUsage = () => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

export function createContactModel(providerID, modelID) {
  return {
    id: modelID,
    name: `${providerID}/${modelID}`,
    api: 'openai-completions',
    provider: 'openchamber',
    baseUrl: 'http://openchamber.invalid/api/openchamber/llm',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
  };
}

const assistantMessage = (model, text, stopReason, errorMessage) => ({
  role: 'assistant',
  content: text ? [{ type: 'text', text }] : [],
  api: model.api,
  provider: model.provider,
  model: model.id,
  usage: emptyUsage(),
  stopReason,
  timestamp: Date.now(),
  ...(errorMessage ? { errorMessage } : {}),
});

/**
 * streamFn for pi-agent-core. Calls OpenChamber's non-streaming completions
 * function (POST /api/openchamber/llm/chat/completions, stream omitted).
 * Replays the completed text as one Agent event burst — not token SSE.
 * Must not throw — encode failures on the event stream.
 */
export function createContactStreamFn(createChatCompletion) {
  return (model, context) => {
    const stream = createAssistantMessageEventStream();
    const run = async () => {
      try {
        const messages = [
          ...(context.systemPrompt ? [{ role: 'system', content: context.systemPrompt }] : []),
          ...context.messages.flatMap((message) => {
            if (message.role === 'user') {
              const content = typeof message.content === 'string'
                ? message.content
                : (message.content || []).map((part) => part?.text || '').join('');
              return content ? [{ role: 'user', content }] : [];
            }
            if (message.role === 'assistant') {
              const content = (message.content || [])
                .filter((part) => part?.type === 'text')
                .map((part) => part.text)
                .join('');
              return content ? [{ role: 'assistant', content }] : [];
            }
            return [];
          }),
        ];
        const result = await createChatCompletion({
          body: {
            model: `${model.provider === 'openchamber' ? '' : `${model.provider}/`}${model.id}`.replace(/^\//, '') || model.name,
            providerID: typeof model.name === 'string' && model.name.includes('/')
              ? model.name.split('/')[0]
              : undefined,
            modelID: model.id,
            messages,
          },
        });
        const text = result?.completion?.choices?.[0]?.message?.content
          ?? result?.text
          ?? '';
        const partial = assistantMessage(model, text, 'stop');
        stream.push({ type: 'start', partial });
        stream.push({ type: 'text_start', contentIndex: 0, partial });
        stream.push({ type: 'text_delta', contentIndex: 0, delta: text, partial });
        stream.push({ type: 'text_end', contentIndex: 0, content: text, partial });
        stream.push({ type: 'done', reason: 'stop', message: partial });
        stream.end(partial);
      } catch (error) {
        const failed = assistantMessage(model, '', 'error', error?.message || 'upstream_error');
        stream.push({ type: 'error', reason: 'error', error: failed });
        stream.end(failed);
      }
    };
    void run();
    return stream;
  };
}

const extractAssistantText = (messages) => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'assistant') continue;
    const text = (message.content || [])
      .filter((part) => part?.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('');
    if (text.trim()) return text;
    if (message.errorMessage) {
      const error = new Error(message.errorMessage);
      error.code = 'upstream_error';
      throw error;
    }
  }
  return '';
};

/**
 * Thin OpenChamber contact harness: pi-agent-core Agent + empty tools +
 * thinkingLevel off. Transcript in, completions via streamFn, bubbles out.
 *
 * TODO(next-slice): attach OpenChamber API tools (open project session / watch /
 * summon) as AgentTool. Those tools MUST persist contact cards — never bash/edit/read/write.
 */
export async function runContactTurn({
  assistant,
  history,
  userText,
  createChatCompletion,
  AgentImpl = Agent,
}) {
  const providerID = assistant.providerID;
  const modelID = assistant.modelID;
  const systemPrompt = [CONTACT_SYSTEM_PROMPT, assistant.defaultPrompt].filter((value) => typeof value === 'string' && value.trim()).join('\n\n');
  const model = createContactModel(providerID, modelID);
  // streamFn receives the model; completions needs providerID/modelID.
  model.name = `${providerID}/${modelID}`;

  const prior = Array.isArray(history)
    ? history.map((message) => (
      message.role === 'assistant'
        ? { role: 'assistant', content: [{ type: 'text', text: message.content }], api: model.api, provider: model.provider, model: model.id, usage: emptyUsage(), stopReason: 'stop', timestamp: Date.now() }
        : { role: 'user', content: message.content, timestamp: Date.now() }
    ))
    : [];

  const agent = new AgentImpl({
    initialState: {
      systemPrompt,
      model,
      thinkingLevel: 'off',
      tools: [],
      messages: prior,
    },
    streamFn: createContactStreamFn(createChatCompletion),
  });

  await agent.prompt(userText);
  if (agent.state.errorMessage) {
    const error = new Error(agent.state.errorMessage);
    error.code = 'upstream_error';
    throw error;
  }
  const text = extractAssistantText(agent.state.messages);
  if (!text.trim()) {
    const error = new Error('Assistant returned no text');
    error.code = 'upstream_error';
    throw error;
  }
  return {
    text,
    bubbles: splitContactBubbles(text),
    thinkingLevel: agent.state.thinkingLevel,
    tools: [...agent.state.tools],
  };
}
