import { scoreByFuzzyQuery } from '@/lib/search/fuzzySearch';

export type RankableSkill = {
  name: string;
  description?: string;
  scope?: string;
};

export const rankSkillsForQuery = <T extends RankableSkill>(
  skills: readonly T[],
  searchQuery: string,
): T[] => {
  const normalizedQuery = searchQuery.trim();
  if (!normalizedQuery.length) {
    return [...skills].sort((left, right) => {
      if (left.scope === 'project' && right.scope !== 'project') return -1;
      if (left.scope !== 'project' && right.scope === 'project') return 1;
      return left.name.localeCompare(right.name);
    });
  }

  const ranked = scoreByFuzzyQuery(
    [...skills],
    normalizedQuery,
    (skill) => [skill.name, skill.description ?? ''],
  );
  ranked.sort((left, right) => {
    if (left.score !== right.score) return left.score - right.score;
    if (left.item.scope === 'project' && right.item.scope !== 'project') return -1;
    if (left.item.scope !== 'project' && right.item.scope === 'project') return 1;
    return left.item.name.localeCompare(right.item.name);
  });
  return ranked.map((entry) => entry.item);
};
