import { forceCloseHttpServerConnections } from './http-server-connections.js';

export const createGracefulShutdownRuntime = (dependencies) => {
  const {
    process,
    shutdownTimeoutMs,
    getExitOnShutdown,
    getIsShuttingDown,
    setIsShuttingDown,
    syncToHmrState,
    openCodeWatcherRuntime,
    sessionRuntime,
    sessionTitleRuntime,
    sessionGoalRuntime,
    questionAutoDelegateRuntime,
    scheduledTasksRuntime,
    getHealthCheckInterval,
    clearHealthCheckInterval,
    getTerminalRuntime,
    setTerminalRuntime,
    getMessageStreamRuntime,
    setMessageStreamRuntime,
    shouldSkipOpenCodeStop,
    getOpenCodePort,
    getOpenCodeProcess,
    setOpenCodeProcess,
    waitForPortRelease,
    getServer,
    getUiAuthController,
    setUiAuthController,
    tunnelAuthController,
    closeFeatureRoutes,
  } = dependencies;

  let shutdownPromise = null;

  const runShutdown = async (options = {}) => {
    if (getIsShuttingDown()) return;

    setIsShuttingDown(true);
    syncToHmrState();
    console.log('Starting graceful shutdown...');
    const exitProcess = typeof options.exitProcess === 'boolean' ? options.exitProcess : getExitOnShutdown();

    openCodeWatcherRuntime.stop();
    sessionRuntime.dispose();
    sessionTitleRuntime?.stop?.();
    sessionGoalRuntime?.stop?.();
    questionAutoDelegateRuntime?.dispose?.();
    // Stop timers/queue only. Keep the process-lifetime run history store open so
    // in-flight attach/finalize can still write, and so exitProcess:false restarts
    // can reuse the same global singleton without reopening a closed SQLite handle.
    scheduledTasksRuntime?.stop?.();
    closeFeatureRoutes?.();

    const healthCheckInterval = getHealthCheckInterval();
    if (healthCheckInterval) {
      clearHealthCheckInterval(healthCheckInterval);
    }

    const terminalRuntime = getTerminalRuntime();
    if (terminalRuntime) {
      try {
        await terminalRuntime.shutdown();
      } catch {
      } finally {
        setTerminalRuntime(null);
      }
    }

    const messageStreamRuntime = getMessageStreamRuntime();
    if (messageStreamRuntime) {
      try {
        await messageStreamRuntime.close();
      } catch {
      } finally {
        setMessageStreamRuntime(null);
      }
    }

    if (!shouldSkipOpenCodeStop()) {
      const portToRelease = getOpenCodePort();
      const openCodeProcess = getOpenCodeProcess();

      if (openCodeProcess) {
        console.log('Stopping OpenCode process...');
        try {
          // close() owns SIGTERM→SIGKILL on this child handle. Never re-kill a
          // numeric pid captured before close — it may already be recycled.
          await openCodeProcess.close();
        } catch (error) {
          console.warn('Error closing OpenCode process:', error);
        }
        setOpenCodeProcess(null);
      }

      // Probe only after owned close. Do not mass-kill by port (clients / external).
      if (!(await waitForPortRelease(portToRelease, 5000))) {
        console.warn(`Timed out waiting for OpenCode port ${portToRelease} to be released during shutdown`);
      }
    } else {
      console.log('Skipping OpenCode shutdown (external server)');
    }

    const server = getServer();
    if (server) {
      let closeTimeout = null;
      try {
        await Promise.race([
          new Promise((resolve) => {
            // Stop accepting first. closeAllConnections drops plain HTTP sockets
            // but leaves upgraded WS/SSE; destroy tracked server-owned leftovers
            // so the close callback can fire without waiting SHUTDOWN_TIMEOUT.
            server.close(() => {
              console.log('HTTP server closed');
              resolve();
            });
            if (options.forceCloseConnections === true) {
              const { destroyedTracked } = forceCloseHttpServerConnections(server);
              if (destroyedTracked > 0) {
                console.log(`Forced close of ${destroyedTracked} remaining server socket(s)`);
              }
            }
          }),
          new Promise((resolve) => {
            closeTimeout = setTimeout(() => {
              console.warn('Server close timeout reached, forcing shutdown');
              resolve();
            }, shutdownTimeoutMs);
          }),
        ]);
      } finally {
        if (closeTimeout) {
          clearTimeout(closeTimeout);
        }
      }
    }

    const uiAuthController = getUiAuthController();
    if (uiAuthController) {
      uiAuthController.dispose();
      setUiAuthController(null);
    }

    tunnelAuthController?.clearActiveTunnel?.();

    console.log('Graceful shutdown complete');
    if (exitProcess) {
      process.exit(0);
    }
  };

  const gracefulShutdown = (options = {}) => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = runShutdown(options);
    return shutdownPromise;
  };

  return {
    gracefulShutdown,
  };
};
