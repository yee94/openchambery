import { Agent } from '@earendil-works/pi-agent-core';
import { splitContactBubbles } from './bubbles.js';
import {
  confirmBubbleAfterContactReset,
  contactTurnHasSuccessfulReset,
  contactTurnHasToolResult,
  detectRequestedContactTools,
  extractContactCardsFromMessages,
  formatContactToolsPrompt,
  MISSED_FENCE_RETRY_USER_TEXT,
  MISSED_TOOL_FAILURE_BUBBLE,
  NEW_CONVERSATION_CONFIRM_BUBBLE,
  parseContactToolCalls,
  stripContactToolFences,
} from './contact-tools.js';

function createAssistantMessageEventStream() {
  const events = [];
  let pending = null;
  let done = false;
  let resolveFinal = null;
  const finalResult = new Promise((resolve) => { resolveFinal = resolve; });
  const wake = () => {
    pending?.();
    pending = null;
  };
  const finish = (message) => {
    if (resolveFinal) {
      resolveFinal(message);
      resolveFinal = null;
    }
    done = true;
    wake();
  };
  return {
    push(event) {
      events.push(event);
      if (event?.type === 'done') finish(event.message);
      else if (event?.type === 'error') finish(event.error);
      else wake();
    },
    end(message) {
      // Completion is already a typed event (`done` / `error`). Do not push
      // the raw assistant message again — callers read events.at(-1).type.
      finish(message);
    },
    result() {
      return finalResult;
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
  'Do not expose chain-of-thought, tool traces, Activity, or editor actions.',
  'Do not run bash, edit, read, or write.',
  'Understand natural language in any language, including Chinese: 开新对话 means new_conversation, 建助理 means create_assistant, 建会话 means assign_session, 排定时任务 means schedule_task, 给 X 说一声 means message_assistant, 发卡片 means emit a card via those tools — never ask the user to type /card or /dm.',
  'A reply without the tool call does nothing. Never say 已创建, created, scheduled, or opened unless the tool already returned success.',
  'Assign coding work with assign_session so a real Chat session does the work.',
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
    input: ['text', 'image'],
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
const completionFileParts = (value) => (Array.isArray(value) ? value : [])
  .filter((part) => part?.type === 'file' && typeof part.mime === 'string' && typeof part.url === 'string')
  .map((part) => ({
    type: 'file',
    mime: part.mime,
    url: part.url,
    ...(typeof part.filename === 'string' && part.filename.trim() ? { filename: part.filename.trim() } : {}),
  }));

export function createContactStreamFn(createChatCompletion, { pendingFileParts = [] } = {}) {
  return (model, context) => {
    const stream = createAssistantMessageEventStream();
    const run = async () => {
      try {
        const fallbackFiles = completionFileParts(pendingFileParts);
        const mapped = context.messages.flatMap((message) => {
            if (message.role === 'user') {
              const content = typeof message.content === 'string'
                ? message.content
                : (message.content || []).map((part) => part?.text || '').join('');
              const parts = completionFileParts(message.parts);
              if (!content && parts.length === 0) return [];
              return [{
                role: 'user',
                content: content || '[attachment]',
                ...(parts.length > 0 ? { parts } : {}),
              }];
            }
            if (message.role === 'assistant') {
              const content = (message.content || [])
                .filter((part) => part?.type === 'text')
                .map((part) => part.text)
                .join('');
              return content ? [{ role: 'assistant', content }] : [];
            }
            if (message.role === 'toolResult') {
              const content = (message.content || [])
                .filter((part) => part?.type === 'text')
                .map((part) => part.text)
                .join('');
              return content ? [{ role: 'user', content: `OpenChamber tool ${message.toolName || 'result'}: ${content}` }] : [];
            }
            return [];
        });
        const messages = [
          ...(context.systemPrompt ? [{ role: 'system', content: context.systemPrompt }] : []),
          ...mapped,
        ];
        const lastUser = [...messages].reverse().find((message) => message.role === 'user');
        if (lastUser && fallbackFiles.length > 0 && !Array.isArray(lastUser.parts)) {
          lastUser.parts = fallbackFiles;
        }
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
        const allowedNames = (context.tools || []).map((tool) => tool?.name).filter(Boolean);
        const parsed = parseContactToolCalls(text, allowedNames);
        if (parsed.toolCall) {
          const toolCall = {
            type: 'toolCall',
            id: `call_${Date.now().toString(36)}`,
            name: parsed.toolCall.name,
            arguments: parsed.toolCall.arguments,
          };
          const content = [];
          if (parsed.chatText) content.push({ type: 'text', text: parsed.chatText });
          content.push(toolCall);
          const partial = {
            ...assistantMessage(model, parsed.chatText, 'toolUse'),
            content,
          };
          stream.push({ type: 'start', partial });
          if (parsed.chatText) {
            stream.push({ type: 'text_start', contentIndex: 0, partial });
            stream.push({ type: 'text_delta', contentIndex: 0, delta: parsed.chatText, partial });
            stream.push({ type: 'text_end', contentIndex: 0, content: parsed.chatText, partial });
          }
          const toolIndex = parsed.chatText ? 1 : 0;
          stream.push({ type: 'toolcall_start', contentIndex: toolIndex, partial });
          stream.push({ type: 'toolcall_delta', contentIndex: toolIndex, delta: JSON.stringify(toolCall.arguments), partial });
          stream.push({ type: 'toolcall_end', contentIndex: toolIndex, toolCall, partial });
          stream.push({ type: 'done', reason: 'toolUse', message: partial });
          stream.end(partial);
          return;
        }
        const chatText = stripContactToolFences(text);
        const partial = assistantMessage(model, chatText, 'stop');
        stream.push({ type: 'start', partial });
        stream.push({ type: 'text_start', contentIndex: 0, partial });
        stream.push({ type: 'text_delta', contentIndex: 0, delta: chatText, partial });
        stream.push({ type: 'text_end', contentIndex: 0, content: chatText, partial });
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

const userMessageText = (message) => {
  if (typeof message?.content === 'string') return message.content;
  return (message?.content || []).map((part) => (typeof part?.text === 'string' ? part.text : '')).join('');
};

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

const extractToolResultText = (messages) => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'toolResult') continue;
    const text = (message.content || [])
      .filter((part) => part?.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('')
      .trim();
    if (text) return text;
  }
  return '';
};

const extractContactTurnOutcome = (messages, retried) => {
  const list = Array.isArray(messages) ? messages : [];
  let start = 0;
  if (retried) {
    for (let index = list.length - 1; index >= 0; index -= 1) {
      if (list[index]?.role === 'user') {
        start = index;
        break;
      }
    }
    if (start === 0) {
      const toolIndex = list.findIndex((message) => message?.role === 'toolResult');
      if (toolIndex >= 0) start = toolIndex;
    }
  }
  const slice = list.slice(start);
  const cards = extractContactCardsFromMessages(slice);
  const hasTool = contactTurnHasToolResult(slice);
  const text = extractAssistantText(slice) || (hasTool ? extractToolResultText(slice) : '');
  return { text, cards, hasTool };
};

/**
 * Thin OpenChamber contact harness: pi-agent-core Agent + OpenChamber API
 * tools only + thinkingLevel off. Transcript in, completions via streamFn,
 * bubbles and session cards out. Never bash/edit/read/write.
 *
 * Assigned-session settle reuses the assistants event hub plus session-goal
 * `emitGoalNotification` — read-only into the contact transcript.
 */
export async function runContactTurn({
  assistant,
  history,
  userText,
  userParts = [],
  createChatCompletion,
  tools = [],
  AgentImpl = Agent,
}) {
  const providerID = assistant.providerID;
  const modelID = assistant.modelID;
  const contactTools = Array.isArray(tools)
    ? tools.filter((tool) => tool && typeof tool.name === 'string' && !['bash', 'edit', 'read', 'write'].includes(tool.name))
    : [];
  const systemPrompt = [
    CONTACT_SYSTEM_PROMPT,
    formatContactToolsPrompt(contactTools),
    assistant.defaultPrompt,
  ].filter((value) => typeof value === 'string' && value.trim()).join('\n\n');
  const model = createContactModel(providerID, modelID);
  // streamFn receives the model; completions needs providerID/modelID.
  model.name = `${providerID}/${modelID}`;

  const pendingFileParts = [
    ...(Array.isArray(history) ? history.flatMap((message) => completionFileParts(message.parts)) : []),
    ...completionFileParts(userParts),
  ];
  const prior = Array.isArray(history)
    ? history.map((message) => (
      message.role === 'assistant'
        ? { role: 'assistant', content: [{ type: 'text', text: message.content }], api: model.api, provider: model.provider, model: model.id, usage: emptyUsage(), stopReason: 'stop', timestamp: Date.now() }
        : {
          role: 'user',
          content: message.content,
          ...(completionFileParts(message.parts).length > 0 ? { parts: completionFileParts(message.parts) } : {}),
          timestamp: Date.now(),
        }
    ))
    : [];

  const agent = new AgentImpl({
    initialState: {
      systemPrompt,
      model,
      thinkingLevel: 'off',
      tools: contactTools,
      messages: prior,
    },
    streamFn: createContactStreamFn(createChatCompletion, { pendingFileParts }),
  });

  await agent.prompt(userText);
  if (agent.state.errorMessage) {
    const error = new Error(agent.state.errorMessage);
    error.code = 'upstream_error';
    throw error;
  }
  const requested = detectRequestedContactTools(userText, contactTools.map((tool) => tool.name));
  let retried = false;
  if (requested.length > 0 && !contactTurnHasToolResult(agent.state.messages)) {
    retried = true;
    await agent.prompt(MISSED_FENCE_RETRY_USER_TEXT);
    if (agent.state.errorMessage) {
      const error = new Error(agent.state.errorMessage);
      error.code = 'upstream_error';
      throw error;
    }
  }
  if (requested.length > 0 && !contactTurnHasToolResult(agent.state.messages)) {
    return {
      text: MISSED_TOOL_FAILURE_BUBBLE,
      bubbles: [MISSED_TOOL_FAILURE_BUBBLE],
      cards: [],
      thinkingLevel: agent.state.thinkingLevel,
      tools: [...agent.state.tools],
    };
  }
  const outcome = extractContactTurnOutcome(agent.state.messages, retried);
  const text = stripContactToolFences(outcome.text);
  if (contactTurnHasSuccessfulReset(agent.state.messages)) {
    const bubbles = confirmBubbleAfterContactReset(splitContactBubbles(text));
    return {
      text: bubbles[0] || NEW_CONVERSATION_CONFIRM_BUBBLE,
      bubbles,
      cards: [],
      reset: true,
      thinkingLevel: agent.state.thinkingLevel,
      tools: [...agent.state.tools],
    };
  }
  if (!text.trim() && outcome.cards.length === 0) {
    const error = new Error('Assistant returned no text');
    error.code = 'upstream_error';
    throw error;
  }
  return {
    text,
    bubbles: splitContactBubbles(text),
    cards: outcome.cards,
    thinkingLevel: agent.state.thinkingLevel,
    tools: [...agent.state.tools],
  };
}
