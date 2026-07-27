import Fuse from "fuse.js";

export interface FuzzySearchOptions {
  threshold?: number;
  distance?: number;
  ignoreLocation?: boolean;
  preferSubstring?: boolean;
}

const DEFAULT_FUZZY_OPTIONS: Required<FuzzySearchOptions> = {
  threshold: 0.4,
  distance: 100,
  ignoreLocation: true,
  preferSubstring: true,
};

const BOUNDARY_CHARS = new Set(["/", "-", "_", ".", " ", ":", "\\"]);

function normalizeSearchTexts(value: string | readonly string[] | null | undefined): string[] {
  if (value == null) {
    return [];
  }
  if (typeof value === "string") {
    return value ? [value] : [];
  }
  return value.filter((text): text is string => typeof text === "string" && text.length > 0);
}

/**
 * Lower score is better.
 * Tiers:
 *   exact equality      = -2
 *   prefix               ~ -1
 *   boundary substring   ~ 0
 *   mid-string substring ~ 0.5
 *   fuzzy                >= 1
 */
export function scoreTextAgainstQuery(text: string, query: string): number | null {
  if (!query) {
    return 0;
  }
  if (!text) {
    return null;
  }

  const lower = text.toLowerCase();
  const queryLower = query.toLowerCase();
  const idx = lower.indexOf(queryLower);

  if (idx < 0) {
    return null;
  }

  const lengthPenalty = (lower.length - queryLower.length) / 1e4;

  if (lower === queryLower) {
    return -2;
  }

  if (idx === 0) {
    return -1 + lengthPenalty;
  }

  const prev = lower[idx - 1] ?? "";
  const atBoundary = BOUNDARY_CHARS.has(prev);
  const tier = atBoundary ? 0 : 0.5;
  return tier + idx / 1e3 + lengthPenalty;
}

export function matchesFuzzyQuery(
  target: string,
  query: string,
  options?: FuzzySearchOptions
): boolean {
  if (!query) {
    return true;
  }
  if (!target) {
    return false;
  }

  const mergedOptions = { ...DEFAULT_FUZZY_OPTIONS, ...options };

  if (mergedOptions.preferSubstring && target.toLowerCase().includes(query.toLowerCase())) {
    return true;
  }

  const fuse = new Fuse([target], {
    threshold: mergedOptions.threshold,
    distance: mergedOptions.distance,
    ignoreLocation: mergedOptions.ignoreLocation,
  });

  return fuse.search(query).length > 0;
}

/**
 * Score-sorted fuzzy ranking. Strict (low threshold), prioritizes substring
 * matches (especially exact / prefix / boundary matches), and returns the top N.
 *
 * Use this for command-palette-style and searchable-picker ranking where order
 * matters more than recall. `getText` may return one string or several fields;
 * the best field score wins.
 */
export function scoreByFuzzyQuery<T>(
  items: T[],
  query: string,
  getText: (item: T) => string | readonly string[],
  options?: { limit?: number; threshold?: number; noFuzzy?: boolean },
): { item: T; score: number }[] {
  if (!query) {
    return items.map((item) => ({ item, score: 0 }));
  }
  const limit = options?.limit ?? items.length;
  const threshold = options?.threshold ?? 0.3;
  const noFuzzy = options?.noFuzzy ?? false;
  const queryLower = query.toLowerCase();

  const scored: { item: T; score: number; sortKey: string }[] = [];
  const fuzzyCandidates: { item: T; text: string; sortKey: string }[] = [];
  const substringMatched = new Set<T>();

  for (const item of items) {
    const texts = normalizeSearchTexts(getText(item));
    if (texts.length === 0) {
      continue;
    }

    let bestScore: number | null = null;
    let sortKey = texts[0]!.toLowerCase();

    for (const text of texts) {
      const lower = text.toLowerCase();
      const substringScore = scoreTextAgainstQuery(lower, queryLower);
      if (substringScore === null) {
        continue;
      }
      if (bestScore === null || substringScore < bestScore) {
        bestScore = substringScore;
        sortKey = lower;
      }
    }

    if (bestScore !== null) {
      scored.push({ item, score: bestScore, sortKey });
      substringMatched.add(item);
      continue;
    }

    if (!noFuzzy) {
      for (const text of texts) {
        fuzzyCandidates.push({ item, text, sortKey: texts[0]!.toLowerCase() });
      }
    }
  }

  if (fuzzyCandidates.length > 0) {
    const fuse = new Fuse(
      fuzzyCandidates.map((candidate) => candidate.text),
      {
        threshold,
        ignoreLocation: true,
        distance: 100,
        includeScore: true,
        minMatchCharLength: 2,
      },
    );
    const bestFuzzyByItem = new Map<T, { score: number; sortKey: string }>();
    for (const result of fuse.search(query)) {
      const candidate = fuzzyCandidates[result.refIndex];
      if (!candidate || substringMatched.has(candidate.item)) {
        continue;
      }
      // Keep fuzzy strictly worse than any substring tier.
      const score = 1 + (result.score ?? 1);
      const existing = bestFuzzyByItem.get(candidate.item);
      if (!existing || score < existing.score) {
        bestFuzzyByItem.set(candidate.item, { score, sortKey: candidate.sortKey });
      }
    }
    for (const [item, entry] of bestFuzzyByItem) {
      scored.push({ item, score: entry.score, sortKey: entry.sortKey });
    }
  }

  scored.sort((a, b) => {
    if (a.score !== b.score) {
      return a.score - b.score;
    }
    if (a.sortKey.length !== b.sortKey.length) {
      return a.sortKey.length - b.sortKey.length;
    }
    return a.sortKey.localeCompare(b.sortKey, undefined, { sensitivity: "accent" });
  });

  return scored.slice(0, limit).map(({ item, score }) => ({ item, score }));
}

/**
 * Partition items into relevance-ranked matches vs non-matches.
 * Matching order is score-sorted (exact / prefix / boundary before fuzzy).
 */
export function partitionByFuzzyQuery<T>(
  items: T[],
  query: string,
  getText: (item: T) => string | readonly string[],
  options?: FuzzySearchOptions & { noFuzzy?: boolean },
): { matching: T[]; other: T[] } {
  if (!query) {
    return { matching: items.slice(), other: [] };
  }

  const scored = scoreByFuzzyQuery(items, query, getText, {
    threshold: options?.threshold ?? DEFAULT_FUZZY_OPTIONS.threshold,
    noFuzzy: options?.noFuzzy ?? false,
  });
  const matchingSet = new Set(scored.map((entry) => entry.item));
  return {
    matching: scored.map((entry) => entry.item),
    other: items.filter((item) => !matchingSet.has(item)),
  };
}
