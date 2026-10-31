import type { UsageWindow } from '@/types/quota';

/**
 * Account label to show above `entries[index]`, or null. Labels only appear when the
 * entries span more than one account, so single-account providers render unchanged.
 */
export const accountHeadingAt = (entries: ReadonlyArray<[string, UsageWindow]>, index: number): string | null => {
  const name = entries[index]?.[1].accountName;
  if (!name) return null;
  if (index > 0 && entries[index - 1][1].accountName === name) return null;
  const distinct = new Set(entries.map(([, window]) => window.accountName).filter(Boolean));
  return distinct.size > 1 ? name : null;
};
