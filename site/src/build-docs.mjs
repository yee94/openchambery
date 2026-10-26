import { readFileSync, readdirSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const site = fileURLToPath(new URL('../', import.meta.url));
const source = path.resolve(site, '../packages/docs');
const output = path.join(site, 'dist');
const content = path.join(source, 'content/docs');
const sidebar = JSON.parse(readFileSync(path.join(source, 'sidebar.config.json'), 'utf8'));
const locales = {
  'zh-cn': { base: '/docs/', home: '/', lang: 'zh-CN', switch: 'English', other: 'en', handbook: '使用手册', download: '下载', menu: '浏览文档', toc: '本页内容', skip: '跳到正文', previous: '上一篇', next: '下一篇', edit: '编辑此页', moved: '此页已合并，请阅读', search: '查找文档', empty: '没有匹配的文档，请换个词试试。', overview: '选择一个起点', paths: ['安装与首次使用', '连接另一台设备', '创建个人助理'], descriptions: ['选择适合的应用，完成第一段对话。', '手机扫码、电脑配对，或通过 SSH 访问。', '直接交谈，分配工作，安排重复任务。'] },
  en: { base: '/en/docs/', home: '/en/', lang: 'en', switch: '简体中文', other: 'zh-cn', handbook: 'Handbook', download: 'Download', menu: 'Browse docs', toc: 'On this page', skip: 'Skip to content', previous: 'Previous', next: 'Next', edit: 'Edit this page', moved: 'This page has moved. Continue to', search: 'Find a guide', empty: 'No matching guides. Try another term.', overview: 'Choose a starting point', paths: ['Install and get started', 'Connect another device', 'Create an assistant'], descriptions: ['Choose your app and start a conversation.', 'Pair a phone, another computer, or use SSH.', 'Talk, delegate work, and schedule repeatable tasks.'] },
};

export const escapeHtml = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

export function parsePage(text, filename) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) throw new Error(`${filename}: missing frontmatter`);
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = line.match(/^(title|description|redirect):\s*(.+)$/);
    if (!field) throw new Error(`${filename}: unsupported frontmatter: ${line}`);
    if (meta[field[1]]) throw new Error(`${filename}: duplicate ${field[1]}`);
    meta[field[1]] = field[2].replace(/^(["'])(.*)\1$/, '$2');
  }
  if (!meta.title || !meta.description) throw new Error(`${filename}: title and description required`);
  if (/^(import|export)\s/m.test(match[2])) throw new Error(`${filename}: executable MDX is not supported`);
  return { ...meta, body: match[2] };
}

function files(directory, prefix = '') {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return entry.name === 'troubleshooting' ? files(path.join(directory, entry.name), `${prefix}${entry.name}/`) : [];
    return entry.name.endsWith('.mdx') ? [`${prefix}${entry.name}`] : [];
  });
}

export function renderContent(body, locale, routes) {
  const config = locales[locale];
  if (!config) throw new Error(`Unsupported docs locale: ${locale}`);
  const ids = new Set(['content', 'docs-search', 'docs-results']);
  const html = Bun.markdown.html(body.replace(/^\s*# [^\n]+\n/, ''), { tagFilter: true })
    .replace(/<h([1-6])>([\s\S]*?)<\/h\1>/g, (_, level, title) => {
      const base = title.replace(/<[^>]*>/g, '').replace(/&[^;]+;/g, ' ').normalize('NFKC').toLowerCase()
        .replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s+/g, '-') || 'section';
      let id = base;
      let suffix = 1;
      while (ids.has(id)) id = `${base}-${suffix++}`;
      ids.add(id);
      return `<h${level} id="${id}">${title}</h${level}>`;
    });
  return html.replace(/href="([^"]+)"/g, (original, href) => {
    if (!href.startsWith('/') || href.startsWith('//') || href.startsWith('/#') || href.startsWith('/en/#')) return original;
    const clean = href.replace(/^\/zh-cn\//, '/');
    const [route] = clean.split(/[?#]/);
    if (!routes.has(route)) throw new Error(`Unknown documentation link: ${href}`);
    return `href="${config.base}${clean.slice(1)}"`;
  });
}

function write(route, html) {
  const target = path.join(output, route, 'index.html');
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, html);
}

