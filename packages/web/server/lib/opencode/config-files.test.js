import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readConfigFile, readConfigLayers, getConfigForPath, getJsonEntrySource, getJsonWriteTarget, writeConfig, writeConfigText } from './config-files.js';

let root;
let globalDir;
const put = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
};
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-config-files-'));
  globalDir = path.join(root, 'xdg', 'opencode');
  vi.stubEnv('XDG_CONFIG_HOME', path.dirname(globalDir));
  vi.stubEnv('OPENCODE_CONFIG', '');
  vi.stubEnv('OPENCODE_CONFIG_DIR', '');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('physical configuration layers', () => {
  it('resolves an explicit global directory at call time', () => {
    const customDirectory = path.join(root, 'custom-directory');
    put(path.join(customDirectory, 'opencode.jsonc'), '{"model":"custom-directory"}');
    vi.stubEnv('OPENCODE_CONFIG_DIR', customDirectory);
    expect(readConfigLayers().mergedConfig).toEqual({ model: 'custom-directory' });
    expect(getJsonWriteTarget(readConfigLayers(), 'user').path).toBe(path.join(customDirectory, 'opencode.jsonc'));
  });
  it('merges both global documents and keeps each write target unmerged', () => {
    const json = put(path.join(globalDir, 'opencode.json'), '{"model":"base","agent":{"base":{"model":"a"},"shared":{"model":"base","description":"kept"}}}');
    const jsonc = put(path.join(globalDir, 'opencode.jsonc'), '{ // override\n "model":"override","agent":{"shared":{"model":"override"}},}');
    put(path.join(globalDir, 'config.json'), '{"model":"legacy-not-loaded-by-v2"}');
    const layers = readConfigLayers();
    expect(layers.mergedConfig).toEqual({ model: 'override', agent: { base: { model: 'a' }, shared: { model: 'override', description: 'kept' } } });
    expect(getJsonEntrySource(layers, 'agent', 'base').path).toBe(json);
    expect(getJsonEntrySource(layers, 'agent', 'shared').path).toBe(jsonc);
    expect(getConfigForPath(layers, jsonc)).toEqual({ model: 'override', agent: { shared: { model: 'override' } } });
    expect(getJsonWriteTarget(layers, 'user').path).toBe(jsonc);
  });

  it('loads explicit config above global and below discovered project documents', () => {
    put(path.join(globalDir, 'opencode.json'), '{"model":"global","global":true}');
    const custom = put(path.join(root, 'custom.jsonc'), '{"model":"explicit","explicit":true}');
    vi.stubEnv('OPENCODE_CONFIG', custom);
    const workspace = path.join(root, 'workspace');
    const nested = path.join(workspace, 'nested');
    put(path.join(workspace, 'opencode.json'), '{"model":"parent","parent":true}');
    put(path.join(nested, 'opencode.jsonc'), '{"model":"child"}');
    put(path.join(workspace, '.opencode', 'opencode.json'), '{"model":"supplementary"}');
    const layers = readConfigLayers(nested);
    expect(layers.mergedConfig).toEqual({ model: 'supplementary', global: true, explicit: true, parent: true });
    expect(getJsonWriteTarget(layers, 'user').path).toBe(custom);
    expect(getJsonWriteTarget(layers, 'project').path).toBe(path.join(workspace, '.opencode', 'opencode.json'));
    vi.stubEnv('OPENCODE_CONFIG', '');
    expect(readConfigLayers().mergedConfig).toEqual({ model: 'global', global: true });
  });

  it.each(['opencode.json', 'opencode.jsonc'])('reads a single %s and treats missing, blank and comments-only documents explicitly as empty', (name) => {
    expect(readConfigLayers().mergedConfig).toEqual({});
    const file = put(path.join(globalDir, name), ' \n');
    expect(readConfigLayers().mergedConfig).toEqual({});
    put(file, '// empty config\n/* documented */');
    expect(readConfigLayers().mergedConfig).toEqual({});
    put(file, '{"model":"one"}');
    expect(readConfigLayers().mergedConfig).toEqual({ model: 'one' });
    expect(getJsonWriteTarget(readConfigLayers(), 'user').path).toBe(file);
  });

  it.each(['{"model":', '{"model":"x", broken}', '[]', 'null', 'plain text'])('rejects malformed/non-object content %s without changing it', (text) => {
    const file = put(path.join(globalDir, 'opencode.jsonc'), text);
    expect(() => readConfigLayers()).toThrow('Invalid JSONC');
    expect(() => writeConfig({ model: 'new' }, file)).toThrow('Invalid JSONC');
    expect(() => writeConfigText('{}', file)).toThrow('Invalid JSONC');
    expect(fs.readFileSync(file, 'utf8')).toBe(text);
    expect(fs.existsSync(`${file}.openchamber.backup`)).toBe(false);
  });

  it('propagates read failures instead of returning empty success', () => {
    const original = fs.readFileSync;
    vi.spyOn(fs, 'readFileSync').mockImplementation((file, ...args) => {
      if (String(file) === path.join(globalDir, 'opencode.json')) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return original(file, ...args);
    });
    expect(() => readConfigLayers()).toThrow('denied');
  });
});

