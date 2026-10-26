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
  assert.deepEqual(readdirSync(root).sort(), ['assets', 'en', 'index.html']);
}
