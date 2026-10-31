import { Agent } from '@earendil-works/pi-agent-core';
import { randomUUID } from 'node:crypto';
import { splitContactBubbles } from './bubbles.js';
import {
  contactTurnClearedChatHistory,
  contactTurnHasSuccessfulReset,
  contactTurnHasToolResult,
  detectRequestedContactTools,
  extractContactCardsFromMessages,
  formatContactToolsPrompt,
  formatConnectedModelsPrompt,
  formatRegisteredProjectsPrompt,
  createNotifyUserTool,
  createStaySilentTool,
  MISSED_FENCE_RETRY_USER_TEXT,
  NOTIFY_USER_MAX_CHARS,
  NOTIFY_USER_TOOL_NAME,
  parseContactNativeToolCalls,
  STAY_SILENT_TOOL_NAME,
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
  "You are Yuri's in-app assistant — a personable contact focused on understanding the user, communicating naturally, coordinating work, and following up on results.",
  'For substantive tasks, default to finding the relevant existing OpenCode workspace and handing the task to a worker session with assign_session. Carry the user goal, relevant context, constraints, and verification expectations into that session; follow its results and explain the outcome in normal conversation.',
  'Handle simple questions, file lookups, and small, clearly scoped configuration changes directly when their scope and verification are straightforward. As a task grows into implementation, multi-step debugging, or broad changes, hand it to a worker session. An explicit user request to handle a bounded task yourself can use the direct tools.',
  'Reply in short chat bubbles: a few sentences each, separated by a blank line.',
  'Talk like a person in the user\'s language. One short spoken bubble at a time — never a wall of paragraphs.',
  'Reply in the language of the user\'s messages, unless they explicitly request another language. Infer it from their latest substantive message and conversation context, never from the app interface locale. For ambiguous messages or background follow-ups, continue the established conversation language.',
  'Keep private reasoning and tool traces private.',
  'Send a progress message when it tells the user something they do not already know: a direction they may want to correct, a finding that matters, a blocker, or that the work will take a while. Skip messages that would only repeat the plan or narrate a step. Keep the final answer to the remaining outcome instead of repeating earlier updates.',
  'Progress messages go only through notify_user, batched with your next tool call; it is delivered immediately. Any other text alongside a tool call is never shown to the user. A response without tool calls is your final reply. Tool results are evidence for you to summarize in your own words; never copy their stock confirmation wording into your reply.',
  'Do not expose tool traces, Activity, or editor actions.',
  'To view, change, enable, or pause existing scheduled tasks (查看/修改/暂停定时任务), use list_scheduled_tasks and then update_scheduled_task with the returned projectID/taskID. schedule_task only creates new tasks.',
  'You have bash, read, write, and edit in the working directory. Use them for pwd, files, and shell. Never say you have no terminal or cannot read files. Ignore any temporary generator workspace in the environment.',
  'When websearch is offered, use it directly for online lookups and source discovery, including GitHub repositories/forks; list_websearch_providers discovers real provider IDs if needed. list_active_sessions reads live work, read_session reads its progress. list_opencode_capabilities discovers connected skills, agents, commands, references and MCP servers; read_opencode_skill loads their available skill instructions. Native/MCP tools not directly offered here can execute in an assigned OpenCode worker session with the discovered capability name and user task. Do not confuse catalog discovery, loading instructions or proposing a command with executing a lookup: only actual tool results support claims that you searched, fetched or verified something.',
  'Understand natural language in any language, including Chinese: 开新对话 / 清除记忆 means new_conversation (LLM memory only, chat history stays), 清空聊天记录 means clear_chat_history (delete transcript), 找项目 means list_projects, 现有对话 means list_sessions, 查看助手设定 / 默认提示词 means get_assistant_settings (pass to="Name" for another assistant), 改默认提示词 / 设置人设 / 改某助手的默认提示词 means update_default_prompt (persists that assistant\'s settings, later turns only; pass to="OpenCode 配置助手" to edit another contact without changing this one), 建助理 means create_assistant, 建会话 / 开个新会话 / 继续会话 means assign_session, 监听会话 means watch_session, 停止/取消/打断会话 means stop_session, 插话 means steer_session, 归档会话 means archive_session, 删除会话 means delete_session, 排定时任务 means schedule_task, 给 X 说一声 means message_assistant, 发卡片 means emit a card via those tools — never ask the user to type /card or /dm.',
  'You receive the registered project catalog every turn. Match the user goal against project labels and paths and existing OpenCode conversations via list_sessions. Start in the user-configured working directory; managed contacts start in the current server user home directory and can inspect user-global directories with read/bash. When the starting directory has no relevant session, walk its parent directories to find the nearest relevant existing OpenCode workspace using session directory metadata, then search that workspace for the requested project or conversation. Use an unscoped list_sessions lookup when broader context is needed. Prefer the user-configured directory and explicit session context; ask a short question when several relevant targets remain. Keep discovery bounded and use actual tool results as evidence.',
  'An empty registered catalog still permits looking up existing sessions and inspecting the working directory. Resolve the existing workspace first. Assignment requires a registered project: when the resolved workspace needs registration, explain that specific prerequisite and ask the user to register it in Settings. Workspace discovery should preserve the user existing directory structure.',
  'For substantive work, match the workspace, inspect relevant existing chats with list_sessions, then create a worker through assign_session with projectPath or continue the relevant conversation with sessionID plus the task prompt (omit model args to keep the prior worker model). File and shell tools support discovery and the small-task exception. To only listen without prompting when asked (监听/watch/monitor), watch_session with sessionID — a plain @session:id mention alone is not a watch request. To abort a running session, stop_session with sessionID. Optional worker model via providerID/modelID/model from the connected catalog — that does not change this contact. Current-turn user attachments are server-forwarded on assign. One successful assign_session or watch_session ends the turn — do not call it again.',
  'A reply without the tool call does nothing. Never say 已创建, created, scheduled, opened, watched, or stopped unless the tool already returned success.',
  'When creating a scheduled task, preserve the user reporting intent in its prompt: deliver requested research/summaries, or keep successful background work quiet when no report is wanted. Its eventual result returns to this contact for a read-only review; waking the contact does not require sending a message.',
].join(' ');

