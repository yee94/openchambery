import fuzzysort from 'fuzzysort';
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
  isYuri?: boolean;
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
    : command.isYuri
      ? 'Yuri'
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
  skills = [],
  agents,
  sessions,
  recentFiles,
  pathHits,
  untitledSession,
  sessionBadge,
  skillBadge,
  searchQuery = '',
}: {
  skills?: readonly SkillRowSource[];
  agents: readonly MentionAgentRowSource[];
  sessions: readonly MentionSessionRowSource[];
  recentFiles: readonly MentionPathRowSource[];
  pathHits: readonly MentionPathRowSource[];
  untitledSession: string;
  sessionBadge?: string;
  skillBadge?: string;
  searchQuery?: string;
}): ComposerAutocompleteListRow[] => {
  const rows: ComposerAutocompleteListRow[] = [];
  for (const skill of skills) {
    rows.push({
      id: `skill:${skill.name}-${skill.scope}`,
      title: `@${skill.name}`,
      subtitle: skill.description,
      badge: skillBadge ?? skill.scope,
      iconName: resolveSkillIconName(),
    });
  }
  for (const agent of agents) {
    rows.push({
      id: `agent:${agent.name}`,
      title: `@${agent.name}`,
      subtitle: agent.description,
      iconName: resolveAgentMentionIconName(),
      agentName: agent.name,
    });
  }
  const query = searchQuery.trim();
  // Keep TUI name ranking; skill descriptions add a lower-priority recall tier.
  const matches = query ? fuzzysort.go(query, rows, {
    keys: ['title', (row) => row.id.startsWith('skill:') ? row.subtitle ?? '' : ''],
    threshold: 0.5,
    limit: 10,
    scoreFn: (result) => {
      const name = result[0];
      const nameScore = (name?.score ?? 0) * (name?.target.startsWith(`@${query}`) ? 2 : 1);
      return nameScore >= 0.5 ? 1 + nameScore : result[1]?.score ?? 0;
    },
  }).map((result) => result.obj) : rows.slice();
  rows.length = 0;
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
  for (const session of sessions) {
    rows.push({
      id: `session:${session.id}`,
      title: session.title || untitledSession,
      badge: sessionBadge,
      iconName: resolveSessionMentionIconName(),
    });
  }
  return query ? [...matches, ...rows].slice(0, 10) : [...matches, ...rows];
};
