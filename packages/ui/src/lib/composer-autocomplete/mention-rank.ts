/** Shared title tiers; recency is only a tie-breaker, never a relevance boost. */
export const scoreMentionTitle = (query: string, title: string, fuzzyScore: number): number => {
  const normalizedTitle = title.replace(/^@/, '').toLowerCase();
  const normalizedQuery = query.toLowerCase();
  if (normalizedTitle === normalizedQuery) return 5;
  if (normalizedTitle.startsWith(normalizedQuery)) return 4 + fuzzyScore;
  if (normalizedTitle.includes(normalizedQuery)) return 3 + fuzzyScore;
  return fuzzyScore >= 0.5 ? 1 + fuzzyScore : 0;
};

export const scoreSessionMentionId = (query: string, id: string): number => (
  id.toLowerCase().includes(query.toLowerCase()) ? 0.5 : 0
);
