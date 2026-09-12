import { Agent } from '@earendil-works/pi-agent-core';
import { isContactSpokenPreamble, splitContactBubbles } from './bubbles.js';
import {
  contactTurnClearedChatHistory,
  contactTurnHasSuccessfulReset,
  contactTurnHasToolResult,
  detectRequestedContactTools,
  extractContactCardsFromMessages,
  formatContactToolsPrompt,
  formatConnectedModelsPrompt,
  formatRegisteredProjectsPrompt,
  MISSED_FENCE_RETRY_USER_TEXT,
  parseContactToolCalls,
  stripContactToolFences,
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

const CONTACT_LANGUAGE_NAMES = {
  en: 'English',
  fr: 'French',
  'zh-CN': 'Simplified Chinese',
  'zh-TW': 'Traditional Chinese',
  uk: 'Ukrainian',
  es: 'Spanish',
  'pt-BR': 'Brazilian Portuguese',
  ko: 'Korean',
  pl: 'Polish',
  ja: 'Japanese',
};

const CONTACT_LANGUAGE_FALLBACK = "the user's interface language";

/**
 * Map a UI locale code to a display name for the system prompt. Unknown or
 * missing values fall back to a neutral phrase so `{{LANGUAGE}}` never leaks.
 * Whitelisted only: arbitrary client text must not reach the system prompt.
 */
export const resolveContactLanguage = (value) => {
  if (typeof value !== 'string') return CONTACT_LANGUAGE_FALLBACK;
  const code = value.trim();
  if (!code) return CONTACT_LANGUAGE_FALLBACK;
  if (CONTACT_LANGUAGE_NAMES[code]) return CONTACT_LANGUAGE_NAMES[code];
  const match = Object.keys(CONTACT_LANGUAGE_NAMES).find((key) => key.toLowerCase() === code.toLowerCase());
  return match ? CONTACT_LANGUAGE_NAMES[match] : CONTACT_LANGUAGE_FALLBACK;
};

export const CONTACT_SYSTEM_PROMPT = [
  "You are OpenChamber's in-app assistant — a personable contact focused on understanding the user, communicating naturally, coordinating work, and following up on results.",
  'For substantive tasks, default to finding the relevant existing OpenCode workspace and handing the task to a worker session with assign_session. Carry the user goal, relevant context, constraints, and verification expectations into that session; follow its results and explain the outcome in normal conversation.',
  'Handle simple questions, file lookups, and small, clearly scoped configuration changes directly when their scope and verification are straightforward. As a task grows into implementation, multi-step debugging, or broad changes, hand it to a worker session. An explicit user request to handle a bounded task yourself can use the direct tools.',
  'Reply in short chat bubbles: a few sentences each, separated by a blank line.',
  'Talk like a person in the user\'s language. One short spoken bubble at a time — never a wall of paragraphs.',
  'Always reply in {{LANGUAGE}} — the user\'s current interface language — even when the user writes in another language, unless they explicitly ask for a different one.',
  'Keep private reasoning and tool traces private. Communicate your next concrete action, verified milestones, and blockers in short natural messages in {{LANGUAGE}}.',
  'Before starting work, send a short message explaining the next action. During multi-step work, send a message when a meaningful result arrives or the direction changes. Publish these messages during execution; keep the final answer to the remaining outcome instead of repeating earlier updates.',
  'Public message protocol: put each user-facing progress message at the START of your response in its own openchamber-message JSON fence, with a single-line JSON object {"text":"Your short message"}. Then emit the next tool call or final answer. A closed message fence is delivered immediately while you are still generating. Include only text intended for the user. Tool results are evidence for you to summarize in your own words; never copy their stock confirmation wording into your reply.',
  'Do not expose tool traces, Activity, or editor actions.',
  'You have bash, read, write, and edit in the working directory. Use them for pwd, files, and shell. Never say you have no terminal or cannot read files. Ignore any temporary generator workspace in the environment.',
  'Understand natural language in any language, including Chinese: 开新对话 / 清除记忆 means new_conversation (LLM memory only, chat history stays), 清空聊天记录 means clear_chat_history (delete transcript), 找项目 means list_projects, 现有对话 means list_sessions, 查看助手设定 / 默认提示词 means get_assistant_settings (pass to="Name" for another assistant), 改默认提示词 / 设置人设 / 改某助手的默认提示词 means update_default_prompt (persists that assistant\'s settings, later turns only; pass to="OpenCode 配置助手" to edit another contact without changing this one), 建助理 means create_assistant, 建会话 / 开个新会话 / 继续会话 means assign_session, 监听会话 means watch_session, 停止/取消/打断会话 means stop_session, 插话 means steer_session, 归档会话 means archive_session, 删除会话 means delete_session, 排定时任务 means schedule_task, 给 X 说一声 means message_assistant, 发卡片 means emit a card via those tools — never ask the user to type /card or /dm.',
  'You receive the registered project catalog every turn. Match the user goal against project labels and paths and existing OpenCode conversations via list_sessions. Start in the user-configured working directory; managed contacts start in the current server user home directory and can inspect user-global directories with read/bash. When the starting directory has no relevant session, walk its parent directories to find the nearest relevant existing OpenCode workspace using session directory metadata, then search that workspace for the requested project or conversation. Use an unscoped list_sessions lookup when broader context is needed. Prefer the user-configured directory and explicit session context; ask a short question when several relevant targets remain. Keep discovery bounded and use actual tool results as evidence.',
  'An empty registered catalog still permits looking up existing sessions and inspecting the working directory. Resolve the existing workspace first. Assignment requires a registered project: when the resolved workspace needs registration, explain that specific prerequisite and ask the user to register it in Settings. Workspace discovery should preserve the user existing directory structure.',
  'For substantive work, match the workspace, inspect relevant existing chats with list_sessions, then create a worker through assign_session with projectPath or continue the relevant conversation with sessionID plus the task prompt (omit model args to keep the prior worker model). File and shell tools support discovery and the small-task exception. To only listen without prompting when asked (监听/watch/monitor), watch_session with sessionID — a plain @session:id mention alone is not a watch request. To abort a running session, stop_session with sessionID. Optional worker model via providerID/modelID/model from the connected catalog — that does not change this contact. Current-turn user attachments are server-forwarded on assign. One successful assign_session or watch_session ends the turn — do not call it again.',
  'A reply without the tool call does nothing. Never say 已创建, created, scheduled, opened, watched, or stopped unless the tool already returned success.',
].join(' ');

// A workspace response must explicitly finish or ask for missing input. Plain
// progress prose is not a final answer and must not silently end the pi loop.
const WORKSPACE_RESPONSE_PROTOCOL = [
  'Workspace response protocol: continue using openchamber-tool calls until the task is handed to a worker session, or the small direct task and its verification are done. A successful assign_session ends this turn and worker completion is reported through the session follow-up.',
  'You may batch independent coding calls, but they execute sequentially in the order supplied. Wait for results before using their output. Send OpenChamber operation tools one at a time.',
  'Reading a skill loads instructions. For substantive work, pass relevant instructions and context to the worker session; for a small direct task, execute the applicable steps and verify the result before completing.',
  'To finish, reply with only an openchamber-final JSON fence: ```openchamber-final\n{"status":"complete","text":"Your final answer in the user language"}\n```.',
  'Use status "blocked" with the missing information or real blocker when you cannot proceed. Questions and ordinary conversation also use this final format; they do not require a tool call.',
  'Do not use a final declaration for a progress update or promise to act later. Never invent tool results, User messages, or future assistant turns. Only supplied tool-result records are execution evidence.',
].join('\n');

const parseFinalResponse = (text) => {
  const match = text.trim().match(/^```openchamber-final\s*([\s\S]*?)```$/u);
  if (!match) return null;
  try {
    const value = JSON.parse(match[1]);
    if (!value || !['complete', 'blocked'].includes(value.status) || typeof value.text !== 'string' || !value.text.trim()) return null;
    return { status: value.status, text: value.text.trim() };
  } catch {
    return null;
  }
};

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
 * the throwaway generate path. Complete public prefix records publish during
 * generation; ordinary raw tokens stay private. Legacy prose and final replies
 * publish after parsing. Failures are encoded on the event stream.
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

// Only explicitly public, complete prefix records may publish before completion.
// Retain at most one bounded incomplete record; ordinary text and tool JSON stay private.
function createPublicMessageReader(publish) {
  const marker = '```openchamber-message';
  let pending = '';
  let stopped = false;
  return {
    push(delta) {
      if (stopped || typeof delta !== 'string') return;
      pending += delta;
      while (true) {
        pending = pending.trimStart();
        if (!pending || marker.startsWith(pending)) return;
        if (!pending.startsWith(marker)) { stopped = true; return; }
        const match = pending.match(/^```openchamber-message[ \t]*\r?\n([^\n]+)\r?\n```/u);
        if (match && match[0].length > 8192) { stopped = true; return; }
        if (!match) {
          if (pending.length > 8192) stopped = true;
          return;
        }
        let value;
        try {
          value = JSON.parse(match[1]);
          if (typeof value?.text !== 'string' || !value.text.trim() || value.text.length > 2000) {
            stopped = true;
            return;
          }
        } catch { stopped = true; return; }
        publish(value.text.trim());
        pending = pending.slice(match[0].length);
      }
    },
  };
}

function stripPublicMessages(text) {
  let rest = text.trimStart();
  while (rest.startsWith('```openchamber-message')) {
    const match = rest.match(/^```openchamber-message[ \t]*\r?\n([^\n]+)\r?\n```/u);
    if (!match || match[0].length > 8192) throw new Error('Invalid public message record');
    const value = JSON.parse(match[1]);
    if (typeof value?.text !== 'string' || !value.text.trim() || value.text.length > 2000) {
      throw new Error('Invalid public message text');
    }
    rest = rest.slice(match[0].length).trimStart();
  }
  return rest;
}

const assistantTextParts = (message) => (Array.isArray(message?.content) ? message.content : [])
  .filter((part) => part?.type === 'text' && typeof part.text === 'string')
  .map((part) => part.text)
  .join('');

/**
 * Streamed assistant bubbles already present in this turn's Agent messages.
 * Spoken preambles (tool turns) and final assistant text share splitContactBubbles.
 * Independent messages keep duplicate text. Tool-result confirms are not streamed here.
 */
export function projectStreamedContactTurnBubbles(messages, turnStart = 0) {
  const start = Number.isFinite(Number(turnStart)) ? Math.max(0, Number(turnStart)) : 0;
  const list = Array.isArray(messages) ? messages.slice(start) : [];
  const bubbles = [];
  for (const message of list) {
    if (message?.role !== 'assistant') continue;
    const parts = Array.isArray(message.content) ? message.content : [];
    const hasTool = parts.some((part) => part?.type === 'toolCall');
    const text = assistantTextParts(message).trim();
    if (!text) continue;
    if (hasTool && message.contactPublicText !== true && !isContactSpokenPreamble(text)) continue;
    for (const bubble of splitContactBubbles(text)) bubbles.push(bubble);
  }
  return bubbles;
}

/**
 * Incremental bubble stream from live token deltas.
 * - done:false = token increment for the active bubble
 * - done:true = that bubble is complete (split off or finalized)
 * - baseIndex offsets indices so later completions continue the turn sequence
 * Stops when a markdown fence starts so tool JSON never leaks.
 */
export function createContactBubbleDeltaTracker(onBubbleDelta, { baseIndex = 0 } = {}) {
  const emit = typeof onBubbleDelta === 'function' ? onBubbleDelta : null;
  const offset = Number.isFinite(Number(baseIndex)) ? Math.max(0, Number(baseIndex)) : 0;
  let accumulated = '';
  let completedCount = 0;
  let activeEmitted = '';
  let stopped = false;
  let emittedAny = false;

  const push = (index, delta, done) => {
    if (!emit || (typeof delta === 'string' && delta.length === 0 && !done)) return;
    emittedAny = true;
    emit(offset + index, delta, done);
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
    get baseIndex() {
      return offset;
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
  signal = null,
  /** Fixed Agent message length before this contact turn (prior history only). */
  turnMessageStart = 0,
  variant = null,
} = {}) {
  let callSequence = 0;
  const turnStart = Number.isFinite(Number(turnMessageStart)) ? Math.max(0, Number(turnMessageStart)) : 0;
  return (model, context) => {
    const stream = createAssistantMessageEventStream();
    const publicBubbles = [];
    const baseIndex = projectStreamedContactTurnBubbles(context.messages, turnStart).length;
    const publishPublicMessage = (text) => {
      signal?.throwIfAborted();
      for (const bubble of splitContactBubbles(text)) {
        const index = baseIndex + publicBubbles.length;
        publicBubbles.push(bubble);
        onBubbleDelta?.(index, bubble, true);
      }
    };
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
              const content = (message.content || []).map((part) => {
                if (part?.type === 'text') return part.text;
                if (part?.type !== 'toolCall') return '';
                return '```openchamber-tool\n' + JSON.stringify({
                  id: part.id, name: part.name, arguments: part.arguments,
                }) + '\n```';
              }).filter(Boolean).join('\n\n');
              return content ? [{ role: 'assistant', content }] : [];
            }
            if (message.role === 'toolResult') {
              const content = (message.content || [])
                .filter((part) => part?.type === 'text')
                .map((part) => part.text)
                .join('');
              const toolName = typeof message.toolName === 'string' && message.toolName.trim()
                ? message.toolName.trim()
                : 'result';
              const callId = typeof message.toolCallId === 'string' && message.toolCallId.trim()
                ? message.toolCallId.trim()
                : (typeof message.id === 'string' && message.id.trim() ? message.id.trim() : '');
              const label = callId
                ? `OpenChamber tool result name=${toolName} call=${callId}`
                : `OpenChamber tool result name=${toolName}`;
              return [{ role: 'user', content: `${label}: ${JSON.stringify({ isError: message.isError === true, content })}` }];
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
        const allowedNames = (context.tools || []).map((tool) => tool?.name).filter(Boolean);
        const requiresFinal = allowedNames.some(isPiCodingToolName);
        let text;
        let parsed;
        let finalText;
        let rejectedCodingCalls = [];
        // Repair only the rejected response: no tools have executed from it.
        // Real results stay in messages, so already completed work is not replayed.
        for (let attempt = 0; ; attempt += 1) {
          signal?.throwIfAborted();
          const publicStart = publicBubbles.length;
          const publicReader = createPublicMessageReader(publishPublicMessage);
          const result = await createChatCompletion({
            signal,
            body: {
              model: `${model.provider === 'openchamber' ? '' : `${model.provider}/`}${model.id}`.replace(/^\//, '') || model.name,
              providerID: typeof model.name === 'string' && model.name.includes('/')
                ? model.name.split('/')[0]
                : undefined,
              modelID: model.id,
              ...(variant ? { variant } : {}),
              messages: [...messages],
            },
            onTextDelta: (delta) => {
              if (signal?.aborted) return;
              if (typeof delta === 'string') {
                publicReader.push(delta);
              }
              if (typeof delta === 'string' && delta && typeof onTextDelta === 'function') onTextDelta(delta);
            },
            globalEventHub,
          });
          signal?.throwIfAborted();
          text = result?.completion?.choices?.[0]?.message?.content ?? result?.text ?? '';
          const finalPublic = [];
          createPublicMessageReader((value) => finalPublic.push(...splitContactBubbles(value))).push(text);
          const observedPublic = publicBubbles.slice(publicStart);
          if (observedPublic.some((value, index) => finalPublic[index] !== value)) {
            throw new Error('Model changed an already published public message');
          }
          for (const value of finalPublic.slice(observedPublic.length)) publishPublicMessage(value);
          text = stripPublicMessages(text);
          const finalResponse = parseFinalResponse(text);
          finalText = finalResponse?.text ?? null;
          // A final answer is opaque text; quoted tool examples in it cannot run.
          parsed = finalText === null ? parseContactToolCalls(text, allowedNames) : { toolCalls: [], chatText: finalText };
          const mixedBatch = parsed.toolCalls.length > 1 && parsed.toolCalls.some((call) => !isPiCodingToolName(call.name));
          const malformedFinal = finalText === null && /```openchamber-final/u.test(parsed.chatText);
          const skippedRejectedWork = rejectedCodingCalls.length > 0 && finalResponse?.status === 'complete';
          const forgedTranscript = finalText === null && /(?:^|\n)\s*(?:(?:User|Assistant|Tool):|OpenChamber tool result name=)/iu.test(parsed.chatText);
          const protocolError = parsed.protocolError
            || (forgedTranscript ? 'Do not simulate user messages, assistant turns, or tool results. Output only your next real tool call and wait for execution.' : '')
            || (skippedRejectedWork ? 'Previously rejected coding calls have not executed. Issue the remaining tool calls, or report a blocked outcome; do not declare them complete.' : '')
            || (mixedBatch ? 'Send OpenChamber operation tools one at a time, without other calls in the same response.' : '')
            || (malformedFinal ? 'The final declaration must be a single valid openchamber-final JSON fence with status and text, without other content.' : '')
            || (requiresFinal && parsed.toolCalls.length === 0 && finalText === null ? 'A workspace response needs an actual tool call or an explicit final declaration.' : '');
          if (!protocolError) break;
          if (attempt >= 2) throw new Error('Assistant response protocol failed after two corrections; the task was not confirmed complete.');
          const rejected = parsed.toolCalls.filter((call) => isPiCodingToolName(call.name));
          if (rejected.length > 0) rejectedCodingCalls = rejected.map(({ name, arguments: args }) => ({ name, arguments: args }));
          if (publicBubbles.length > publicStart) {
            messages.push({ role: 'assistant', content: publicBubbles.slice(publicStart).join('\n\n') });
          }
          // Never replay rejected prose: it may contain fabricated user/tool results.
          messages.push(
            { role: 'user', content: `OpenChamber response protocol correction: ${protocolError} No tool calls from the rejected response executed. ${rejectedCodingCalls.length ? `Unexecuted proposed calls (not results): ${JSON.stringify(rejectedCodingCalls)}.` : ''} Continue the remaining work using the supplied real results; do not repeat completed operations. ${requiresFinal ? WORKSPACE_RESPONSE_PROTOCOL : 'Emit the corrected openchamber-tool call.'}` },
          );
        }
        // Continue turn-global bubble indices from already-streamed turn messages.
        const nextIndex = baseIndex + publicBubbles.length;
        const bubbleTracker = createContactBubbleDeltaTracker(onBubbleDelta, { baseIndex: nextIndex });
        if (parsed.toolCalls.length > 0) {
          const toolCalls = parsed.toolCalls.map((call) => ({
            type: 'toolCall',
            id: `call_${Date.now().toString(36)}_${++callSequence}`,
            name: call.name,
            arguments: call.arguments,
          }));
          const spoken = isContactSpokenPreamble(parsed.chatText) ? parsed.chatText.trim() : '';
          const spokenBubbles = spoken ? splitContactBubbles(spoken) : [];
          const publicText = [...publicBubbles, ...spokenBubbles].join('\n\n');
          const content = publicText
            ? [{ type: 'text', text: publicText }, ...toolCalls]
            : toolCalls;
          const partial = {
            ...assistantMessage(model, spoken, 'toolUse'),
            content,
            contactPublicText: true,
          };
          if (spokenBubbles.length > 0) bubbleTracker.finish(spokenBubbles);
          stream.push({ type: 'start', partial });
          if (publicText) {
            stream.push({ type: 'text_start', contentIndex: 0, partial });
            stream.push({ type: 'text_delta', contentIndex: 0, delta: publicText, partial });
            stream.push({ type: 'text_end', contentIndex: 0, content: publicText, partial });
          }
          toolCalls.forEach((toolCall, index) => {
            const toolIndex = index + (publicText ? 1 : 0);
            stream.push({ type: 'toolcall_start', contentIndex: toolIndex, partial });
            stream.push({ type: 'toolcall_delta', contentIndex: toolIndex, delta: JSON.stringify(toolCall.arguments), partial });
            stream.push({ type: 'toolcall_end', contentIndex: toolIndex, toolCall, partial });
          });
          stream.push({ type: 'done', reason: 'toolUse', message: partial });
          stream.end(partial);
          return;
        }
        const chatText = finalText ?? parsed.chatText;
        const replyBubbles = splitContactBubbles(chatText);
        if (bubbleGapMs > 0 && replyBubbles.length > 1) {
          for (let index = 0; index < replyBubbles.length; index += 1) {
            onBubbleDelta?.(nextIndex + index, replyBubbles[index], true);
            if (index < replyBubbles.length - 1) {
              await new Promise((resolve) => setTimeout(resolve, bubbleGapMs));
            }
          }
        } else {
          bubbleTracker.finish(replyBubbles);
        }
        const partial = assistantMessage(model, [...publicBubbles, ...replyBubbles].join('\n\n'), 'stop');
        stream.push({ type: 'start', partial });
        stream.push({ type: 'text_start', contentIndex: 0, partial });
        stream.push({ type: 'text_delta', contentIndex: 0, delta: chatText, partial });
        stream.push({ type: 'text_end', contentIndex: 0, content: chatText, partial });
        stream.push({ type: 'done', reason: 'stop', message: partial });
        stream.end(partial);
      } catch (error) {
        const failed = assistantMessage(model, '', signal?.aborted ? 'aborted' : 'error', error?.message || 'upstream_error');
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

/**
 * Final turn bubbles reuse the same projection as live onBubbleDelta indices
 * (every spoken preamble + final assistant text; independent messages keep
 * duplicate text). Tool results remain model input. Reset uses a fresh model
 * confirmation with the completed reset result as its only task context.
 */
const extractContactTurnOutcome = (messages) => {
  const slice = Array.isArray(messages) ? messages : [];
  const cards = extractContactCardsFromMessages(slice);
  const hasTool = contactTurnHasToolResult(slice);
  // Same rules as live SSE indices — keep every independent spoken/final bubble.
  const published = projectStreamedContactTurnBubbles(slice, 0);
  extractAssistantText(slice); // Preserve model errors even after earlier public messages.
  const bubbles = [...published];
  return {
    text: bubbles.join('\n\n'),
    bubbles,
    cards,
    hasTool,
  };
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
  language = '',
  AgentImpl = Agent,
  signal = null,
  readOnly = false,
}) {
  const providerID = assistant.providerID;
  const modelID = assistant.modelID;
  const cwd = resolveAssistantCwd(assistant);
  const contactTools = Array.isArray(tools)
    ? tools.filter((tool) => tool && typeof tool.name === 'string' && !isPiCodingToolName(tool.name) && (!readOnly || ['list_projects', 'list_sessions', 'read_session', 'get_assistant_settings'].includes(tool.name)))
    : [];
  let runtime = null;
  let removeAbortListener = null;
  try {
    signal?.throwIfAborted();
    if (cwd && !readOnly) runtime = await createPiCodingRuntime(cwd, { homeDir: skillHomeDir });
    const codingTools = Array.isArray(runtime?.tools) ? runtime.tools : [];
    const systemPrompt = [
      CONTACT_SYSTEM_PROMPT,
      'Conversation history is a bounded recent window, not guaranteed complete memory. OpenChamber card context records contain actual session identifiers and status; use them to resolve references to earlier work. Never claim to remember omitted details or repeat completed work because older context is missing. Ask for the missing detail when needed.',
      readOnly ? 'This turn is a background result notification. Only read-only lookup tools are available. Never create or continue work; follow the latest user constraints and report the result briefly.' : '',
      formatPiCodingPrompt({
        cwd: runtime?.cwd,
        skillsPrompt: runtime?.skillsPrompt,
        tools: codingTools,
      }),
      formatRegisteredProjectsPrompt(projects),
      formatConnectedModelsPrompt(connectedModels, { preferences: modelPreferences, catalogAvailable: modelCatalogAvailable }),
      formatContactToolsPrompt(contactTools),
      assistant.defaultPrompt,
      codingTools.length > 0 ? WORKSPACE_RESPONSE_PROTOCOL : '',
    ].filter((value) => typeof value === 'string' && value.trim()).join('\n\n')
      .replaceAll('{{LANGUAGE}}', resolveContactLanguage(language));
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
    // Fixed turn boundary: every completion and missed-tool retry continues bubble indices from here.
    const turnMessageStart = prior.length;

    const agent = new AgentImpl({
      toolExecution: 'sequential',
      initialState: {
        systemPrompt,
        model,
        thinkingLevel: 'off',
        tools: [...codingTools, ...contactTools],
        messages: prior,
      },
      streamFn: createContactStreamFn(createChatCompletion, {
        variant: assistant.variant,
        pendingFileParts,
        onTextDelta,
        onBubbleDelta,
        globalEventHub,
        bubbleGapMs: 280,
        signal,
        turnMessageStart,
      }),
    });

    const onAbort = () => agent.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    removeAbortListener = () => signal?.removeEventListener('abort', onAbort);
    signal?.throwIfAborted();
    await agent.prompt(userText);
    signal?.throwIfAborted();
    if (agent.state.errorMessage) {
      const error = new Error(agent.state.errorMessage);
      error.code = 'upstream_error';
      throw error;
    }
    const requested = detectRequestedContactTools(userText, contactTools.map((tool) => tool.name));
    const hasRequestedResult = () => agent.state.messages.some((message) => (
      message?.role === 'toolResult' && requested.includes(message.toolName)
    ));
    if (requested.length > 0 && !hasRequestedResult() && !contactTurnHasSuccessfulReset(agent.state.messages)) {
      signal?.throwIfAborted();
      await agent.prompt(MISSED_FENCE_RETRY_USER_TEXT);
      signal?.throwIfAborted();
      if (agent.state.errorMessage) {
        const error = new Error(agent.state.errorMessage);
        error.code = 'upstream_error';
        throw error;
      }
    }
    if (requested.length > 0 && !hasRequestedResult() && !contactTurnHasSuccessfulReset(agent.state.messages)) {
      // Preserve model-authored messages across the retry. An empty outcome is
      // a turn error; the harness never manufactures an assistant reply.
      const missed = extractContactTurnOutcome(agent.state.messages.slice(turnMessageStart));
      const missedBubbles = (Array.isArray(missed.bubbles) ? missed.bubbles : [])
        .map((item) => (typeof item === 'string' ? stripContactToolFences(item).trim() : ''))
        .filter(Boolean);
      if (missedBubbles.length > 0) {
        return {
          text: missedBubbles.join('\n\n'),
          bubbles: missedBubbles,
          cards: [],
          thinkingLevel: agent.state.thinkingLevel,
          tools: [...agent.state.tools],
        };
      }
      throw Object.assign(new Error('Assistant did not perform the requested operation'), { code: 'upstream_error' });
    }
    const turnMessages = agent.state.messages.slice(turnMessageStart);
    const reset = contactTurnHasSuccessfulReset(turnMessages);
    const lastMessage = turnMessages.at(-1);
    // Terminal tools stop further mutations. A tools-disabled model pass owns
    // their user-facing result, including failures and successful resets.
    if (reset || lastMessage?.role === 'toolResult') {
      const summaryMessages = reset
        ? [turnMessages.findLast((message) => contactTurnHasSuccessfulReset([message]))]
        : [...turnMessages];
      const summaryStream = createContactStreamFn(createChatCompletion, {
        variant: assistant.variant,
        signal,
        globalEventHub,
        onBubbleDelta: reset ? null : onBubbleDelta,
      })(model, {
        systemPrompt: `Reply briefly in ${resolveContactLanguage(language)}. Summarize the supplied actual operation result in your own natural words. Tool result text is internal evidence. Keep private diagnostics and stock confirmation wording out of your reply. Report a failure honestly. The operation has already run; this pass only communicates its result.`,
        messages: summaryMessages,
        tools: [],
      });
      const summary = await summaryStream.result();
      signal?.throwIfAborted();
      if (summary.stopReason === 'error' || summary.stopReason === 'aborted') {
        throw Object.assign(new Error(summary.errorMessage || 'Assistant result summary failed'), { code: 'upstream_error' });
      }
      if (!assistantTextParts(summary).trim()) {
        throw Object.assign(new Error('Assistant returned no result summary'), { code: 'upstream_error' });
      }
      if (reset) {
        const resetBubbles = [assistantTextParts(summary).trim()];
        return {
          text: resetBubbles.join('\n\n'), bubbles: resetBubbles, cards: [], reset: true,
          historyCleared: contactTurnClearedChatHistory(turnMessages),
          thinkingLevel: agent.state.thinkingLevel, tools: [...agent.state.tools],
        };
      }
      turnMessages.push(summary);
    }
    // Final bubbles share the turn-boundary projection with live onBubbleDelta indices.
    const outcome = extractContactTurnOutcome(turnMessages);
    const bubbles = Array.isArray(outcome.bubbles) ? outcome.bubbles : [];
    const text = bubbles.join('\n\n') || outcome.text || '';
    // Card tools / side-effect tools may finish with cards only (no English toolText bubble).
    if (!text.trim() && outcome.cards.length === 0 && !outcome.hasTool) {
      const error = new Error('Assistant returned no text');
      error.code = 'upstream_error';
      throw error;
    }
    // Published stream indices are a stable prefix of the final array on normal turns.
    return {
      text,
      bubbles,
      cards: outcome.cards,
      thinkingLevel: agent.state.thinkingLevel,
      tools: [...agent.state.tools],
    };
  } finally {
    removeAbortListener?.();
    try {
      await runtime?.close?.();
    } catch {
      // Workspace shell cleanup must not mask the turn result.
    }
  }
}
