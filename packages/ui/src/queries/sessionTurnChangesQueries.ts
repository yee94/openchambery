import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@/lib/queryRuntime';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import { opencodeClient } from '@/lib/opencode/client';

export type SessionTurnChangeRequest = {
  sessionID: string;
  directory: string;
  messageID: string;
  /**
   * Marker revision in the Changes query key. Keep it: when a turn grows,
   * a new count invalidates stale L2 summary / L3 file caches for that turn.
   */
  diffCount?: number;
};

/** Safe L2 file summary — never includes patch / before / after bodies. */
export type SessionTurnChangeFileSummary = {
  file: string;
  status?: string;
  additions?: number;
  deletions?: number;
};

/** L3 single-file diff — may include patch / snapshot bodies. */
export type SessionTurnChangeFileDiff = {
  file: string;
  status?: string;
  additions?: number;
  deletions?: number;
  patch?: string;
  before?: string;
  after?: string;
  from?: string;
  to?: string;
  [key: string]: unknown;
};

export type SessionTurnChangesSummaryResponse = {
  files: SessionTurnChangeFileSummary[];
};

export type SessionTurnChangeFileResponse = {
  diff: SessionTurnChangeFileDiff;
};

const CHANGES_PATH = (sessionID: string) =>
  `/api/openchamber/sessions/${encodeURIComponent(sessionID)}/changes`;

const normalizeDirectory = (directory: string): string => directory.trim();

const isLegacyHostFallbackStatus = (status: number): boolean =>
  status === 404 || status === 405 || status === 501;

const projectLegacyFileSummary = (entry: unknown): SessionTurnChangeFileSummary | null => {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const record = entry as Record<string, unknown>;
  const file = typeof record.file === 'string' ? record.file : null;
  if (!file) return null;
  return {
    file,
    ...(typeof record.status === 'string' ? { status: record.status } : {}),
    additions: typeof record.additions === 'number' && Number.isFinite(record.additions)
      ? record.additions
      : 0,
    deletions: typeof record.deletions === 'number' && Number.isFinite(record.deletions)
      ? record.deletions
      : 0,
  };
};

const projectLegacyFileList = (diffs: unknown): SessionTurnChangesSummaryResponse => {
  if (!Array.isArray(diffs)) return { files: [] };
  const files: SessionTurnChangeFileSummary[] = [];
  for (const entry of diffs) {
    const projected = projectLegacyFileSummary(entry);
    if (projected) files.push(projected);
  }
  return { files };
};

const findLegacyFileDiff = (
  diffs: unknown,
  file: string,
): SessionTurnChangeFileDiff | null => {
  if (!Array.isArray(diffs)) return null;
  for (const entry of diffs) {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)
      && (entry as { file?: unknown }).file === file) {
      return entry as SessionTurnChangeFileDiff;
    }
  }
  return null;
};

const fetchOpenChamberChanges = async (
  input: SessionTurnChangeRequest & { file?: string },
  signal: AbortSignal,
): Promise<Response> => {
  const query: Record<string, string> = {
    messageID: input.messageID,
    directory: input.directory,
  };
  if (typeof input.file === 'string' && input.file.length > 0) {
    query.file = input.file;
  }
  return runtimeFetch(CHANGES_PATH(input.sessionID), {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      'x-opencode-directory': input.directory,
    },
    query,
    signal,
  });
};

