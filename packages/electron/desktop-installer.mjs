import { parseReleaseVersion } from '../../deploy/update-service/lib/semver.js';

/** Installer fallback is pinned to the shared OTA decision, never a latest feed. */
export class DesktopInstaller {
  constructor(updater, { onProgress = () => {}, onError = () => {} } = {}) {
    this.updater = updater;
    this.version = null;
    this.downloaded = false;
    this.busy = false;
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.disableDifferentialDownload = true;
    updater.on('download-progress', onProgress);
    updater.on('error', onError);
  }

  assertIdle() {
    if (this.busy) throw new Error('An installer update operation is in progress');
  }

  clear() {
    this.assertIdle();
    this.version = null;
    this.downloaded = false;
  }

  async check(version, { channel, rollback = false }) {
    this.assertIdle();
    const parsed = parseReleaseVersion(version);
    if (!parsed || (version.includes('-') && channel !== 'beta')) throw new Error('Invalid installer release channel');
    if (this.version === version) return { downloaded: this.downloaded };
    this.clear();
    this.busy = true;
    try {
      this.updater.allowPrerelease = channel === 'beta';
      this.updater.allowDowngrade = rollback;
      this.updater.setFeedURL({ provider: 'generic', channel: 'full',
        url: `https://github.com/yee94/openchamber/releases/download/v${version}/`,
        useMultipleRangeRequest: false });
      const result = await this.updater.checkForUpdates();
      if (result?.updateInfo?.version !== version) throw new Error('Installer metadata does not match the selected release');
      if (!result.isUpdateAvailable) throw new Error('The selected installer is not applicable to this desktop');
      this.version = version;
      return { downloaded: false };
    } finally { this.busy = false; }
  }

  async download() {
    this.assertIdle();
    if (!this.version) throw new Error('No installer update selected');
    if (this.downloaded) return;
    this.busy = true;
    try {
      const files = await this.updater.downloadUpdate();
      if (!files?.length) throw new Error('Installer download did not produce a package');
      this.downloaded = true;
    } finally { this.busy = false; }
  }

  assertPending() {
    if (!this.version || !this.downloaded || this.busy) throw new Error('No downloaded installer update');
  }

  install() {
    this.assertPending();
    this.updater.quitAndInstall(false, true);
  }
}
