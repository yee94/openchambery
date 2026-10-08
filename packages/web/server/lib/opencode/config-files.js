import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { parse, parseTree, findNodeAtLocation, createScanner, SyntaxKind, modify, applyEdits } from 'jsonc-parser';

export const getGlobalConfigDirectory = () => process.env.OPENCODE_CONFIG_DIR
  ? path.resolve(process.env.OPENCODE_CONFIG_DIR)
  : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'opencode');
export const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function parseConfigObject(content, filePath) {
  const errors = [];
  const value = parse(content.replace(/^\uFEFF/, ''), errors, { allowTrailingComma: true, allowEmptyContent: true });
  if (errors.length || (value !== undefined && !isPlainObject(value))) {
    throw Object.assign(new Error(`Invalid JSONC configuration: ${filePath}`), { code: 'INVALID_JSONC' });
  }
  return value ?? {};
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export function readConfigFile(filePath) {
  if (!filePath) return {};
  const text = readText(filePath);
  return text === null ? {} : parseConfigObject(text, filePath);
}

function mergeConfigs(base, override) {
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    Object.defineProperty(result, key, {
      value: isPlainObject(result[key]) && isPlainObject(value) ? mergeConfigs(result[key], value) : value,
      enumerable: true, configurable: true, writable: true,
    });
  }
  return result;
}

const names = ['opencode.json', 'opencode.jsonc'];

