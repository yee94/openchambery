export function registerSmallModelRoutes(app, { getSmallModelService }) {
  app.get('/api/small-model', async (req, res) => {
    try {
      const { describeSmallModel, listCallableProviders, listCallableModels } = await getSmallModelService();
      const directory = typeof req.query.directory === 'string' ? req.query.directory : undefined;
      const resolved = await describeSmallModel({
        directory,
        preferredProviderID: typeof req.query.providerID === 'string' ? req.query.providerID : undefined,
        preferredModelID: typeof req.query.modelID === 'string' ? req.query.modelID : undefined,
      });
      res.json({
        available: Boolean(resolved),
        model: resolved,
        authenticatedProviders: await listCallableProviders({ directory }),
        callableModels: await listCallableModels({ directory }),
      });
    } catch (error) {
      console.error('Failed to resolve small model:', error);
      res.status(500).json({ error: error.message || 'Failed to resolve small model' });
    }
  });

  app.post('/api/small-model/generate', async (req, res) => {
    try {
      const { generateSmallModelText } = await getSmallModelService();
      const { prompt, system, maxOutputTokens, model, directory, preferredProviderID, preferredModelID, restrictToPreferredProvider, purpose } = req.body || {};
      const result = await generateSmallModelText({
        prompt,
        system,
        maxOutputTokens,
        model,
        directory,
        preferredProviderID,
        preferredModelID,
        restrictToPreferredProvider: restrictToPreferredProvider === true,
        purpose,
      });
      res.json(result);
    } catch (error) {
      const statusCode = Number(error?.statusCode) || 500;
      if (statusCode >= 500) {
        console.error('Small model generation failed:', error);
      }
      res.status(statusCode).json({ error: error.message || 'Small model generation failed' });
    }
  });

  app.post('/api/small-model/test', async (req, res) => {
    try {
      const { testCustomApi } = await getSmallModelService();
      const result = await testCustomApi(req.body || {});
      res.status(result.ok ? 200 : 400).json(result);
    } catch (error) {
      console.error('Small model custom API test failed:', error);
      res.status(500).json({ ok: false, code: 'baseURL' });
    }
  });

  app.post('/api/small-model/custom-models', async (req, res) => {
    try {
      const { listCustomModels } = await getSmallModelService();
      const models = await listCustomModels(req.body || {});
      res.json({ models });
    } catch (error) {
      console.error('Small model custom model list failed:', error);
      res.json({ models: [] });
    }
  });
}
