import { Agent } from '@earendil-works/pi-agent-core';
import { isContactSpokenPreamble, splitContactBubbles } from './bubbles.js';
import {
  ASSIGN_SESSION_TOOL_NAME,
  CLEAR_CHAT_HISTORY_CONFIRM_BUBBLE,
  CLEAR_CHAT_HISTORY_TOOL_NAME,
  confirmBubbleAfterContactReset,
  contactTurnClearedChatHistory,
  contactTurnHasSuccessfulReset,
  contactTurnHasToolResult,
  CREATE_ASSISTANT_TOOL_NAME,
  detectRequestedContactTools,
  extractContactCardsFromMessages,
  formatContactToolsPrompt,
  formatConnectedModelsPrompt,
  formatRegisteredProjectsPrompt,
  GET_ASSISTANT_SETTINGS_TOOL_NAME,
  MESSAGE_ASSISTANT_TOOL_NAME,
  MISSED_FENCE_RETRY_USER_TEXT,
  MISSED_TOOL_FAILURE_BUBBLE,
  NEW_CONVERSATION_CONFIRM_BUBBLE,
  NEW_CONVERSATION_TOOL_NAME,
  parseContactToolCalls,
  SCHEDULE_TASK_TOOL_NAME,
  stripContactToolFences,
  UPDATE_DEFAULT_PROMPT_TOOL_NAME,
} from './contact-tools.js';
import {
  createPiCodingRuntime,
  formatPiCodingPrompt,
  isPiCodingToolName,
  resolveAssistantCwd,
} from './pi-tools.js';

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
  "You are OpenChamber's in-app assistant — a personable contact who can also work in the user's configured project directory.",
  'Reply in short chat bubbles: a few sentences each, separated by a blank line.',
  'Talk like a person in the user\'s language. One short spoken bubble at a time — never a wall of paragraphs.',
  'Never write chain-of-thought, plans, tool names, or English narration of what you will do. The user never sees thinking.',
  'Do not expose tool traces, Activity, or editor actions.',
  'You have bash, read, write, and edit in the working directory. Use them for pwd, files, and shell. Never say you have no terminal or cannot read files. Ignore any temporary generator workspace in the environment.',
  'Understand natural language in any language, including Chinese: 开新对话 / 清除记忆 means new_conversation (LLM memory only, chat history stays), 清空聊天记录 means clear_chat_history (delete transcript), 找项目 means list_projects, 现有对话 means list_sessions, 查看助手设定 / 默认提示词 means get_assistant_settings (pass to="Name" for another assistant), 改默认提示词 / 设置人设 / 改某助手的默认提示词 means update_default_prompt (persists that assistant\'s settings, later turns only; pass to="OpenCode 配置助手" to edit another contact without changing this one), 建助理 means create_assistant, 建会话 / 开个新会话 means assign_session, 排定时任务 means schedule_task, 给 X 说一声 means message_assistant, 发卡片 means emit a card via those tools — never ask the user to type /card or /dm.',
  'You receive the registered project catalog every turn. You CAN see those projects. Look them up yourself (fuzzy match label/name/path). Never say you cannot see the registered project list. Never ask for a raw filesystem path when a name matches. If the catalog is empty, tell the user to add a project in Settings.',
  'File and shell work in this working directory uses read, write, edit, and bash. To open a separate Chat coding session: match the project, optionally list_sessions for existing chats, then assign_session with projectPath or sessionID. Optional worker model via providerID/modelID/model from the connected catalog — that does not change this contact. Current-turn user attachments are server-forwarded on assign. One successful assign_session ends the turn — do not call it again.',
  'A reply without the tool call does nothing. Never say 已创建, created, scheduled, or opened unless the tool already returned success.',
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
  bubbleGapMs = 0,
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
              if (!content) return [];
              const toolName = typeof message.toolName === 'string' && message.toolName.trim()
                ? message.toolName.trim()
                : 'result';
              const callId = typeof message.toolCallId === 'string' && message.toolCallId.trim()
                ? message.toolCallId.trim()
                : (typeof message.id === 'string' && message.id.trim() ? message.id.trim() : '');
              const label = callId
                ? `OpenChamber tool result name=${toolName} call=${callId}`
                : `OpenChamber tool result name=${toolName}`;
              return [{ role: 'user', content: `${label}: ${content}` }];
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
          const spoken = isContactSpokenPreamble(parsed.chatText) ? parsed.chatText.trim() : '';
          const content = spoken
            ? [{ type: 'text', text: spoken }, toolCall]
            : [toolCall];
          const partial = {
            ...assistantMessage(model, spoken, 'toolUse'),
            content,
          };
          if (spoken) bubbleTracker.finish([spoken]);
          stream.push({ type: 'start', partial });
          if (spoken) {
            stream.push({ type: 'text_start', contentIndex: 0, partial });
            stream.push({ type: 'text_delta', contentIndex: 0, delta: spoken, partial });
            stream.push({ type: 'text_end', contentIndex: 0, content: spoken, partial });
          }
          const toolIndex = spoken ? 1 : 0;
          stream.push({ type: 'toolcall_start', contentIndex: toolIndex, partial });
          stream.push({ type: 'toolcall_delta', contentIndex: toolIndex, delta: JSON.stringify(toolCall.arguments), partial });
          stream.push({ type: 'toolcall_end', contentIndex: toolIndex, toolCall, partial });
          stream.push({ type: 'done', reason: 'toolUse', message: partial });
          stream.end(partial);
          return;
        }
        const chatText = stripContactToolFences(text);
        const replyBubbles = splitContactBubbles(chatText);
        if (bubbleGapMs > 0 && replyBubbles.length > 1) {
          for (let index = 0; index < replyBubbles.length; index += 1) {
            onBubbleDelta?.(index, replyBubbles[index], true);
            if (index < replyBubbles.length - 1) {
              await new Promise((resolve) => setTimeout(resolve, bubbleGapMs));
            }
          }
        } else {
          bubbleTracker.finish(replyBubbles);
        }
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

