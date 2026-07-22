// Install / launch the debug .app on a connected iOS device via devicectl.
//
// Mirrors scripts/ios-sim.mjs for the simulator. Run through with-mobile-env.mjs.
// Build the app first with `bun run build:ios:device`; `run` installs + launches it.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const mobileRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE_ID = process.env.IOS_DEV_BUNDLE_ID || 'com.yeewang.openchamber.dev';

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    env: process.env,
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    if (options.capture && result.stderr) process.stderr.write(result.stderr);
    throw new Error(`${command} ${args.join(' ')} exited with ${result.status ?? result.signal}`);
  }

  return result.stdout?.trim() ?? '';
};

const connectedDevice = () => {
  if (process.env.IOS_DEVICE_UDID) {
    return process.env.IOS_DEVICE_UDID;
  }

  // Prefer CoreDevice UUID for install/launch; fall back to matching the
  // connected row's Identifier column (not Hostname).
  const output = run('xcrun', ['devicectl', 'list', 'devices', '--json-output', '/dev/stdout'], { capture: true });
  try {
    const parsed = JSON.parse(output);
    const devices = parsed?.result?.devices || parsed?.devices || [];
    const connected = devices.find((device) => {
      const state = device?.connectionProperties?.connectionState || device?.state || '';
      return String(state).toLowerCase().includes('connected');
    });
    const identifier = connected?.identifier || connected?.hardwareProperties?.udid || connected?.coreDeviceIdentifier;
    if (identifier) return identifier;
  } catch {
    // Fall through to table parsing.
  }

  const line = output
    .split('\n')
    .find((entry) => entry.includes('connected') && !entry.startsWith('Name') && !entry.includes('{'));
  if (!line) {
    throw new Error('No connected iOS device found. Connect your iPhone and trust this Mac.');
  }

  // Columns: Name Hostname Identifier State Model — Identifier is a UUID.
  const match = line.match(/[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}/i);
  if (!match) {
    throw new Error('Unable to parse connected device UDID from devicectl output.');
  }
  return match[0];
};

const getBuiltAppPath = () => {
  const appPath = run('xcodebuild', [
    '-workspace', 'ios/App/App.xcworkspace',
    '-scheme', 'App',
    '-configuration', 'Debug',
    '-sdk', 'iphoneos',
    '-showBuildSettings',
  ], { capture: true })
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('TARGET_BUILD_DIR = '))
    ?.replace('TARGET_BUILD_DIR = ', '');

  if (!appPath) throw new Error('Unable to resolve iOS device build output directory.');
  const fullPath = path.join(appPath, 'App.app');
  if (!existsSync(fullPath)) {
    throw new Error(`Built app not found at ${fullPath}. Run bun run build:ios:device first.`);
  }
  return fullPath;
};

const command = process.argv[2];

switch (command) {
  case 'devices':
    run('xcrun', ['devicectl', 'list', 'devices']);
    break;
  case 'install': {
    const device = connectedDevice();
    run('xcrun', ['devicectl', 'device', 'install', 'app', '--device', device, getBuiltAppPath()]);
    break;
  }
  case 'launch': {
    const device = connectedDevice();
    run('xcrun', ['devicectl', 'device', 'process', 'launch', '--device', device, BUNDLE_ID]);
    break;
  }
  case 'run': {
    const device = connectedDevice();
    run('xcrun', ['devicectl', 'device', 'install', 'app', '--device', device, getBuiltAppPath()]);
    run('xcrun', ['devicectl', 'device', 'process', 'launch', '--device', device, BUNDLE_ID]);
    break;
  }
  default:
    console.error('Usage: node scripts/ios-device.mjs <devices|install|launch|run>');
    process.exit(1);
}
