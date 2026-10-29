import { registerSessionIndexRoutes } from '../session-index/routes.js';
import { registerTranscriptCacheRoutes } from '../transcript-cache/routes.js';
import { registerContentSearchRoutes } from '../content-search/routes.js';
import { registerConfigSyncRoutes } from '../config-sync/routes.js';
import { registerHostUpdateRoutes } from '../host-update/routes.js';

export const registerYuriRoutes = (app, dependencies) => {
  const {
    fetchFreeZenModels,
    getCachedZenModels,
    sessionIndexService,
    sessionIndexSyncRuntime,
    /** Production: committed Host metadata for archive-aware snapshot/lookup. */
    getCommittedHostMetadata = null,
    transcriptCacheService,
    express,
  } = dependencies;

  registerSessionIndexRoutes(app, {
    sessionIndexService,
    sessionIndexSyncRuntime,
    getCommittedHostMetadata,
  });
  registerTranscriptCacheRoutes(app, { transcriptCacheService });
  registerContentSearchRoutes(app, { contentSearch: dependencies.contentSearch });
  registerConfigSyncRoutes(app, { express });
  if (dependencies.hostUpdates) registerHostUpdateRoutes(app, {
    express, runtime: dependencies.hostUpdates, uiAuthController: dependencies.uiAuthController,
  });

  app.get('/api/yuri/update-check', async (req, res) => {
    try {
      const { checkForUpdates } = await import('../package-manager.js');
      const parseString = (value) => (typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined);
      const parseReportUsage = (value) => {
        if (typeof value !== 'string') return false;
        const normalized = value.trim().toLowerCase();
        return normalized === 'true' || normalized === '1' || normalized === 'yes';
      };
      const inferDeviceClass = (ua) => {
        const value = (ua || '').toLowerCase();
        if (!value) return 'unknown';
        if (value.includes('ipad') || value.includes('tablet')) return 'tablet';
        if (value.includes('mobi') || value.includes('android') || value.includes('iphone')) return 'mobile';
        return 'desktop';
      };
      const userAgent = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : '';

      const updateInfo = await checkForUpdates({
        appType: parseString(req.query.appType),
        deviceClass: parseString(req.query.deviceClass) || inferDeviceClass(userAgent),
        platform: parseString(req.query.platform),
        arch: parseString(req.query.arch),
        instanceMode: parseString(req.query.instanceMode),
        currentVersion: parseString(req.query.currentVersion),
        reportUsage: parseReportUsage(parseString(req.query.reportUsage)),
      });
      res.json(updateInfo);
    } catch (error) {
      console.error('Failed to check for updates:', error);
      res.status(500).json({
        available: false,
        error: error instanceof Error ? error.message : 'Failed to check for updates',
      });
    }
  });

  // Old clients must obtain and confirm an exact Host-owned update plan.
  app.post('/api/yuri/update-install', (_req, res) => {
    res.status(409).json({ error: 'update_plan_required', endpoint: '/api/system/update' });
  });

  app.get('/api/zen/models', async (_req, res) => {
    try {
      const models = await fetchFreeZenModels();
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.json({ models });
    } catch (error) {
      console.warn('Failed to fetch zen models:', error);
      const cachedZenModels = getCachedZenModels();
      if (cachedZenModels) {
        res.setHeader('Cache-Control', 'public, max-age=60');
        res.json(cachedZenModels);
      } else {
        const statusCode = error?.name === 'AbortError' ? 504 : 502;
        res.status(statusCode).json({ error: 'Failed to retrieve zen models' });
      }
    }
  });
};
