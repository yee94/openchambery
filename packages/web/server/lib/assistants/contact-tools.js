import { AssignError, PROJECT_REQUIRED_MESSAGE } from './assign.js';
import { createAssistantCardPart, createScheduleCardPart, createSessionCardPart } from './cards.js';

const typeboxString = (description) => {
  const schema = { type: 'string', description };
  Object.defineProperty(schema, '~kind', { value: 'String' });
  return schema;
};

const typeboxOptional = (schema) => {
  Object.defineProperty(schema, '~optional', { value: true });
  return schema;
};

const typeboxObject = (properties) => {
  const required = Object.entries(properties)
    .filter(([, schema]) => !schema['~optional'])
    .map(([key]) => key);
  const schema = { type: 'object', required, properties };
  Object.defineProperty(schema, '~kind', { value: 'Object' });
  return schema;
};

export const ASSIGN_SESSION_TOOL_NAME = 'assign_session';
export const CREATE_ASSISTANT_TOOL_NAME = 'create_assistant';
export const SCHEDULE_TASK_TOOL_NAME = 'schedule_task';
export const MESSAGE_ASSISTANT_TOOL_NAME = 'message_assistant';
export const NEW_CONVERSATION_TOOL_NAME = 'new_conversation';
const CONTACT_TOOL_FENCE = 'openchamber-tool';
export const ASSIGNED_SESSION_FALLBACK_BUBBLE = 'Opened a coding session.';
export const NEW_CONVERSATION_CONFIRM_BUBBLE = 'Started a new conversation. Previous contact messages are cleared.';

const DENIED_CODING_TOOLS = new Set(['bash', 'edit', 'read', 'write', 'glob', 'grep', 'shell']);

const FENCE = new RegExp(`\`\`\`${CONTACT_TOOL_FENCE}\\s*([\\s\\S]*?)\`\`\``, 'u');
export const MISSED_FENCE_RETRY_USER_TEXT = 'emit the fence now, do not claim success.';
export const MISSED_TOOL_FAILURE_BUBBLE = 'I could not complete that. No tool ran, so nothing was created.';

const CREATE_ASSISTANT_INTENT = /建助理|新建[^。\n!]{0,24}助理|创建[^。\n!]{0,24}助理|加一个助理|create (?:an |a new )?assistant|new assistant/iu;
const SCHEDULE_TASK_INTENT = /排定时任务|排个?定时任务|定时任务|schedule (?:a )?(?:daily )?(?:task|ping)|scheduled task|排个?(?:每日)?(?:任务|ping)/iu;
const ASSIGN_SESSION_INTENT = /建会话|开会话|开(?:一个)?(?:编码\s*)?(?:session|会话)|open (?:a )?(?:coding )?session|assign_session|write a file|写(?:一个)?文件/giu;
const MESSAGE_ASSISTANT_INTENT = /给[^。\n]{1,40}说(?:一声)?|跟[^。\n]{1,24}说(?:一声)?|告诉(?!我)[^。\n]{1,40}|说一声|message (?:the )?(?:assistant|peer)|(?:tell|message)\s+[A-Za-z0-9._-]+|send (?:a )?message to/iu;
const NEW_CONVERSATION_INTENT = /开新对话|新对话|清空(?:聊天|对话)|clear chat|new conversation|start over/iu;
const INTENT_NEGATION = /不要|别|不用|不开|don't|do\s+not/iu;
const newConversationParameters = typeboxObject({});

const assignParameters = typeboxObject({
  prompt: typeboxString('Coding prompt to kick into the worker OpenCode session.'),
  projectPath: typeboxOptional(typeboxString('Registered project path. Required when more than one project exists.')),
  directory: typeboxOptional(typeboxString('Existing project or worktree directory to reuse.')),
  branch: typeboxOptional(typeboxString('Existing Chat worktree branch to reuse. Do not create a new worktree.')),
  sessionID: typeboxOptional(typeboxString('Existing OpenCode session to reuse instead of creating one.')),
  title: typeboxOptional(typeboxString('Optional title for the worker session and contact card.')),
});

const createAssistantParameters = typeboxObject({
  name: typeboxString('Display name for the new assistant contact, e.g. FlowQA.'),
  providerID: typeboxOptional(typeboxString('OpenCode provider ID already connected in Settings, e.g. opencode-go.')),
  modelID: typeboxOptional(typeboxString('OpenCode model ID already connected in Settings, e.g. deepseek-v4-flash.')),
  model: typeboxOptional(typeboxString('Optional provider/model string such as opencode-go/deepseek-v4-flash.')),
});

