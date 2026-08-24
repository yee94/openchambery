/**
 * Compare OpenChamber release versions: `X.Y.Z` or `X.Y.Z-beta.N`.
 * Optional `v` prefix is ignored. Stable of the same core is newer than any beta.
 */

export function parseReleaseVersion(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim().replace(/^v/i, '');
  const match = text.match(/^(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    beta: match[4] === undefined ? null : Number(match[4]),
  };
}

/**
 * @returns {number | null} negative when `left < right`, 0 when equal,
 *   positive when `left > right`, null when either side is not a release version.
 */
export function compareReleaseVersions(left, right) {
  const parsedLeft = parseReleaseVersion(left);
  const parsedRight = parseReleaseVersion(right);
  if (!parsedLeft || !parsedRight) return null;
  if (parsedLeft.major !== parsedRight.major) return parsedLeft.major - parsedRight.major;
  if (parsedLeft.minor !== parsedRight.minor) return parsedLeft.minor - parsedRight.minor;
  if (parsedLeft.patch !== parsedRight.patch) return parsedLeft.patch - parsedRight.patch;
  if (parsedLeft.beta === null && parsedRight.beta === null) return 0;
  if (parsedLeft.beta === null) return 1;
  if (parsedRight.beta === null) return -1;
  return parsedLeft.beta - parsedRight.beta;
}
