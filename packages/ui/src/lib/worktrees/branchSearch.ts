import { scoreByFuzzyQuery } from "@/lib/search/fuzzySearch";

export interface RankedBranchGroups {
  matching: Array<{
    label: string;
    value: string;
    source: 'local' | 'remote';
  }>;
  otherLocal: string[];
  otherRemote: string[];
}

export function rankBranchesForQuery(args: {
  localBranches: string[];
  remoteBranches: string[];
  query: string;
}): RankedBranchGroups {
  const { localBranches, remoteBranches, query } = args;
  const normalizedQuery = query.trim();

  if (!normalizedQuery) {
    return {
      matching: [],
      otherLocal: localBranches,
      otherRemote: remoteBranches,
    };
  }

  const localScored = scoreByFuzzyQuery(localBranches, normalizedQuery, (branch) => branch);
  const remoteScored = scoreByFuzzyQuery(remoteBranches, normalizedQuery, (branch) => branch);

  const localMatched = new Set(localScored.map((entry) => entry.item));
  const remoteMatched = new Set(remoteScored.map((entry) => entry.item));

  const matching = [
    ...localScored.map((entry) => ({
      label: entry.item,
      value: entry.item,
      source: 'local' as const,
      score: entry.score,
    })),
    ...remoteScored.map((entry) => ({
      label: entry.item,
      value: `remotes/${entry.item}`,
      source: 'remote' as const,
      score: entry.score,
    })),
  ]
    .sort((a, b) => {
      if (a.score !== b.score) {
        return a.score - b.score;
      }
      // Prefer local branches when relevance ties.
      if (a.source !== b.source) {
        return a.source === 'local' ? -1 : 1;
      }
      if (a.label.length !== b.label.length) {
        return a.label.length - b.label.length;
      }
      return a.label.localeCompare(b.label, undefined, { sensitivity: 'accent' });
    })
    .map(({ label, value, source }) => ({ label, value, source }));

  return {
    matching,
    otherLocal: localBranches.filter((branch) => !localMatched.has(branch)),
    otherRemote: remoteBranches.filter((branch) => !remoteMatched.has(branch)),
  };
}
