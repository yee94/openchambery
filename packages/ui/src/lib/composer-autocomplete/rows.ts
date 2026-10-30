import fuzzysort from 'fuzzysort';
import {
  resolveAgentMentionIconName,
  resolveFileMentionIconName,
  resolveSessionMentionIconName,
  resolveSkillIconName,
  resolveSlashCommandIconName,
} from './icons';
import type { ComposerAutocompleteListRow } from './types';
import { scoreMentionTitle, scoreSessionMentionId } from './mention-rank';

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
  for (const session of sessions) {
    rows.push({
      id: `session:${session.id}`,
      title: session.title || untitledSession,
      badge: sessionBadge,
      iconName: resolveSessionMentionIconName(),
    });
  }
  const query = searchQuery.trim();
  const sourceOrder = new Map(rows.map((row, index) => [row.id, index]));
  // Titles share relevance tiers; skill descriptions and session IDs are fallback recall.
  const rankCandidates = (candidates: readonly ComposerAutocompleteListRow[], limit: number) => fuzzysort.go(query, candidates, {
    keys: ['title', (row) => row.id.startsWith('skill:') ? row.subtitle ?? '' : '',
      (row) => row.id.startsWith('session:') ? row.id.slice('session:'.length) : ''],
    threshold: 0.5,
    limit,
    scoreFn: (result) => {
      const name = result[0];
      return Math.max(
        scoreMentionTitle(query, result.obj.title, name?.score ?? 0),
        result[1]?.score ?? 0,
        result.obj.id.startsWith('session:') ? scoreSessionMentionId(query, result.obj.id.slice('session:'.length)) : 0,
      );
    },
  });
  const matches = query ? [
    ...rankCandidates(rows.filter((row) => !row.id.startsWith('session:')), 10),
    ...rankCandidates(rows.filter((row) => row.id.startsWith('session:')), Infinity),
  ].sort((a, b) => b.score - a.score
    || (sourceOrder.get(a.obj.id) ?? 0) - (sourceOrder.get(b.obj.id) ?? 0))
    .map((result) => result.obj) : rows.slice();
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
  if (!query) {
    return [...matches.filter((row) => !row.id.startsWith('session:')), ...rows,
      ...matches.filter((row) => row.id.startsWith('session:'))];
  }
  let nonSessionCount = 0;
  return [...matches, ...rows].filter((row) => row.id.startsWith('session:') || nonSessionCount++ < 10);
};