const scheduleTaskParameters = typeboxObject({
  name: typeboxString('Short scheduled-task name.'),
  prompt: typeboxString('Prompt the scheduled run should send to the worker session.'),
  projectPath: typeboxOptional(typeboxString('Registered project path. Required when more than one project exists.')),
  kind: typeboxOptional(typeboxString('Schedule kind: daily, weekly, once, or cron. Default daily.')),
  time: typeboxOptional(typeboxString('HH:mm local time, e.g. 18:00.')),
  timezone: typeboxOptional(typeboxString('IANA timezone, e.g. Asia/Shanghai.')),
  date: typeboxOptional(typeboxString('YYYY-MM-DD for kind=once.')),
  weekdays: typeboxOptional(typeboxString('Comma-separated 0-6 weekdays for kind=weekly.')),
  cron: typeboxOptional(typeboxString('Cron expression for kind=cron.')),
  providerID: typeboxOptional(typeboxString('OpenCode provider ID. Defaults to this contact\'s provider.')),
  modelID: typeboxOptional(typeboxString('OpenCode model ID. Defaults to this contact\'s model.')),
  model: typeboxOptional(typeboxString('Optional provider/model string such as opencode-go/deepseek-v4-flash.')),
});

const messageAssistantParameters = typeboxObject({
  text: typeboxString('Read-only message to insert into the other assistant contact transcript.'),
  to: typeboxOptional(typeboxString('Recipient assistant display name, e.g. PeerQA.')),
  name: typeboxOptional(typeboxString('Recipient assistant display name if `to` is omitted.')),
  toAssistantID: typeboxOptional(typeboxString('Recipient assistant id when already known.')),
});

const allowedToolName = (name, allowedNames) => {
  if (typeof name !== 'string' || !name.trim()) return false;
  const next = name.trim();
  if (DENIED_CODING_TOOLS.has(next)) return false;
  return allowedNames.has(next);
};

const parseToolPayload = (raw, allowedNames) => {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const name = typeof parsed.name === 'string' ? parsed.name.trim() : '';
  if (!allowedToolName(name, allowedNames)) return null;
  const args = parsed.arguments;
  if (args != null && (typeof args !== 'object' || Array.isArray(args))) return null;
  return { name, arguments: args && typeof args === 'object' ? args : {} };
};

const extractJsonObjectAt = (text, start) => {
  if (text[start] !== '{') return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (character === '\\') {
        escape = true;
        continue;
      }
      if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
};

const findEmbeddedToolCall = (text, allowedNames) => {
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '{') continue;
    const snippet = extractJsonObjectAt(text, index);
    if (!snippet) continue;
    const toolCall = parseToolPayload(snippet, allowedNames);
    if (!toolCall) continue;
    const chatText = stripContactToolFences(`${text.slice(0, index)}${text.slice(index + snippet.length)}`.trim());
    return { chatText, toolCall };
  }
  return null;
};

export function stripContactToolFences(text) {
  if (typeof text !== 'string') return '';
  return text.replace(new RegExp(`\`\`\`${CONTACT_TOOL_FENCE}[\\s\\S]*?\`\`\``, 'gu'), '').trim();
}

export function parseContactToolCalls(text, allowedNames = []) {
  const allowed = new Set(
    (Array.isArray(allowedNames) ? allowedNames : [])
      .filter((name) => typeof name === 'string' && name.trim() && !DENIED_CODING_TOOLS.has(name.trim()))
      .map((name) => name.trim()),
  );
  const raw = typeof text === 'string' ? text : '';
  const chatText = stripContactToolFences(raw);
  const fence = raw.match(FENCE);
  if (fence?.[1]) {
    const toolCall = parseToolPayload(fence[1], allowed);
    if (toolCall) return { chatText, toolCall };
  }
  const trimmed = raw.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    const toolCall = parseToolPayload(trimmed, allowed);
    if (toolCall) return { chatText: '', toolCall };
  }
  const embedded = findEmbeddedToolCall(raw, allowed);
  if (embedded) return embedded;
  return { chatText, toolCall: null };
}

