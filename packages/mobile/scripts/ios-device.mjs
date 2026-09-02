// Install / launch the debug .app on a connected iOS device via devicectl.
//
// Mirrors scripts/ios-sim.mjs for the simulator. Run through with-mobile-env.mjs.
// Build the app first with `bun run build:ios:device`; `run` installs + launches it.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const mobileRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE_ID = process.env.IOS_DEV_BUNDLE_ID || 'com.yeewang.openchamber.dev';

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    cwd: mobileRoot,
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

// `devicectl` writes its human table to stdout and only then appends the JSON
// payload, so the report has to be read from a file: anything parsing stdout
// meets the table first. Read it into a temp file rather than /dev/stdout.
const listDevices = () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'openchamber-devicectl-'));
  const reportPath = path.join(directory, 'devices.json');
  try {
    run('xcrun', ['devicectl', 'list', 'devices', '--json-output', reportPath], { capture: true });
    return JSON.parse(readFileSync(reportPath, 'utf8'))?.result?.devices ?? [];
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

// The payload carries no single "usable" flag, and current Xcode omits the
// `connectionState` field entirely — so rank on what it does report. A paired
// device is reachable unless its tunnel is `unavailable`; devicectl opens a
// `disconnected` tunnel on demand when the install runs.
const TUNNEL_RANK = { connected: 2, disconnected: 1 };

const reachableDevices = () => listDevices()
  .map((device) => {
    const connection = device?.connectionProperties ?? {};
    const tunnelRank = TUNNEL_RANK[String(connection.tunnelState ?? '').toLowerCase()] ?? 0;
    return {
      // install/launch address the CoreDevice identifier, not the hardware UDID
      // that xcodebuild wants for `-destination`.
      identifier: device?.identifier || device?.hardwareProperties?.udid || '',
      name: device?.deviceProperties?.name?.trim() || 'unnamed device',
      paired: String(connection.pairingState ?? '').toLowerCase() === 'paired',
      tunnelRank,
      // Wired outranks the same phone offered over the local network only.
      rank: tunnelRank * 2 + (connection.transportType === 'wired' ? 1 : 0),
    };
  })
  .filter((device) => device.identifier && device.paired && device.tunnelRank > 0)
  .sort((left, right) => right.rank - left.rank);

const connectedDevice = () => {
  if (process.env.IOS_DEVICE_UDID) {
    return process.env.IOS_DEVICE_UDID;
  }

  const candidates = reachableDevices();
  if (candidates.length === 0) {
    throw new Error('No reachable iOS device found. Connect your iPhone, unlock it, and trust this Mac.');
  }

  // Refuse to guess only between equals. A wired phone beside a stale
  // local-network entry, or beside hardware whose tunnel is unavailable, is not
  // an ambiguous choice, and failing there would make the common case unusable.
  const tied = candidates.filter((device) => device.rank === candidates[0].rank);
  if (tied.length > 1) {
    const names = tied.map((device) => `${device.name} (${device.identifier})`).join(', ');
    throw new Error(`Multiple iOS devices are equally reachable: ${names}. Set IOS_DEVICE_UDID to choose one.`);
  }
  return candidates[0].identifier;
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
