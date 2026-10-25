import { test, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { auditLegacyBrand } from '../../../scripts/audit-legacy-brand.mjs';

const oldName = ['open', 'chamber'].join('');
const exact = (line, count = 1) => ({
  kind: 'content', path: 'migration.js', line, count,
  category: 'migration-read', reason: 'Legacy data import', owner: 'Host owner', exitCondition: 'Remove after supported imports end',
});

test('exact exceptions accept line movement but reject changed, repeated, and new-file matches', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yuri-brand-audit-'));
  try {
    const line = `const legacy = '${oldName}';`;
    const manifest = { schemaVersion: 1, exceptions: [exact(line)] };
    await fs.writeFile(path.join(root, 'migration.js'), `\n${line}\n`);
    expect((await auditLegacyBrand(root, manifest)).ok).toBe(true);
    await fs.writeFile(path.join(root, 'migration.js'), `${line}\n${line}\n`);
    expect((await auditLegacyBrand(root, manifest)).unapproved).toHaveLength(1);
    await fs.writeFile(path.join(root, 'migration.js'), `${line} // another use\n`);
    const changed = await auditLegacyBrand(root, manifest);
    expect(changed.unapproved).toHaveLength(1);
    expect(changed.stale).toHaveLength(1);
    await fs.writeFile(path.join(root, 'migration.js'), line);
    await fs.mkdir(path.join(root, '.hidden'));
    await fs.writeFile(path.join(root, '.hidden', 'new.js'), oldName);
    expect((await auditLegacyBrand(root, manifest)).unapproved[0].path).toBe('.hidden/new.js');
    await fs.unlink(path.join(root, '.hidden', 'new.js'));
    await fs.writeFile(path.join(root, `${oldName}.txt`), 'no legacy text');
    expect((await auditLegacyBrand(root, manifest)).unapproved).toEqual([{ kind: 'path', path: `${oldName}.txt` }]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('copyright-author terms are matched case-insensitively and stale exceptions fail', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yuri-brand-audit-'));
  try {
    for (const parts of [['feday', 'kindev'], ['boh', 'dan'], ['tria', 'pitsyn']]) {
      await fs.writeFile(path.join(root, 'NOTICE'), parts.join('').toUpperCase());
      const result = await auditLegacyBrand(root, { schemaVersion: 1, exceptions: [] });
      expect(result.ok).toBe(false);
      expect(result.unapproved).toHaveLength(1);
    }
    await fs.unlink(path.join(root, 'NOTICE'));
    expect((await auditLegacyBrand(root, { schemaVersion: 1, exceptions: [exact(oldName)] })).stale).toHaveLength(1);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('rejects display-name variants, misspellings and the retired community destination', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yuri-brand-variants-'));
  try {
    const variants = ['', ' ', '  ', '_', '-', '.', '\t', '\u00a0'].flatMap((separator) => [
      ['OPEN', 'CHAMBER'].join(separator),
      ['Open', 'ChamberY'].join(separator),
      ['YEE', 'CODE'].join(separator),
    ]);
    variants.push(['open', 'chamer'].join(''), `https://discord.gg/${['ZYRS', 'dnwwKA'].join('')}`);
    for (const variant of variants) {
      await fs.writeFile(path.join(root, 'defaults.js'), `export const label = '${variant}';`);
      const result = await auditLegacyBrand(root, { schemaVersion: 1, exceptions: [] });
      expect(result.ok, variant).toBe(false);
      expect(result.unapproved, variant).toHaveLength(1);
    }
    await fs.unlink(path.join(root, 'defaults.js'));
    const retiredPath = `${['Open', 'Chamber'].join('-')}.svg`;
    await fs.writeFile(path.join(root, retiredPath), '<svg/>');
    expect((await auditLegacyBrand(root, { schemaVersion: 1, exceptions: [] })).unapproved)
      .toEqual([{ kind: 'path', path: retiredPath }]);
    await fs.unlink(path.join(root, retiredPath));
    await fs.writeFile(path.join(root, 'defaults.js'), "const labels = ['Yuri', 'OpenCode'];");
    expect((await auditLegacyBrand(root, { schemaVersion: 1, exceptions: [] })).ok).toBe(true);
    const line = `const legacy = '${['OPEN', 'CHAMBER'].join(' ')}';`;
    await fs.writeFile(path.join(root, 'migration.js'), line);
    expect((await auditLegacyBrand(root, { schemaVersion: 1, exceptions: [exact(line)] })).ok).toBe(true);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
