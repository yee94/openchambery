import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { extractAssetZip } from '@openchambery/web/server/lib/zip-assets.js';
import { compareReleaseVersions, parseReleaseVersion } from '../../deploy/update-service/lib/semver.js';

const UPDATE_ORIGIN = 'https://openchamber-update.vercel.app';
const MAX_BYTES = 64 * 1024 * 1024;
const validId = (id) => typeof id === 'string' && /^[a-f0-9]{16}$/.test(id);

/** Owns desktop assets only. Shell, preload and backend always stay in the installer. */
export class DesktopOta {
  constructor({ directory, builtinDirectory, nativeVersion, fetchImpl = fetch, origin = UPDATE_ORIGIN, onProgress = () => {} }) {
    Object.assign(this, { directory, builtinDirectory, nativeVersion, fetchImpl, origin, onProgress });
    this.state = { schemaVersion: 1, nativeVersion, deviceId: randomUUID(), channel: null,
      active: null, previous: null, queued: null, trial: false, rejected: [] };
    this.running = null;
    this.decision = null;
    this.generation = 0;
    this.selection = 0;
    this.downloadPromise = null;
    this.writes = Promise.resolve();
  }

  get version() { return this.running?.releaseVersion ?? this.nativeVersion; }
  get assetDirectory() { return this.running ? path.join(this.directory, this.running.bundleId) : this.builtinDirectory; }

  async persist() {
    const data = JSON.stringify(this.state);
    this.writes = this.writes.catch(() => {}).then(async () => {
      await mkdir(this.directory, { recursive: true });
      const temporary = path.join(this.directory, 'state.tmp');
      await writeFile(temporary, data);
      await rename(temporary, path.join(this.directory, 'state.json'));
    });
    return this.writes;
  }

  async usable(bundle) {
    if (!bundle || !validId(bundle.bundleId) || !parseReleaseVersion(bundle.releaseVersion)
      || parseReleaseVersion(bundle.releaseVersion).major !== parseReleaseVersion(this.nativeVersion)?.major) return false;
    try {
      const dir = path.join(this.directory, bundle.bundleId);
      const metadata = JSON.parse(await readFile(path.join(dir, 'desktop-ota.json'), 'utf8'));
      if (metadata.releaseVersion !== bundle.releaseVersion) return false;
      await readFile(path.join(dir, 'index.html'));
      return true;
    } catch { return false; }
  }

