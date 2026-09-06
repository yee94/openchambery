import { Agent } from '@earendil-works/pi-agent-core';
import { splitContactBubbles } from './bubbles.js';
import {
  confirmBubbleAfterContactReset,
  contactTurnHasSuccessfulReset,
  contactTurnHasToolResult,
  detectRequestedContactTools,
  extractContactCardsFromMessages,
  formatContactToolsPrompt,
  formatRegisteredProjectsPrompt,
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
  'Never write chain-of-thought, plans, tool names, or English narration of what you will do. The user never sees thinking.',
  'Do not expose tool traces, Activity, or editor actions.',
  'Do not run bash, edit, read, or write.',
  'Understand natural language in any language, including Chinese: 开新对话 means new_conversation, 找项目 means list_projects, 现有对话 means list_sessions, 建助理 means create_assistant, 建会话 / 开个新会话 means assign_session, 排定时任务 means schedule_task, 给 X 说一声 means message_assistant, 发卡片 means emit a card via those tools — never ask the user to type /card or /dm.',
  'You receive the registered project catalog every turn. You CAN see those projects. Look them up yourself (fuzzy match label/name/path). Never say you cannot see the registered project list. Never ask for a raw filesystem path when a name matches. If the catalog is empty, tell the user to add a project in Settings.',
  'To open coding work: match the project, optionally list_sessions for existing chats, then assign_session with projectPath or sessionID.',
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
 * streamFn for pi-agent-core. Calls OpenChamber completions (public HTTP stays
 * non-streaming). In-process callers may pass onTextDelta/globalEventHub for
 * the throwaway generate path. Raw tokens are never painted as contact bubbles
 * (they are often chain-of-thought). User-facing bubbles emit only after parse:
 * no-tool replies as stripped bubbles; tool calls stay silent until the tool
 * confirm. Must not throw — encode failures on the event stream.
 */
const completionFileParts = (value) => (Array.isArray(value) ? value : [])
  .filter((part) => part?.type === 'file' && typeof part.mime === 'string' && typeof part.url === 'string')
  .map((part) => ({
    type: 'file',
    mime: part.mime,
    url: part.url,
    ...(typeof part.filename === 'string' && part.filename.trim() ? { filename: part.filename.trim() } : {}),
  }));

/** Fence start (openchamber-tool or generic ```) — stop live bubble deltas. */
const CONTACT_FENCE_START = /```/;

/**
 * Incremental bubble stream from live token deltas.
 * - done:false = token increment for the active bubble
 * - done:true = that bubble is complete (split off or finalized)
 * Stops when a markdown fence starts so tool JSON never leaks.
 */
export function createContactBubbleDeltaTracker(onBubbleDelta) {
  const emit = typeof onBubbleDelta === 'function' ? onBubbleDelta : null;
  let accumulated = '';
  let completedCount = 0;
  let activeEmitted = '';
  let stopped = false;
  let emittedAny = false;

  const push = (index, delta, done) => {
    if (!emit || (typeof delta === 'string' && delta.length === 0 && !done)) return;
    emittedAny = true;
    emit(index, delta, done);
  };

  const applyVisible = (visible) => {
    const bubbles = splitContactBubbles(visible);
    if (bubbles.length === 0) return;
    while (completedCount < bubbles.length - 1) {
      const bubble = bubbles[completedCount];
      const rest = bubble.slice(activeEmitted.length);
      push(completedCount, rest, true);
      completedCount += 1;
      activeEmitted = '';
    }
    const active = bubbles[bubbles.length - 1] || '';
    if (active.length > activeEmitted.length) {
      push(completedCount, active.slice(activeEmitted.length), false);
    }
    activeEmitted = active;
  };

  return {
    get emittedAny() {
      return emittedAny;
    },
    get stopped() {
      return stopped;
    },
    pushDelta(delta) {
      if (stopped || typeof delta !== 'string' || !delta) return;
      const next = accumulated + delta;
      const fenceAt = next.search(CONTACT_FENCE_START);
      if (fenceAt >= 0) {
        const visibleChunk = next.slice(accumulated.length, fenceAt);
        accumulated = next.slice(0, fenceAt);
        if (visibleChunk) applyVisible(accumulated);
        stopped = true;
        return;
      }
      accumulated = next;
      applyVisible(accumulated);
    },
    /** Finalize after full stripped chat text is known. */
    finish(finalBubbles) {
      const bubbles = Array.isArray(finalBubbles)
        ? finalBubbles.filter((item) => typeof item === 'string' && item.trim())
        : [];
      if (!emittedAny) {
        bubbles.forEach((bubble, index) => push(index, bubble, true));
        return;
      }
      // Complete the active partial bubble, then any trailing bubbles not yet opened.
      if (completedCount < bubbles.length) {
        const current = bubbles[completedCount] || '';
        const rest = current.slice(activeEmitted.length);
        if (rest || activeEmitted || current) push(completedCount, rest, true);
        completedCount += 1;
        activeEmitted = '';
      }
      while (completedCount < bubbles.length) {
        push(completedCount, bubbles[completedCount], true);
        completedCount += 1;
      }
    },
  };
}

export function createContactStreamFn(createChatCompletion, {
  pendingFileParts = [],
  onTextDelta = null,
  onBubbleDelta = null,
  globalEventHub = null,
} = {}) {
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
        const bubbleTracker = createContactBubbleDeltaTracker(onBubbleDelta);
        const result = await createChatCompletion({
          body: {
            model: `${model.provider === 'openchamber' ? '' : `${model.provider}/`}${model.id}`.replace(/^\//, '') || model.name,
            providerID: typeof model.name === 'string' && model.name.includes('/')
              ? model.name.split('/')[0]
              : undefined,
            modelID: model.id,
            messages,
          },
          onTextDelta: (delta) => {
            if (typeof delta !== 'string' || !delta) return;
            // Do not live-paint raw tokens: they are often chain-of-thought
            // and would appear then vanish after parse/persist.
            if (typeof onTextDelta === 'function') onTextDelta(delta);
          },
          globalEventHub,
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
          // Pre-tool chatText is planning. Never show it; wait for the tool confirm.
          const partial = {
            ...assistantMessage(model, '', 'toolUse'),
            content: [toolCall],
          };
          stream.push({ type: 'start', partial });
          stream.push({ type: 'toolcall_start', contentIndex: 0, partial });
          stream.push({ type: 'toolcall_delta', contentIndex: 0, delta: JSON.stringify(toolCall.arguments), partial });
          stream.push({ type: 'toolcall_end', contentIndex: 0, toolCall, partial });
          stream.push({ type: 'done', reason: 'toolUse', message: partial });
          stream.end(partial);
          return;
        }
        const chatText = stripContactToolFences(text);
        bubbleTracker.finish(splitContactBubbles(chatText));
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
    const parts = Array.isArray(message.content) ? message.content : [];
    if (parts.some((part) => part?.type === 'toolCall')) continue;
    const text = parts
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
  const text = hasTool
    ? (extractToolResultText(slice) || extractAssistantText(slice))
    : extractAssistantText(slice);
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
  projects = [],
  onTextDelta = null,
  onBubbleDelta = null,
  globalEventHub = null,
  AgentImpl = Agent,
}) {
  const providerID = assistant.providerID;
  const modelID = assistant.modelID;
  const contactTools = Array.isArray(tools)
    ? tools.filter((tool) => tool && typeof tool.name === 'string' && !['bash', 'edit', 'read', 'write'].includes(tool.name))
    : [];
  const systemPrompt = [
    CONTACT_SYSTEM_PROMPT,
    formatRegisteredProjectsPrompt(projects),
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
    streamFn: createContactStreamFn(createChatCompletion, {
      pendingFileParts,
      onTextDelta,
      onBubbleDelta,
      globalEventHub,
    }),
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