describe('structural JSONC writes', () => {
  it.each(['absolute', 'relative'])('preserves a %s dotfiles symlink while updating its target, permissions and backup', (kind) => {
    const original = '{ // dotfiles comment\n "model":"old"\n}';
    const target = put(path.join(root, 'dotfiles', 'config.jsonc'), original);
    fs.chmodSync(target, 0o664);
    fs.mkdirSync(globalDir, { recursive: true });
    const file = path.join(globalDir, 'opencode.jsonc');
    const link = kind === 'relative' ? path.relative(globalDir, target) : target;
    fs.symlinkSync(link, file);

    writeConfig({ model: 'new' }, file);
    expect(fs.lstatSync(file).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(file)).toBe(link);
    expect(readConfigFile(target)).toEqual({ model: 'new' });
    expect(fs.readFileSync(target, 'utf8')).toContain('// dotfiles comment');
    expect(fs.statSync(target).mode & 0o777).toBe(0o664);
    expect(fs.readFileSync(`${file}.openchamber.backup`, 'utf8')).toBe(original);
    expect(fs.existsSync(`${target}.openchamber.backup`)).toBe(false);

    const structured = fs.readFileSync(target, 'utf8');
    writeConfigText('{"model":"raw"}', file);
    expect(fs.readlinkSync(file)).toBe(link);
    expect(readConfigFile(target)).toEqual({ model: 'raw' });
    expect(fs.statSync(target).mode & 0o777).toBe(0o664);
    expect(fs.readFileSync(`${file}.openchamber.backup`, 'utf8')).toBe(structured);
  });

  it.each(['writeFileSync', 'chmodSync', 'copyFileSync', 'renameSync'])('preserves a symlink and its original target when %s fails', (method) => {
    const original = '{ // retained\n "model":"old"\n}';
    const target = put(path.join(root, 'dotfiles', 'config.jsonc'), original);
    fs.chmodSync(target, 0o640);
    fs.mkdirSync(globalDir, { recursive: true });
    const file = path.join(globalDir, 'opencode.jsonc');
    const link = path.relative(globalDir, target);
    fs.symlinkSync(link, file);
    vi.spyOn(fs, method).mockImplementation(() => { throw new Error('simulated IO failure'); });
    expect(() => writeConfig({ model: 'new' }, file)).toThrow('simulated IO failure');
    expect(fs.readlinkSync(file)).toBe(link);
    expect(fs.readFileSync(target, 'utf8')).toBe(original);
    expect(fs.statSync(target).mode & 0o777).toBe(0o640);
    for (const dir of [globalDir, path.dirname(target)]) {
      expect(fs.readdirSync(dir).some((name) => name.endsWith('.tmp'))).toBe(false);
    }
  });

  it.each(['structured', 'raw'])('rejects a dangling symlink during a %s write without replacing it', (kind) => {
    fs.mkdirSync(globalDir, { recursive: true });
    const file = path.join(globalDir, 'opencode.jsonc');
    const link = '../../dotfiles/missing.jsonc';
    fs.symlinkSync(link, file);
    const write = () => kind === 'structured' ? writeConfig({ model: 'new' }, file) : writeConfigText('{}', file);
    expect(write).toThrow(expect.objectContaining({ code: 'ENOENT' }));
    expect(fs.readlinkSync(file)).toBe(link);
    expect(fs.existsSync(path.resolve(globalDir, link))).toBe(false);
    expect(fs.readdirSync(globalDir)).toEqual(['opencode.jsonc']);
  });

  it('edits nested values, adds fields and removes fields without losing surrounding comments or unrelated bytes', () => {
    const original = '\uFEFF{\r\n\t// model comment\r\n\t"model": "old",\r\n\t"agent": {"review": {/* owned */ "model":"old", "remove":true, /* trailing */}},\r\n\t// unrelated field\r\n\t"unrelated" : [ 1, 2 ], // leave alone\r\n}\r\n';
    const file = put(path.join(globalDir, 'opencode.jsonc'), original);
    const config = readConfigFile(file);
    config.model = 'new';
    config.agent.review.model = 'new';
    delete config.agent.review.remove;
    config.agent.review.description = 'added';
    writeConfig(config, file);
    const saved = fs.readFileSync(file, 'utf8');
    expect(readConfigFile(file)).toEqual(config);
    for (const comment of ['// model comment', '/* owned */', '/* trailing */', '// unrelated field', '// leave alone']) expect(saved).toContain(comment);
    expect(saved).toContain('\t"unrelated" : [ 1, 2 ], // leave alone\r\n');
    expect(saved.startsWith('\uFEFF')).toBe(true);
    expect(fs.readFileSync(`${file}.openchamber.backup`, 'utf8')).toBe(original);
    writeConfig(config, file);
    expect(fs.readFileSync(file, 'utf8')).toBe(saved);
    expect(fs.readFileSync(`${file}.openchamber.backup`, 'utf8')).toBe(original);
  });

  it.each([
    '{/* before */ "only":1, /* after , */}',
    '{"keep":2, /* before */ "only":1 /* after */}',
    '{/* before */ "only":1, /* after */ "keep":2}',
  ])('removes a property and its comma from %s', (text) => {
    const file = put(path.join(globalDir, 'opencode.jsonc'), text);
    const desired = readConfigFile(file);
    delete desired.only;
    writeConfig(desired, file);
    expect(readConfigFile(file)).toEqual(desired);
    expect(fs.readFileSync(file, 'utf8')).toContain('/* before */');
    expect(fs.readFileSync(file, 'utf8')).toContain('/* after');
  });

  it.each(['', '// notes without newline', '{"old":1}'])('supports new/empty/comment-only/JSON files (%s)', (text) => {
    const file = path.join(globalDir, 'opencode.json');
    if (text) put(file, text);
    writeConfig({ model: 'new', nested: { enabled: true } }, file);
    expect(readConfigFile(file)).toEqual({ model: 'new', nested: { enabled: true } });
    if (text.startsWith('//')) expect(fs.readFileSync(file, 'utf8')).toContain(text);
  });

  it.each(['writeFileSync', 'copyFileSync', 'renameSync'])('keeps original content and cleans temporary files when %s fails', (method) => {
    const original = '{ // retained\n "model":"old"\n}';
    const file = put(path.join(globalDir, 'opencode.jsonc'), original);
    vi.spyOn(fs, method).mockImplementation(() => { throw new Error('simulated IO failure'); });
    expect(() => writeConfig({ model: 'new' }, file)).toThrow('simulated IO failure');
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
    expect(fs.readdirSync(globalDir).some((name) => name.endsWith('.tmp'))).toBe(false);
  });
});