const assistantTextParts = (message) => (Array.isArray(message?.content) ? message.content : [])
  .filter((part) => part?.type === 'text' && typeof part.text === 'string')
  .map((part) => part.text)
  .join('');

const extractSpokenPreamble = (messages) => {
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message?.role !== 'assistant') continue;
    const parts = Array.isArray(message.content) ? message.content : [];
    if (!parts.some((part) => part?.type === 'toolCall')) continue;
    const text = assistantTextParts(message).trim();
    if (isContactSpokenPreamble(text)) return text;
  }
  return '';
};

const extractAssistantText = (messages) => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'assistant') continue;
    const parts = Array.isArray(message.content) ? message.content : [];
    if (parts.some((part) => part?.type === 'toolCall')) continue;
    const text = assistantTextParts(message);
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

/** Tool confirms that are themselves the user-facing bubble (no card). */
const TOOL_TEXT_BUBBLE_TOOLS = new Set([
  NEW_CONVERSATION_TOOL_NAME,
  CLEAR_CHAT_HISTORY_TOOL_NAME,
  UPDATE_DEFAULT_PROMPT_TOOL_NAME,
  GET_ASSISTANT_SETTINGS_TOOL_NAME,
]);

/** Card / side-effect tools: never paint English toolText into the transcript. */
const CARD_SIDE_EFFECT_TOOLS = new Set([
  ASSIGN_SESSION_TOOL_NAME,
  CREATE_ASSISTANT_TOOL_NAME,
  SCHEDULE_TASK_TOOL_NAME,
  MESSAGE_ASSISTANT_TOOL_NAME,
]);

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
  const spoken = extractSpokenPreamble(slice);
  const lastToolName = [...slice].reverse().find((message) => message?.role === 'toolResult')?.toolName;
  const coding = isPiCodingToolName(lastToolName);
  const toolText = extractToolResultText(slice);
  const assistant = extractAssistantText(slice);
  let confirm = '';
  if (hasTool && !coding) {
    if (TOOL_TEXT_BUBBLE_TOOLS.has(lastToolName)) {
      // Confirm-only tools: toolText is the user bubble.
      confirm = toolText || assistant;
    } else if (CARD_SIDE_EFFECT_TOOLS.has(lastToolName)) {
      // Spoken preamble only. Card is enough when present; never English toolText.
      // Post-tool assistant text (terminate:false tools) may still surface when no spoken.
      confirm = spoken ? '' : (assistant || '');
    } else {
      // list_projects / list_sessions and other app tools keep toolText.
      confirm = toolText || assistant;
    }
  } else {
    confirm = assistant || (coding ? toolText : '');
  }
  const parts = [];
  if (spoken) parts.push(spoken);
  if (confirm && confirm !== spoken) parts.push(confirm);
  return { text: parts.join('\n\n'), cards, hasTool };
};

