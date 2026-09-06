import { readDraftHandoffSyncFrame } from './draftTranscriptHandoff.chrome.sync.fixture';

const sync = {
  ensureSessionRenderable: async () => undefined,
  isLoading: () => readDraftHandoffSyncFrame().syncLoading,
};

export const useSync = () => sync;
