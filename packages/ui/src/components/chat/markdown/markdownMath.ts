// Currency-safe `$...$` / `$$...$$` pairing (Pandoc `tex_math_dollars`).
// Opening `$` must sit against a non-space; closing `$` must sit against a
// non-space and must not be followed by a digit — so `$20,000 and $30,000`
// and `"$50M to $72M"` stay currency. A space-prefixed `$` inside an inline
// attempt aborts the opener, otherwise `$50 and $I_m$` would swallow the
// money into the later formula. `$$...$$` is matched here too: marked's
// start() clips one character at a time, so leaving `$$` to post-process
// would turn `$$E=mc^2$$` into a stray `$` plus inline `$E=mc^2$`.

export type DollarMathMatch = {
  raw: string;
  text: string;
  display: boolean;
};

const isWhitespace = (ch: string | undefined): boolean => (
  ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r'
);

const isDigit = (ch: string | undefined): boolean => (
  ch !== undefined && ch >= '0' && ch <= '9'
);

// TeX / operator marks that a digit-leading span is actually math (`$2\pi$`,
// `$1+x$`) rather than money. Letters do not count: `$72M` and `$3x$` both
// have them.
const isMathMeta = (ch: string): boolean => (
  ch === '\\' || ch === '^' || ch === '_' || ch === '{' || ch === '}'
  || ch === '=' || ch === '+' || ch === '*' || ch === '/' || ch === '-'
);

const containsMathMeta = (text: string): boolean => {
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index];
    if (ch !== undefined && isMathMeta(ch)) return true;
  }
  return false;
};

// Quote / whitespace inside a digit-leading span is prose (`$72M". US$`),
// not a formula. `$3x$` and `$50$` have neither, so they still pair.
const hasProseNoise = (text: string): boolean => {
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index];
    if (ch === '"' || ch === "'" || isWhitespace(ch)) return true;
  }
  return false;
};

// Next `$` that can open math. Skip `$` followed by whitespace (not an
// inline opener); `$$` is always a display candidate.
export const findDollarMathStart = (src: string): number | undefined => {
  let from = 0;
  while (from < src.length) {
    const index = src.indexOf('$', from);
    if (index < 0) return undefined;
    const next = src[index + 1];
    if (next === '$' || (next !== undefined && !isWhitespace(next))) {
      return index;
    }
    from = index + 1;
  }
  return undefined;
};

export const matchDollarMath = (src: string): DollarMathMatch | undefined => {
  if (src[0] !== '$') return undefined;

  if (src[1] === '$') {
    const close = src.indexOf('$$', 2);
    if (close < 0) return undefined;
    return { raw: src.slice(0, close + 2), text: src.slice(2, close), display: true };
  }

  if (src.length < 3 || isWhitespace(src[1])) return undefined;

  for (let index = 1; index < src.length; index += 1) {
    const ch = src[index];
    if (ch === '\\') {
      index += 1;
      continue;
    }
    if (ch !== '$') continue;
    // Display delimiter inside an inline attempt — this opener is not `$...$`.
    if (src[index + 1] === '$') return undefined;
    // Space before `$` cannot close; abort so currency then math in the same
    // paragraph does not become one span.
    if (isWhitespace(src[index - 1])) return undefined;
    if (isDigit(src[index + 1])) continue;
    if (index === 1) return undefined;
    const text = src.slice(1, index);
    // `$72M". US$ 680`: digit-leading, no TeX, quote/space in the body.
    if (isDigit(src[1]) && !containsMathMeta(text) && hasProseNoise(text)) {
      return undefined;
    }
    return { raw: src.slice(0, index + 1), text, display: false };
  }
  return undefined;
};
