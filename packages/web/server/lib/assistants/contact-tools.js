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
const CONTACT_TOOL_FENCE = 'openchamber-tool';
export const ASSIGNED_SESSION_FALLBACK_BUBBLE = 'Opened a coding session.';

const DENIED_CODING_TOOLS = new Set(['bash', 'edit', 'read', 'write', 'glob', 'grep', 'shell']);

const FENCE = new RegExp(`\`\`\`${CONTACT_TOOL_FENCE}\\s*([\\s\\S]*?)\`\`\``, 'u');

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
  return { chatText, toolCall: null };
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

export function formatContactToolsPrompt(tools) {
  const list = Array.isArray(tools) ? tools.filter((tool) => tool?.name && !DENIED_CODING_TOOLS.has(tool.name)) : [];
  if (list.length === 0) return '';
  return [
    'The user talks in natural language (including Chinese). Never ask them to type slash commands.',
    'When they want another assistant (建助理 / create an assistant), call create_assistant.',
    'When they want coding work or a Chat session (建会话 / open a session / write a file), call assign_session.',
    'When they want a scheduled task (排定时任务 / schedule daily ping), call schedule_task.',
    `Call exactly one tool per reply by emitting one fenced JSON block:`,
    `\`\`\`${CONTACT_TOOL_FENCE}`,
    `{"name":"${CREATE_ASSISTANT_TOOL_NAME}","arguments":{"name":"FlowQA","model":"opencode-go/deepseek-v4-flash"}}`,
    '```',
    `\`\`\`${CONTACT_TOOL_FENCE}`,
    `{"name":"${SCHEDULE_TASK_TOOL_NAME}","arguments":{"name":"Daily ping","prompt":"ping","time":"18:00","timezone":"Asia/Shanghai"}}`,
    '```',
    `\`\`\`${CONTACT_TOOL_FENCE}`,
    `{"name":"${ASSIGN_SESSION_TOOL_NAME}","arguments":{"prompt":"...","projectPath":"..."}}`,
    '```',
    'If the user asked for more than one of these, do them in that order across turns: create_assistant, then schedule_task, then assign_session.',
    'assign_session opens a real OpenChamber/OpenCode session on a registered project. You are not the worker.',
    'create_assistant reuses already-connected OpenCode providers (providerID/modelID). Mode is continuous.',
    'schedule_task writes the same payload as PUT /api/projects/:id/scheduled-tasks onto a registered project.',
    'Never emit bash, edit, read, write, or other coding tools. Never assign through a peer DM.',
    'If no registered project exists, tell the user to add one in Settings — do not use assistant-workspaces.',
    'After a successful tool, confirm in one short bubble. The user sees a contact card, not tool traces.',
    'Available OpenChamber tools:',
    ...list.map((tool) => `- ${tool.name}: ${tool.description || tool.label || tool.name}`),
  ].join('\n');
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
  currentAssistant,
  onCard,
} = {}) {
  const emitCard = (card) => {
    if (typeof onCard === 'function') onCard(card);
  };

  return [
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
