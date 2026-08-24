import { TunnelCliError, EXIT_CODE } from './cli-errors.js';

const DEFAULT_PORT = 3000;
const DEFAULT_TAIL_LINES = 200;

function levenshteinDistance(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function findClosestMatch(input, candidates, maxDistance = 3) {
  if (typeof input !== 'string' || input.length === 0 || !Array.isArray(candidates)) {
    return null;
  }
  const normalized = input.toLowerCase();
  let bestCandidate = null;
  let bestDistance = maxDistance + 1;
  for (const candidate of candidates) {
    const distance = levenshteinDistance(normalized, candidate.toLowerCase());
    if (distance < bestDistance) {
      bestDistance = distance;
      bestCandidate = candidate;
    }
  }
  return bestDistance <= maxDistance ? bestCandidate : null;
}

function splitOptionToken(arg) {
  if (!arg.startsWith('-')) return null;
  if (arg.startsWith('--')) {
    const eqIndex = arg.indexOf('=');
    return {
      name: eqIndex >= 0 ? arg.slice(2, eqIndex) : arg.slice(2),
      inlineValue: eqIndex >= 0 ? arg.slice(eqIndex + 1) : undefined,
      long: true,
    };
  }
  return {
    name: arg.slice(1),
    inlineValue: undefined,
    long: false,
  };
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = Array.isArray(argv) ? [...argv] : [];
  const options = {
    port: DEFAULT_PORT,
    host: undefined,
    uiPassword: process.env.OPENCHAMBER_UI_PASSWORD || undefined,
    json: false,
    all: false,
    follow: true,
    lines: DEFAULT_TAIL_LINES,
    name: undefined,
    hostname: undefined,
    server: undefined,
    qr: false,
    explicitQr: false,
    plain: false,
    quiet: false,
    explicitPort: false,
    explicitUiPassword: false,
    envSnapshot: true,
    foreground: false,
    lan: false,
    apiOnly: false,
    // false = unset; true = enable with default/stored URL; string = pin URL
    relayHost: false,
  };

  const removedFlagErrors = [];
  const positional = [];
  let helpRequested = false;
  let versionRequested = false;

  const consumeValue = (index, inlineValue) => {
    if (typeof inlineValue === 'string' && inlineValue.length > 0) {
      return { value: inlineValue, nextIndex: index };
    }
    const candidate = args[index + 1];
    if (typeof candidate === 'string' && !candidate.startsWith('-')) {
      return { value: candidate, nextIndex: index + 1 };
    }
    return { value: undefined, nextIndex: index };
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const parsedToken = splitOptionToken(arg);
    if (!parsedToken) {
      positional.push(arg);
      continue;
    }

    const { name, inlineValue, long } = parsedToken;
    switch (name) {
      case 'port':
      case 'p': {
        const { value: consumedValue, nextIndex: consumedIndex } = consumeValue(i, inlineValue);
        let value = consumedValue;
        let nextIndex = consumedIndex;

        // Support explicit negative numeric values like `-p -1` so we can report
        // a clear range validation error instead of "Unknown option".
        if (value === undefined && typeof inlineValue !== 'string') {
          const candidate = args[i + 1];
          if (typeof candidate === 'string' && /^-\d+$/.test(candidate)) {
            value = candidate;
            nextIndex = i + 1;
          }
        }

        i = nextIndex;

        if (typeof value !== 'string' || value.trim().length === 0) {
          throw new TunnelCliError('Missing value for --port.', EXIT_CODE.USAGE_ERROR);
        }

        if (!/^-?\d+$/.test(value.trim())) {
          throw new TunnelCliError(`Invalid port value: ${value}`, EXIT_CODE.USAGE_ERROR);
        }

        const parsed = parseInt(value, 10);
        if (parsed < 1 || parsed > 65535) {
          throw new TunnelCliError(`Invalid port value: ${parsed}`, EXIT_CODE.USAGE_ERROR);
        }

        options.port = parsed;
        options.explicitPort = true;
        break;
      }
      case 'host': {
        const { value, nextIndex } = consumeValue(i, inlineValue);
        i = nextIndex;
        if (typeof value !== 'string' || value.trim().length === 0) {
          throw new TunnelCliError('Missing value for --host.', EXIT_CODE.USAGE_ERROR);
        }
        options.host = value.trim();
        break;
      }
      case 'lan':
        options.lan = true;
        break;
      case 'ui-password': {
        const { value, nextIndex } = consumeValue(i, inlineValue);
        i = nextIndex;
        options.uiPassword = typeof value === 'string' ? value : '';
        options.explicitUiPassword = true;
        break;
      }
      case 'name': {
        const { value, nextIndex } = consumeValue(i, inlineValue);
        i = nextIndex;
        options.name = typeof value === 'string' ? value : options.name;
        break;
      }
      case 'hostname': {
        const { value, nextIndex } = consumeValue(i, inlineValue);
        i = nextIndex;
        options.hostname = typeof value === 'string' ? value : options.hostname;
        break;
      }
      case 'server':
      case 'server-url': {
        const { value, nextIndex } = consumeValue(i, inlineValue);
        i = nextIndex;
        if (typeof value !== 'string' || value.trim().length === 0) {
          throw new TunnelCliError('Missing value for --server.', EXIT_CODE.USAGE_ERROR);
        }
        options.server = value.trim();
        break;
      }
      case 'json':
        options.json = true;
        break;
      case 'all':
        options.all = true;
        break;
      case 'no-follow':
        options.follow = false;
        break;
      case 'no-env-snapshot':
        options.envSnapshot = false;
        break;
      case 'lines': {
        const { value, nextIndex } = consumeValue(i, inlineValue);
        i = nextIndex;
        const parsed = parseInt(value ?? '', 10);
        if (Number.isFinite(parsed) && parsed > 0) {
          options.lines = parsed;
        }
        break;
      }
      case 'relay':
        options.relay = true;
        break;
      case 'relay-host': {
        // Optional value: `--relay-host` enables with default/stored URL;
        // `--relay-host wss://…` (or `=`) pins a custom endpoint.
        const { value, nextIndex } = consumeValue(i, inlineValue);
        i = nextIndex;
        if (typeof value === 'string' && value.trim().length > 0) {
          options.relayHost = value.trim();
        } else {
          options.relayHost = true;
        }
        break;
      }
      case 'qr':
        options.qr = true;
        options.explicitQr = true;
        break;
      case 'no-qr':
        options.qr = false;
        options.explicitQr = true;
        break;
      case 'plain':
        options.plain = true;
        break;
      case 'quiet':
      case 'q':
        options.quiet = true;
        break;
      case 'help':
      case 'h':
        helpRequested = true;
        break;
      case 'version':
      case 'v':
        versionRequested = true;
        break;
      case 'foreground':
      case 'no-daemon':
        options.foreground = true;
        break;
      case 'api-only':
        options.apiOnly = true;
        break;
      case 'daemon':
      case 'd':
        // Legacy no-op: daemon mode is already the default, but older clients
        // may still pass this when starting a remote server.
        break;
      case 'try-cf-tunnel':
      case 'tunnel-qr':
      case 'tunnel-password-url':
      case 'tunnel-provider':
      case 'tunnel-mode':
      case 'tunnel-config':
      case 'tunnel-token':
      case 'tunnel-hostname':
      case 'tunnel':
        removedFlagErrors.push(`\`--${name}\` was removed. Use LAN pairing (\`openchamber connect-url\`) or private relay instead.`);
        break;
      default:
        if (!long && name.length === 1) {
          removedFlagErrors.push(`Unknown option: -${name}`);
        } else {
          removedFlagErrors.push(`Unknown option: --${name}`);
        }
        break;
    }
  }

  const command = positional[0] || 'serve';
  const startupAction = command === 'startup' ? (positional[1] || 'status') : null;

  if (options.lan && typeof options.host !== 'string') {
    options.host = '0.0.0.0';
  }

  if (typeof options.hostname === 'string' && typeof options.host !== 'string') {
    options.host = options.hostname;
  }

  return {
    command,
    startupAction,
    options,
    removedFlagErrors,
    helpRequested,
    versionRequested,
  };
}

function showHelp() {
  console.log(`
 OpenChamber - Web interface for the OpenCode AI coding agent

USAGE:
  openchamber [COMMAND] [OPTIONS]

COMMANDS:
  serve          Start the web server (daemon default)
  stop           Stop running instance(s)
  restart        Stop and start the server
  status         Show server status
  startup        Manage launch at system startup
  logs           Tail OpenChamber logs
  connect-url    Generate URL/QR for connecting another client
  update         Check for and install updates

OPTIONS:
  -p, --port              Web server port (default: ${DEFAULT_PORT})
  --host                  Bind address (default: 127.0.0.1)
  --hostname              Alias for --host
  --lan                   Bind to 0.0.0.0 for LAN access
  --server <url>          Public/server URL for connect-url links
  --relay                 connect-url: also include the end-to-end-encrypted relay transport
  --relay-host [url]      serve: enable the private relay host (desktop/SSH-remote only).
                          Optional ws(s) URL pins the relay endpoint.
  --ui-password           Protect browser UI with single password
  --api-only              Start API routes only, without serving browser UI assets
  --foreground            Run server in foreground (use with systemd/process managers)
  --no-daemon             Alias for --foreground
  -h, --help              Show help
  -v, --version           Show version

ENVIRONMENT:
  OPENCHAMBER_HOST             Bind address (e.g. 0.0.0.0 for all interfaces)
  OPENCHAMBER_UI_PASSWORD      Alternative to --ui-password flag
  OPENCHAMBER_API_ONLY         Set to true/1 to start API routes only
  OPENCHAMBER_DATA_DIR         Override OpenChamber data directory
  OPENCHAMBER_RELAY_URL        Pin private relay endpoint (ws:// or wss://)
  OPENCODE_HOST               External OpenCode server base URL, e.g. http://hostname:4096
  OPENCODE_PORT               Port of external OpenCode server to connect to
  OPENCODE_SKIP_START          Skip starting OpenCode, use external server
  OPENCHAMBER_OPENCODE_HOSTNAME  Bind hostname for managed OpenCode server (default: 127.0.0.1)

EXAMPLES:
  openchamber                    # Start in daemon mode on default port 3000 (or free port)
  openchamber --port 8080        # Start on port 8080 (daemon)
  openchamber --lan --port 3002  # Start on LAN at 0.0.0.0:3002
  openchamber serve --foreground # Start in foreground (for systemd Type=simple)
  openchamber serve --relay-host # Enable private relay host (SSH-managed remote)
  openchamber serve --relay-host wss://relay.example/ws
  openchamber connect-url --port 3000 --qr
  openchamber connect-url --server https://openchamber.example.com
  openchamber startup enable     # Start OpenChamber at user login
  openchamber logs               # Follow logs for latest running instance
`);
}

function showStartupHelp() {
  console.log(`
 OpenChamber Startup Commands

USAGE:
  openchamber startup <SUBCOMMAND> [OPTIONS]

SUBCOMMANDS:
  status      Show startup integration status
  enable      Install and start native user startup integration
  disable     Stop and remove native user startup integration

OPTIONS:
  -p, --port              Web server port used by startup service
  --host                  Bind address used by startup service
  --ui-password           Protect browser UI with single password
  --api-only              Start API routes only, without serving browser UI assets
  --no-env-snapshot       Do not save current environment for startup service
  --json                  Output machine-readable JSON
  -q, --quiet             Suppress non-essential output

EXAMPLES:
  openchamber startup enable
  openchamber startup enable --port 3000
  openchamber startup enable --port 3000 --api-only --host 0.0.0.0
  openchamber startup status --json
`);
}

function showConnectUrlHelp() {
  console.log(`
 OpenChamber Connect URL

USAGE:
  openchamber connect-url [OPTIONS]

DESCRIPTION:
  Generate an openchamber:// connection link for adding this server to another
  OpenChamber app. If no server is running on the selected port, it starts one.

OPTIONS:
  -p, --port <port>       Server port to use or start (default: ${DEFAULT_PORT})
  --host <address>        Bind address when starting the server
  --hostname <address>    Alias for --host
  --lan                   Bind to 0.0.0.0 for LAN access when starting
  --server <url>          Public URL saved into the connection link
  --server-url <url>      Alias for --server
  --relay                 Also include the end-to-end-encrypted relay transport
                          so the link works away from the local network. The
                          device prefers the direct connection when reachable;
                          the instance brings the relay up on its own. Set
                          OPENCHAMBER_RELAY_URL to use a self-hosted relay.
  --name <label>          Instance name stored on the connecting device
  --ui-password <value>   Protect browser access when UI routes are enabled
  --api-only              Start in headless/API-only mode when starting
  --qr                    Print a QR code for the connection link
  --json                  Output machine-readable JSON
  -q, --quiet             Print only the connection link
  -h, --help              Show this help

EXAMPLES:
  openchamber connect-url --port 3000 --qr
  openchamber connect-url --port 3000 --api-only --lan --server http://workstation.local:3000 --qr
  openchamber connect-url --server https://openchamber.example.com --name Workstation
  openchamber connect-url --relay --name "My laptop"
`);
}

export {
  DEFAULT_PORT,
  parseArgs,
  showHelp,
  showStartupHelp,
  showConnectUrlHelp,
  findClosestMatch,
};
