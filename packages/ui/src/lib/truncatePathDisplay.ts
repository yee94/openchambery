export type TruncatedPathParts = {
  prefix: string;
  parent: string;
  stem: string;
  ext: string;
  name: string;
  leadingSlash: boolean;
};

const PATH_DISPLAY_TAIL_SEGMENTS = 2;

export function splitFileNameExt(fileName: string): { stem: string; ext: string } {
  const lastDot = fileName.lastIndexOf('.');
  if (lastDot <= 0 || lastDot === fileName.length - 1) {
    return { stem: fileName, ext: '' };
  }
  return {
    stem: fileName.slice(0, lastDot),
    ext: fileName.slice(lastDot),
  };
}

/** Keep the parent directory and filename (-2) as a pinned tail; prefix may truncate. */
export function splitTruncatedPath(
  path: string,
  keepTailSegments: number = PATH_DISPLAY_TAIL_SEGMENTS,
): TruncatedPathParts {
  const source = path ?? '';
  const leadingSlash = source.startsWith('/');
  const segments = source.split('/').filter(Boolean);

  if (segments.length === 0) {
    return {
      prefix: '',
      parent: '',
      stem: '',
      ext: '',
      name: '',
      leadingSlash,
    };
  }

  const name = segments[segments.length - 1] ?? '';
  const { stem, ext } = splitFileNameExt(name);
  const keepTail = Math.max(1, Math.floor(keepTailSegments));
  const parentCount = Math.min(segments.length - 1, keepTail - 1);
  const parentStart = segments.length - 1 - parentCount;
  const parent = parentCount > 0 ? segments.slice(parentStart, -1).join('/') : '';
  const prefixBody = segments.slice(0, parentStart).join('/');
  const prefix = prefixBody ? (leadingSlash ? `/${prefixBody}` : prefixBody) : '';

  return {
    prefix,
    parent,
    stem,
    ext,
    name,
    leadingSlash: leadingSlash && !prefix,
  };
}