const isNegatedAt = (text, index) => INTENT_NEGATION.test(text.slice(Math.max(0, index - 12), index));

const hasAssignSessionIntent = (text) => {
  ASSIGN_SESSION_INTENT.lastIndex = 0;
  let match = ASSIGN_SESSION_INTENT.exec(text);
  while (match) {
    if (!isNegatedAt(text, match.index)) return true;
    match = ASSIGN_SESSION_INTENT.exec(text);
  }
  return false;
};

/** Which attached tools the user asked for in natural language. */
export function detectRequestedContactTools(userText, allowedNames = []) {
  const allowed = new Set(
    (Array.isArray(allowedNames) ? allowedNames : [])
      .filter((name) => typeof name === 'string' && name.trim() && !DENIED_CODING_TOOLS.has(name.trim()))
      .map((name) => name.trim()),
  );
  const text = typeof userText === 'string' ? userText : '';
  const requested = [];
  if (allowed.has(NEW_CONVERSATION_TOOL_NAME) && NEW_CONVERSATION_INTENT.test(text)) {
    requested.push(NEW_CONVERSATION_TOOL_NAME);
  }
  if (allowed.has(CREATE_ASSISTANT_TOOL_NAME) && CREATE_ASSISTANT_INTENT.test(text)) {
    requested.push(CREATE_ASSISTANT_TOOL_NAME);
  }
  if (allowed.has(SCHEDULE_TASK_TOOL_NAME) && SCHEDULE_TASK_INTENT.test(text)) {
    requested.push(SCHEDULE_TASK_TOOL_NAME);
  }
  if (allowed.has(ASSIGN_SESSION_TOOL_NAME) && hasAssignSessionIntent(text)) {
    requested.push(ASSIGN_SESSION_TOOL_NAME);
  }
  if (allowed.has(MESSAGE_ASSISTANT_TOOL_NAME) && MESSAGE_ASSISTANT_INTENT.test(text)) {
    requested.push(MESSAGE_ASSISTANT_TOOL_NAME);
  }
  return requested;
}

export function contactTurnHasToolResult(messages) {
  return (Array.isArray(messages) ? messages : []).some((message) => message?.role === 'toolResult');
}

const trim = (value, max = 10_000) => {
  if (typeof value !== 'string') return null;
  const next = value.trim();
  if (!next || next.length > max) return null;
  return next;
};

/** Resolve OpenCode provider/model from tool args or the current contact. */
export function resolveContactProviderModel(params = {}, fallback = {}) {
  const providerID = trim(params.providerID, 256);
  const modelID = trim(params.modelID, 256);
  if (providerID && modelID) return { providerID, modelID };
  const combined = trim(params.model, 512);
  if (combined && combined.includes('/')) {
    const slash = combined.indexOf('/');
    const fromModel = {
      providerID: combined.slice(0, slash).trim(),
      modelID: combined.slice(slash + 1).trim(),
    };
    if (fromModel.providerID && fromModel.modelID) return fromModel;
  }
  const fallbackProvider = trim(fallback.providerID, 256);
  const fallbackModel = trim(fallback.modelID, 256);
  if (fallbackProvider && fallbackModel) return { providerID: fallbackProvider, modelID: fallbackModel };
  return null;
}

const assistantIdentity = (assistant) => assistant?.id || assistant?.assistantID || null;

/** Resolve a live peer by id or display name. */
export function resolvePeerAssistant(params = {}, assistants = [], currentAssistant = {}) {
  const toAssistantID = trim(params.toAssistantID, 256);
  const toName = trim(params.to, 256) || trim(params.name, 256);
  const list = Array.isArray(assistants) ? assistants : [];
  const currentID = assistantIdentity(currentAssistant);
  if (toAssistantID) {
    const match = list.find((item) => assistantIdentity(item) === toAssistantID);
    if (!match) {
      throw new AssignError('not_found', 'No assistant with that id is available.');
    }
    if (assistantIdentity(match) === currentID) {
      throw new AssignError('validation_error', 'Cannot message this same assistant.');
    }
    return match;
  }
  if (!toName) {
    throw new AssignError('validation_error', 'message_assistant requires a recipient name or toAssistantID.');
  }
  const matches = list.filter((item) => {
    const name = typeof item?.name === 'string' ? item.name.trim() : '';
    return name === toName || name.toLowerCase() === toName.toLowerCase();
  });
  if (matches.length === 0) {
    throw new AssignError('not_found', `No assistant named ${toName} is available.`);
  }
  if (matches.length > 1) {
    throw new AssignError('validation_error', `Several assistants are named ${toName}; use toAssistantID.`);
  }
  if (assistantIdentity(matches[0]) === currentID) {
    throw new AssignError('validation_error', 'Cannot message this same assistant.');
  }
  return matches[0];
}