  async initialize({ activateQueued = true } = {}) {
    try {
      const saved = JSON.parse(await readFile(path.join(this.directory, 'state.json'), 'utf8'));
      if (!saved || saved.schemaVersion !== 1 || typeof saved.deviceId !== 'string'
        || !Array.isArray(saved.rejected) || ![null, 'beta', 'stable'].includes(saved.channel)) throw new Error('Invalid OTA state');
      // A newly installed shell owns its own embedded UI; cached OTA must not
      // accidentally downgrade it or retain a bundle requiring another backend.
      if (saved.nativeVersion === this.nativeVersion) this.state = saved;
      else Object.assign(this.state, { deviceId: saved.deviceId, channel: saved.channel });
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError) && error.message !== 'Invalid OTA state') throw error;
    }
    if (this.state.trial) {
      if (this.state.active) this.state.rejected = [...this.state.rejected, this.state.active.bundleId].slice(-8);
      this.state.active = this.state.previous;
      this.state.queued = null;
      this.state.trial = false;
    }
    if (activateQueued && await this.usable(this.state.queued)) {
      this.state.previous = this.state.active;
      this.state.active = this.state.queued;
      this.state.queued = null;
      this.state.trial = true;
    }
    if (!(await this.usable(this.state.active))) {
      this.state.active = await this.usable(this.state.previous) ? this.state.previous : null;
      this.state.trial = false;
    }
    this.running = this.state.active;
    await this.persist();
    const retained = new Set([this.state.active?.bundleId, this.state.previous?.bundleId, this.state.queued?.bundleId]);
    const { readdir } = await import('node:fs/promises');
    for (const entry of await readdir(this.directory)) {
      if ((validId(entry) && !retained.has(entry)) || entry.startsWith('staging-')) {
        await rm(path.join(this.directory, entry), { recursive: true, force: true });
      }
    }
  }

  async ready(version) {
    if (version !== this.version) throw new Error('OTA ready version mismatch');
    if (this.state.trial) {
      this.state.trial = false;
      try { await this.persist(); }
      catch (error) { this.state.trial = true; throw error; }
    }
  }

  async check(channelOverride) {
    if (channelOverride !== undefined && channelOverride !== null && channelOverride !== 'beta' && channelOverride !== 'stable') {
      throw new Error('Invalid OTA channel');
    }
    const channel = channelOverride ?? (this.nativeVersion.includes('-') ? 'beta' : 'stable');
    const generation = ++this.generation;
    if (this.state.channel !== channel) {
      this.selection += 1;
      this.state.channel = channel;
      this.state.queued = null;
      this.decision = null;
      await this.persist();
    }
    const response = await this.fetchImpl(new URL('/v1/mobile/update/check', this.origin), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(10000),
      body: JSON.stringify({ channel, platform: 'desktop', deviceId: this.state.deviceId,
        nativeVersion: this.nativeVersion, nativeBuild: 1, shellApiVersion: 1,
        currentBundleId: this.version, releaseMajor: parseReleaseVersion(this.version)?.major }),
    });
    if (!response.ok) throw new Error(`OTA check failed (${response.status})`);
    const decision = await response.json();
    if (decision.status !== 'ok' || !['none', 'apply_ota', 'install_native_required'].includes(decision.primaryAction)
      || !decision.ota || !decision.native || !Number.isFinite(decision.nextCheckInSec)) throw new Error('Invalid OTA decision');
    if (generation !== this.generation) throw new Error('OTA check superseded');
    if (decision.native.version && parseReleaseVersion(decision.native.version)?.major !== parseReleaseVersion(this.version)?.major) {
      throw new Error('OTA native target crossed release major');
    }
    if (decision.primaryAction === 'apply_ota') this.validateBundle(decision.ota.bundle, decision.isChannelRollback === true);
    this.decision = decision;
    const bundle = decision.ota.bundle;
    if (this.state.queued?.bundleId !== bundle?.bundleId) {
      this.state.queued = null;
      await this.persist();
    }
    return {
      available: decision.primaryAction !== 'none', currentVersion: this.version,
      version: bundle?.releaseVersion ?? decision.native.version,
      body: decision.releaseNotes, nextSuggestedCheckInSec: decision.nextCheckInSec,
      inAppApply: decision.primaryAction === 'apply_ota', manualUpdate: decision.primaryAction === 'install_native_required',
      isChannelRollback: decision.isChannelRollback === true,
      downloadUrl: bundle?.url ?? decision.native.installUrl,
      releaseUrl: decision.native.installUrl,
      downloaded: Boolean(bundle && this.state.queued?.bundleId === bundle.bundleId),
      otaDecision: decision,
    };
  }

  validateBundle(bundle, rollback) {
    const target = parseReleaseVersion(bundle?.releaseVersion);
    const floor = parseReleaseVersion(bundle?.minShellReleaseVersion);
    const current = parseReleaseVersion(this.version);
    if (!bundle || !validId(bundle.bundleId) || !/^[a-f0-9]{64}$/.test(bundle.checksum)
      || !Number.isSafeInteger(bundle.size) || bundle.size < 1 || bundle.size > MAX_BYTES
      || !target || target.major !== current?.major || !floor || floor.major !== target.major
      || compareReleaseVersions(this.nativeVersion, bundle.minShellReleaseVersion) < 0
      || bundle.minShellApiVersion !== 1 || bundle.sessionKey) throw new Error('Incompatible desktop OTA bundle');
    const url = new URL(bundle.url, this.origin);
    if (url.origin !== new URL(this.origin).origin || url.pathname !== `/ota/bundles/${bundle.bundleId}.zip` || url.search || url.hash) {
      throw new Error('Invalid desktop OTA URL');
    }
    if (compareReleaseVersions(bundle.releaseVersion, this.version) < 0
      && !(rollback && this.state.channel === 'stable' && current.beta !== null && target.beta === null)) {
      throw new Error('OTA downgrade is not a stable-channel rollback');
    }
    if (this.state.rejected.includes(bundle.bundleId)) throw new Error('This OTA bundle previously failed to start');
  }

  async download() {
    if (this.downloadPromise) return this.downloadPromise;
    const decision = this.decision;
    if (decision?.primaryAction !== 'apply_ota') throw new Error('No pending OTA update');
    const bundle = decision.ota.bundle;
    this.validateBundle(bundle, decision.isChannelRollback === true);
    const channel = this.state.channel;
    const selection = this.selection;
    this.downloadPromise = (async () => {
      const skipped = await this.usable(bundle);
      if (!skipped) {
        const response = await this.fetchImpl(new URL(bundle.url, this.origin), { signal: AbortSignal.timeout(120000), redirect: 'error' });
        if (!response.ok || !response.body) throw new Error('OTA download failed');
        const chunks = [];
        let length = 0;
        for await (const chunk of response.body) {
          length += chunk.byteLength;
          if (length > bundle.size) throw new Error('OTA download exceeds declared size');
          chunks.push(Buffer.from(chunk));
          this.onProgress({ downloaded: length, total: bundle.size });
        }
        const bytes = Buffer.concat(chunks);
        if (length !== bundle.size || createHash('sha256').update(bytes).digest('hex') !== bundle.checksum) throw new Error('OTA checksum mismatch');
        const staging = path.join(this.directory, `staging-${randomUUID()}`);
        try {
          await mkdir(staging, { recursive: true });
          await extractAssetZip(bytes, staging);
          const metadata = JSON.parse(await readFile(path.join(staging, 'desktop-ota.json'), 'utf8'));
          if (metadata.releaseVersion !== bundle.releaseVersion) throw new Error('OTA resource version mismatch');
          await readFile(path.join(staging, 'index.html'));
          const target = path.join(this.directory, bundle.bundleId);
          await rm(target, { recursive: true, force: true });
          await rename(staging, target);
        } finally { await rm(staging, { recursive: true, force: true }); }
      }
      if (this.selection !== selection || this.state.channel !== channel || this.decision?.ota.bundle?.bundleId !== bundle.bundleId) throw new Error('OTA channel or bundle changed during download');
      const previous = this.state.queued;
      this.state.queued = bundle;
      try { await this.persist(); }
      catch (error) { this.state.queued = previous; throw error; }
      if (this.selection !== selection || this.state.queued?.bundleId !== bundle.bundleId) throw new Error('OTA selection changed while queueing');
      return { skipped };
    })().finally(() => { this.downloadPromise = null; });
    return this.downloadPromise;
  }

  async assertPending() {
    if (!(await this.usable(this.state.queued))) throw new Error('No downloaded OTA update');
  }
}
