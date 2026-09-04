/// <reference lib="webworker" />

import { bundledLanguages, createHighlighter, type BundledLanguage, type ThemedToken } from 'shiki';
import { MARKDOWN_SHIKI_THEME, MARKDOWN_SHIKI_THEME_DEFINITION } from './markdownShikiThemeDefinition';
import type { MarkdownWorkerJobRequest, MarkdownWorkerRequest, MarkdownWorkerResponse } from './markdown-worker-protocol';
import { createMarkdownWorkerTaskQueue } from './markdown-worker-task-queue';
import {
  applyCodeHighlights,
  markdownBlockId,
  parseMarkdownUnsafe,
  streamBlocks,
} from './markdownParsePipeline';

// Shiki FontStyle bitmask (from @shikijs/types). Inlined to avoid an extra import.
const FONT_STYLE_ITALIC = 1;
const FONT_STYLE_BOLD = 2;
const FONT_STYLE_UNDERLINE = 4;

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

const tokenSpan = (token: ThemedToken): string => {
  const styles: string[] = [];
  if (token.color) styles.push(`color:${token.color}`);
  const fontStyle = token.fontStyle ?? 0;
  if (fontStyle & FONT_STYLE_ITALIC) styles.push('font-style:italic');
  if (fontStyle & FONT_STYLE_BOLD) styles.push('font-weight:bold');
  if (fontStyle & FONT_STYLE_UNDERLINE) styles.push('text-decoration:underline');
  const style = styles.length ? ` style="${styles.join(';')}"` : '';
  return `<span${style}>${escapeHtml(token.content)}</span>`;
};

// Single shared highlighter for the worker. Languages load lazily on demand.
let highlighter: ReturnType<typeof createHighlighter> | undefined;

const ensureHighlighter = (): ReturnType<typeof createHighlighter> => {
  highlighter ??= createHighlighter({
    // Cast: the theme is a CSS-variable TextMate theme; Shiki accepts the shape.
    themes: [MARKDOWN_SHIKI_THEME_DEFINITION as unknown as Parameters<typeof createHighlighter>[0]['themes'][number]],
    langs: [],
  });
  return highlighter;
};

const taskQueue = createMarkdownWorkerTaskQueue(async (request, isCancelled) => {
  if (request.type === 'highlight') {
    await highlight(request, isCancelled);
    return;
  }
  if (request.type === 'highlightTokens') {
    await highlightTokens(request, isCancelled);
    return;
  }
  if (request.type === 'parse') {
    await parseMarkdown(request, isCancelled);
    return;
  }
  await highlightLines(request, isCancelled);
});

self.onmessage = (event: MessageEvent<MarkdownWorkerRequest>) => {
  const request = event.data;
  if (request.type === 'init') {
    ensureHighlighter();
    return;
  }
  if (request.type === 'cancel') {
    taskQueue.cancel(request.id);
    return;
  }
  taskQueue.enqueue(request);
};

type Instance = Awaited<ReturnType<typeof createHighlighter>>;

const resolveLanguage = async (
  instance: Instance,
  requested: string,
  isCancelled: () => boolean,
): Promise<string | null> => {
  if (isCancelled()) return null;
  let lang = requested in bundledLanguages ? requested : 'text';
  if (lang !== 'text' && !instance.getLoadedLanguages().includes(lang)) {
    try {
      await instance.loadLanguage(bundledLanguages[lang as BundledLanguage]);
    } catch {
      lang = 'text';
    }
  }
  if (isCancelled()) return null;
  return lang;
};

async function highlight(
  request: Extract<MarkdownWorkerJobRequest, { type: 'highlight' }>,
  isCancelled: () => boolean,
): Promise<void> {
  try {
    if (isCancelled()) return;
    const instance = await ensureHighlighter();
    const lang = await resolveLanguage(instance, request.lang, isCancelled);
    if (lang === null || isCancelled()) return;
    const html = instance.codeToHtml(request.code, {
      lang,
      theme: MARKDOWN_SHIKI_THEME,
      tabindex: false,
    });
    if (isCancelled()) return;
    post({ type: 'highlight', id: request.id, html });
  } catch (error) {
    if (isCancelled()) return;
    post({ type: 'error', id: request.id, message: error instanceof Error ? error.message : String(error) });
  }
}

