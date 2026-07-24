import { printTunnelWarning } from '../cloudflare-tunnel.js';
import { createTunnelService } from '../tunnels/index.js';
import { createTunnelRoutesRuntime } from '../tunnels/routes.js';

export const createTunnelWiringRuntime = (dependencies) => {
  const {
    crypto,
    URL,
    tunnelProviderRegistry,
    tunnelAuthController,
    readSettingsFromDiskMigrated,
    readManagedRemoteTunnelConfigFromDisk,
    normalizeTunnelProvider,
    normalizeTunnelMode,
    normalizeOptionalPath,
    normalizeManagedRemoteTunnelHostname,
    normalizeTunnelBootstrapTtlMs,
    normalizeTunnelSessionTtlMs,
    isSupportedTunnelMode,
    upsertManagedRemoteTunnelToken,
    resolveManagedRemoteTunnelToken,
    TUNNEL_MODE_QUICK,
    TUNNEL_MODE_MANAGED_LOCAL,
    TUNNEL_MODE_MANAGED_REMOTE,
    TUNNEL_PROVIDER_CLOUDFLARE,
    TunnelServiceError,
    getActiveTunnelController,
    setActiveTunnelController,
    getRuntimeManagedRemoteTunnelHostname,
    setRuntimeManagedRemoteTunnelHostname,
    getRuntimeManagedRemoteTunnelToken,
    setRuntimeManagedRemoteTunnelToken,
  } = dependencies;

  const initialize = (app, initialPort) => {
    let activePort = initialPort;

    const tunnelService = createTunnelService({
      registry: tunnelProviderRegistry,
      getController: getActiveTunnelController,
      setController: setActiveTunnelController,
      getActivePort: () => activePort,
      onQuickTunnelWarning: () => {
        printTunnelWarning();
      },
    });

    const tunnelRoutesRuntime = createTunnelRoutesRuntime({
      crypto,
      URL,
      tunnelService,
      tunnelProviderRegistry,
      tunnelAuthController,
      readSettingsFromDiskMigrated,
      readManagedRemoteTunnelConfigFromDisk,
      normalizeTunnelProvider,
      normalizeTunnelMode,
      normalizeOptionalPath,
      normalizeManagedRemoteTunnelHostname,
      normalizeTunnelBootstrapTtlMs,
      normalizeTunnelSessionTtlMs,
      isSupportedTunnelMode,
      upsertManagedRemoteTunnelToken,
      resolveManagedRemoteTunnelToken,
      TUNNEL_MODE_QUICK,
      TUNNEL_MODE_MANAGED_LOCAL,
      TUNNEL_MODE_MANAGED_REMOTE,
      TUNNEL_PROVIDER_CLOUDFLARE,
      TunnelServiceError,
      getActivePort: () => activePort,
      getRuntimeManagedRemoteTunnelHostname,
      setRuntimeManagedRemoteTunnelHostname,
      getRuntimeManagedRemoteTunnelToken,
      setRuntimeManagedRemoteTunnelToken,
      getActiveTunnelController,
      setActiveTunnelController,
    });

    tunnelRoutesRuntime.registerRoutes(app);

    // HAPI/tunwg keeps its key material and selected relay host under the
    // OpenChamber data directory. Restore the outbound channel on server start
    // so already-paired mobile devices keep working after both apps restart.
    const restoreHapiTunnel = async () => {
      const provider = tunnelProviderRegistry.get('hapi');
      const hostname = await provider?.readPersistedHostname?.();
      if (!hostname || getActiveTunnelController()) return null;
      try {
        const result = await tunnelService.start({ provider: 'hapi', mode: TUNNEL_MODE_QUICK, hostname });
        tunnelAuthController.setActiveTunnel({
          tunnelId: crypto.randomUUID(),
          publicUrl: result.publicUrl,
          mode: TUNNEL_MODE_QUICK,
          provider: 'hapi',
        });
        console.log(`HAPI tunnel restored: ${result.publicUrl}`);
        return result.publicUrl;
      } catch (error) {
        console.warn('Failed to restore HAPI tunnel:', error?.message || error);
        return null;
      }
    };
    const hapiRestorePromise = restoreHapiTunnel();

    return {
      tunnelService,
      startTunnelWithNormalizedRequest: (...args) => tunnelRoutesRuntime.startTunnelWithNormalizedRequest(...args),
      getActivePort: () => activePort,
      setActivePort: (value) => {
        activePort = value;
      },
      hapiRestorePromise,
    };
  };

  return {
    initialize,
  };
};
