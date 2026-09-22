#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { isModuleCliExecution } from './cli-entry.js';
import { EXIT_CODE, TunnelCliError } from './lib/cli-errors.js';
import {
  resolveServeHost,
  hasUiPasswordConfigured,
  assertAuthenticatedNetworkExposure,
} from './lib/cli-network.js';
import {
  parseArgs,
  showHelp,
  showStartupHelp,
  showConnectUrlHelp,
  findClosestMatch,
} from './lib/cli-args.js';
import { readDesktopLocalPortFromSettings } from './lib/cli-paths.js';
import { searchPathFor } from './lib/cli-executables.js';
import {
  assertOpenCode2Binary,
  readConfiguredOpenCodeBinary,
} from './lib/cli-startup.js';
import { ensurePinnedOpenCode2Cli } from '../server/lib/opencode/ensure-cli.js';
import { startupCommand } from './lib/commands-startup.js';
import { logsCommand } from './lib/commands-logs.js';
import { statusCommand } from './lib/commands-status.js';
import { createUpdateCommand } from './lib/commands-update.js';
import { createConnectUrlCommand } from './lib/commands-connect-url.js';
import { createLifecycleCommands } from './lib/commands-lifecycle.js';
import { createServeCommand } from './lib/commands-serve.js';
import {
  discoverRunningInstances,
  discoverOpenChamberInstanceOnPort,
  discoverLifecycleInstances,
  discoverUnconfirmedRegistryInstanceOnPort,
} from './lib/cli-lifecycle.js';
import {
  fetchSystemInfoFromPort,
} from './lib/cli-http.js';
import {
  getPidFilePath,
  getInstanceFilePath,
  isProcessRunning,
  isOpenchamberCmdline,
  isOpenchamberProcessRunning,
  getOpenchamberProcessState,
} from './lib/cli-process.js';
import {
  intro as clackIntro, outro as clackOutro, cancel as clackCancel,
  isJsonMode,
  printJson,
  logStatus,
} from './cli-output.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PACKAGE_JSON = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

let activeCommandOptions = null;
let foregroundServerActive = false;
let foregroundShutdown = null;

const HAS_PLAIN_FLAG = process.argv.includes('--plain');
const STYLE_ENABLED = process.stdout.isTTY && process.env.NO_COLOR !== '1' && !HAS_PLAIN_FLAG;
const ANSI = {
  bold: '\x1b[1m',
  unbold: '\x1b[22m',
};

function boldText(text) {
  if (!STYLE_ENABLED) return text;
  return `${ANSI.bold}${text}${ANSI.unbold}`;
}

function importFromFilePath(filePath) {
  return import(pathToFileURL(filePath).href);
}

// Binary validation is policy, not presentation: TTY, non-TTY, --quiet, and
// --json all run this same check before serve starts.
async function checkOpenCodeCLI(onNotice, options = {}) {
  if (process.env.OPENCODE_BINARY) {
    const override = assertOpenCode2Binary(process.env.OPENCODE_BINARY);
    if (override) {
      process.env.OPENCODE_BINARY = override;
      return override;
    }
    const message = `OPENCODE_BINARY="${process.env.OPENCODE_BINARY}" is not a usable OpenCode v2 CLI. Falling back to PATH lookup.`;
    if (typeof onNotice === 'function') {
      onNotice({ level: 'warning', code: 'OPENCODE_BINARY_INVALID', message });
    } else {
      console.warn(`Warning: ${message}`);
    }
  }

  const configured = readConfiguredOpenCodeBinary();
  if (configured) {
    const fromConfig = assertOpenCode2Binary(configured);
    if (fromConfig) {
      process.env.OPENCODE_BINARY = fromConfig;
      return fromConfig;
    }
  }

  let discovered = '';
  for (const name of ['opencode', 'opencode2']) {
    const resolvedFromPath = searchPathFor(name);
    if (!resolvedFromPath) continue;
    try {
      const verified = assertOpenCode2Binary(resolvedFromPath);
      if (verified) {
        discovered = verified;
        break;
      }
    } catch (error) {
      if (error?.code === 'OPENCODE_BINARY_INVALID') continue;
      throw error;
    }
  }
  const ensureCli = typeof options.ensurePinnedOpenCode2Cli === 'function'
    ? options.ensurePinnedOpenCode2Cli
    : ensurePinnedOpenCode2Cli;

  try {
    const ensured = await ensureCli({ discoveredPath: discovered });
    if (ensured?.path) {
      if (typeof onNotice === 'function' && ensured.installed) {
        onNotice({
          level: 'info',
          code: 'OPENCODE_CLI_INSTALLED',
          message: `Installed opencode ${ensured.version} to ${ensured.path}`,
        });
      }
      process.env.OPENCODE_BINARY = ensured.path;
      return ensured.path;
    }
  } catch (error) {
    if (error?.code === 'OPENCODE_CLI_MISSING') {
      throw new Error(
        `Unable to locate the opencode CLI on PATH (${process.env.PATH || '<empty>'}). ` +
        'Ensure OpenCode v2 is installed and reachable, or set OPENCODE_BINARY to its full path.'
      );
    }
    throw error;
  }

  throw new Error(
    `Unable to locate the opencode CLI on PATH (${process.env.PATH || '<empty>'}). ` +
    'Ensure OpenCode v2 is installed and reachable, or set OPENCODE_BINARY to its full path.'
  );
}

