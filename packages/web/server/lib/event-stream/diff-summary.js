// ---------------------------------------------------------------------------
// Outbound FileDiff summarization for message-stream fan-out and Host L1.
//
// L1 (ordinary first-packet / SSE / exact message GET):
//   keep `info.summary.diffs` as a slim file list
//   `{ file, status?, additions, deletions }` plus additive
//   `diffCount` / `hasDiffs` markers. Never ship patch bodies on these paths.
//
// Explicit L2/L3 APIs may still use summarizeFileDiff(s) for file-list / patch
// responses. Pure JS — do not import UI TypeScript from the server package.
// ---------------------------------------------------------------------------

/** Lightweight FileDiff fields safe for outbound event frames (preview only). */
const FILE_DIFF_SUMMARY_KEYS = ['file', 'status', 'additions', 'deletions'];

const hasHeavyDiffBody = (diff) => {
  if (!diff || typeof diff !== 'object' || Array.isArray(diff)) {
    return false;
  }
  if (typeof diff.before === 'string') return true;
  if (typeof diff.after === 'string') return true;
  if (typeof diff.from === 'string') return true;
  if (typeof diff.to === 'string') return true;
  if (typeof diff.patch === 'string') return true;
  return false;
};

/**
 * Reduce a FileDiff / SnapshotFileDiff to preview-safe scalars only.
 * Drops patch / before / after / from / to and any other large body fields.
 * Already-summary objects keep identity.
 */
export function summarizeFileDiff(diff) {
  if (!diff || typeof diff !== 'object' || Array.isArray(diff)) {
    return diff;
  }

  if (!hasHeavyDiffBody(diff)) {
    return diff;
  }

  const summary = {};
  for (const key of FILE_DIFF_SUMMARY_KEYS) {
    if (key in diff && diff[key] !== undefined) {
      summary[key] = diff[key];
    }
  }
  return summary;
}

/** Summarize a FileDiff list; preserves array identity when nothing changes. */
export function summarizeFileDiffs(diffs) {
  if (!Array.isArray(diffs)) {
    return diffs;
  }

  let changed = false;
  const next = diffs.map((entry) => {
    const summarized = summarizeFileDiff(entry);
    if (summarized !== entry) {
      changed = true;
    }
    return summarized;
  });

  return changed ? next : diffs;
}

/**
 * L1 projection: keep `summary.diffs` as a slim file-list array and set
 * additive `diffCount` / `hasDiffs` markers. Drops patch/before/after/from/to.
 * Keeps every other lightweight summary field. Identity when unchanged.
 *
 * @param {unknown} owner message info / session info / summary-bearing object
 * @returns {unknown}
 */
export const projectMessageSummaryDiffSlim = (owner) => {
  if (!owner || typeof owner !== 'object' || Array.isArray(owner)) {
    return owner;
  }

  const summary = owner.summary;
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) {
    return owner;
  }

  if (!Object.prototype.hasOwnProperty.call(summary, 'diffs')) {
    return owner;
  }

  const rawDiffs = summary.diffs;
  const slimDiffs = Array.isArray(rawDiffs) ? summarizeFileDiffs(rawDiffs) : [];
  const diffCount = slimDiffs.length;
  const hasDiffs = diffCount > 0;

  const diffsUnchanged = slimDiffs === rawDiffs;
  const markersMatch = summary.diffCount === diffCount && summary.hasDiffs === hasDiffs;
  if (diffsUnchanged && markersMatch) {
    return owner;
  }

  return {
    ...owner,
    summary: {
      ...summary,
      diffs: slimDiffs,
      diffCount,
      hasDiffs,
    },
  };
};

/** @deprecated Prefer projectMessageSummaryDiffSlim — same L1 slim-list behavior. */
export const projectMessageSummaryDiffCounts = projectMessageSummaryDiffSlim;

/** @deprecated Prefer projectMessageSummaryDiffSlim — L1 keeps slim file list + markers. */
export const summarizeMessageDiffSnapshots = projectMessageSummaryDiffSlim;

/**
 * Summarize FileDiff bodies on outbound event payloads.
 *
 * Handles:
 * - `session.diff` with legacy `properties.diff` or current `data.diff`
 *   (keeps file/status/additions/deletions; drops patch bodies)
 * - message/session objects carrying `summary.diffs` under properties/data info
 *   (L1: slim file list + diffCount/hasDiffs; never patch bodies)
 *
 * Non-diff events keep identity.
 */
export function summarizeOutboundEventPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return payload;
  }

  const type = typeof payload.type === 'string' ? payload.type : '';

  // session.diff — properties (legacy) or data (current) envelope
  if (type === 'session.diff') {
    let next = payload;
    let changed = false;

    for (const key of ['properties', 'data']) {
      const body = next[key];
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        continue;
      }
      if (!Array.isArray(body.diff)) {
        continue;
      }
      const stripped = summarizeFileDiffs(body.diff);
      if (stripped === body.diff) {
        continue;
      }
      next = {
        ...next,
        [key]: {
          ...body,
          diff: stripped,
        },
      };
      changed = true;
    }

    return changed ? next : payload;
  }

  // message/session envelopes that may carry summary.diffs on info
  if (
    type === 'message.updated'
    || type === 'message.created'
    || type === 'session.updated'
    || type === 'session.created'
  ) {
    let next = payload;
    let changed = false;

    for (const key of ['properties', 'data']) {
      const body = next[key];
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        continue;
      }

      // Common shape: properties.info.summary.diffs
      if (body.info && typeof body.info === 'object' && !Array.isArray(body.info)) {
        const nextInfo = projectMessageSummaryDiffSlim(body.info);
        if (nextInfo !== body.info) {
          next = {
            ...next,
            [key]: {
              ...body,
              info: nextInfo,
            },
          };
          changed = true;
          continue;
        }
      }

      // Rare: properties.summary.diffs directly on the properties/data body
      const nextBody = projectMessageSummaryDiffSlim(body);
      if (nextBody !== body) {
        next = {
          ...next,
          [key]: nextBody,
        };
        changed = true;
      }
    }

    return changed ? next : payload;
  }

  return payload;
}
