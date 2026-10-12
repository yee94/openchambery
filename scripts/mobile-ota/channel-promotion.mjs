import { mergeOtaMajor, selectOtaMajor } from '../../deploy/update-service/lib/ota-manifest.js'
import { compareReleaseVersions, parseReleaseVersion } from '../../deploy/update-service/lib/semver.js'

/** Advance the matching beta lane to stable without downgrading newer betas. */
export function promoteStableToBeta(stable, beta) {
  const active = stable.activeBundle
  const version = parseReleaseVersion(active?.releaseVersion)
  if (stable.channel !== 'stable' || !version || version.beta !== null) {
    throw new Error('Beta promotion requires an active stable release')
  }
  const previous = selectOtaMajor(beta, version.major)
  if (previous?.activeBundle && compareReleaseVersions(previous.activeBundle.releaseVersion, active.releaseVersion) > 0) {
    return beta
  }
  const sameBundle = previous?.activeBundle?.bundleId === active.bundleId
  const rollbackBundleIds = [...new Set([
    previous?.activeBundle?.bundleId,
    ...(previous?.rollbackBundleIds ?? []),
  ])].filter((id) => id && id !== active.bundleId).slice(0, 2)
  return mergeOtaMajor(beta, {
    schemaVersion: 1,
    channel: 'beta',
    generation: (previous?.generation ?? 0) + (sameBundle ? 0 : 1),
    activeBundle: { ...active },
    nativeTargets: { ...stable.nativeTargets },
    rollbackBundleIds,
    rollbackBundles: Object.fromEntries(rollbackBundleIds.flatMap((id) => {
      const bundle = id === previous?.activeBundle?.bundleId
        ? previous.activeBundle : previous?.rollbackBundles?.[id]
      return bundle ? [[id, bundle]] : []
    })),
  })
}
