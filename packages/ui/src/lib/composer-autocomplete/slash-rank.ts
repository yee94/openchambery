import { scoreByFuzzyQuery } from '@/lib/search/fuzzySearch';

export type RankableSlashCommand = {
  name: string;
  description?: string;
  isBuiltIn?: boolean;
};

export const rankCommandsForQuery = <T extends RankableSlashCommand>(
  commands: readonly T[],
  searchQuery: string,
): T[] => {
  const normalizedQuery = searchQuery.trim();
  if (!normalizedQuery) {
    return [...commands].sort((left, right) => {
      if (left.isBuiltIn !== right.isBuiltIn) {
        return left.isBuiltIn ? -1 : 1;
      }
      return left.name.localeCompare(right.name);
    });
  }

  const ranked = scoreByFuzzyQuery(
    [...commands],
    normalizedQuery,
    (command) => [command.name, command.description ?? ''],
  );
  ranked.sort((left, right) => {
    if (left.score !== right.score) {
      return left.score - right.score;
    }
    if (left.item.isBuiltIn !== right.item.isBuiltIn) {
      return left.item.isBuiltIn ? -1 : 1;
    }
    return left.item.name.localeCompare(right.item.name);
  });
  return ranked.map((entry) => entry.item);
};