// Plain text without tool calls ends the pi loop, so a workspace turn keeps
// calling tools until the work is done or handed off.
const WORKSPACE_RESPONSE_PROTOCOL = [
  'Workspace response protocol: keep calling tools until the task is handed to a worker session, or the small direct task and its verification are done. A successful assign_session ends this turn and worker completion is reported through the session follow-up.',
  'You may batch independent coding calls, but they execute sequentially in the order supplied. Wait for results before using their output. Send Yuri operation tools one at a time; notify_user may accompany any call.',
  'Reading a skill loads instructions. For substantive work, pass relevant instructions and context to the worker session; for a small direct task, execute the applicable steps and verify the result before completing.',
  'A response without tool calls ends the turn: use it only for the final answer, a question, or the real blocker, never for a progress update or a promise to act later.',
  'Never invent tool results, User messages, or future assistant turns. Only supplied tool-result records are execution evidence.',
].join('\n');

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
    provider: 'yuri',
    baseUrl: 'http://yuri.invalid/api/yuri/llm',
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
 * streamFn for pi-agent-core. Calls Yuri completions (public HTTP stays
 * non-streaming). In-process callers may pass onTextDelta/globalEventHub for
 * the throwaway generate path. notify_user notes publish when the response
 * arrives; other text beside tool calls stays private, and a response without
 * tool calls is the final reply. Failures are encoded on the event stream.
 */
const completionFileParts = (value) => (Array.isArray(value) ? value : [])
  .filter((part) => part?.type === 'file' && typeof part.mime === 'string' && typeof part.url === 'string')
  .map((part) => ({
    type: 'file',
    mime: part.mime,
    url: part.url,
    ...(typeof part.filename === 'string' && part.filename.trim() ? { filename: part.filename.trim() } : {}),
  }));

const assistantTextParts = (message) => (Array.isArray(message?.content) ? message.content : [])
  .filter((part) => part?.type === 'text' && typeof part.text === 'string')
  .map((part) => part.text)
  .join('');

