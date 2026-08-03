/**
 * A fence's info string is usually a language id, but a code reference puts a
 * `startLine:endLine:filepath` triple there instead:
 *
 *     ```102:106:packages/ui/src/components/chat/lib/markdownHydrationWindow.ts
 *
 * marked passes the info string through verbatim as the `language-*` class, so
 * both forms reach the highlighter as one opaque string. Treating that whole
 * string as a language id leaves every reference block unhighlighted, since no
 * grammar is registered under a name containing line numbers.
 *
 * Splitting it into the id to tokenize with and the text to label the card with
 * also keeps the label readable: the id has to be lowercased to match Shiki's
 * registry, which would otherwise mangle the casing of the referenced path.
 */

/** Shiki's built-in no-op grammar, used when nothing else matches. */
const PLAIN_TEXT = 'text';

const CODE_REFERENCE_RE = /^(\d+):(\d+):(.+)$/;

// Values must be ids Shiki actually bundles: an unknown id falls back to plain
// text in the worker, which looks identical to no mapping at all.
const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  vue: 'vue',
  svelte: 'svelte',
  astro: 'astro',
  json: 'json',
  jsonc: 'jsonc',
  json5: 'json5',
  jsonl: 'json',
  ndjson: 'json',
  geojson: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  ini: 'ini',
  cfg: 'ini',
  conf: 'ini',
  properties: 'properties',
  env: 'dotenv',
  css: 'css',
  scss: 'scss',
  sass: 'sass',
  less: 'less',
  styl: 'stylus',
  html: 'html',
  htm: 'html',
  xml: 'xml',
  svg: 'xml',
  md: 'markdown',
  markdown: 'markdown',
  mdown: 'markdown',
  mkd: 'markdown',
  mdx: 'mdx',
  py: 'python',
  pyw: 'python',
  pyi: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  swift: 'swift',
  scala: 'scala',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  m: 'objective-c',
  mm: 'objective-cpp',
  cs: 'csharp',
  fs: 'fsharp',
  fsx: 'fsharp',
  vb: 'vb',
  php: 'php',
  pl: 'perl',
  pm: 'perl',
  lua: 'lua',
  r: 'r',
  dart: 'dart',
  ex: 'elixir',
  exs: 'elixir',
  erl: 'erlang',
  hrl: 'erlang',
  hs: 'haskell',
  clj: 'clojure',
  cljs: 'clojure',
  cljc: 'clojure',
  groovy: 'groovy',
  jl: 'julia',
  ml: 'ocaml',
  mli: 'ocaml',
  zig: 'zig',
  nix: 'nix',
  sol: 'solidity',
  prisma: 'prisma',
  proto: 'proto',
  graphql: 'graphql',
  gql: 'graphql',
  sql: 'sql',
  sh: 'shellscript',
  bash: 'shellscript',
  zsh: 'shellscript',
  fish: 'shellscript',
  ps1: 'powershell',
  psm1: 'powershell',
  bat: 'bat',
  cmd: 'bat',
  tf: 'terraform',
  tfvars: 'terraform',
  hcl: 'hcl',
  diff: 'diff',
  patch: 'diff',
  csv: 'csv',
  tex: 'latex',
  vim: 'viml',
  wgsl: 'wgsl',
  glsl: 'glsl',
  wat: 'wasm',
  mermaid: 'mermaid',
  mmd: 'mermaid',
};

// Extensionless (or misleadingly extensioned) files that still have a grammar.
const LANGUAGE_BY_FILENAME: Record<string, string> = {
  dockerfile: 'docker',
  containerfile: 'docker',
  makefile: 'make',
  gnumakefile: 'make',
  'cmakelists.txt': 'cmake',
  gemfile: 'ruby',
  rakefile: 'ruby',
  podfile: 'ruby',
  '.env': 'dotenv',
  '.bashrc': 'shellscript',
  '.zshrc': 'shellscript',
  '.profile': 'shellscript',
};

export type CodeFenceInfo = {
  /** Shiki language id to tokenize with; `text` when nothing matched. */
  lang: string;
  /** Text for the code card header; preserves a referenced path's casing. */
  label: string;
  /** True when the info string was a `startLine:endLine:filepath` triple. */
  reference: boolean;
};

/** Best-effort Shiki language id for a file path, by name then extension. */
export const languageFromFilePath = (path: string): string => {
  const filename = path.split(/[\\/]/).pop()?.toLowerCase() ?? '';
  if (!filename) return PLAIN_TEXT;

  const byName = LANGUAGE_BY_FILENAME[filename];
  if (byName) return byName;

  const dot = filename.lastIndexOf('.');
  // A leading dot belongs to the name (`.env`), so it never marks an extension.
  if (dot <= 0) return PLAIN_TEXT;

  return LANGUAGE_BY_EXTENSION[filename.slice(dot + 1)] ?? PLAIN_TEXT;
};

/** Split a fence info string into a language to highlight with and a label. */
export const parseCodeFenceInfo = (raw: string | null | undefined): CodeFenceInfo => {
  const info = raw?.trim() ?? '';
  if (!info) return { lang: PLAIN_TEXT, label: PLAIN_TEXT, reference: false };

  const matched = CODE_REFERENCE_RE.exec(info);
  if (!matched) {
    const lang = info.toLowerCase();
    return { lang, label: lang, reference: false };
  }

  const [, start = '', end = '', path = ''] = matched;
  const range = start === end ? start : `${start}-${end}`;
  return { lang: languageFromFilePath(path), label: `${path}:${range}`, reference: true };
};