/** @typedef {string | URL} UrlLike */

export const UI_PROTOCOL = 'openchamber-ui';

export const packagedUiOrigin = () => `${UI_PROTOCOL}://app`;

/**
 * Stable identity for navigation / origin checks.
 *
 * Chromium and Node report `URL.origin === "null"` (string) for many custom
 * schemes, including openchamber-ui://. Comparing origins then fails forever
 * (`"null" !== "openchamber-ui://app"`), which blocked packaged-UI reloads after
 * first-launch onboarding and left the chooser stuck.
 *
 * @param {UrlLike | null | undefined} raw
 * @returns {string}
 */
export const urlIdentityKey = (raw) => {
  if (!raw) return '';
  try {
    const url = raw instanceof URL ? raw : new URL(String(raw));
    if (url.protocol === `${UI_PROTOCOL}:`) {
      return `${UI_PROTOCOL}://${url.hostname || 'app'}`;
    }
    if (url.origin && url.origin !== 'null') {
      return url.origin;
    }
    return `${url.protocol}//${url.host}`;
  } catch {
    return '';
  }
};

/**
 * @param {UrlLike | null | undefined} left
 * @param {UrlLike | null | undefined} right
 */
export const sameUrlIdentity = (left, right) => {
  const a = urlIdentityKey(left);
  const b = urlIdentityKey(right);
  return Boolean(a && b && a === b);
};

/**
 * @param {UrlLike | null | undefined} raw
 */
export const isPackagedUiUrl = (raw) => {
  try {
    const url = raw instanceof URL ? raw : new URL(String(raw));
    return url.protocol === `${UI_PROTOCOL}:` && (url.hostname === 'app' || url.host === 'app');
  } catch {
    return false;
  }
};
