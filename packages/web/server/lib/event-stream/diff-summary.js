// ---------------------------------------------------------------------------
// Outbound FileDiff summarization for message-stream fan-out.
//
// Mirrors packages/ui/src/sync/sanitize.ts summarizeFileDiff(s) so Host never
// pushes full patch/before/after/from/to blobs over Relay/WS (>64KB frames).
// Pure JS — do not import UI TypeScript from the server package.
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

const summarizeSummaryDiffs = (owner) => {
  if (!owner || typeof owner !== 'object' || Array.isArray(owner)) {
    return owner;
  }

  const summary = owner.summary;
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) {
    return owner;
  }

  if (!Array.isArray(summary.diffs)) {
    return owner;
  }

  const stripped = summarizeFileDiffs(summary.diffs);
  if (stripped === summary.diffs) {
    return owner;
  }

  return {
    ...owner,
    summary: {
      ...summary,
      diffs: stripped,
    },
  };
};

/**
 * Summarize FileDiff bodies on outbound event payloads.
 *
 * Handles:
 * - `session.diff` with legacy `properties.diff` or current `data.diff`
 * - message/session objects carrying `summary.diffs` under properties/data info
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
        const nextInfo = summarizeSummaryDiffs(body.info);
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
      const nextBody = summarizeSummaryDiffs(body);
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
