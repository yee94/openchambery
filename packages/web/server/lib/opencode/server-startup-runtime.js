export const createServerStartupRuntime = (dependencies) => {
  const {
    process,
    server,
    gracefulShutdown,
    getSignalsAttached,
    setSignalsAttached,
    syncToHmrState,
  } = dependencies;

  const resolveBindHost = (host) =>
    host
    || (typeof process.env.OPENCHAMBER_HOST === 'string' && process.env.OPENCHAMBER_HOST.trim().length > 0
      ? process.env.OPENCHAMBER_HOST.trim()
      : '127.0.0.1');

  const startListeningAndMaybeTunnel = async ({
    port,
    bindHost,
  }) => {
    let activePort = port;

    await new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off('error', onError);
        reject(error);
      };
      server.once('error', onError);
      const onListening = async () => {
        server.off('error', onError);
        try {
          const addressInfo = server.address();
          activePort = typeof addressInfo === 'object' && addressInfo ? addressInfo.port : port;

          if (typeof process.send === 'function') {
            if (!process.connected) {
              throw new Error('OpenChamber startup IPC channel disconnected before ready notification');
            }

            await new Promise((resolveReadyNotification, rejectReadyNotification) => {
              try {
                process.send({ type: 'openchamber:ready', port: activePort }, (error) => {
                  if (error) {
                    rejectReadyNotification(error);
                    return;
                  }
                  resolveReadyNotification();
                });
              } catch (error) {
                rejectReadyNotification(error);
              }
            });
          }

          const displayHost = (bindHost === '0.0.0.0' || bindHost === '::' || bindHost === '[::]')
            ? 'localhost'
            : (bindHost.includes(':') ? `[${bindHost}]` : bindHost);
          console.log(`OpenChamber server listening on ${bindHost}:${activePort}`);
          console.log(`Health check: http://${displayHost}:${activePort}/health`);
          console.log(`Web interface: http://${displayHost}:${activePort}`);

          resolve();
        } catch (error) {
          reject(error);
        }
      };

      server.listen(port, bindHost, onListening);
    });

    return { activePort };
  };

  const attachProcessHandlers = ({ attachSignals }) => {
    if (attachSignals && !getSignalsAttached()) {
      const handleSignal = async () => {
        await gracefulShutdown();
      };
      // Cover every signal a shell or dev harness may use to stop/restart us, so
      // the managed OpenCode child is always torn down gracefully instead of
      // orphaned: SIGINT/SIGQUIT (Ctrl+C/Ctrl+\), SIGTERM (kill/default), SIGHUP
      // (terminal close), SIGUSR2 (nodemon restart for `dev:server:watch`).
      process.on('SIGTERM', handleSignal);
      process.on('SIGINT', handleSignal);
      process.on('SIGQUIT', handleSignal);
      process.on('SIGHUP', handleSignal);
      process.on('SIGUSR2', handleSignal);
      setSignalsAttached(true);
      syncToHmrState();
    }

    process.on('unhandledRejection', (reason, promise) => {
      console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    });

    process.on('uncaughtException', (error) => {
      console.error('Uncaught Exception:', error);
      gracefulShutdown();
    });
  };

  return {
    resolveBindHost,
    startListeningAndMaybeTunnel,
    attachProcessHandlers,
  };
};
