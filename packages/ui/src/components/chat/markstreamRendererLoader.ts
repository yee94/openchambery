let markstreamRendererModulePromise: Promise<typeof import('./MarkstreamRendererImpl')> | null = null;

export const loadMarkstreamRendererModule = () => {
  markstreamRendererModulePromise ??= import('./MarkstreamRendererImpl').catch((error) => {
    markstreamRendererModulePromise = null;
    throw error;
  });
  return markstreamRendererModulePromise;
};

export const preloadMarkstreamRenderer = () => {
  void loadMarkstreamRendererModule().catch(() => undefined);
};
