import { hasPreviewProxyCredential } from '../opencode/core-routes.js';

export function registerContentSearchRoutes(app, { contentSearch } = {}) {
  app.get('/api/yuri/content-search', (req, res) => {
    if (hasPreviewProxyCredential(req)) return res.status(403).json({ error: 'Forbidden' });
    if (!contentSearch) return res.status(503).json({ error: 'Global content index unavailable' });
    const query = req.query.q ?? '';
    const limit = req.query.limit === undefined ? 30 : Number(req.query.limit);
    const directory = req.query.directory;
    if (typeof query !== 'string' || query.length > 500 || !Number.isInteger(limit) || limit < 1 || limit > 50
      || (directory !== undefined && typeof directory !== 'string')) return res.status(400).json({ error: 'Invalid content search query' });
    try {
      return res.json({ hits: contentSearch.service.search(contentSearch.getRuntimeKey(), query, { limit, directory }), index: contentSearch.runtime.status() });
    } catch {
      return res.status(500).json({ error: 'Global content search failed' });
    }
  });
}
