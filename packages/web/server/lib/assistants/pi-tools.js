import os from 'node:os';
import path from 'node:path';
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  formatSkillsForSystemPrompt,
  loadSkills,
} from '@earendil-works/pi-agent-core';
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node';

const EXTERNAL_SKILL_ROOTS = Object.freeze(['.claude', '.agents']);

export const PI_CODING_TOOL_NAMES = Object.freeze(['read', 'write', 'edit', 'bash']);
const PI_CODING_TOOL_NAME_SET = new Set(PI_CODING_TOOL_NAMES);

export function isPiCodingToolName(name) {
  return typeof name === 'string' && PI_CODING_TOOL_NAME_SET.has(name);
}

export function resolveAssistantCwd(assistant) {
  for (const value of [assistant?.effectiveWorkspacePath, assistant?.workspacePath]) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

/** Global ~/.claude/skills + ~/.agents/skills, then this project cwd (.claude then .agents). Later dirs win on name. */
export function collectAssistantSkillDirectories(cwd, { homeDir = os.homedir() } = {}) {
  const dirs = [];
  const seen = new Set();
  const push = (dir) => {
    if (typeof dir !== 'string' || !dir.trim()) return;
    const resolved = path.resolve(dir);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    dirs.push(resolved);
  };
  const home = typeof homeDir === 'string' && homeDir.trim() ? path.resolve(homeDir.trim()) : os.homedir();
  for (const root of EXTERNAL_SKILL_ROOTS) {
    push(path.join(home, root, 'skills'));
  }
  if (typeof cwd === 'string' && cwd.trim()) {
    const project = path.resolve(cwd.trim());
    for (const root of EXTERNAL_SKILL_ROOTS) {
      push(path.join(project, root, 'skills'));
    }
  }
  return dirs;
}

export function mergeSkillsByName(skills) {
  const map = new Map();
  for (const skill of Array.isArray(skills) ? skills : []) {
    const name = typeof skill?.name === 'string' ? skill.name.trim() : '';
    if (!name) continue;
    map.set(name, skill);
  }
  return [...map.values()];
}

const bindHarnessTool = (tool, context) => ({
  name: tool.name,
  label: tool.label,
  description: tool.description,
  parameters: tool.parameters,
  execute: (toolCallId, params, signal, onUpdate) => (
    tool.execute(toolCallId, params, signal, onUpdate, context)
  ),
});

export function formatPiCodingPrompt({ cwd, skillsPrompt = '' } = {}) {
  if (typeof cwd !== 'string' || !cwd.trim()) return '';
  return [
    `Working directory: ${cwd}`,
    'You have pi coding tools in this directory: read, write, edit, bash.',
    'This is your working directory. Ignore any other cwd from the environment, including temporary generator workspaces under /var/folders or os.tmpdir.',
    'When the user asks pwd, the current directory, or to look at files, call bash/read yourself. Never say you have no terminal or cannot read or write files.',
    'Skills are merged from ~/.claude/skills, ~/.agents/skills, and this project\'s .claude/skills plus .agents/skills (project wins on name). Read a skill file when the task matches its description.',
    'Call these tools with the same fenced JSON as other tools:',
    '```openchamber-tool',
    '{"name":"bash","arguments":{"command":"pwd"}}',
    '```',
    '```openchamber-tool',
    '{"name":"read","arguments":{"path":".agents/skills/example/SKILL.md"}}',
    '```',
    typeof skillsPrompt === 'string' && skillsPrompt.trim() ? skillsPrompt.trim() : '',
  ].filter(Boolean).join('\n');
}

export async function createPiCodingRuntime(cwd, { homeDir = os.homedir() } = {}) {
  if (typeof cwd !== 'string' || !cwd.trim()) return null;
  const resolved = cwd.trim();
  const env = new NodeExecutionEnv({ cwd: resolved });
  const context = { env };
  const tools = [
    bindHarnessTool(createReadTool(), context),
    bindHarnessTool(createWriteTool(), context),
    bindHarnessTool(createEditTool(), context),
    bindHarnessTool(createBashTool(), context),
  ];
  let skillsPrompt = '';
  try {
    const loaded = await loadSkills(env, collectAssistantSkillDirectories(resolved, { homeDir }));
    skillsPrompt = formatSkillsForSystemPrompt(mergeSkillsByName(loaded?.skills));
  } catch {
    skillsPrompt = '';
  }
  return {
    cwd: resolved,
    tools,
    skillsPrompt,
    close: async () => {
      await env.cleanup();
    },
  };
}
