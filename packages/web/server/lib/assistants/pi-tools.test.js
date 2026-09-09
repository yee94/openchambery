import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  collectAssistantSkillDirectories,
  createPiCodingRuntime,
  formatPiCodingPrompt,
  mergeSkillsByName,
  PI_CODING_TOOL_NAMES,
  resolveAssistantCwd,
} from './pi-tools.js';

const temps = [];
const temp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-pi-tools-'));
  temps.push(dir);
  return dir;
};
const writeSkill = (root, name, description = `${name} skill`) => {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\nInstructions for ${name}\n`);
};

afterEach(() => {
  while (temps.length > 0) {
    fs.rmSync(temps.pop(), { recursive: true, force: true });
  }
});

describe('resolveAssistantCwd', () => {
  it('prefers effectiveWorkspacePath over workspacePath', () => {
    expect(resolveAssistantCwd({
      effectiveWorkspacePath: '/effective',
      workspacePath: '/workspace',
    })).toBe('/effective');
    expect(resolveAssistantCwd({ workspacePath: '/workspace' })).toBe('/workspace');
    expect(resolveAssistantCwd({ defaultPrompt: 'x' })).toBeNull();
  });
});

describe('collectAssistantSkillDirectories', () => {
  it('lists global ~/.claude and ~/.agents then project .claude and .agents', () => {
    const home = temp();
    const cwd = temp();
    expect(collectAssistantSkillDirectories(cwd, { homeDir: home })).toEqual([
      path.resolve(home, '.claude', 'skills'),
      path.resolve(home, '.agents', 'skills'),
      path.resolve(cwd, '.claude', 'skills'),
      path.resolve(cwd, '.agents', 'skills'),
    ]);
  });

  it('does not invent skill roots on intermediate parent folders', () => {
    const home = temp();
    const root = temp();
    const nested = path.join(root, 'apps', 'web');
    fs.mkdirSync(nested, { recursive: true });
    expect(collectAssistantSkillDirectories(nested, { homeDir: home })).toEqual([
      path.resolve(home, '.claude', 'skills'),
      path.resolve(home, '.agents', 'skills'),
      path.resolve(nested, '.claude', 'skills'),
      path.resolve(nested, '.agents', 'skills'),
    ]);
  });
});

describe('mergeSkillsByName', () => {
  it('keeps the last skill with the same name', () => {
    expect(mergeSkillsByName([
      { name: 'shared', filePath: '/global' },
      { name: 'shared', filePath: '/project' },
      { name: 'other', filePath: '/other' },
    ])).toEqual([
      { name: 'shared', filePath: '/project' },
      { name: 'other', filePath: '/other' },
    ]);
  });
});

describe('formatPiCodingPrompt', () => {
  it('includes full pi tool argument schemas and distinguishes skills from tools', async () => {
    const cwd = temp();
    const home = temp();
    const runtime = await createPiCodingRuntime(cwd, { homeDir: home });
    const prompt = formatPiCodingPrompt({
      cwd: runtime.cwd,
      skillsPrompt: runtime.skillsPrompt,
      tools: runtime.tools,
    });
    expect(prompt).toContain('arguments schema:');
    expect(prompt).toContain('"path"');
    expect(prompt).toContain('"content"');
    expect(prompt).toContain('"edits"');
    expect(prompt).toContain('"oldText"');
    expect(prompt).toContain('"newText"');
    expect(prompt).toContain('"command"');
    expect(prompt).toContain('not OpenCode native tools and not MCP');
    expect(prompt).toContain('never invent skill or MCP tool names');
    expect(prompt).toContain('context7');
    await runtime.close();
  });
});

describe('createPiCodingRuntime', () => {
  it('installs read/write/edit/bash and merges global plus project skills', async () => {
    const home = temp();
    const cwd = temp();
    writeSkill(path.join(home, '.claude', 'skills'), 'claude-global', 'Claude global');
    writeSkill(path.join(home, '.agents', 'skills'), 'agents-global', 'Agents global');
    writeSkill(path.join(cwd, '.claude', 'skills'), 'claude-project', 'Claude project');
    writeSkill(path.join(cwd, '.agents', 'skills'), 'project-skill', 'Project skill');
    writeSkill(path.join(home, '.agents', 'skills'), 'shared', 'Global shared');
    writeSkill(path.join(cwd, '.agents', 'skills'), 'shared', 'Project shared');

    const runtime = await createPiCodingRuntime(cwd, { homeDir: home });
    expect(runtime.tools.map((tool) => tool.name)).toEqual([...PI_CODING_TOOL_NAMES]);
    expect(runtime.skillsPrompt).toContain('claude-global');
    expect(runtime.skillsPrompt).toContain('agents-global');
    expect(runtime.skillsPrompt).toContain('claude-project');
    expect(runtime.skillsPrompt).toContain('project-skill');
    expect(runtime.skillsPrompt).toContain('Project shared');
    expect(runtime.skillsPrompt).not.toContain('Global shared');
    await runtime.close();
  });

  it('runs bash pwd in the workspace', async () => {
    const cwd = temp();
    const home = temp();
    const runtime = await createPiCodingRuntime(cwd, { homeDir: home });
    const bash = runtime.tools.find((tool) => tool.name === 'bash');
    const result = await bash.execute('call_pwd', { command: 'pwd' });
    const text = result.content.map((part) => part.text).join('');
    const resolved = fs.realpathSync(cwd);
    expect(text.includes(cwd) || text.includes(resolved)).toBe(true);
    await runtime.close();
  });
});
