import {
  BLOCK_PATH_TOKEN_RE,
  PARAGRAPH_PATH_TOKEN_RE,
  isLikelyFileReferencePath,
  parseFileReference,
} from './fileReferenceParser';

export const BLOCK_PATH_TOKEN_ATTR = 'data-openchamber-block-path-token';
export const BLOCK_PATH_TOKEN_SELECTOR = `[${BLOCK_PATH_TOKEN_ATTR}]`;
export const FILE_LINK_ATTR = 'data-openchamber-file-link';
export const FILE_LINK_SELECTOR = `[${FILE_LINK_ATTR}="true"]`;
export const FILE_LINK_PRESERVE_ATTRS = [
  FILE_LINK_ATTR,
  'data-openchamber-file-ref',
  'data-openchamber-file-path',
  'data-openchamber-file-binary',
  'title',
  'role',
  'tabindex',
] as const;

const CODE_BLOCK_PATH_SCANNED_ATTR = 'data-openchamber-block-paths-scanned';
const PARAGRAPH_BLOCK_PATH_SCANNED_ATTR = 'data-openchamber-paragraph-paths-scanned';
const PARAGRAPH_SCAN_EXCLUDE_SELECTOR = `pre, code, a, script, style, button, [${FILE_LINK_ATTR}], ${BLOCK_PATH_TOKEN_SELECTOR}`;
const MAX_BLOCK_CODE_SCAN_LENGTH = 200_000;

export const isLikelyFilePath = (value: string): boolean => {
  const parsed = parseFileReference(value);
  if (!parsed) {
    return false;
  }
  return isLikelyFileReferencePath(parsed.path);
};

const findTextPosition = (textNodes: Text[], targetOffset: number): { node: Text; offset: number } | null => {
  let currentOffset = 0;

  for (const node of textNodes) {
    const nextOffset = currentOffset + node.data.length;
    if (targetOffset <= nextOffset) {
      return { node, offset: Math.max(0, targetOffset - currentOffset) };
    }
    currentOffset = nextOffset;
  }

  const lastNode = textNodes.at(-1);
  return lastNode ? { node: lastNode, offset: lastNode.data.length } : null;
};

const wrapBlockCodePathTokens = (container: HTMLElement): void => {
  const codeBlocks = container.querySelectorAll<HTMLElement>('pre code');
  if (codeBlocks.length === 0) {
    return;
  }

  const doc = container.ownerDocument;
  if (!doc) {
    return;
  }

  for (const codeBlock of Array.from(codeBlocks)) {
    if (codeBlock.getAttribute(CODE_BLOCK_PATH_SCANNED_ATTR) === 'true') {
      continue;
    }

    if ((codeBlock.textContent ?? '').length > MAX_BLOCK_CODE_SCAN_LENGTH) {
      codeBlock.setAttribute(CODE_BLOCK_PATH_SCANNED_ATTR, 'true');
      continue;
    }

    const walker = doc.createTreeWalker(codeBlock, NodeFilter.SHOW_TEXT);
    const textNodes: Text[] = [];
    let currentNode = walker.nextNode();
    while (currentNode) {
      textNodes.push(currentNode as Text);
      currentNode = walker.nextNode();
    }

    const fullText = codeBlock.textContent ?? '';
    if (!fullText.includes('.')) {
      codeBlock.setAttribute(CODE_BLOCK_PATH_SCANNED_ATTR, 'true');
      continue;
    }

    BLOCK_PATH_TOKEN_RE.lastIndex = 0;
    const matches: Array<{ start: number; end: number; raw: string }> = [];
    let match: RegExpExecArray | null = BLOCK_PATH_TOKEN_RE.exec(fullText);
    while (match) {
      const raw = match[0];
      if (raw && isLikelyFilePath(raw)) {
        matches.push({ start: match.index, end: match.index + raw.length, raw });
      }
      match = BLOCK_PATH_TOKEN_RE.exec(fullText);
    }

    for (const { start, end, raw } of matches.reverse()) {
      const startPosition = findTextPosition(textNodes, start);
      const endPosition = findTextPosition(textNodes, end);
      if (!startPosition || !endPosition) {
        continue;
      }

      const range = doc.createRange();
      range.setStart(startPosition.node, startPosition.offset);
      range.setEnd(endPosition.node, endPosition.offset);

      const span = doc.createElement('span');
      span.setAttribute(BLOCK_PATH_TOKEN_ATTR, 'true');
      span.textContent = raw;

      range.deleteContents();
      range.insertNode(span);
    }

    codeBlock.setAttribute(CODE_BLOCK_PATH_SCANNED_ATTR, 'true');
  }
};

