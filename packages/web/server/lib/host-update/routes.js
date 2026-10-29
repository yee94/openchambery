/** Auth runs here as well as the global gate; Relay's loopback is not trusted. */
export function registerHostUpdateRoutes(app, { express, runtime, uiAuthController }) {
  const authorize = async (req, res, next) => {
    try {
      // Only a real bearer can bypass browser-origin protection. URL tokens
      // and unauthenticated loopback requests never authorize self-update.
      const bearer = /^Bearer\s+\S+$/i.test(req.headers.authorization ?? '');
      const authRequest = bearer ? Object.assign(Object.create(req), { headers: { ...req.headers, cookie: undefined } }) : req;
      const context = await uiAuthController.resolveAuthContext(authRequest, res, { allowClientAuth: true, allowUrlToken: false });
      if (!context || (!uiAuthController.enabled && context.type === 'session')) return res.status(401).json({ error: 'update_authentication_required' });
      const origin = req.headers.origin;
      if (context.type !== 'client' && (req.headers['sec-fetch-site'] === 'cross-site' || (origin && origin !== `${req.protocol}://${req.get('host')}`))) {
        return res.status(403).json({ error: 'update_origin_forbidden' });
      }
      next();
    } catch (error) { next(error); }
  };
  app.get('/api/system/update', authorize, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const result = await runtime.get(req.query.channel);
      res.status(result.checkFailed ? 502 : 200).json(result);
    } catch (error) { res.status(error.status ?? 500).json({ error: error.code ?? 'update_check_failed' }); }
  });
  app.post('/api/system/update', authorize, express.json({ limit: '16kb' }), async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try { res.status(202).json({ operation: await runtime.start(req.body) }); }
    catch (error) {
      const snapshot = await runtime.get().catch(() => null);
      res.status(error.status ?? 500).json({ error: error.code ?? 'update_start_failed', operation: snapshot?.operation ?? null });
    }
  });
}
