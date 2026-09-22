import { readdirSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

const stripJsonc = (text) => text
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:\\])\/\/.*$/gm, "$1")

const readConfigPlugins = () => {
  const specs = []
  const files = []
  if (process.env.OPENCODE_CONFIG) files.push(process.env.OPENCODE_CONFIG)
  const dirs = [process.env.OPENCODE_CONFIG_DIR, path.join(homedir(), ".config", "opencode")].filter(Boolean)
  for (const dir of dirs) {
    files.push(path.join(dir, "opencode.jsonc"), path.join(dir, "opencode.json"), path.join(dir, "config.json"))
  }
  for (const file of files) {
    try {
      const parsed = JSON.parse(stripJsonc(readFileSync(file, "utf8")))
      const plugin = parsed?.plugin
      const list = Array.isArray(plugin) ? plugin : plugin ? [plugin] : []
      for (const entry of list) {
        if (typeof entry === "string") specs.push(entry)
        else if (Array.isArray(entry) && typeof entry[0] === "string") specs.push(entry[0])
      }
    } catch {
      // Missing or invalid config files are skipped; OpenCode still loads the ones it can parse.
    }
  }
  return [...new Set(specs)]
}

const packageName = (spec) => {
  const slash = spec.startsWith("@") ? spec.indexOf("/", 1) : -1
  const versionAt = spec.lastIndexOf("@")
  if (versionAt > 0 && versionAt > slash) return spec.slice(0, versionAt)
  return spec
}

const resolvePackageEntry = (spec) => {
  const name = packageName(spec)
  const roots = [
    path.join(homedir(), ".cache", "opencode", "npm"),
    path.join(homedir(), ".cache", "opencode", "packages"),
  ]
  const candidates = []
  for (const root of roots) {
    let entries = []
    try {
      entries = readdirSync(root)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry !== name && !entry.startsWith(`${name}@`)) continue
      const base = path.join(root, entry)
      const packageDirs = [path.join(base, "node_modules", name)]
      try {
        for (const child of readdirSync(base)) {
          if (/^\d+$/.test(child)) packageDirs.push(path.join(base, child, "node_modules", name))
        }
      } catch {
        // The cache entry may be the package directory itself.
      }
      for (const pkgDir of packageDirs) {
        try {
          const pkg = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8"))
          if (pkg.name !== name) continue
          const exported = pkg.exports?.["."]
          const rel = typeof exported === "string" ? exported : pkg.module || pkg.main || "index.mjs"
          candidates.push({
            dir: pkgDir,
            entry: path.resolve(pkgDir, rel),
            mtime: statSync(path.join(pkgDir, "package.json")).mtimeMs,
          })
        } catch {
          // Not a readable package directory.
        }
      }
    }
  }
  candidates.sort((left, right) => right.mtime - left.mtime)
  return candidates[0] || null
}

const usesCatalog = (dir) => {
  const stack = [dir]
  let seen = 0
  while (stack.length > 0 && seen < 80) {
    const current = stack.pop()
    let names = []
    try {
      names = readdirSync(current)
    } catch {
      continue
    }
    for (const name of names) {
      if (name === "node_modules" || name === ".git") continue
      const full = path.join(current, name)
      let info
      try {
        info = statSync(full)
      } catch {
        continue
      }
      if (info.isDirectory()) {
        stack.push(full)
        continue
      }
      if (!/\.(?:mjs|cjs|js)$/.test(name) || info.size > 2_000_000) continue
      seen += 1
      try {
        if (readFileSync(full, "utf8").includes(".catalog")) return true
      } catch {
        // Unreadable files are not catalog callers.
      }
    }
  }
  return false
}

const catalogFor = (ctx) => ({
  // OpenCode 2.0.12 removed ctx.catalog. Model plugins still call
  // draft.provider.update / draft.model.update inside catalog.transform.
  transform: (fn) => ctx.provider?.transform?.((draft) => fn({
    provider: {
      update: (id, updater) => draft.update(id, updater),
      add: (...args) => draft.add?.(...args),
    },
    model: {
      update: (providerID, modelID, updater) => draft.models?.update?.(providerID, modelID, updater),
      set: (providerID, modelID, value) => draft.models?.set?.(providerID, modelID, value),
    },
  })),
  reload: () => ctx.provider?.reload?.() ?? ctx.model?.reload?.(),
})

export default {
  id: "openchamber-v2-plugin-host-shim",
  setup: async (ctx) => {
    if (typeof ctx?.catalog?.transform === "function") return
    const patched = { ...ctx, catalog: catalogFor(ctx) }
    for (const spec of readConfigPlugins()) {
      const resolved = resolvePackageEntry(spec)
      if (!resolved || !usesCatalog(resolved.dir)) continue
      try {
        const mod = await import(pathToFileURL(resolved.entry).href)
        if (typeof mod.default?.setup === "function") await mod.default.setup(patched)
      } catch (error) {
        console.error(`[openchamber] v2 plugin host shim skipped ${spec}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  },
}
