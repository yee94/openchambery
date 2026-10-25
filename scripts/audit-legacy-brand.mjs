#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = 'docs/legacy-brand-exceptions.json';
// Cover display-name separators and known misspellings as well as technical slugs.
const legacyPattern = new RegExp([
  'open' + '[\\s_.-]*' + 'chamb?er',
  'yee' + '[\\s_.-]*' + 'code',
  'feday' + 'kindev', 'boh' + 'dan', 'tria' + 'pitsyn',
  'ZYRS' + 'dnwwKA',
].join('|'), 'i');

// Only non-source dependency/build/local-state trees are outside the audit.
// In particular, migration implementations, tests and hidden source trees are scanned.
const excludedNames = new Set([
  '.git', '.scratch', '.graymatter', 'node_modules', '.gradle', 'Pods',
  'DerivedData', '.turbo', '.vite', '.cache', '.vercel', '.idea',
  'dist', 'dist-ssr', 'dist-preview', 'dist-bundle', 'dist-assistant-preview',
  'web-dist', 'build', 'release', 'coverage', 'test-results',
]);
const excludedRoots = [
  '.tmp', '.worktrees', '.slim', 'data', 'workspaces', 'logs', '.opencode/images', '.opencode/plans',
  'packages/mobile/android/app/src/main/assets/public', 'packages/mobile/ios/App/App/public',
];

function excluded(relative) {
  return relative.split('/').some((part) => excludedNames.has(part))
    || excludedRoots.some((root) => relative === root || relative.startsWith(`${root}/`))
    || /(?:^|\/)\.env(?:\..*)?$|\.log$|\.release-backup$/.test(relative);
}

function validateExceptions(manifest) {
  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.exceptions)) throw new Error('Invalid legacy exception manifest');
  const keys = new Set();
  for (const entry of manifest.exceptions) {
    if (!['content', 'path'].includes(entry.kind)
      || typeof entry.path !== 'string' || entry.path.startsWith('/') || entry.path.split('/').includes('..')
      || excluded(entry.path) || entry.path === manifestPath
      || !Number.isSafeInteger(entry.count) || entry.count < 1
      || ['category', 'reason', 'owner', 'exitCondition'].some((key) => typeof entry[key] !== 'string' || !entry[key].trim())
      || (entry.kind === 'content' && (typeof entry.line !== 'string' || entry.line.includes('\n') || !legacyPattern.test(entry.line)))
      || (entry.kind === 'path' && !legacyPattern.test(entry.path))) {
      throw new Error(`Invalid exact exception: ${entry.path ?? '(missing path)'}`);
    }
    const key = JSON.stringify([entry.kind, entry.path, entry.line ?? null]);
    if (keys.has(key)) throw new Error(`Duplicate exception: ${entry.path}`);
    keys.add(key);
  }
}

export async function auditLegacyBrand(root, manifest) {
  validateExceptions(manifest);
  const hits = [];
  const readFailures = [];
  async function walk(directory, prefix = '') {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (excluded(relative)) continue;
      if (legacyPattern.test(relative)) hits.push({ kind: 'path', path: relative });
      // The inventory is metadata for these exact exceptions, not product content.
      if (relative === manifestPath) continue;
      if (entry.isSymbolicLink()) continue; // never traverse external/user workspaces
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) { await walk(absolute, relative); continue; }
      if (!entry.isFile()) continue;
      let buffer;
      try { buffer = await fs.readFile(absolute); }
      catch (error) { readFailures.push(`${relative}: ${error.code ?? error.message}`); continue; }
      if (buffer.includes(0)) continue; // binary images/installers need artifact/visual verification
      for (const [index, line] of buffer.toString('utf8').split(/\r?\n/).entries()) {
        if (legacyPattern.test(line)) hits.push({ kind: 'content', path: relative, line, lineNumber: index + 1 });
      }
    }
  }
  await walk(root);
  const remaining = manifest.exceptions.map((entry) => ({ ...entry, remaining: entry.count }));
  const unapproved = [];
  for (const hit of hits) {
    const allowed = remaining.find((entry) => entry.kind === hit.kind && entry.path === hit.path
      && (hit.kind === 'path' || entry.line === hit.line) && entry.remaining > 0);
    if (allowed) allowed.remaining -= 1;
    else unapproved.push(hit);
  }
  const stale = remaining.filter((entry) => entry.remaining > 0);
  return { ok: !unapproved.length && !stale.length && !readFailures.length, hits, unapproved, stale, readFailures };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--json')) throw new Error('Usage: node scripts/audit-legacy-brand.mjs [--json]');
  const manifest = JSON.parse(await fs.readFile(path.join(repositoryRoot, manifestPath), 'utf8'));
  const result = await auditLegacyBrand(repositoryRoot, manifest);
  if (args.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else {
    for (const hit of result.unapproved) console.error(`UNAPPROVED ${hit.path}${hit.lineNumber ? `:${hit.lineNumber}` : ''} [${hit.kind}]`);
    for (const entry of result.stale) console.error(`STALE ${entry.path} [${entry.kind}]: ${entry.remaining} approved occurrence(s) missing`);
    for (const error of result.readFailures) console.error(`UNREADABLE ${error}`);
    console.log(`Legacy brand audit ${result.ok ? 'passed' : 'failed'}: ${result.hits.length} hits, ${result.unapproved.length} unapproved, ${result.stale.length} stale exceptions.`);
  }
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
