import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  MANAGED_SCHEDULED_TASK_TOKEN_HEADER,
  MANAGED_SCHEDULED_TASK_TOOL_PATH,
} from '../scheduled-tasks/managed-tool-contract.js';

const RESOURCE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'managed-capabilities');

const stableEntryKey = (value) => typeof value === 'string' ? `string:${value}` : `json:${JSON.stringify(value)}`;
const stableDedupe = (values) => {
  const result = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const key = stableEntryKey(value);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
};

export const mergeManagedOpenCodeConfig = ({ configContent, pluginUrl, instructionsUrl }) => {
  let config = {};
  if (typeof configContent === 'string' && configContent.trim()) {
    try {
      config = JSON.parse(configContent);
    } catch (error) {
      throw new Error(`Invalid OPENCODE_CONFIG_CONTENT JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      throw new Error('Invalid OPENCODE_CONFIG_CONTENT JSON: expected an object');
    }
  }
  return JSON.stringify({
    ...config,
    plugin: stableDedupe([...(typeof config.plugin === 'undefined' ? [] : Array.isArray(config.plugin) ? config.plugin : [config.plugin]), pluginUrl]),
    instructions: stableDedupe([...(typeof config.instructions === 'undefined' ? [] : Array.isArray(config.instructions) ? config.instructions : [config.instructions]), instructionsUrl]),
  });
};

export const createManagedCapabilitiesRuntime = ({
  dataDir = process.env.OPENCHAMBER_DATA_DIR || path.join(os.homedir(), '.local', 'share', 'openchamber'),
  version = '1',
  fsLike = fs,
  cryptoLike = crypto,
  pathLike = path,
  resourceDir = RESOURCE_DIR,
  getManagedChildPid = () => null,
  isManagedChildAlive = () => false,
} = {}) => {
  let bridgeOrigin = null;
  let identity = null;
  const safeVersion = String(version).replace(/[^A-Za-z0-9._-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'capability';
  const sourcePluginPath = pathLike.join(resourceDir, 'scheduled-task.js');
  const sourceInstructionsPath = pathLike.join(resourceDir, 'scheduled-task-instructions.md');
  const materialFingerprint = cryptoLike.createHash('sha256')
    .update('scheduled-task.js\0')
    .update(readFileSync(sourcePluginPath))
    .update('\0scheduled-task-instructions.md\0')
    .update(readFileSync(sourceInstructionsPath))
    .digest('hex')
    .slice(0, 16);
  const materialVersion = `${safeVersion}-${materialFingerprint}`;

  const resourceDirectory = () => pathLike.join(dataDir, 'managed-opencode-capabilities', materialVersion);
  const resourcePaths = () => {
    const directory = resourceDirectory();
    return {
      directory,
      pluginPath: pathLike.join(directory, 'scheduled-task.mjs'),
      instructionsPath: pathLike.join(directory, 'scheduled-task-instructions.md'),
    };
  };

  const publishResources = async () => {
    const target = resourceDirectory();
    try {
      await fsLike.access(pathLike.join(target, 'scheduled-task.mjs'));
      await fsLike.access(pathLike.join(target, 'scheduled-task-instructions.md'));
      return resourcePaths();
    } catch {
    }
    const parent = pathLike.dirname(target);
    await fsLike.mkdir(parent, { recursive: true });
    const temporary = pathLike.join(parent, `.${materialVersion}.${cryptoLike.randomBytes(8).toString('hex')}.tmp`);
    try {
      await fsLike.mkdir(temporary);
      await Promise.all([
        fsLike.copyFile(sourcePluginPath, pathLike.join(temporary, 'scheduled-task.mjs')),
        fsLike.copyFile(sourceInstructionsPath, pathLike.join(temporary, 'scheduled-task-instructions.md')),
      ]);
      try {
        await fsLike.rename(temporary, target);
      } catch (error) {
        if (error?.code !== 'EEXIST' && error?.code !== 'ENOTEMPTY') throw error;
        try {
          await fsLike.access(pathLike.join(target, 'scheduled-task.mjs'));
          await fsLike.access(pathLike.join(target, 'scheduled-task-instructions.md'));
          await fsLike.rm(temporary, { recursive: true, force: true });
        } catch {
          await fsLike.rm(target, { recursive: true, force: true });
          await fsLike.rename(temporary, target);
        }
      }
      return resourcePaths();
    } catch (error) {
      await fsLike.rm(temporary, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  };

  const setBridgeOrigin = (origin) => {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) {
      throw new Error('Managed scheduled-task bridge requires a loopback HTTP origin');
    }
    bridgeOrigin = parsed.origin;
  };

  const publishHostShim = async () => {
    const sourceDir = pathLike.join(pathLike.dirname(fileURLToPath(import.meta.url)), 'v2-plugin-host-shim');
    const target = pathLike.join(dataDir, 'managed-opencode-capabilities', 'v2-plugin-host-shim');
    await fsLike.mkdir(target, { recursive: true });
    await Promise.all(['package.json', 'index.mjs'].map((name) => fsLike.copyFile(pathLike.join(sourceDir, name), pathLike.join(target, name))));
    return target;
  };

  const prepareManagedChildEnv = async (baseEnv = {}) => {
    if (!bridgeOrigin) throw new Error('Managed scheduled-task bridge origin is unavailable');
    const [{ pluginPath, instructionsPath }, shimDirectory] = await Promise.all([
      publishResources(),
      publishHostShim(),
    ]);
    const token = cryptoLike.randomBytes(32).toString('hex');
    const pluginUrl = pathToFileURL(pluginPath).href;
    identity = { version: materialVersion, origin: bridgeOrigin, token, childPid: null };
    const merged = JSON.parse(mergeManagedOpenCodeConfig({ configContent: baseEnv.OPENCODE_CONFIG_CONTENT, pluginUrl, instructionsUrl: instructionsPath }));
    merged.plugin = stableDedupe([...(Array.isArray(merged.plugin) ? merged.plugin : []), shimDirectory]);
    return {
      ...baseEnv,
      OPENCODE_CONFIG_CONTENT: JSON.stringify(merged),
      OPENCHAMBER_SCHEDULED_TASK_BRIDGE_ORIGIN: bridgeOrigin,
      OPENCHAMBER_SCHEDULED_TASK_BRIDGE_PATH: MANAGED_SCHEDULED_TASK_TOOL_PATH,
      OPENCHAMBER_SCHEDULED_TASK_TOKEN_HEADER: MANAGED_SCHEDULED_TASK_TOKEN_HEADER,
      OPENCHAMBER_SCHEDULED_TASK_BRIDGE_TOKEN: token,
    };
  };

  const recordManagedChildPid = (childPid) => {
    if (identity && Number.isInteger(childPid) && childPid > 0) identity = { ...identity, childPid };
  };
  const setCapabilityIdentity = (value) => { identity = value || null; };
  const getCapabilityIdentity = () => identity;
  const hasValidIdentity = () => Boolean(
    identity?.version === materialVersion
    && identity.origin === bridgeOrigin
    && typeof identity.token === 'string'
    && identity.token.length === 64
    && Number.isInteger(identity.childPid)
    && identity.childPid > 0
    && getManagedChildPid() === identity.childPid
    && isManagedChildAlive(identity.childPid)
  );
  const authorizeManagedOpenCodeBridgeRequest = (req) => {
    let requestPath = '';
    try {
      requestPath = new URL(req?.originalUrl || req?.url || req?.path || '', 'http://127.0.0.1').pathname;
    } catch {
      return false;
    }
    if (!hasValidIdentity() || req?.method !== 'POST' || requestPath !== MANAGED_SCHEDULED_TASK_TOOL_PATH) return false;
    const address = req.socket?.remoteAddress || req.connection?.remoteAddress;
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address)) return false;
    const provided = req.headers?.[MANAGED_SCHEDULED_TASK_TOKEN_HEADER];
    if (typeof provided !== 'string' || provided.length !== identity.token.length) return false;
    const providedBuffer = Buffer.from(provided);
    const expectedBuffer = Buffer.from(identity.token);
    if (providedBuffer.length !== expectedBuffer.length) return false;
    return cryptoLike.timingSafeEqual(providedBuffer, expectedBuffer);
  };

  return { publishResources, setBridgeOrigin, prepareManagedChildEnv, recordManagedChildPid, getCapabilityIdentity, setCapabilityIdentity, hasValidIdentity, authorizeManagedOpenCodeBridgeRequest };
};
