/**
 * The authoritative answer to "are these two paths the same location?" and
 * "what is the canonical key for this directory?".
 *
 * Everything that compares, keys, or stores a path must come through here.
 * Hand-rolling `replace(/\\/g, '/')` at the call site is what produced roughly
 * a hundred slightly different conventions in this codebase, only a handful of
 * which handled Windows drive-letter case — so comparisons that were perfectly
 * consistent on macOS and Linux disagreed on Windows.
 *
 * Separator and drive-letter handling is delegated to `pathe`, which already
 * normalizes both (`c:\Users\x` → `C:/Users/x`) and additionally resolves `.`
 * and `..` segments and collapses duplicate slashes. `pathe` deliberately keeps
 * trailing slashes, so trimming those is ours.
 *
 * Windows `\\?\` device paths and UNC shares survive as `//?/C:/x` and
 * `//server/share`; only the leading drive letter is case-folded, so tokens
 * like `abc:def` and a `c:` appearing mid-path are left alone.
 */

import { normalize } from "pathe";

/** True when the input is nothing but separators (`/`, `//`, `\\`, …). */
const isSeparatorOnly = (value: string): boolean => /^[\\/]+$/.test(value);

/**
 * Normalize a path for comparison or display.
 *
 * Returns null for non-strings, empty and whitespace-only input, and for
 * degenerate separator-only input longer than one character — those carry no
 * location and must not be mistaken for the filesystem root. A single
 * separator is the root and normalizes to "/".
 */
export const normalizePath = (value?: string | null): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (isSeparatorOnly(trimmed)) {
    return trimmed.length === 1 ? "/" : null;
  }

  const normalized = normalize(trimmed);
  if (normalized === "/") return "/";

  const stripped = normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
  return stripped || null;
};

/**
 * Canonical identity key for a directory.
 *
 * Unlike `normalizePath` this is total: a directory being tracked always needs
 * *some* key, so unusable input degrades to its trimmed self rather than
 * vanishing and silently merging every such directory into one bucket. Use this
 * for map keys, cache buckets and ownership comparisons; use `normalizePath`
 * when a nullable, display-oriented result is what you want.
 *
 * Note this does not case-fold beyond the drive letter. Two spellings that
 * differ only by the case of a directory *name* remain distinct keys, because
 * that distinction is real on case-sensitive filesystems.
 */
export const normalizeDirectoryKey = (value?: string | null): string => {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  return normalizePath(trimmed) ?? trimmed;
};

/** True when both inputs name the same location. Empty/unusable never matches. */
export const arePathsEquivalent = (
  left?: string | null,
  right?: string | null,
): boolean => {
  const a = normalizePath(left);
  const b = normalizePath(right);
  return a !== null && a === b;
};
