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