async function highlightTokens(
  request: Extract<MarkdownWorkerJobRequest, { type: 'highlightTokens' }>,
  isCancelled: () => boolean,
): Promise<void> {
  try {
    if (isCancelled()) return;
    const instance = await ensureHighlighter();
    if (isCancelled()) return;
    if (request.theme && !instance.getLoadedThemes().includes(request.themeName)) {
      // Cast: a resolved TextMate theme object from the app theme registry.
      await instance.loadTheme(request.theme as Parameters<typeof instance.loadTheme>[0]);
    }
    const lang = await resolveLanguage(instance, request.lang, isCancelled);
    if (lang === null || isCancelled()) return;
    const { tokens } = instance.codeToTokens(request.code, {
      lang: lang as BundledLanguage,
      theme: request.themeName,
    });
    if (isCancelled()) return;
    const lines = tokens.map((line) =>
      line.map((token) => [token.content.length, token.color ?? '', token.fontStyle ?? 0] as [number, string, number]),
    );
    post({ type: 'highlightTokens', id: request.id, lines });
  } catch (error) {
    if (isCancelled()) return;
    post({ type: 'error', id: request.id, message: error instanceof Error ? error.message : String(error) });
  }
}

async function highlightCodeLocal(
  code: string,
  lang: string,
  isCancelled: () => boolean,
): Promise<string | null> {
  if (isCancelled()) return null;
  const instance = await ensureHighlighter();
  const resolved = await resolveLanguage(instance, lang, isCancelled);
  if (resolved === null || isCancelled()) return null;
  return instance.codeToHtml(code, {
    lang: resolved,
    theme: MARKDOWN_SHIKI_THEME,
    tabindex: false,
  });
}

async function parseMarkdown(
  request: Extract<MarkdownWorkerJobRequest, { type: 'parse' }>,
  isCancelled: () => boolean,
): Promise<void> {
  try {
    if (isCancelled()) return;
    const blocks = request.blocks && request.blocks.length > 0
      ? request.blocks
      : streamBlocks(request.text ?? '', request.streaming);
    const parsed = [];
    for (const block of blocks) {
      if (isCancelled()) return;
      let html = parseMarkdownUnsafe(block.src);
      if (request.highlight && block.highlight) {
        const highlighted = await applyCodeHighlights(
          html,
          (code, lang) => highlightCodeLocal(code, lang, isCancelled),
          { lineLimit: request.highlightLineLimit, isCancelled },
        );
        if (highlighted === null || isCancelled()) return;
        html = highlighted;
      }
      parsed.push({
        id: markdownBlockId(block),
        html,
        highlight: block.highlight,
      });
    }
    if (isCancelled()) return;
    post({ type: 'parse', id: request.id, blocks: parsed });
  } catch (error) {
    if (isCancelled()) return;
    post({ type: 'error', id: request.id, message: error instanceof Error ? error.message : String(error) });
  }
}

async function highlightLines(
  request: Extract<MarkdownWorkerJobRequest, { type: 'highlightLines' }>,
  isCancelled: () => boolean,
): Promise<void> {
  try {
    if (isCancelled()) return;
    const instance = await ensureHighlighter();
    const lang = await resolveLanguage(instance, request.lang, isCancelled);
    if (lang === null || isCancelled()) return;
    const { tokens } = instance.codeToTokens(request.code, {
      lang: lang as BundledLanguage,
      theme: MARKDOWN_SHIKI_THEME,
    });
    if (isCancelled()) return;
    const lines = tokens.map((line) => line.map(tokenSpan).join(''));
    post({ type: 'highlightLines', id: request.id, lines });
  } catch (error) {
    if (isCancelled()) return;
    post({ type: 'error', id: request.id, message: error instanceof Error ? error.message : String(error) });
  }
}

function post(response: MarkdownWorkerResponse): void {
  self.postMessage(response);
}