const wrapParagraphPathTokens = (container: HTMLElement): void => {
  const doc = container.ownerDocument;
  if (!doc) {
    return;
  }

  const blockContainers = container.querySelectorAll<HTMLElement>(
    'p, li, blockquote, h1, h2, h3, h4, h5, h6, td, th',
  );
  if (blockContainers.length === 0) {
    return;
  }

  for (const block of Array.from(blockContainers)) {
    if (block.getAttribute(PARAGRAPH_BLOCK_PATH_SCANNED_ATTR) === 'true') {
      continue;
    }
    if (block.closest(PARAGRAPH_SCAN_EXCLUDE_SELECTOR)) {
      block.setAttribute(PARAGRAPH_BLOCK_PATH_SCANNED_ATTR, 'true');
      continue;
    }

    const walker = doc.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        const parent = node.parentElement;
        if (!parent) {
          return NodeFilter.FILTER_REJECT;
        }
        if (parent.closest(PARAGRAPH_SCAN_EXCLUDE_SELECTOR)) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    const textNodes: Text[] = [];
    let currentNode = walker.nextNode();
    while (currentNode) {
      textNodes.push(currentNode as Text);
      currentNode = walker.nextNode();
    }

    if (textNodes.length === 0) {
      block.setAttribute(PARAGRAPH_BLOCK_PATH_SCANNED_ATTR, 'true');
      continue;
    }

    const fullText = textNodes.map((node) => node.data).join('');
    if (!fullText.includes('/') || !fullText.includes('.')) {
      block.setAttribute(PARAGRAPH_BLOCK_PATH_SCANNED_ATTR, 'true');
      continue;
    }

    PARAGRAPH_PATH_TOKEN_RE.lastIndex = 0;
    const matches: Array<{ start: number; end: number; raw: string }> = [];
    let match: RegExpExecArray | null = PARAGRAPH_PATH_TOKEN_RE.exec(fullText);
    while (match) {
      const raw = match[0];
      if (!raw) {
        match = PARAGRAPH_PATH_TOKEN_RE.exec(fullText);
        continue;
      }

      const prevTwo = match.index >= 2 ? fullText.slice(match.index - 2, match.index) : '';
      const prevChar = match.index >= 1 ? fullText.charAt(match.index - 1) : '';
      if (prevChar === ':' || prevTwo === ':/') {
        match = PARAGRAPH_PATH_TOKEN_RE.exec(fullText);
        continue;
      }

      if (isLikelyFilePath(raw)) {
        matches.push({ start: match.index, end: match.index + raw.length, raw });
      }
      match = PARAGRAPH_PATH_TOKEN_RE.exec(fullText);
    }

    for (const { start, end, raw } of matches.reverse()) {
      const startPosition = findTextPosition(textNodes, start);
      const endPosition = findTextPosition(textNodes, end);
      if (!startPosition || !endPosition) {
        continue;
      }

      const range = doc.createRange();
      range.setStart(startPosition.node, startPosition.offset);
      range.setEnd(endPosition.node, endPosition.offset);

      const span = doc.createElement('span');
      span.setAttribute(BLOCK_PATH_TOKEN_ATTR, 'true');
      span.textContent = raw;

      range.deleteContents();
      range.insertNode(span);
    }

    block.setAttribute(PARAGRAPH_BLOCK_PATH_SCANNED_ATTR, 'true');
  }
};

/** Wrap path-like tokens in freshly decorated markdown so Morphdom owns the structure. */
export const wrapMarkdownFileReferenceTokens = (container: HTMLElement): void => {
  wrapBlockCodePathTokens(container);
  wrapParagraphPathTokens(container);
};

export const copyPreservedFileLinkAttributes = (fromEl: Element, toEl: Element): void => {
  if (fromEl.getAttribute(FILE_LINK_ATTR) !== 'true') {
    return;
  }
  const fromRef = (fromEl.getAttribute('data-openchamber-file-ref') || fromEl.textContent || '').trim();
  const toRef = (toEl.textContent || '').trim();
  if (!fromRef || fromRef !== toRef) {
    return;
  }
  for (const attribute of FILE_LINK_PRESERVE_ATTRS) {
    const value = fromEl.getAttribute(attribute);
    if (value === null) toEl.removeAttribute(attribute);
    else toEl.setAttribute(attribute, value);
  }
};
