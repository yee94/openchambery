/**
 * Pure backfill pagination reducer for Assistant history mirrors.
 * Disposition tells the service whether provisional (covered=0) rows may be dropped.
 */
export const reduceBackfillState = (state, event) => {
  const type = typeof event === 'string' ? event : event?.type;
  if (type === 'invalidate') {
    return { cursor: null, complete: false, disposition: 'preserve' };
  }
  if (type === 'page') {
    const raw = event?.nextCursor;
    const nextCursor = typeof raw === 'string' && raw.length > 0 ? raw : null;
    return { cursor: nextCursor, complete: nextCursor == null, disposition: 'preserve' };
  }
  if (type === 'session-missing') {
    return { cursor: null, complete: true, disposition: 'discard-provisional' };
  }
  return {
    cursor: state?.cursor ?? null,
    complete: Boolean(state?.complete),
    disposition: 'preserve',
  };
};
