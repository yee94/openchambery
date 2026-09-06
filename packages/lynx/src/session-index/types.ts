export type SessionIndexSession = {
  id: string;
  title: string;
  directory: string;
  parentID?: string | null;
  hasChildren?: boolean;
  time: {
    created: number;
    updated: number;
    archived?: number;
    pinned?: string | number | null;
  };
  metadata?: {
    openchamber?: {
      titleRefresh?: { activityUpdatedAt?: number };
      sessionStatus?: { type?: string; changedAt?: number };
      assistant?: { assistantID?: string; name?: string };
    };
  };
};

export type SessionIndexDirectory = {
  directory: string;
  cursor: number | null;
  hasMore: boolean;
  lastSyncedAt: number;
  lastFullSyncedAt: number;
  lastAccessedAt: number;
  sessions: SessionIndexSession[];
};

export type SessionIndexSnapshot = {
  revision: number;
  sync: {
    active: boolean;
    completed: number;
    total: number;
    pendingDirectories: string[];
    completedDirectories: string[];
    failedDirectories: string[];
    enriching?: boolean;
  };
  directories: SessionIndexDirectory[];
  pinnedSessionIds?: string[];
};

export type SessionIndexLookupHit = {
  id: string;
  directory: string;
  title?: string;
  parentID?: string | null;
};

export type SessionIndexLoadResult =
  | { status: 'ok'; snapshot: SessionIndexSnapshot }
  | { status: 'unsupported' }
  | { status: 'failed'; error: Error; previous: SessionIndexSnapshot | null };

export type SessionIndexState = {
  status: 'idle' | 'loading' | 'ready' | 'unsupported' | 'failed';
  snapshot: SessionIndexSnapshot | null;
  error: Error | null;
  runtimeKey: string | null;
};
