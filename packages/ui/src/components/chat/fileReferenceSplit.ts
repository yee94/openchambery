import { PARAGRAPH_PATH_TOKEN_RE } from './fileReferenceParser';
import { isLikelyFilePath } from './fileReferenceDecorate';

type FilePathTextSegment =
  | { kind: 'text'; value: string }
  | { kind: 'path'; value: string };

const skipUrlSchemePrefix = (text: string, index: number): boolean => {
  const prevTwo = index >= 2 ? text.slice(index - 2, index) : '';
  const prevChar = index >= 1 ? text.charAt(index - 1) : '';
  return prevChar === ':' || prevTwo === ':/';
};

/** Split ordinary prose so path tokens exist in the first React commit. */
export const splitParagraphPathTokens = (text: string): FilePathTextSegment[] => {
  if (!text.includes('/') || !text.includes('.')) {
    return [{ kind: 'text', value: text }];
  }

  PARAGRAPH_PATH_TOKEN_RE.lastIndex = 0;
  const segments: FilePathTextSegment[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null = PARAGRAPH_PATH_TOKEN_RE.exec(text);

  while (match) {
    const raw = match[0];
    if (!raw || skipUrlSchemePrefix(text, match.index) || !isLikelyFilePath(raw)) {
      match = PARAGRAPH_PATH_TOKEN_RE.exec(text);
      continue;
    }

    if (match.index > lastIndex) {
      segments.push({ kind: 'text', value: text.slice(lastIndex, match.index) });
    }
    segments.push({ kind: 'path', value: raw });
    lastIndex = match.index + raw.length;
    match = PARAGRAPH_PATH_TOKEN_RE.exec(text);
  }

  if (lastIndex === 0) {
    return [{ kind: 'text', value: text }];
  }
  if (lastIndex < text.length) {
    segments.push({ kind: 'text', value: text.slice(lastIndex) });
  }
  return segments;
};
