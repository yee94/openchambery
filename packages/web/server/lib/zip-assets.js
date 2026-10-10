import AdmZip from 'adm-zip';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Extract a bounded static asset archive into a new, empty staging directory. */
export async function extractAssetZip(bytes, destination) {
  const entries = new AdmZip(bytes).getEntries();
  if (entries.length > 20000) throw new Error('Too many asset entries');
  let size = 0;
  const names = new Set();
  for (const entry of entries) {
    const name = entry.entryName;
    const parts = name.replace(/\/$/, '').split('/');
    const type = (entry.attr >>> 16) & 0o170000;
    if (!name || /[\\:\x00-\x1f]/.test(name) || parts.some((p) => !p || p === '.' || p === '..')
      || (type && type !== 0o100000 && type !== 0o040000)
      || names.has(name.toLowerCase())) throw new Error('Unsafe asset archive entry');
    names.add(name.toLowerCase());
    size += entry.header.size;
    if (size > 256 * 1024 * 1024) throw new Error('Asset archive exceeds expanded size limit');
  }
  for (const entry of entries) {
    const target = path.join(destination, entry.entryName);
    if (entry.isDirectory) await mkdir(target, { recursive: true });
    else {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, entry.getData(), { flag: 'wx' });
    }
  }
}

export function createAssetZip(directory, output) {
  const zip = new AdmZip();
  zip.addLocalFolder(directory);
  zip.writeZip(output);
}

export function readAssetZipMetadata(file) {
  const entry = new AdmZip(file).getEntry('desktop-ota.json');
  if (!entry || entry.header.size > 4096) throw new Error('Missing desktop OTA metadata');
  return JSON.parse(entry.getData().toString('utf8'));
}
