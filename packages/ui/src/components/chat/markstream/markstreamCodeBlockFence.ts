type CodeBlockNodeShape = {
  type?: string;
  language?: string;
  code?: string;
  raw?: string;
};

/** Opening fence line: optional indent + 3+ backticks or tildes (CommonMark). */
const FENCE_OPEN_LINE = /^[ \t]{0,3}(`{3,}|~{3,})/;

/**
 * True when `raw` already looks like a fenced source Marked can parse.
 * Do not trim: unclosed streaming bodies may end with significant whitespace.
 */
export const isUsableCodeBlockFenceRaw = (raw: string): boolean => {
  if (typeof raw !== 'string' || raw.length === 0) return false;
  const firstLine = raw.split(/\r?\n/, 1)[0] ?? '';
  return FENCE_OPEN_LINE.test(firstLine);
};

/**
 * Pick a fence run long enough that body lines containing ``` / ~~~ cannot
 * terminate the block. Prefer backticks; fall back to tildes when needed.
 */
export const pickCodeBlockFenceMarker = (code: string): string => {
  let maxBacktick = 0;
  let maxTilde = 0;
  const runs = code.match(/[`~]+/g) ?? [];
  for (const run of runs) {
    if (run[0] === '`') maxBacktick = Math.max(maxBacktick, run.length);
    else maxTilde = Math.max(maxTilde, run.length);
  }
  if (maxBacktick >= 3) {
    return '`'.repeat(Math.max(3, maxBacktick + 1));
  }
  if (maxTilde >= 3 && maxBacktick === 0) {
    // Body is tilde-heavy but has no backticks — backticks stay the safer rebuild.
    return '```';
  }
  if (maxTilde >= 3) {
    return '~'.repeat(Math.max(3, maxTilde + 1));
  }
  return '```';
};

/**
 * Rebuild a fenced source so marked+Shiki+morphdom can own the card chrome.
 * Prefer the parser's original `raw` when it is already a valid fence (indent,
 * longer runs, tilde markers, trailing body whitespace). Rebuild only when raw
 * is missing or not fence-shaped.
 */
export const fenceMarkdownFromCodeBlockNode = (node: CodeBlockNodeShape): string => {
  const raw = typeof node.raw === 'string' ? node.raw : '';
  if (isUsableCodeBlockFenceRaw(raw)) {
    return raw.endsWith('\n') ? raw : `${raw}\n`;
  }
  const language = (node.language ?? '').trim();
  const code = node.code ?? '';
  const marker = pickCodeBlockFenceMarker(code);
  const body = code.endsWith('\n') ? code : `${code}\n`;
  return `${marker}${language}\n${body}${marker}\n`;
};
