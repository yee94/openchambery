import { describe, expect, test } from 'bun:test';
import katex from 'katex';
import { marked, type Tokens } from 'marked';

import { findDollarMathStart, matchDollarMath } from './markdownMath';

const dollarParser = marked.use({
  gfm: true,
  breaks: false,
  extensions: [{
    name: 'dollarMath',
    level: 'inline' as const,
    start: findDollarMathStart,
    tokenizer(src: string) {
      const match = matchDollarMath(src);
      if (!match) return undefined;
      return { type: 'dollarMath', raw: match.raw, text: match.text, display: match.display };
    },
    renderer(token: Tokens.Generic) {
      const math = token as Tokens.Generic & { text: string; raw: string; display: boolean };
      try {
        return katex.renderToString(math.text, { displayMode: math.display, throwOnError: false });
      } catch {
        return math.raw;
      }
    },
  }],
});

const parseDollars = (text: string): string => dollarParser.parse(text) as string;

describe('matchDollarMath', () => {
  test('pairs inline $I_m$ without treating nearby currency as math', () => {
    expect(matchDollarMath('$I_m$')).toEqual({ raw: '$I_m$', text: 'I_m', display: false });
    expect(matchDollarMath('$f_{sw,\\max}=127,\\text{kHz}$')).toEqual({
      raw: '$f_{sw,\\max}=127,\\text{kHz}$',
      text: 'f_{sw,\\max}=127,\\text{kHz}',
      display: false,
    });
    expect(matchDollarMath('$50')).toBeUndefined();
    expect(matchDollarMath('$ 680')).toBeUndefined();
    expect(matchDollarMath('$50M to $72M"')).toBeUndefined();
    expect(matchDollarMath('$20,000 and $30,000')).toBeUndefined();
    expect(matchDollarMath('$50 and current is $I_m$')).toBeUndefined();
    expect(matchDollarMath('$72M". US$ 680.')).toBeUndefined();
    expect(matchDollarMath('$2\\pi$')).toEqual({ raw: '$2\\pi$', text: '2\\pi', display: false });
    expect(matchDollarMath('$3x$')).toEqual({ raw: '$3x$', text: '3x', display: false });
  });

  test('stops at the first formula so a later $I_m$ can match on its own', () => {
    expect(matchDollarMath('$I_m$ 最小的点 ($f_{sw,\\max}=127$)')!.raw).toBe('$I_m$');
    expect(matchDollarMath('$I_m$ and $I_{oe}$')!.raw).toBe('$I_m$');
  });

  test('rejects spaced delimiters and a closer glued to a digit', () => {
    expect(matchDollarMath('$ x $')).toBeUndefined();
    expect(matchDollarMath('$x$1')).toBeUndefined();
  });

  test('keeps $$display$$ intact so it is not split into inline math', () => {
    expect(matchDollarMath('$$E=mc^2$$')).toEqual({
      raw: '$$E=mc^2$$',
      text: 'E=mc^2',
      display: true,
    });
    expect(matchDollarMath('$E=mc^2$$')).toBeUndefined();
    expect(matchDollarMath('$$\nI_r = 2.51\n$$')).toEqual({
      raw: '$$\nI_r = 2.51\n$$',
      text: '\nI_r = 2.51\n',
      display: true,
    });
  });

  test('skips an escaped dollar inside the formula', () => {
    expect(matchDollarMath('$a\\$b$')).toEqual({ raw: '$a\\$b$', text: 'a\\$b', display: false });
  });
});

describe('findDollarMathStart', () => {
  test('points at the next opener, skipping a dollar that is only currency spacing', () => {
    const sentence = 'ZVS 校核取的是 $I_m$ 最小的点';
    const start = findDollarMathStart(sentence) ?? -1;
    expect(sentence.slice(start, start + 5)).toBe('$I_m$');
    expect(findDollarMathStart('hello $$E=mc^2$$')).toBe(6);
    expect(findDollarMathStart('US$ 680')).toBeUndefined();
    expect(findDollarMathStart('cost $50')).toBe(5);
  });
});

describe('dollar math through marked', () => {
  test('renders the screenshot sentence as KaTeX, not leftover $I_m$ or emphasis', () => {
    const html = parseDollars(
      'ZVS 校核取的是 $I_m$ 最小的点 ($f_{sw,\\max}=127,\\text{kHz}$)',
    );
    expect(html).toContain('katex');
    expect(html).not.toContain('$I_m$');
    expect(html).not.toContain('$f_{sw');
    expect(html).not.toContain('<em>');
  });

  test('leaves currency and spaced dollars as text', () => {
    const html = parseDollars('The MOSFET costs $50 and the quote is "$50M to $72M". US$ 680.');
    expect(html).not.toContain('katex');
    expect(html).toContain('$50');
    expect(html).toContain('$50M to $72M');
    expect(html).toContain('US$ 680');
  });

  test('renders a later formula after currency in the same paragraph', () => {
    const html = parseDollars('The MOSFET costs $50 and current is $I_m$.');
    expect(html).toContain('katex');
    expect(html).toContain('$50');
    expect(html).not.toContain('$I_m$');
  });

  test('does not parse math inside a code span', () => {
    const html = parseDollars('use `$I_m$` in the report');
    expect(html).not.toContain('katex');
    expect(html).toContain('<code>$I_m$</code>');
  });
});
