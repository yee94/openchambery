import React from 'react';

/**
 * Query match inside composer autocomplete rows.
 * Color only — do not add weight. `<mark>` must not introduce bold or a fill.
 */
export const AUTOCOMPLETE_QUERY_HIGHLIGHT_CLASS =
  'bg-transparent font-[inherit] text-[var(--primary-base)]';

export const highlightAutocompleteQuery = (text: string, query: string): React.ReactNode => {
  const needle = query.trim().toLowerCase();
  if (!needle) return text;
  const normalized = text.toLowerCase();
  if (!normalized.includes(needle)) return text;

  const parts: React.ReactNode[] = [];
  let cursor = 0;
  let match = normalized.indexOf(needle);
  while (match !== -1) {
    if (match > cursor) parts.push(text.slice(cursor, match));
    parts.push(
      <mark key={`${match}-${needle}`} className={AUTOCOMPLETE_QUERY_HIGHLIGHT_CLASS}>
        {text.slice(match, match + needle.length)}
      </mark>,
    );
    cursor = match + needle.length;
    match = normalized.indexOf(needle, cursor);
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
};
