import { describe, expect, it } from 'vitest';
import { evaluateGuiBundle } from './bundle';

describe('the OpenCode CommonJS GUI ABI', () => {
  it.each(['module.exports', 'exports.default'])('accepts the standard %s default export', (target) => {
    const plugin = evaluateGuiBundle(`const { Plugin } = require('@opencode/plugin/gui'); ${target} = Plugin.define({ setup() {} });`);
    expect(typeof plugin.setup).toBe('function');
  });

  it('shares Solid and SDK module instances and leaves main unevaluated', () => {
    const plugin = evaluateGuiBundle(`
      const { Plugin, Command } = require('@opencode/plugin/gui');
      const solid = require('solid-js');
      const electron = require('electron');
      const fs = require('node:fs');
      const hoisted = new electron.WebContentsView();
      fs.readFileSync('unused');
      if (solid !== require('solid-js')) throw new Error('duplicate solid');
      module.exports = Plugin.define({ setup(ctx) { ctx.add(Command, { id: 'ok', title: 'ok', run() {} }); }, main() { throw new Error('must never run'); } });
    `);
    expect(plugin.setup).toBeTypeOf('function');
  });

  it.each([
    ['module.exports = {}', 'window setup'],
    ['exports.default = {main(){}}', 'main-only'],
    ['exports.default = {setup(){}, stores:{bad:{scope:"global", schema:{},initial:{}}}}', 'store declaration'],
    ['exports.default = {setup(){}, i18n:{en:()=>({})}}', 'inline string'],
    ['exports.default = {setup(){}, os:["macos"]}', 'native GUI host'],
    ['require("solid-js/dist/solid.js")', 'Unsupported GUI shared module'],
    ['require("@opencode/plugin/gui/yuri-host")', 'Unsupported GUI shared module'],
  ])('rejects unsupported or malformed bundles without changing the shared host: %s', (code, error) => {
    expect(() => evaluateGuiBundle(code)).toThrow(error);
    expect(evaluateGuiBundle('exports.default = { setup() {} }').setup).toBeTypeOf('function');
  });
});
