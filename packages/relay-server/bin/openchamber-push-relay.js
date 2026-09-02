#!/usr/bin/env node
import packageJson from '../package.json' with { type: 'json' };

import { isModuleCliExecution } from './cli-entry.js';
import { runPushRelayCli } from '../src/push/cli.js';

const version = packageJson.version;

if (isModuleCliExecution(process.argv[1], import.meta.url, undefined, 'openchamber-push-relay')) {
  runPushRelayCli(process.argv.slice(2), { version }).then((code) => { process.exitCode = code; });
}
