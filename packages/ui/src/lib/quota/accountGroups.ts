import type { UsageWindow } from '@/types/quota';

type AccountRef = { name: string };

/**
 * Tag each window with its owning account, derived from the `<account> · <window>` key
 * convention the host uses, so it works against any host version. Returns the same entries
 * when the provider has fewer than two accounts.
 */
export const tagWindowsWithAccount = (
  entries: Array<[string, UsageWindow]>,
  accounts: ReadonlyArray<AccountRef> | undefined,
): Array<[string, UsageWindow]> => {
  if (!accounts || accounts.length < 2) return entries;
  const names = accounts.map((account) => account.name).filter(Boolean).sort((a, b) => b.length - a.length);
  return entries.map(([key, window]) => {
    const name = names.find((candidate) => key.startsWith(`${candidate} · `));
    return name ? [key, { ...window, accountName: name }] : [key, window];
  });
};

/**
 * Account label to show above `windows[index]`, or null. Labels only appear when the
 * windows span more than one account, so single-account providers render unchanged.
 */
export const accountHeadingForWindows = (windows: ReadonlyArray<UsageWindow>, index: number): string | null => {
  const name = windows[index]?.accountName;
  if (!name) return null;
  if (index > 0 && windows[index - 1].accountName === name) return null;
  const distinct = new Set(windows.map((window) => window.accountName).filter(Boolean));
  return distinct.size > 1 ? name : null;
};

export const accountHeadingAt = (entries: ReadonlyArray<[string, UsageWindow]>, index: number): string | null =>
  accountHeadingForWindows(entries.map(([, window]) => window), index);
