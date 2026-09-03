import { Type } from 'typebox';
import { AssignError, assignSession } from './assign.js';
import { createSessionCardPart } from './cards.js';

export const ASSIGN_SESSION_TOOL_NAME = 'assign_session';
export const CONTACT_TOOL_FENCE = 'openchamber-tool';
export const ASSIGNED_SESSION_FALLBACK_BUBBLE = 'Opened a coding session.';

const DENIED_CODING_TOOLS = new Set(['bash', 'edit', 'read', 'write', 'glob', 'grep', 'shell']);

const FENCE = new RegExp(`\`\`\`${CONTACT_TOOL_FENCE}\\s*([\\s\\S]*?)\`\`\``, 'u');

const assignParameters = Type.Object({
  prompt: Type.String({ description: 'Coding prompt to kick into the worker OpenCode session.' }),
  projectPath: Type.Optional(Type.String({ description: 'Registered project path. Required when more than one project exists.' })),
  directory: Type.Optional(Type.String({ description: 'Existing project or worktree directory to reuse.' })),
  branch: Type.Optional(Type.String({ description: 'Existing Chat worktree branch to reuse. Do not create a new worktree.' })),
  sessionID: Type.Optional(Type.String({ description: 'Existing OpenCode session to reuse instead of creating one.' })),
  title: Type.Optional(Type.String({ description: 'Optional title for the worker session and contact card.' })),
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

export function formatContactToolsPrompt(tools) {
  const list = Array.isArray(tools) ? tools.filter((tool) => tool?.name && !DENIED_CODING_TOOLS.has(tool.name)) : [];
  if (list.length === 0) return '';
  return [
    `When the user wants coding work done, call ${ASSIGN_SESSION_TOOL_NAME} by emitting exactly one fenced JSON block:`,
    `\`\`\`${CONTACT_TOOL_FENCE}`,
    `{"name":"${ASSIGN_SESSION_TOOL_NAME}","arguments":{"prompt":"...","projectPath":"..."}}`,
    '```',
    'That opens a real OpenChamber/OpenCode session on a registered project. You are not the worker.',
    'Never emit bash, edit, read, write, or other coding tools. Never assign through a peer DM.',
    'If no registered project exists, tell the user to add one in Settings — do not use assistant-workspaces.',
    'After a successful assign, confirm in one short bubble. The user sees a session card, not tool traces.',
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

export function createContactTools({ assignWork, onCard } = {}) {
  return [{
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
        });
        if (typeof onCard === 'function') onCard(card);
        return {
          content: [{ type: 'text', text: `Opened coding session ${assigned.sessionID}. The user will see a session card.` }],
          details: { card, assigned },
          terminate: true,
        };
      } catch (error) {
        const code = error instanceof AssignError ? error.code : (error?.code || 'assign_failed');
        const message = typeof error?.message === 'string' && error.message.trim()
          ? error.message.trim()
          : 'Could not assign a coding session.';
        return {
          content: [{ type: 'text', text: message }],
          details: { error: code },
          terminate: true,
        };
      }
    },
  }];
}

export { assignSession };
