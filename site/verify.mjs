import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('./dist/', import.meta.url));
const origin = process.argv[2];
const fetched = new Map();
async function read(relative) {
  if (!origin) return readFileSync(path.join(root, relative.split('?')[0]));
  if (!fetched.has(relative)) {
    const url = new URL(relative, origin.endsWith('/') ? origin : `${origin}/`);
    const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
    assert(response.ok, `${url.pathname}: HTTP ${response.status}`);
    if (/\.(?:m?js)$/.test(url.pathname)) {
      assert.match(response.headers.get('content-type') || '', /^(?:text|application)\/javascript\b/i, `${url.pathname}: browser scripts require a JavaScript MIME type`);
    }
    fetched.set(relative, Buffer.from(await response.arrayBuffer()));
  }
  return fetched.get(relative);
}
for (const page of ['index.html', 'en/index.html']) {
  const html = (await read(origin ? page.replace('index.html', '') : page)).toString();
  if (origin) assert.equal(html, readFileSync(path.join(root, page), 'utf8'), `${page}: production differs from this revision`);
  assert(!html.includes('{{'), `${page}: unresolved template`);
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(ids.length, new Set(ids).size, `${page}: duplicate ids`);
  for (const [, hash] of html.matchAll(/href="#([^"]+)"/g)) {
    assert(ids.includes(hash), `${page}: missing anchor ${hash}`);
  }
  let assets = 0;
  for (const [, url, version] of html.matchAll(/(?:src|href)="((?:\.\.\/)?assets\/[^"?]+)\?v=([a-f0-9]{16})"/g)) {
    const relative = url.replace(/^\.\.\//, '');
    const data = await read(`${relative}?v=${version}`);
    assert.equal(createHash('sha256').update(data).digest('hex').slice(0, 16), version, relative);
    assets++;
  }
  assert(assets > 20, `${page}: missing versioned resources`);
  assert(!/(?:src|href)="(?:\.\.\/)?assets\/[^"?]+"/.test(html), `${page}: unversioned resource`);
  assert.equal((html.match(/data-platform=/g) || []).length, 6, `${page}: download targets`);
  console.log(`${page}: anchors, downloads and ${assets} asset references verified`);
}
if (!origin) {
  assert.deepEqual(readdirSync(root).sort(), ['assets', 'docs', 'en', 'index.html']);
}

function htmlFiles(directory, prefix = '') {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relative = `${prefix}${entry.name}`;
    if (entry.isDirectory()) return htmlFiles(path.join(directory, entry.name), `${relative}/`);
    return entry.name.endsWith('.html') ? [relative] : [];
  });
}

const documents = new Map();
for (const file of htmlFiles(root)) {
  const route = `/${file.replace(/index\.html$/, '')}`;
  const html = (await read(origin ? route.slice(1) : file)).toString();
  if (origin) assert.equal(html, readFileSync(path.join(root, file), 'utf8'), `${route}: production differs from this revision`);
  const ids = [...html.matchAll(/\bid="([^"]*)"/g)].map((match) => match[1]);
  assert(ids.every(Boolean), `${route}: empty IDs`);
  assert.equal(ids.length, new Set(ids).size, `${route}: duplicate IDs`);
  if (html.includes('class="docs-page"')) {
    assert.equal((html.match(/<h1[ >]/g) || []).length, 1, `${route}: exactly one page heading`);
    assert(html.includes('aria-current="page"'), `${route}: missing current navigation item`);
  }
  documents.set(route, { html, ids });
}
let references = 0;
for (const [route, { html }] of documents) {
  for (const [, encoded] of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    const url = new URL(encoded.replaceAll('&amp;', '&'), `https://site.invalid${route}`);
    if (url.origin !== 'https://site.invalid') continue;
    const pathname = decodeURIComponent(url.pathname);
    if (pathname.startsWith('/assets/')) {
      const version = url.searchParams.get('v');
      assert.match(version || '', /^[a-f0-9]{16}$/, `${route}: missing asset hash: ${pathname}`);
      const data = await read(url.pathname.slice(1) + url.search);
      assert.equal(createHash('sha256').update(data).digest('hex').slice(0, 16), version, pathname);
    } else {
      const target = documents.get(pathname);
      assert(target, `${route}: broken internal link ${encoded}`);
      if (url.hash) assert(target.ids.includes(decodeURIComponent(url.hash.slice(1))), `${route}: missing fragment ${encoded}`);
    }
    references++;
  }
}
console.log(`${documents.size} pages: ${references} internal links, fragments and versioned resources verified`);
