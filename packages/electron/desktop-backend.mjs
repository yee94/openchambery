import { createRequire, registerHooks } from 'node:module';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// These modules are also loaded by the installer-owned shell, or launch a
// separate native worker. Their sources remain part of the shell fingerprint.
const SHELL_BACKEND_PATHS = ['server/lib/config-sync/', 'server/lib/dictation/local/'];

export function registerDesktopBackend({ directory, builtinEntry }) {
  const root = pathToFileURL(`${realpathSync(directory)}${path.sep}`).href;
  const builtinRoot = new URL('../', builtinEntry).href;
  const builtinRequire = createRequire(builtinEntry);
  return registerHooks({
    resolve(specifier, context, nextResolve) {
      if (!context.parentURL?.startsWith(root)) return nextResolve(specifier, context);
      if (specifier.startsWith('.') || specifier.startsWith('file:')) {
        const url = new URL(specifier, context.parentURL).href;
        const relative = url.startsWith(root) ? url.slice(root.length) : null;
        if (relative && SHELL_BACKEND_PATHS.some((prefix) => relative.startsWith(prefix))) {
          return nextResolve(new URL(relative, builtinRoot).href, context);
        }
        return nextResolve(specifier, context);
      }
      // Resolve dependencies from the installed package, retaining ESM/CJS
      // conditions. Never copy native modules into the OTA archive.
      if (!specifier.startsWith('/') && !path.isAbsolute(specifier)) {
        if (context.conditions.includes('require')) return nextResolve(builtinRequire.resolve(specifier), context);
        return nextResolve(specifier, { ...context, parentURL: builtinEntry });
      }
      return nextResolve(specifier, context);
    },
  });
}

export async function loadDesktopBackend(directory) {
  const builtinEntry = import.meta.resolve('@openchambery/web/server/index.js');
  const entry = directory ? pathToFileURL(path.join(directory, 'server/index.js')).href : builtinEntry;
  if (directory) registerDesktopBackend({ directory, builtinEntry });
  const [server, files] = await Promise.all([
    import(entry),
    import(pathToFileURL(path.join(path.dirname(fileURLToPath(entry)), 'lib/fs/routes.js')).href),
  ]);
  return { startWebUiServer: server.startWebUiServer, mintOutsideFileGrant: files.mintOutsideFileGrant };
}
