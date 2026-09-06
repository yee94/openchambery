export type HighlightSegment = {
  text: string;
  highlighted: boolean;
};

/** Split `text` into highlight segments for a case-insensitive substring query (1.19.3-beta.1). */
export const highlightTextSegments = (text: string, rawQuery: string): HighlightSegment[] => {
  const query = rawQuery.trim();
  if (!query || !text) return [{ text, highlighted: false }];

  const loweredText = text.toLowerCase();
  const loweredQuery = query.toLowerCase();
  const queryLength = loweredQuery.length;
  const parts: HighlightSegment[] = [];
  let cursor = 0;
  let matchIndex = loweredText.indexOf(loweredQuery, cursor);

  while (matchIndex !== -1) {
    if (matchIndex > cursor) {
      parts.push({ text: text.slice(cursor, matchIndex), highlighted: false });
    }
    parts.push({
      text: text.slice(matchIndex, matchIndex + queryLength),
      highlighted: true,
    });
    cursor = matchIndex + queryLength;
    matchIndex = loweredText.indexOf(loweredQuery, cursor);
  }

  if (cursor < text.length) {
    parts.push({ text: text.slice(cursor), highlighted: false });
  }

  return parts.length > 0 ? parts : [{ text, highlighted: false }];
};