/**
 * Streamed assistant bubbles already present in this turn's Agent messages.
 * notify_user notes (tool turns) and final assistant text share splitContactBubbles.
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
    if (hasTool && message.contactPublicText !== true) continue;
    for (const bubble of splitContactBubbles(text)) bubbles.push(bubble);
  }
  return bubbles;
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
  allowSilent = false,
  cacheKey = randomUUID(),
} = {}) {
  let callSequence = 0;
  const turnStart = Number.isFinite(Number(turnMessageStart)) ? Math.max(0, Number(turnMessageStart)) : 0;
  return (model, context) => {
    const stream = createAssistantMessageEventStream();
    const publicBubbles = [];
    const baseIndex = projectStreamedContactTurnBubbles(context.messages, turnStart).length;
    const publishPublicMessage = (text) => {
      signal?.throwIfAborted();
      // Background reviews speak only through their final decision.
      if (allowSilent) return;
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
              const content = (message.content || []).filter(part => part?.type === 'text').map(part => part.text).join('\n\n');
              const calls = (message.content || []).filter(part => part?.type === 'toolCall').map(part => ({ id: part.id, type: 'function', function: { name: part.name, arguments: JSON.stringify(part.arguments) } }));
              // Delivered notes beside other calls replay as the notify_user call they
              // came from, so the model never sees narration accompanying a tool call.
              if (message.contactPublicText === true && content && calls.length && !calls.some((call) => call.function.name === NOTIFY_USER_TOOL_NAME)) {
                const id = `${calls[0].id || 'call'}_notify`;
                return [
                  { role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name: NOTIFY_USER_TOOL_NAME, arguments: JSON.stringify({ text: content }) } }, ...calls] },
                  { role: 'tool', name: NOTIFY_USER_TOOL_NAME, tool_call_id: id, content: JSON.stringify({ isError: false, content: 'Delivered.' }) },
                ];
              }
              if (calls.length) return [{ role: 'assistant', content: '', tool_calls: calls }];
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
              return [{ role: 'tool', name: toolName, tool_call_id: callId, content: JSON.stringify({ isError: message.isError === true, content }) }];
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
        let text;
        let parsed;
        let rejectedCodingCalls = [];
        // Repair only the rejected response: no tools have executed from it.
        // Real results stay in messages, so already completed work is not replayed.
        for (let attempt = 0; ; attempt += 1) {
          signal?.throwIfAborted();
          const result = await createChatCompletion({
            signal,
            timeoutMs: 0,
            retryEmptyTextUntilCancelled: true,
            cacheKey,
            body: {
              model: `${model.provider === 'yuri' ? '' : `${model.provider}/`}${model.id}`.replace(/^\//, '') || model.name,
              providerID: typeof model.name === 'string' && model.name.includes('/')
                ? model.name.split('/')[0]
                : undefined,
              modelID: model.id,
              ...(variant ? { variant } : {}),
              messages: [...messages],
              tools: (context.tools || []).map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description || tool.name, parameters: JSON.parse(JSON.stringify(tool.parameters ?? { type: 'object', properties: {} })) } })),
            },
            onTextDelta: (delta) => {
              if (signal?.aborted) return;
              if (typeof delta === 'string' && delta && typeof onTextDelta === 'function') onTextDelta(delta);
            },
            globalEventHub,
            validateToolCalls: false,
          });
          signal?.throwIfAborted();
          const message = result?.completion?.choices?.[0]?.message;
          const content = message?.content ?? result?.text ?? '';
          text = typeof content === 'string' ? content : '';
          const nativeCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
          parsed = nativeCalls.length
            ? parseContactNativeToolCalls(nativeCalls, allowedNames)
            : { toolCalls: [], protocolError: '' };
          const operations = parsed.toolCalls.filter((call) => call.name !== NOTIFY_USER_TOOL_NAME);
          const mixedBatch = operations.length > 1 && operations.some((call) => !isPiCodingToolName(call.name));
          const forgedTranscript = nativeCalls.length === 0 && /(?:^|\n)\s*(?:(?:User|Assistant|Tool):|Yuri tool result name=)/iu.test(text);
          const protocolError = parsed.protocolError
            || (forgedTranscript ? 'Do not simulate user messages, assistant turns, or tool results. Call the next real tool and wait for its result.' : '')
            || (mixedBatch ? 'Send Yuri operation tools one at a time, without other calls in the same response.' : '');
          if (!protocolError) break;
          if (attempt >= 2) throw new Error(`Assistant response protocol failed after two corrections; the task was not confirmed complete. Reason: ${protocolError}`);
          const rejected = operations.filter((call) => isPiCodingToolName(call.name));
          if (rejected.length > 0) rejectedCodingCalls = rejected.map(({ name, arguments: args }) => ({ name, arguments: args }));
          // Never replay rejected prose: it may contain fabricated user/tool results.
          messages.push(
            { role: 'user', content: `Yuri response protocol correction: ${protocolError} No tool calls from the rejected response executed. ${rejectedCodingCalls.length ? `Unexecuted proposed calls (not results): ${JSON.stringify(rejectedCodingCalls)}.` : ''} Continue the remaining work using the supplied real results; do not repeat completed operations.` },
          );
        }
        if (parsed.toolCalls.length > 0) {
          // notify_user text is the only public part of a tool-call response; other
          // text that accompanies a tool call is model narration and stays private.
          for (const call of parsed.toolCalls) {
            if (call.name !== NOTIFY_USER_TOOL_NAME) continue;
            const note = typeof call.arguments?.text === 'string' ? call.arguments.text.trim() : '';
            if (note && note.length <= NOTIFY_USER_MAX_CHARS) publishPublicMessage(note);
          }
          const operations = parsed.toolCalls.filter((call) => call.name !== NOTIFY_USER_TOOL_NAME);
          // Delivered notes alongside other calls need no execution. Dropping them keeps
          // terminal batches (assign_session, stay_silent) terminal; a notes-only
          // response still executes so the loop continues.
          const executed = operations.length > 0 ? operations : parsed.toolCalls;
          const toolCalls = executed.map((call) => ({
            type: 'toolCall',
            id: call.id || `call_${Date.now().toString(36)}_${++callSequence}`,
            name: call.name,
            arguments: call.arguments,
          }));
          const publicText = publicBubbles.join('\n\n');
          const content = publicText
            ? [{ type: 'text', text: publicText }, ...toolCalls]
            : toolCalls;
          const partial = {
            ...assistantMessage(model, '', 'toolUse'),
            content,
            contactPublicText: true,
          };
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
        // A response without tool calls is the final reply.
        const chatText = text.trim();
        const replyBubbles = splitContactBubbles(chatText);
        for (let index = 0; index < replyBubbles.length; index += 1) {
          onBubbleDelta?.(baseIndex + index, replyBubbles[index], true);
          if (bubbleGapMs > 0 && index < replyBubbles.length - 1) {
            await new Promise((resolve) => setTimeout(resolve, bubbleGapMs));
          }
        }
        const partial = assistantMessage(model, replyBubbles.join('\n\n'), 'stop');
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
 * Thin Yuri contact harness: pi-agent-core Agent + thinkingLevel off.
 * Attaches pi read/write/edit/bash in the assistant workspace plus Yuri
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
  openCodeContext = '',
  language = '',
  AgentImpl = Agent,
  signal = null,
  readOnly = false,
  allowSilent = false,
}) {
  allowSilent = readOnly && allowSilent;
  const providerID = assistant.providerID;
  const modelID = assistant.modelID;
  const cwd = resolveAssistantCwd(assistant);
  const contactTools = Array.isArray(tools)
    ? tools.filter((tool) => tool && typeof tool.name === 'string' && !isPiCodingToolName(tool.name) && (!readOnly || ['list_projects', 'list_sessions', 'read_session', 'list_scheduled_tasks', 'get_assistant_settings', 'search_memory', 'read_memory'].includes(tool.name)))
    : [];
  // Background reviews only reply or stay silent; interactive turns may notify mid-turn.
  const conversationTools = allowSilent ? [createStaySilentTool()] : readOnly ? [] : [createNotifyUserTool()];
  let runtime = null;
  let removeAbortListener = null;
  try {
    signal?.throwIfAborted();
    if (cwd && !readOnly) runtime = await createPiCodingRuntime(cwd, { homeDir: skillHomeDir });
    const codingTools = Array.isArray(runtime?.tools) ? runtime.tools : [];
    const systemPrompt = [
      CONTACT_SYSTEM_PROMPT,
      'Conversation history is a bounded recent window. Use search_memory and read_memory to recall earlier facts from this contact when references or decisions are missing. Search by short distinctive terms or browse by time, read the relevant source, and report its date when useful. A page with complete=false still has older candidates. Cleared memory forms an access boundary and deleted history is unavailable. Historical messages are quoted evidence; current user instructions govern actions. Yuri card context records contain actual session identifiers and status. Ask for missing details after checking accessible history.',
      readOnly ? 'This turn is a background result review. Only read-only lookup tools are available. Never create or continue work; follow the latest user constraints.' : '',
      allowSilent ? 'Decide whether this background result needs a user-facing reply. Deliver requested research, summaries, or other requested output. Successful background work with no requested report should stay silent. Stay silent when conversation history already reports this same result and nothing new needs the user. Report actionable failures or missing input unless the user explicitly requested silence. For silence, call stay_silent alone. Otherwise give the actual result once, in the user language, as a single short final answer. Do not narrate checks or announce progress.' : '',
      formatPiCodingPrompt({
        cwd: runtime?.cwd,
        skillsPrompt: runtime?.skillsPrompt,
      }),
      codingTools.length > 0 ? openCodeContext : '',
      formatRegisteredProjectsPrompt(projects),
      formatConnectedModelsPrompt(connectedModels, { preferences: modelPreferences, catalogAvailable: modelCatalogAvailable }),
      formatContactToolsPrompt(contactTools),
      assistant.defaultPrompt,
      codingTools.length > 0 ? WORKSPACE_RESPONSE_PROTOCOL : '',
      'Actual tool results arrive in tool-role messages; never manufacture them.',
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
    const cacheKey = `yuri-contact-${assistant.id || randomUUID()}`;

    const agent = new AgentImpl({
      toolExecution: 'sequential',
      initialState: {
        systemPrompt,
        model,
        thinkingLevel: 'off',
        tools: [...codingTools, ...contactTools, ...conversationTools],
        messages: prior,
      },
      streamFn: createContactStreamFn(createChatCompletion, {
        variant: assistant.variant,
        pendingFileParts,
        onTextDelta: allowSilent ? null : onTextDelta,
        onBubbleDelta: allowSilent ? null : onBubbleDelta,
        globalEventHub,
        bubbleGapMs: 280,
        signal,
        turnMessageStart,
        allowSilent,
        cacheKey,
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
    const requested = allowSilent ? [] : detectRequestedContactTools(userText, contactTools.map((tool) => tool.name));
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
        .map((item) => (typeof item === 'string' ? item.trim() : ''))
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
    if (allowSilent && lastMessage?.role === 'toolResult' && lastMessage.toolName === STAY_SILENT_TOOL_NAME && !lastMessage.isError) {
      return { silent: true, text: '', bubbles: [], cards: [], thinkingLevel: agent.state.thinkingLevel, tools: [...agent.state.tools] };
    }
    // Terminal tools stop further mutations. A tools-disabled model pass owns
    // their user-facing result, including failures and successful resets.
    if (reset || lastMessage?.role === 'toolResult') {
      const summaryMessages = reset
        ? [{ role: 'user', content: userText, timestamp: Date.now() }, turnMessages.findLast((message) => contactTurnHasSuccessfulReset([message]))]
        : [...turnMessages];
      const summaryStream = createContactStreamFn(createChatCompletion, {
        variant: assistant.variant,
        signal,
        globalEventHub,
        onBubbleDelta: reset ? null : onBubbleDelta,
        cacheKey,
      })(model, {
        systemPrompt: 'Reply briefly in the language of the user\'s messages, honoring explicit language requests. Use the conversation language, never the app interface locale or tool-result language. Summarize the supplied actual operation result in your own natural words. Tool result text is internal evidence. Keep private diagnostics and stock confirmation wording out of your reply. Report a failure honestly. The operation has already run; this pass only communicates its result.',
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
