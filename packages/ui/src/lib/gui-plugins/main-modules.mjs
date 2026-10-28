// The pinned GUI ABI is owned here for both processes. Electron bundles this map;
// renderer entrypoints must never import it (Solid is intentionally absent).
import * as gui from '@opencode/plugin/gui/main';
import * as effect from 'effect';
import * as rpc from '@opencode/plugin/rpc';
import * as schema from '@yuriai/opencode-gui-schema/rpc';
import * as client from '@yuriai/opencode-gui-client';
import * as effectClient from '@yuriai/opencode-gui-client/effect';

export const mainModules = {
  '@opencode/plugin/gui': gui,
  '@opencode/plugin/gui/main': gui,
  effect,
  '@opencode/plugin/rpc': rpc,
  '@opencode/schema/rpc': schema,
  '@opencode/client': client,
  '@opencode/client/effect': effectClient,
};
