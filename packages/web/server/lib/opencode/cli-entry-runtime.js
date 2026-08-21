export const runCliEntryIfMain = (dependencies) => {
  const {
    process,
    currentFilename,
    parseServeCliOptions,
    defaultPort,
    setExitOnShutdown,
    startServer,
  } = dependencies;

  const isCliExecution = process.argv[1] === currentFilename;
  if (!isCliExecution) {
    return;
  }

  // Direct `node server/index.js` is the standalone web/dev server. Never inherit
  // OPENCHAMBER_RUNTIME=desktop from the parent shell — that would open a relay
  // host-control socket from `bun run dev` / `dev:server`. Electron sets desktop
  // before importing this module and never takes this CLI path.
  process.env.OPENCHAMBER_RUNTIME = 'web';

  const cliOptions = parseServeCliOptions({
    argv: process.argv.slice(2),
    env: process.env,
    defaultPort,
  });

  setExitOnShutdown(true);
  startServer({
    port: cliOptions.port,
    host: cliOptions.host,
    attachSignals: true,
    exitOnShutdown: true,
    uiPassword: cliOptions.uiPassword,
    apiOnly: cliOptions.apiOnly,
  }).catch((error) => {
    console.error('Failed to start server:', error);
    process.exit(1);
  });
};