const commands = {
  serve: null,

  'connect-url': null,

  stop: null,

  restart: null,

  status: statusCommand,


  logs: logsCommand,

  startup: startupCommand,

  update: null,
};

commands.serve = createServeCommand({
  serverPath: path.join(__dirname, '..', 'server', 'index.js'),
  checkOpenCodeCLI,
  setForegroundServerActive(value) { foregroundServerActive = value; },
  setForegroundShutdown(handler) { foregroundShutdown = handler; },
});

{
  const lifecycleCommands = createLifecycleCommands({ serveCommand: commands.serve.bind(commands) });
  commands.stop = lifecycleCommands.stop;
  commands.restart = lifecycleCommands.restart;
}

commands['connect-url'] = createConnectUrlCommand({
  serveCommand: commands.serve.bind(commands),
});

commands.update = createUpdateCommand({
  importFromFilePath,
  packageManagerPath: path.join(__dirname, '..', 'server', 'lib', 'package-manager.js'),
  serveCommand: commands.serve.bind(commands),
});

async function main() {
  const parsed = parseArgs();
  const { command, startupAction, options, removedFlagErrors, helpRequested, versionRequested } = parsed;
  activeCommandOptions = options;

  if (versionRequested) {
    if (isJsonMode(options)) {
      printJson({ version: PACKAGE_JSON.version });
    } else {
      console.log(PACKAGE_JSON.version);
    }
    return;
  }

  if (removedFlagErrors.length > 0) {
    if (isJsonMode(options)) {
      printJson({
        status: 'error',
        error: {
          message: removedFlagErrors[0],
          details: removedFlagErrors,
        },
      });
    } else {
      for (const error of removedFlagErrors) {
        console.error(`Error: ${error}`);
      }
    }
    process.exit(1);
  }

  if (helpRequested) {
    if (command === 'startup') {
      showStartupHelp();
    } else if (command === 'connect-url') {
      showConnectUrlHelp();
    } else {
      showHelp();
    }
    return;
  }

  if (command === 'startup') {
    await commands.startup(options, startupAction);
    return;
  }

  if (!commands[command]) {
    const knownCommands = ['serve', 'stop', 'restart', 'status', 'startup', 'logs', 'connect-url', 'update'];
    const suggestion = findClosestMatch(command, knownCommands);
    const hint = suggestion ? ` Did you mean '${suggestion}'?` : '';
    if (isJsonMode(options)) {
      printJson({
        status: 'error',
        error: {
          message: `Unknown command '${command}'.${hint}`,
        },
        messages: [{ level: 'info', code: 'USAGE_HELP', message: 'Use --help to see available commands' }],
      });
    } else {
      console.error(`Error: Unknown command '${command}'.${hint}`);
      console.error('Use --help to see available commands');
    }
    process.exit(EXIT_CODE.USAGE_ERROR);
  }

  await commands[command](options);
}

const isCliExecution = isModuleCliExecution(process.argv[1], import.meta.url, fs.realpathSync, 'openchamber');

if (isCliExecution) {
  let isHandlingSigint = false;
  process.on('SIGINT', () => {
    if (isHandlingSigint) {
      return;
    }
    if (foregroundServerActive) {
      if (typeof foregroundShutdown === 'function') {
        void foregroundShutdown('SIGINT');
      }
      return;
    }
    isHandlingSigint = true;
    (async () => {
      clackCancel('Operation cancelled.');
      process.exit(130);
    })();
  });

  process.on('unhandledRejection', (reason, promise) => {
    if (isJsonMode(activeCommandOptions)) {
      printJson({
        status: 'error',
        error: {
          message: `Unhandled rejection: ${String(reason)}`,
        },
      });
    } else {
      console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    }
    process.exit(1);
  });

  process.on('uncaughtException', (error) => {
    if (isJsonMode(activeCommandOptions)) {
      printJson({
        status: 'error',
        error: {
          message: `Uncaught exception: ${error instanceof Error ? error.message : String(error)}`,
        },
      });
    } else {
      console.error('Uncaught Exception:', error);
    }
    process.exit(1);
  });

  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    if (isJsonMode(activeCommandOptions)) {
      printJson({
        status: 'error',
        error: {
          message,
        },
      });
    } else if (process.stdout?.isTTY && !HAS_PLAIN_FLAG) {
      clackIntro(boldText('Error'));
      logStatus('error', message);
      clackOutro('failed');
    } else {
      console.error(`Error: ${message}`);
    }
    const exitCode = error instanceof TunnelCliError ? error.exitCode : EXIT_CODE.GENERAL_ERROR;
    process.exit(exitCode);
  });
}

export {
  commands,
  parseArgs,
  assertAuthenticatedNetworkExposure,
  resolveServeHost,
  hasUiPasswordConfigured,
  readDesktopLocalPortFromSettings,
  getPidFilePath,
  getInstanceFilePath,
  isProcessRunning,
  isOpenchamberProcessRunning,
  isOpenchamberCmdline,
  getOpenchamberProcessState,
  fetchSystemInfoFromPort,
  discoverRunningInstances,
  discoverOpenChamberInstanceOnPort,
  discoverLifecycleInstances,
  discoverUnconfirmedRegistryInstanceOnPort,
  findClosestMatch,
  TunnelCliError,
  EXIT_CODE,
  checkOpenCodeCLI,
};