function asset(url) {
  if (!/^\/assets\/[\w./-]+$/.test(url) || url.includes('..')) throw new Error(`Invalid asset: ${url}`);
  const relative = url.slice(1);
  const file = path.join(site, relative);
  const target = path.join(output, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  copyFileSync(file, target);
  return `${url}?v=${createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 16)}`;
}

function redirect(route, target, config) {
  write(route, `<!doctype html><html lang="${config.lang}"><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${target}"><meta name="robots" content="noindex"><link rel="canonical" href="${target}"><title>${config.handbook} · Yuri</title></head><body><p>${config.moved} <a href="${target}">${config.handbook}</a>.</p></body></html>`);
}

export function buildDocs() {
  const pages = new Map();
  for (const locale of Object.keys(locales)) {
    const directory = locale === 'en' ? content : path.join(content, locale);
    pages.set(locale, new Map(files(directory).map((file) => {
      const route = file === 'index.mdx' ? '/' : `/${file.replace(/\.mdx$/, '')}/`;
      return [route, { ...parsePage(readFileSync(path.join(directory, file), 'utf8'), file), file }];
    })));
  }
  const routes = new Set(pages.get('en').keys());
  if ([...routes].some((route) => !pages.get('zh-cn').has(route)) || pages.get('zh-cn').size !== routes.size) throw new Error('English and Chinese docs must have matching routes');
  const items = sidebar.sections.flatMap((section) => section.items);
  if (new Set(items.map((item) => item.link)).size !== items.length) throw new Error('Duplicate sidebar links');
  const stylesheet = asset('/assets/docs.css');
  const sharedStyle = asset('/assets/site.css');
  const script = asset('/assets/docs.js');
  const wordmark = asset('/assets/brand/yuri-wordmark-white.svg');
  const icon = asset('/assets/brand/icon-512.webp');
  let count = 0;

  for (const [locale, config] of Object.entries(locales)) {
    const local = pages.get(locale);
    const label = (entry) => locale === 'en' ? entry.label : entry.translations?.['zh-CN'] || entry.label;
    const href = (route) => `${config.base}${route.slice(1)}`;
    for (const item of items) if (!local.has(item.link) || local.get(item.link).redirect) throw new Error(`Sidebar must point to an article: ${item.link}`);
    for (const [route, page] of local) {
      const url = href(route);
      if (page.redirect) {
        if (!local.has(page.redirect) || local.get(page.redirect).redirect) throw new Error(`Invalid redirect: ${route}`);
        redirect(url, href(page.redirect), config);
        continue;
      }
      const body = renderContent(page.body, locale, routes).replace(/src="(\/assets\/[^"?]+)"/g, (_, url) => `src="${asset(url)}" loading="lazy" decoding="async"`);
      const headings = [...body.matchAll(/<h([23]) id="([^"]+)">([\s\S]*?)<\/h\1>/g)];
      const nav = sidebar.sections.map((section) => {
        const links = section.items.map((item) => `<a href="${href(item.link)}"${item.link === route ? ' aria-current="page"' : ''}>${escapeHtml(label(item))}</a>`).join('');
        return section.collapsed
          ? `<details class="docs-section"${section.items.some((item) => item.link === route) ? ' open' : ''}><summary>${escapeHtml(label(section))}</summary>${links}</details>`
          : `<section class="docs-section"><h2>${escapeHtml(label(section))}</h2>${links}</section>`;
      }).join('');
      const index = items.findIndex((item) => item.link === route);
      const adjacent = (item, direction) => item ? `<a href="${href(item.link)}"><small>${direction}</small><span>${escapeHtml(label(item))}</span></a>` : '<span></span>';
      const toc = headings.map(([, level, id, title]) => `<a class="depth-${level}" href="#${id}">${title.replace(/<[^>]*>/g, '')}</a>`).join('');
      const paths = route === '/' ? `<div class="docs-start" aria-label="${config.overview}">${['/install/', '/connect-devices/', '/assistants/'].map((target, i) => `<a href="${href(target)}"><span>${config.paths[i]}</span><p>${config.descriptions[i]}</p></a>`).join('')}</div>` : '';
      const search = `<div class="docs-search" hidden><label for="docs-search">${config.search}</label><input id="docs-search" type="search" autocomplete="off" placeholder="${config.search}" aria-controls="docs-results"><div id="docs-results" hidden><p class="docs-empty" role="status" hidden>${config.empty}</p>${items.map((item) => `<a href="${href(item.link)}" data-search="${escapeHtml(`${label(item)} ${local.get(item.link).title} ${local.get(item.link).description} ${item.link}`.toLowerCase())}"><b>${escapeHtml(label(item))}</b><small>${escapeHtml(local.get(item.link).description)}</small></a>`).join('')}</div></div>`;
      const html = `<!doctype html>
<html lang="${config.lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="dark">
<title>${escapeHtml(page.title)} · Yuri</title><meta name="description" content="${escapeHtml(page.description)}"><link rel="icon" href="${icon}">
<link rel="alternate" hreflang="zh-CN" href="${locales['zh-cn'].base}${route.slice(1)}"><link rel="alternate" hreflang="en" href="${locales.en.base}${route.slice(1)}">
<link rel="stylesheet" href="${sharedStyle}"><link rel="stylesheet" href="${stylesheet}"><script src="${script}" defer></script></head>
<body class="docs-page"><a class="skip" href="#content">${config.skip}</a>
<header class="docs-header"><a class="brand" href="${config.home}" aria-label="Yuri"><img src="${icon}" width="40" height="40" alt=""><img src="${wordmark}" width="64" height="30" alt="Yuri"></a><a class="docs-label" href="${config.base}">${config.handbook}</a><nav aria-label="Yuri"><a href="${locales[config.other].base}${route.slice(1)}" lang="${locales[config.other].lang}" hreflang="${locales[config.other].lang}">${config.switch}</a><a class="docs-download" href="${config.home}#downloads">${config.download}</a><a class="docs-github" href="https://github.com/yee94/yuri">GitHub</a></nav></header>
<div class="docs-layout"><aside class="docs-sidebar"><details class="docs-menu" open><summary>${config.menu}</summary><div class="docs-nav-body">${search}<nav aria-label="${config.menu}">${nav}</nav></div></details></aside>
<main id="content" class="docs-main" tabindex="-1"><div class="docs-page-heading"><p>${escapeHtml(label(sidebar.sections.find((section) => section.items.some((item) => item.link === route)) || sidebar.sections[0]))}</p><h1>${escapeHtml(page.title)}</h1><div class="docs-description">${escapeHtml(page.description)}</div></div>${paths}<article class="docs-prose">${body}</article><footer class="docs-article-footer"><a href="https://github.com/yee94/yuri/edit/main/packages/docs/content/docs/${locale === 'en' ? '' : 'zh-cn/'}${page.file}">${config.edit}</a><nav class="docs-pagination" aria-label="${config.handbook}">${adjacent(items[index - 1], config.previous)}${adjacent(items[index + 1], config.next)}</nav></footer></main>
<aside class="docs-toc"><nav aria-label="${config.toc}"><p>${config.toc}</p>${toc}</nav><a class="docs-toc-home" href="${config.base}">${config.handbook}</a></aside></div></body></html>`;
      write(url, html);
      count++;
    }
  }
  for (const route of routes) {
    const page = pages.get('zh-cn').get(route);
    redirect(`/docs/zh-cn${route}`, `${locales['zh-cn'].base}${(page.redirect || route).slice(1)}`, locales['zh-cn']);
  }
  console.log(`wrote ${count} handbook articles, bilingual merged-page and /docs/zh-cn/ redirects`);
}

if (import.meta.main) buildDocs();