export function readConfigLayers(workingDirectory) {
  const directory = getGlobalConfigDirectory();
  const userPaths = names.map((name) => path.join(directory, name));
  const customPath = process.env.OPENCODE_CONFIG ? path.resolve(process.env.OPENCODE_CONFIG) : null;
  const ancestors = [];
  if (workingDirectory && path.resolve(workingDirectory) !== path.resolve(directory)) {
    let current = path.resolve(workingDirectory);
    while (true) {
      ancestors.unshift(current);
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  const projectPaths = [
    ...ancestors.flatMap((dir) => names.map((name) => path.join(dir, name))),
    ...ancestors.flatMap((dir) => names.map((name) => path.join(dir, '.opencode', name))),
  ].filter((filePath) => !userPaths.includes(filePath));
  const load = (paths, scope) => paths.flatMap((filePath) => {
    const text = readText(filePath);
    return text === null ? [] : [{ path: filePath, scope, config: parseConfigObject(text, filePath) }];
  });
  const userLayers = load(userPaths, 'user');
  const projectLayers = load(projectPaths, 'project');
  const customConfig = readConfigFile(customPath);
  const documents = [...userLayers, ...(customPath ? [{ path: customPath, scope: 'custom', config: customConfig }] : []), ...projectLayers];
  const merge = (layers) => layers.reduce((config, layer) => mergeConfigs(config, layer.config), {});
  return {
    userConfig: merge(userLayers), projectConfig: merge(projectLayers), customConfig,
    mergedConfig: merge(documents), userLayers, projectLayers, documents,
    paths: {
      userPath: userLayers.at(-1)?.path ?? path.join(directory, 'opencode.jsonc'),
      projectPath: projectLayers.at(-1)?.path ?? (workingDirectory ? path.join(workingDirectory, '.opencode', 'opencode.jsonc') : null),
      customPath,
    },
  };
}

export const readConfig = (workingDirectory) => readConfigLayers(workingDirectory).mergedConfig;

export function getConfigForPath(layers, targetPath) {
  const filePath = targetPath || layers.paths.userPath;
  return layers.documents.findLast((layer) => layer.path === filePath)?.config ?? readConfigFile(filePath);
}

export function getJsonEntrySource(layers, sectionKey, entryName) {
  for (const layer of layers.documents.toReversed()) {
    const section = layer.config?.[sectionKey]?.[entryName];
    if (section !== undefined) return { section, config: layer.config, path: layer.path, exists: true };
  }
  return { section: null, config: null, path: null, exists: false };
}

export function getJsonWriteTarget(layers, preferredScope) {
  const filePath = preferredScope === 'project' && layers.paths.projectPath
    ? layers.paths.projectPath : layers.paths.customPath || layers.paths.userPath;
  return { config: getConfigForPath(layers, filePath), path: filePath };
}

function removalEdits(text, propertyPath) {
  const node = findNodeAtLocation(parseTree(text), propertyPath)?.parent;
  const parent = node?.parent;
  if (!node || parent?.type !== 'object') throw new Error('Cannot locate configuration property');
  const siblings = parent.children;
  const index = siblings.indexOf(node);
  const end = node.offset + node.length;
  const scanner = createScanner(text, true);
  const comma = (start, stop) => {
    scanner.setPosition(start);
    return scanner.scan() === SyntaxKind.CommaToken && scanner.getTokenOffset() < stop ? scanner.getTokenOffset() : -1;
  };
  let separator = comma(end, siblings[index + 1]?.offset ?? parent.offset + parent.length - 1);
  if (separator < 0) {
    const previous = siblings[index - 1];
    separator = comma(previous ? previous.offset + previous.length : parent.offset + 1, node.offset);
  }
  return [{ offset: node.offset, length: node.length, content: '' }, ...(separator < 0 ? [] : [{ offset: separator, length: 1, content: '' }])];
}

function editConfig(existing, desired, filePath) {
  const current = parseConfigObject(existing, filePath);
  const bom = existing.startsWith('\uFEFF') ? '\uFEFF' : '';
  let text = existing.slice(bom.length);
  if (!parseTree(text)) return `${existing}${existing && !existing.endsWith('\n') ? '\n' : ''}${JSON.stringify(desired, null, 2)}\n`;
  const indentation = text.match(/\n([\t ]+)"/)?.[1] ?? '  ';
  const formattingOptions = { insertSpaces: !indentation.includes('\t'), tabSize: indentation.length, eol: text.includes('\r\n') ? '\r\n' : '\n' };
  const visit = (before, after, keys) => {
    if (isDeepStrictEqual(before, after)) return;
    if (isPlainObject(before) && isPlainObject(after)) {
      for (const key of Object.keys(before)) {
        if (!Object.hasOwn(after, key)) text = applyEdits(text, removalEdits(text, [...keys, key]));
      }
      for (const key of Object.keys(after)) visit(before[key], after[key], [...keys, key]);
    } else {
      text = applyEdits(text, modify(text, keys, after, { formattingOptions }));
    }
  };
  visit(current, desired, []);
  if (!isDeepStrictEqual(parseConfigObject(text, filePath), desired)) throw new Error('Configuration edit did not round-trip');
  return bom + text;
}

// Shared by structured entity edits and the raw editor; failure never truncates the original.
export function writeConfigText(content, filePath) {
  parseConfigObject(content, filePath);
  let exists = false;
  try {
    fs.lstatSync(filePath);
    exists = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  // Resolve before staging: rename must replace the dotfile target, not its link.
  // lstat distinguishes new files from dangling links, whose realpath must fail.
  const targetPath = exists ? fs.realpathSync(filePath) : filePath;
  const original = readText(targetPath);
  if (original !== null) parseConfigObject(original, filePath);
  if (content === original) return;
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const temporaryPath = `${targetPath}.${randomUUID()}.tmp`;
  try {
    const mode = original === null ? 0o600 : fs.statSync(targetPath).mode & 0o777;
    fs.writeFileSync(temporaryPath, content, { encoding: 'utf8', flag: 'wx', mode });
    if (original !== null) {
      fs.chmodSync(temporaryPath, mode);
      fs.copyFileSync(targetPath, `${filePath}.openchamber.backup`);
    }
    fs.renameSync(temporaryPath, targetPath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}

export function writeConfig(config, filePath = path.join(getGlobalConfigDirectory(), 'opencode.jsonc')) {
  const desired = JSON.parse(JSON.stringify(config));
  if (!isPlainObject(desired)) throw new Error('Configuration must be an object');
  writeConfigText(editConfig(readText(filePath) ?? '', desired, filePath), filePath);
}
