import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function writeInstallerFeed({ directory, version, platform, arch }) {
  const suffix = platform === 'darwin' ? '-mac' : platform === 'linux' ? `-linux${arch === 'x64' ? '' : `-${arch}`}` : '';
  const extension = platform === 'darwin' ? '.zip' : platform === 'linux' ? '.AppImage' : '.exe';
  const files = (await readdir(directory)).filter((name) => name.startsWith(`OpenChamber-${version}-`) && name.endsWith(extension));
  if (files.length !== 1) throw new Error(`Expected one ${platform}/${arch} installer, found ${files.length}`);
  const name = files[0];
  const file = path.join(directory, name);
  const hash = createHash('sha512');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  const sha512 = hash.digest('base64');
  const metadata = { version, files: [{ url: name, sha512, size: (await stat(file)).size }], path: name, sha512 };
  // JSON is valid YAML. These immutable, version-scoped files never form a
  // stable "latest" feed and cannot offer beta builds to stable clients.
  await writeFile(path.join(directory, `full${suffix}.yml`), JSON.stringify(metadata, null, 2));
  return metadata;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [directory, version, platform, arch] = process.argv.slice(2);
  await writeInstallerFeed({ directory, version, platform, arch });
}