export function formatContactToolsPrompt(tools) {
  const list = Array.isArray(tools) ? tools.filter((tool) => tool?.name && !DENIED_CODING_TOOLS.has(tool.name)) : [];
  if (list.length === 0) return '';
  return [
    'The user talks in natural language (including Chinese). Never ask them to type slash commands.',
    'When they want a fresh contact chat (开新对话 / new conversation / clear chat), call new_conversation. That clears this contact transcript only. It is not OpenCode session/new and does not open a coding session.',
    'When they want another assistant (建助理 / create an assistant), call create_assistant.',
    'When they want coding work or a Chat session (建会话 / open a session / write a file), call assign_session.',
    'When they want a scheduled task (排定时任务 / schedule daily ping), call schedule_task.',
    'When they want to tell another assistant (给 PeerQA 说一声 / message PeerQA), call message_assistant.',
    `Call exactly one tool per reply by emitting one fenced JSON block:`,
    `\`\`\`${CONTACT_TOOL_FENCE}`,
    `{"name":"${NEW_CONVERSATION_TOOL_NAME}","arguments":{}}`,
    '```',
    `\`\`\`${CONTACT_TOOL_FENCE}`,
    `{"name":"${CREATE_ASSISTANT_TOOL_NAME}","arguments":{"name":"FlowQA","model":"opencode-go/deepseek-v4-flash"}}`,
    '```',
    `\`\`\`${CONTACT_TOOL_FENCE}`,
    `{"name":"${SCHEDULE_TASK_TOOL_NAME}","arguments":{"name":"Daily ping","prompt":"ping","time":"18:00","timezone":"Asia/Shanghai"}}`,
    '```',
    `\`\`\`${CONTACT_TOOL_FENCE}`,
    `{"name":"${MESSAGE_ASSISTANT_TOOL_NAME}","arguments":{"to":"PeerQA","text":"hello-from-assistant 写好了"}}`,
    '```',
    `\`\`\`${CONTACT_TOOL_FENCE}`,
    `{"name":"${ASSIGN_SESSION_TOOL_NAME}","arguments":{"prompt":"...","projectPath":"..."}}`,
    '```',
    'If the user asked for more than one of these, do them in that order across turns: new_conversation, then create_assistant, then schedule_task, then message_assistant, then assign_session.',
    'new_conversation deletes this contact\'s stored messages and watches. It never calls session/new or createNew.',
    'assign_session opens a real OpenChamber/OpenCode session on a registered project. You are not the worker.',
    'create_assistant reuses already-connected OpenCode providers (providerID/modelID). Mode is continuous.',
    'schedule_task writes the same payload as PUT /api/projects/:id/scheduled-tasks onto a registered project.',
    'message_assistant is read-only: it inserts into the other contact transcript. It never runs promptAsync or mutates sessions or files. Never assign through a peer message.',
    'A reply without the tool call does nothing — agreeing in Chinese (好的 / 我来创建 / 我去说一声) is not sending.',
    'Never say 已创建, 已发送, created, scheduled, opened, or sent unless the tool already returned success.',
    'If no registered project exists, tell the user to add one in Settings — do not use assistant-workspaces.',
    'After a successful tool, confirm in one short bubble. The user sees a contact card, not tool traces.',
    'Available OpenChamber tools:',
    ...list.map((tool) => `- ${tool.name}: ${tool.description || tool.label || tool.name}`),
  ].join('\n');
}

export function contactTurnHasSuccessfulReset(messages) {
  return (Array.isArray(messages) ? messages : []).some((message) => (
    message?.role === 'toolResult'
    && (message.toolName === NEW_CONVERSATION_TOOL_NAME || message.details?.reset === true)
    && !message.details?.error
  ));
}

