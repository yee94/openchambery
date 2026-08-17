import type { Session } from '@/lib/opencode/v2-types';

const toFiniteNumber = (value: unknown): number | null => (
  typeof value === 'number' && Number.isFinite(value) ? value : null
);

export const getSessionActivityUpdatedAt = (session: Session): number => {
  const metadata = (session as Session & {
    metadata?: { openchamber?: { titleRefresh?: { activityUpdatedAt?: unknown } } };
  }).metadata;
  const activityUpdatedAt = toFiniteNumber(metadata?.openchamber?.titleRefresh?.activityUpdatedAt);
  return activityUpdatedAt
    ?? toFiniteNumber(session.time?.updated)
    ?? toFiniteNumber(session.time?.created)
    ?? 0;
};