const fallbackLegacySessionDiff = async (
  input: SessionTurnChangeRequest,
  signal: AbortSignal,
): Promise<unknown[]> => {
  // Honor TanStack query cancellation on legacy Host 404/405/501 fallback too.
  if (signal.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
  return opencodeClient.getSessionDiff(
    {
      sessionID: input.sessionID,
      directory: input.directory,
      messageID: input.messageID,
    },
    { signal },
  );
};

export const sessionTurnChangesQueryKey = (
  input: SessionTurnChangeRequest,
  transport = getRuntimeTransportIdentity(),
) => queryKeys.sessionTurnChanges.summary(
  input.directory,
  input.sessionID,
  input.messageID,
  input.diffCount,
  transport,
);

export const sessionTurnChangeFileQueryKey = (
  input: SessionTurnChangeRequest & { file: string },
  transport = getRuntimeTransportIdentity(),
) => queryKeys.sessionTurnChanges.file(
  input.directory,
  input.sessionID,
  input.messageID,
  input.file,
  input.diffCount,
  transport,
);

export const sessionTurnChangesQueryOptions = (
  input: SessionTurnChangeRequest,
  transport = getRuntimeTransportIdentity(),
) => ({
  queryKey: sessionTurnChangesQueryKey(input, transport),
  queryFn: async ({ signal }: { signal: AbortSignal }): Promise<SessionTurnChangesSummaryResponse> => {
    const response = await fetchOpenChamberChanges(input, signal);
    if (response.ok) {
      const payload = await response.json().catch(() => null) as SessionTurnChangesSummaryResponse | null;
      if (!payload || !Array.isArray(payload.files)) {
        throw new Error('Invalid session turn changes response');
      }
      return payload;
    }
    if (!isLegacyHostFallbackStatus(response.status)) {
      throw new Error(`Session turn changes request failed (${response.status})`);
    }
    const diffs = await fallbackLegacySessionDiff(input, signal);
    return projectLegacyFileList(diffs);
  },
  staleTime: 0,
  gcTime: 5 * 60_000,
  retry: false as const,
});

export const sessionTurnChangeFileQueryOptions = (
  input: SessionTurnChangeRequest & { file: string },
  transport = getRuntimeTransportIdentity(),
) => ({
  queryKey: sessionTurnChangeFileQueryKey(input, transport),
  queryFn: async ({ signal }: { signal: AbortSignal }): Promise<SessionTurnChangeFileResponse> => {
    const response = await fetchOpenChamberChanges(input, signal);
    if (response.ok) {
      const payload = await response.json().catch(() => null) as SessionTurnChangeFileResponse | null;
      if (!payload || !payload.diff || typeof payload.diff !== 'object') {
        throw new Error('Invalid session turn change file response');
      }
      return payload;
    }
    if (!isLegacyHostFallbackStatus(response.status)) {
      throw new Error(`Session turn change file request failed (${response.status})`);
    }
    const diffs = await fallbackLegacySessionDiff(input, signal);
    const match = findLegacyFileDiff(diffs, input.file);
    if (!match) {
      throw new Error('change file not found');
    }
    return { diff: match };
  },
  staleTime: 0,
  gcTime: 60_000,
  retry: false as const,
});

export const useSessionTurnChangesQuery = (
  input: SessionTurnChangeRequest | null,
  options: { enabled?: boolean } = {},
) => {
  const transport = getRuntimeTransportIdentity();
  const enabled = Boolean(input)
    && Boolean(input?.sessionID?.trim())
    && Boolean(input?.directory?.trim())
    && Boolean(input?.messageID?.trim())
    && options.enabled !== false;
  const request = input ?? {
    sessionID: '',
    directory: '',
    messageID: '',
  };
  return useQuery({
    ...sessionTurnChangesQueryOptions(
      {
        ...request,
        directory: normalizeDirectory(request.directory),
      },
      transport,
    ),
    enabled,
  });
};

export const useSessionTurnChangeFileQuery = (
  input: (SessionTurnChangeRequest & { file: string }) | null,
  options: { enabled?: boolean } = {},
) => {
  const transport = getRuntimeTransportIdentity();
  const enabled = Boolean(input)
    && Boolean(input?.sessionID?.trim())
    && Boolean(input?.directory?.trim())
    && Boolean(input?.messageID?.trim())
    && Boolean(input?.file?.trim())
    && options.enabled !== false;
  const request = input ?? {
    sessionID: '',
    directory: '',
    messageID: '',
    file: '',
  };
  return useQuery({
    ...sessionTurnChangeFileQueryOptions(
      {
        ...request,
        directory: normalizeDirectory(request.directory),
        file: request.file,
      },
      transport,
    ),
    enabled,
  });
};
