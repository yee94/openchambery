import {
  resolveAgentMentionIconName,
  resolveFileMentionIconName,
  resolveSessionMentionIconName,
  resolveSkillIconName,
  resolveSlashCommandIconName,
} from './icons';
import type { ComposerAutocompleteListRow } from './types';

export type SlashCommandRowSource = {
  id: string;
  name: string;
  description?: string;
  isBuiltIn?: boolean;
  isOpenChamber?: boolean;
  isSkill?: boolean;
  scope?: string;
  agent?: string;
};

export type SlashCommandRowLabels = {
  skill: string;
  command: string;
  system: string;
};

export const buildSlashCommandRows = (
  commands: readonly SlashCommandRowSource[],
  labels: SlashCommandRowLabels,
): ComposerAutocompleteListRow[] => commands.map((command) => {
  const badge = command.isSkill
    ? labels.skill
    : command.isOpenChamber
      ? 'OpenChamber'
      : command.isBuiltIn
        ? labels.system
        : command.scope || command.agent || labels.command;
  return {
    id: command.id,
    title: `/${command.name}`,
    subtitle: command.description,
    badge,
    iconName: resolveSlashCommandIconName(command),
  };
});

export type SkillRowSource = {
  name: string;
  scope: string;
  source?: string;
  description?: string;
};

export const buildSkillRows = (
  skills: readonly SkillRowSource[],
): ComposerAutocompleteListRow[] => skills.map((skill) => ({
  id: `${skill.name}-${skill.scope}`,
  title: skill.name,
  subtitle: skill.description,
  badge: skill.scope,
  iconName: resolveSkillIconName(),
}));

export type MentionAgentRowSource = {
  name: string;
  description?: string;
};

export type MentionSessionRowSource = {
  id: string;
  title?: string | null;
};

export type MentionPathRowSource = {
  path: string;
  name: string;
  relativePath?: string;
  isDirectory?: boolean;
  extension?: string | null;
};

export const buildMentionRows = ({
  agents,
  sessions,
  recentFiles,
  pathHits,
  untitledSession,
  sessionBadge,
}: {
  agents: readonly MentionAgentRowSource[];
  sessions: readonly MentionSessionRowSource[];
  recentFiles: readonly MentionPathRowSource[];
  pathHits: readonly MentionPathRowSource[];
  untitledSession: string;
  sessionBadge?: string;
}): ComposerAutocompleteListRow[] => {
  const rows: ComposerAutocompleteListRow[] = [];
  for (const agent of agents) {
    rows.push({
      id: `agent:${agent.name}`,
      title: `@${agent.name}`,
      subtitle: agent.description,
      iconName: resolveAgentMentionIconName(),
    });
  }
  for (const session of sessions) {
    rows.push({
      id: `session:${session.id}`,
      title: session.title || untitledSession,
      badge: sessionBadge,
      iconName: resolveSessionMentionIconName(),
    });
  }
  for (const file of recentFiles) {
    rows.push({
      id: `recent:${file.path}`,
      title: file.relativePath || file.name,
      iconName: resolveFileMentionIconName(file),
    });
  }
  for (const file of pathHits) {
    rows.push({
      id: `file:${file.path}`,
      title: file.relativePath || file.name,
      iconName: resolveFileMentionIconName(file),
    });
  }
  return rows;
};
