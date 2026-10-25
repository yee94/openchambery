import type { Session } from '@/lib/opencode/v2-types';

export type SessionMetadataRecord = Record<string, unknown>;

type YuriMetadata = {
  kind?: 'review';
  originalSessionID?: string;
  reviewSessionID?: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

export const getSessionMetadata = (session: Session | null | undefined): SessionMetadataRecord => {
  const metadata = (session as (Session & { metadata?: unknown }) | null | undefined)?.metadata;
  return isRecord(metadata) ? metadata : {};
};

const getYuriMetadata = (metadata: SessionMetadataRecord): YuriMetadata => {
  const value = metadata.yuri;
  return isRecord(value) ? value as YuriMetadata : {};
};

export const getReviewSessionID = (session: Session | null | undefined): string | null => {
  const value = getYuriMetadata(getSessionMetadata(session)).reviewSessionID;
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
};

export const getOriginalSessionID = (session: Session | null | undefined): string | null => {
  const value = getYuriMetadata(getSessionMetadata(session)).originalSessionID;
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
};

export const isReviewSession = (session: Session | null | undefined): boolean =>
  getYuriMetadata(getSessionMetadata(session)).kind === 'review' && Boolean(getOriginalSessionID(session));

export const withReviewSessionLink = (
  metadata: SessionMetadataRecord,
  reviewSessionID: string,
): SessionMetadataRecord => {
  const current = getYuriMetadata(metadata);
  return {
    ...metadata,
    yuri: {
      ...current,
      reviewSessionID,
    },
  };
};

export const withReviewSessionMarker = (
  metadata: SessionMetadataRecord,
  originalSessionID: string,
): SessionMetadataRecord => {
  const current = getYuriMetadata(metadata);
  return {
    ...metadata,
    yuri: {
      ...current,
      kind: 'review' as const,
      originalSessionID,
    },
  };
};

export const withoutReviewSessionLink = (
  metadata: SessionMetadataRecord,
  reviewSessionID: string,
): SessionMetadataRecord => {
  const current = getYuriMetadata(metadata);
  if (current.reviewSessionID !== reviewSessionID) return metadata;

  const restYuri = { ...current };
  delete restYuri.reviewSessionID;
  const next: SessionMetadataRecord = { ...metadata };
  if (Object.keys(restYuri).length > 0) {
    next.yuri = restYuri;
  } else {
    delete next.yuri;
  }
  return next;
};