/**
 * Thin OpenChamber contact harness: pi-agent-core Agent + thinkingLevel off.
 * Attaches pi read/write/edit/bash in the assistant workspace plus OpenChamber
 * API tools. Transcript in, completions via streamFn, bubbles and session
 * cards out.
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
  connectedModels = [],
  modelPreferences = null,
  modelCatalogAvailable = true,
  onTextDelta = null,
  onBubbleDelta = null,
  globalEventHub = null,
  skillHomeDir,
  AgentImpl = Agent,
}) {
  const providerID = assistant.providerID;
  const modelID = assistant.modelID;
  const cwd = resolveAssistantCwd(assistant);
  const contactTools = Array.isArray(tools)
    ? tools.filter((tool) => tool && typeof tool.name === 'string' && !isPiCodingToolName(tool.name))
    : [];
  let runtime = null;
  try {
    if (cwd) runtime = await createPiCodingRuntime(cwd, { homeDir: skillHomeDir });
    const codingTools = Array.isArray(runtime?.tools) ? runtime.tools : [];
    const systemPrompt = [
      CONTACT_SYSTEM_PROMPT,
      formatPiCodingPrompt({
        cwd: runtime?.cwd,
        skillsPrompt: runtime?.skillsPrompt,
        tools: codingTools,
      }),
      formatRegisteredProjectsPrompt(projects),
      formatConnectedModelsPrompt(connectedModels, { preferences: modelPreferences, catalogAvailable: modelCatalogAvailable }),
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
        tools: [...codingTools, ...contactTools],
        messages: prior,
      },
      streamFn: createContactStreamFn(createChatCompletion, {
        pendingFileParts,
        onTextDelta,
        onBubbleDelta,
        globalEventHub,
        bubbleGapMs: 280,
      }),
    });

    await agent.prompt(userText);
    if (agent.state.errorMessage) {
      const error = new Error(agent.state.errorMessage);
      error.code = 'upstream_error';
      throw error;
    }
    const requested = detectRequestedContactTools(userText, contactTools.map((tool) => tool.name));
    const hasRequestedResult = () => agent.state.messages.some((message) => (
      message?.role === 'toolResult' && requested.includes(message.toolName)
    ));
    let retried = false;
    if (requested.length > 0 && !hasRequestedResult() && !contactTurnHasSuccessfulReset(agent.state.messages)) {
      retried = true;
      await agent.prompt(MISSED_FENCE_RETRY_USER_TEXT);
      if (agent.state.errorMessage) {
        const error = new Error(agent.state.errorMessage);
        error.code = 'upstream_error';
        throw error;
      }
    }
    if (requested.length > 0 && !hasRequestedResult() && !contactTurnHasSuccessfulReset(agent.state.messages)) {
      // Prefer any spoken/assistant text already in the turn over the English failure fallback.
      const missed = extractContactTurnOutcome(agent.state.messages, retried);
      const missedText = stripContactToolFences(missed.text).trim();
      if (missedText) {
        const missedBubbles = splitContactBubbles(missedText);
        return {
          text: missedText,
          bubbles: missedBubbles.length > 0 ? missedBubbles : [missedText],
          cards: [],
          thinkingLevel: agent.state.thinkingLevel,
          tools: [...agent.state.tools],
        };
      }
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
      const historyCleared = contactTurnClearedChatHistory(agent.state.messages);
      const preferredConfirm = historyCleared
        ? CLEAR_CHAT_HISTORY_CONFIRM_BUBBLE
        : NEW_CONVERSATION_CONFIRM_BUBBLE;
      const bubbles = confirmBubbleAfterContactReset(splitContactBubbles(text), preferredConfirm);
      return {
        text: bubbles[0] || preferredConfirm,
        bubbles,
        cards: [],
        reset: true,
        historyCleared,
        thinkingLevel: agent.state.thinkingLevel,
        tools: [...agent.state.tools],
      };
    }
    // Card tools / side-effect tools may finish with cards only (no English toolText bubble).
    if (!text.trim() && outcome.cards.length === 0 && !outcome.hasTool) {
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
  } finally {
    try {
      await runtime?.close?.();
    } catch {
      // Workspace shell cleanup must not mask the turn result.
    }
  }
}