/** After reset, keep only the short confirm — leftover pre-reset model text is discarded. */
export function confirmBubbleAfterContactReset(bubbles) {
  const list = (Array.isArray(bubbles) ? bubbles : [])
    .filter((item) => typeof item === 'string' && item.trim())
    .map((item) => item.trim());
  if (list.includes(NEW_CONVERSATION_CONFIRM_BUBBLE)) return [NEW_CONVERSATION_CONFIRM_BUBBLE];
  if (list.length > 0) return [list[0]];
  return [NEW_CONVERSATION_CONFIRM_BUBBLE];
}

export function extractContactCardsFromMessages(messages) {
  const cards = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message?.role !== 'toolResult') continue;
    const card = message.details?.card;
    if (card && typeof card === 'object') cards.push(card);
  }
  return cards;
}

const toolFailure = (error, fallbackCode, fallbackMessage) => {
  const code = error instanceof AssignError ? error.code : (error?.code || fallbackCode);
  const message = typeof error?.message === 'string' && error.message.trim()
    ? error.message.trim()
    : fallbackMessage;
  return {
    content: [{ type: 'text', text: message }],
    details: { error: code },
    terminate: true,
  };
};

export function createContactTools({
  assignWork,
  createAssistant,
  scheduleTask,
  deliverPeerMessage,
  resetContact,
  listAssistants,
  currentAssistant,
  onCard,
} = {}) {
  const emitCard = (card) => {
    if (typeof onCard === 'function') onCard(card);
  };

  return [
    {
      name: NEW_CONVERSATION_TOOL_NAME,
      label: 'New conversation',
      description: [
        'Clear this assistant contact transcript (messages, parts, and watches).',
        'Use when the user says 开新对话, new conversation, or clear chat.',
        'Does not call OpenCode session/new or create a worker session.',
      ].join(' '),
      parameters: newConversationParameters,
      execute: async () => {
        try {
          if (typeof resetContact !== 'function') {
            throw new AssignError('upstream_error', 'Resetting this conversation is unavailable.');
          }
          await resetContact();
          return {
            content: [{ type: 'text', text: NEW_CONVERSATION_CONFIRM_BUBBLE }],
            details: { reset: true },
            terminate: true,
          };
        } catch (error) {
          return toolFailure(error, 'new_conversation_failed', 'Could not start a new conversation.');
        }
      },
    },
    {
      name: CREATE_ASSISTANT_TOOL_NAME,
      label: 'Create assistant',
      description: [
        'Create another OpenChamber assistant contact (POST createAssistant).',
        'Requires a name. Reuse a connected OpenCode provider/model (providerID + modelID or model like opencode-go/deepseek-v4-flash).',
        'Mode is always continuous. Emits an assistant card that opens that contact.',
      ].join(' '),
      parameters: createAssistantParameters,
      execute: async (_toolCallId, params) => {
        try {
          if (typeof createAssistant !== 'function') {
            throw new AssignError('upstream_error', 'Creating an assistant is unavailable.');
          }
          const name = trim(params?.name, 256);
          if (!name) {
            throw new AssignError('validation_error', 'create_assistant requires a name.');
          }
          const model = resolveContactProviderModel(params, currentAssistant);
          if (!model) {
            throw new AssignError('no_provider', 'No connected OpenCode provider/model is available. Reuse a provider already configured in Settings.');
          }
          const created = await createAssistant({
            name,
            providerID: model.providerID,
            modelID: model.modelID,
            mode: 'continuous',
          });
          const card = createAssistantCardPart({
            assistantID: created.id || created.assistantID,
            name: created.name || name,
            providerID: created.providerID || model.providerID,
            modelID: created.modelID || model.modelID,
            mode: created.mode || 'continuous',
          });
          emitCard(card);
          return {
            content: [{ type: 'text', text: `Created assistant ${card.name}. The user will see an assistant card.` }],
            details: { card, assistant: created },
            terminate: false,
          };
        } catch (error) {
          return toolFailure(error, 'create_assistant_failed', 'Could not create that assistant.');
        }
      },
    },
    {
      name: SCHEDULE_TASK_TOOL_NAME,
      label: 'Schedule task',
      description: [
        'Create a scheduled task on a registered project (same payload as PUT /api/projects/:id/scheduled-tasks).',
        'Needs name, prompt, and a daily/weekly/once/cron schedule (time + timezone).',
        'Reuses this contact\'s provider/model unless the user named another connected model.',
        'Emits a schedule card.',
      ].join(' '),
      parameters: scheduleTaskParameters,
      execute: async (_toolCallId, params) => {
        try {
          if (typeof scheduleTask !== 'function') {
            throw new AssignError('upstream_error', 'Scheduling a task is unavailable.');
          }
          const name = trim(params?.name, 80);
          const prompt = trim(params?.prompt, 20_000);
          if (!name || !prompt) {
            throw new AssignError('validation_error', 'schedule_task requires a name and prompt.');
          }
          const model = resolveContactProviderModel(params, currentAssistant);
          if (!model) {
            throw new AssignError('no_provider', 'No connected OpenCode provider/model is available for the scheduled task.');
          }
          const scheduled = await scheduleTask({
            ...params,
            name,
            prompt,
            providerID: model.providerID,
            modelID: model.modelID,
          });
          const card = createScheduleCardPart({
            taskID: scheduled.taskID || scheduled.task?.id,
            projectID: scheduled.projectID,
            name: scheduled.name || scheduled.task?.name || name,
            kind: scheduled.kind || scheduled.task?.schedule?.kind,
            time: scheduled.time || scheduled.task?.schedule?.time || scheduled.task?.schedule?.times?.[0],
            timezone: scheduled.timezone || scheduled.task?.schedule?.timezone,
            prompt: scheduled.prompt || scheduled.task?.execution?.prompt || prompt,
          });
          emitCard(card);
          return {
            content: [{ type: 'text', text: `Scheduled ${card.name}. The user will see a schedule card.` }],
            details: { card, scheduled },
            terminate: false,
          };
        } catch (error) {
          const fallback = error?.code === 'project_required' ? PROJECT_REQUIRED_MESSAGE : 'Could not create that scheduled task.';
          return toolFailure(error, 'schedule_failed', fallback);
        }
      },
    },
    {
      name: MESSAGE_ASSISTANT_TOOL_NAME,
      label: 'Message assistant',
      description: [
        'Send a read-only peer message to another OpenChamber assistant contact.',
        'Resolve the recipient by display name (to/name) or toAssistantID.',
        'Inserts into their contact transcript only. Never promptAsync. Never mutates sessions or files.',
      ].join(' '),
      parameters: messageAssistantParameters,
      execute: async (_toolCallId, params) => {
        try {
          if (typeof deliverPeerMessage !== 'function') {
            throw new AssignError('upstream_error', 'Messaging another assistant is unavailable.');
          }
          const text = trim(params?.text, 20_000) || trim(params?.message, 20_000);
          if (!text) {
            throw new AssignError('validation_error', 'message_assistant requires text.');
          }
          const listed = typeof listAssistants === 'function' ? await listAssistants() : [];
          const recipient = resolvePeerAssistant(params, listed, currentAssistant);
          const toAssistantID = assistantIdentity(recipient);
          const delivered = await deliverPeerMessage({
            toAssistantID,
            text,
          });
          return {
            content: [{ type: 'text', text: `Sent to ${recipient.name}. They will see it in their contact.` }],
            details: { delivered, toAssistantID, toName: recipient.name, text },
            terminate: false,
          };
        } catch (error) {
          return toolFailure(error, 'message_assistant_failed', 'Could not message that assistant.');
        }
      },
    },
    {
      name: ASSIGN_SESSION_TOOL_NAME,
      label: 'Assign session',
      description: [
        'Open or reuse a real OpenChamber coding session on a registered project path',
        'and kick the prompt into that session. Optional existing worktree branch or sessionID.',
        'Never codes here. Never uses assistant-workspaces.',
      ].join(' '),
      parameters: assignParameters,
      execute: async (_toolCallId, params) => {
        try {
          if (typeof assignWork !== 'function') {
            throw new AssignError('upstream_error', 'Assign is unavailable.');
          }
          const assigned = await assignWork(params || {});
          const card = createSessionCardPart({
            sessionID: assigned.sessionID,
            directory: assigned.directory,
            title: assigned.title,
            status: assigned.status || 'busy',
            branch: assigned.branch,
          });
          emitCard(card);
          return {
            content: [{ type: 'text', text: `Opened coding session ${assigned.sessionID}. The user will see a session card.` }],
            details: { card, assigned },
            terminate: false,
          };
        } catch (error) {
          return toolFailure(error, 'assign_failed', 'Could not assign a coding session.');
        }
      },
    },
  ];
}
