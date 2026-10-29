/** Adapter to the shell-owned OTA/installer chain; never runs a package manager. */
export function createDesktopUpdateAdapter({ getOta, getInstaller, isSupported, isBusy, getOperation = () => null, download, restart }) {
  const inspect = async (channel) => {
    const ota = getOta();
    if (!ota) throw new Error('Desktop updates require a packaged app');
    const info = await ota.check(channel, { select: false });
    if (!info.available) return null;
    const decision = info.otaDecision;
    return {
      version: info.manualUpdate ? decision.native.version : info.version,
      releaseNotes: typeof info.body === 'string' ? info.body : null, kind: info.manualUpdate ? 'installer' : 'ota',
      rollback: info.isChannelRollback, restartRequired: true,
      artifact: info.manualUpdate ? decision.native : decision.ota.bundle,
    };
  };
  return {
    host: 'electron', supported: isSupported, reason: isSupported ? null : 'packaged_desktop_required',
    channel: () => getOta()?.state.channel,
    operation: getOperation,
    inspect,
    assertReady() {
      if (isBusy() || getInstaller()?.busy || getOta()?.downloadPromise) throw Object.assign(new Error('Desktop update is busy'), { status: 409, code: 'update_in_progress' });
    },
    async execute({ release, channel, report }) {
      const info = await getOta().check(channel);
      if (!info.available || (info.manualUpdate ? info.otaDecision.native.version : info.version) !== release.version
        || (info.manualUpdate ? 'installer' : 'ota') !== release.kind
        || JSON.stringify(info.manualUpdate ? info.otaDecision.native : info.otaDecision.ota.bundle) !== JSON.stringify(release.artifact)) throw new Error('Desktop update plan changed');
      if (release.kind === 'installer') await getInstaller().check(release.version, { channel, rollback: release.rollback });
      await report({ status: 'downloading' });
      await download(release.kind);
      await report({ status: 'restarting', progress: 100 });
      await restart();
    },
  };
}
