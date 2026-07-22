import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse as parseJsonc } from 'jsonc-parser';
import { createOpencodeClient } from '@opencode-ai/sdk/v2';
import { projectProviderCatalog } from './provider-catalog.js';

const MAX_GLOBAL_CONFIG_SIZE = 2 * 1024 * 1024;
const GLOBAL_CONFIG_FILES = {
  opencode: ['opencode.json', 'opencode.jsonc'],
  'oh-my-opencode-slim': ['oh-my-opencode-slim.json', 'oh-my-opencode-slim.jsonc'],
  'oh-my-openagent': ['oh-my-openagent.json', 'oh-my-openagent.jsonc'],
};

const truncateDescription = (value, maximum = 160) => {
  const normalized = typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '';
  const codePoints = Array.from(normalized);
  return codePoints.length > maximum ? `${codePoints.slice(0, maximum).join('')}…` : normalized;
};

const isSafeCommandCatalogName = (value) => typeof value === 'string'
  && value.length > 0
  && !/[\]\r\n]/u.test(value);

const isSafeCommandCatalogReference = (value) => typeof value === 'string'
  && value.length <= 8_192
  && !/[\]\r\n]/u.test(value);

function resolveGlobalConfigPath(target, configDirectory) {
  const fileNames = GLOBAL_CONFIG_FILES[target];
  if (!fileNames) {
    return null;
  }
  return {
    target,
    fileNames,
    fileName: fileNames[0],
    filePath: path.join(configDirectory, fileNames[0]),
  };
}

async function findGlobalConfigPath(target, configDirectory) {
  const configPath = resolveGlobalConfigPath(target, configDirectory);
  if (!configPath) {
    return null;
  }

  for (const fileName of configPath.fileNames) {
    const filePath = path.join(configDirectory, fileName);
    try {
      if ((await fs.stat(filePath)).isFile()) {
        return { ...configPath, fileName, filePath };
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }
    }
  }

  return null;
}

function validateGlobalConfigContent(content) {
  if (typeof content !== 'string') {
    return 'Configuration content must be a string';
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_GLOBAL_CONFIG_SIZE) {
    return `Configuration content exceeds ${MAX_GLOBAL_CONFIG_SIZE} bytes`;
  }

  const errors = [];
  const parsed = parseJsonc(content, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0 || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return 'Invalid JSONC configuration';
  }
  return null;
}

export const registerConfigEntityRoutes = (app, dependencies) => {
  const {
    resolveProjectDirectory,
    resolveOptionalProjectDirectory,
    refreshOpenCodeAfterConfigChange,
    clientReloadDelayMs,
    getAgentSources,
    getAgentConfig,
    createAgent,
    updateAgent,
    deleteAgent,
    getCommandSources,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    getOpenCodePort,
    createCommand,
    updateCommand,
    deleteCommand,
    listMcpConfigs,
    getMcpConfig,
    createMcpConfig,
    updateMcpConfig,
    deleteMcpConfig,
    listSnippets,
    getSnippet,
    createSnippet,
    updateSnippet,
    deleteSnippet,
    expandSnippets,
    configDirectory = path.join(os.homedir(), '.config', 'opencode'),
  } = dependencies;

  app.get('/api/config/catalog/providers', async (req, res) => {
    try {
      const { directory, error } = await resolveProjectDirectory(req);
      if (!directory) {
        return res.status(400).json({ error });
      }
      const client = createOpencodeClient({
        baseUrl: buildOpenCodeUrl('/', '').replace(/\/$/, ''),
        directory,
        headers: getOpenCodeAuthHeaders(),
        fetch: (request) => fetch(request, { signal: AbortSignal.timeout(8_000) }),
      });
      const response = await client.config.providers({ directory });
      if (response?.error || response?.data === undefined) {
        console.error('Provider catalog upstream response failed');
        return res.status(502).json({ error: 'Provider catalog is unavailable' });
      }
      const catalog = projectProviderCatalog(response?.data);
      if (!catalog.ok) {
        console.error('Provider catalog upstream response is malformed');
        return res.status(502).json({ error: 'Provider catalog is unavailable' });
      }
      return res.json(catalog.value);
    } catch {
      console.error('Provider catalog request failed');
      return res.status(502).json({ error: 'Provider catalog is unavailable' });
    }
  });

  app.get('/api/config/global', async (_req, res) => {
    try {
      const targets = (await Promise.all(Object.keys(GLOBAL_CONFIG_FILES).map(async (target) => (
        findGlobalConfigPath(target, configDirectory)
      )))).filter(Boolean).map(({ target, fileName }) => ({ target, fileName }));
      return res.json({ targets });
    } catch (error) {
      console.error('Failed to discover global configuration files:', error);
      return res.status(500).json({ error: 'Failed to discover global configuration files' });
    }
  });

  app.get('/api/config/global/:target', async (req, res) => {
    const target = await findGlobalConfigPath(req.params.target, configDirectory);
    if (!target) {
      return res.status(404).json({ error: 'Global configuration file does not exist' });
    }

    try {
      const content = await fs.readFile(target.filePath, 'utf8');
      return res.json({ target: req.params.target, fileName: target.fileName, content });
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return res.status(404).json({ error: `${target.fileName} does not exist` });
      }
      console.error('Failed to read global configuration:', error);
      return res.status(500).json({ error: 'Failed to read global configuration' });
    }
  });

  app.put('/api/config/global/:target', async (req, res) => {
    const configuredTarget = resolveGlobalConfigPath(req.params.target, configDirectory);
    if (!configuredTarget) {
      return res.status(404).json({ error: 'Unknown global configuration target' });
    }

    const target = await findGlobalConfigPath(req.params.target, configDirectory) || configuredTarget;

    const content = req.body?.content;
    const validationError = validateGlobalConfigContent(content);
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

    try {
      await fs.mkdir(configDirectory, { recursive: true });
      const temporaryPath = `${target.filePath}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeFile(temporaryPath, content, 'utf8');
      await fs.rename(temporaryPath, target.filePath);
      return res.json({
        target: req.params.target,
        fileName: target.fileName,
        content,
        requiresManualRestart: true,
      });
    } catch (error) {
      console.error('Failed to write global configuration:', error);
      return res.status(500).json({ error: 'Failed to write global configuration' });
    }
  });

  // Build the response for a config mutation based on whether OpenCode actually
  // reloaded the change. When connected to an external OpenCode server that
  // OpenChamber cannot restart, the change is persisted to disk but the running
  // server will not serve it until the user restarts that server. We must not
  // report a clean "reloading" success in that case, otherwise the UI silently
  // reverts the edit to the stale value on the next refresh.
  const buildConfigMutationResponse = (refreshResult, { liveMessage, manualRestartMessage }) => {
    if (refreshResult && refreshResult.external) {
      return {
        success: true,
        requiresReload: false,
        requiresManualRestart: true,
        message: manualRestartMessage,
      };
    }

    return {
      success: true,
      requiresReload: true,
      message: liveMessage,
      reloadDelayMs: clientReloadDelayMs,
    };
  };

  const completeMcpMutation = async (res, action, name, applyChange) => {
    applyChange();

    try {
      await refreshOpenCodeAfterConfigChange(`mcp ${action}`);
      return res.json({
        success: true,
        requiresReload: true,
        message: `MCP server "${name}" ${action}d. Reloading interface…`,
        reloadDelayMs: clientReloadDelayMs,
      });
    } catch (error) {
      console.error(`[API:MCP ${action}] Reload failed after config write:`, error);
      return res.json({
        success: true,
        requiresReload: false,
        reloadFailed: true,
        message: `MCP server "${name}" ${action}d, but OpenCode reload failed.`,
        warning: error.message || 'OpenCode reload failed after the MCP configuration changed',
      });
    }
  };

  app.post('/api/config/agents/metadata', async (req, res) => {
    try {
      const { directory, error } = await resolveProjectDirectory(req);
      if (!directory) {
        return res.status(400).json({ error });
      }
      if (!Array.isArray(req.body?.names)) {
        return res.status(400).json({ error: 'names must be an array' });
      }

      const names = [...new Set(req.body.names
        .filter((name) => typeof name === 'string')
        .map((name) => name.trim())
        .filter(Boolean))]
        .slice(0, 500);
      const agents = {};
      for (const agentName of names) {
        const sources = getAgentSources(agentName, directory);
        const scope = sources.md.exists
          ? sources.md.scope
          : (sources.json.exists ? sources.json.scope : null);
        agents[agentName] = {
          scope,
          isBuiltIn: !sources.md.exists && !sources.json.exists,
          sources,
        };
      }
      return res.json({ agents });
    } catch (error) {
      console.error('Failed to get agent metadata batch:', error);
      return res.status(500).json({ error: 'Failed to get agent configuration metadata' });
    }
  });

  app.get('/api/config/agents/:name', async (req, res) => {
    try {
      const agentName = req.params.name;
      const { directory, error } = await resolveProjectDirectory(req);
      if (!directory) {
        return res.status(400).json({ error });
      }
      const sources = getAgentSources(agentName, directory);

      const scope = sources.md.exists
        ? sources.md.scope
        : (sources.json.exists ? sources.json.scope : null);

      res.json({
        name: agentName,
        sources: sources,
        scope,
        isBuiltIn: !sources.md.exists && !sources.json.exists
      });
    } catch (error) {
      console.error('Failed to get agent sources:', error);
      res.status(500).json({ error: 'Failed to get agent configuration metadata' });
    }
  });

  app.get('/api/config/agents/:name/config', async (req, res) => {
    try {
      const agentName = req.params.name;
      const { directory, error } = await resolveProjectDirectory(req);
      if (!directory) {
        return res.status(400).json({ error });
      }

      const configInfo = getAgentConfig(agentName, directory);
      res.json(configInfo);
    } catch (error) {
      console.error('Failed to get agent config:', error);
      res.status(500).json({ error: 'Failed to get agent configuration' });
    }
  });

  app.post('/api/config/agents/:name', async (req, res) => {
    try {
      const agentName = req.params.name;
      const { scope, ...config } = req.body;
      const { directory, error } = await resolveProjectDirectory(req);
      if (!directory) {
        return res.status(400).json({ error });
      }

      console.log('[Server] Creating agent');

      createAgent(agentName, config, directory, scope);
      const refreshResult = await refreshOpenCodeAfterConfigChange('agent creation', {
        agentName
      });

      res.json(buildConfigMutationResponse(refreshResult, {
        liveMessage: `Agent ${agentName} created successfully. Reloading interface…`,
        manualRestartMessage: `Agent ${agentName} saved. Restart your connected OpenCode server to apply the change.`,
      }));
    } catch (error) {
      console.error('Failed to create agent');
      res.status(500).json({ error: error.message || 'Failed to create agent' });
    }
  });

  app.patch('/api/config/agents/:name', async (req, res) => {
    try {
      const agentName = req.params.name;
      const updates = req.body;
      const { directory, error } = await resolveProjectDirectory(req);
      if (!directory) {
        return res.status(400).json({ error });
      }

      console.log('[Server] Updating agent');

      updateAgent(agentName, updates, directory);
      const refreshResult = await refreshOpenCodeAfterConfigChange('agent update');

      console.log('[Server] Agent updated successfully');

      res.json(buildConfigMutationResponse(refreshResult, {
        liveMessage: `Agent ${agentName} updated successfully. Reloading interface…`,
        manualRestartMessage: `Agent ${agentName} saved. Restart your connected OpenCode server to apply the change.`,
      }));
    } catch (error) {
      console.error('[Server] Failed to update agent');
      res.status(500).json({ error: error.message || 'Failed to update agent' });
    }
  });

  app.delete('/api/config/agents/:name', async (req, res) => {
    try {
      const agentName = req.params.name;
      const { directory, error } = await resolveProjectDirectory(req);
      if (!directory) {
        return res.status(400).json({ error });
      }

      const scope = req.body?.scope;
      deleteAgent(agentName, directory, scope);
      const refreshResult = await refreshOpenCodeAfterConfigChange('agent deletion');

      res.json(buildConfigMutationResponse(refreshResult, {
        liveMessage: `Agent ${agentName} deleted successfully. Reloading interface…`,
        manualRestartMessage: `Agent ${agentName} deleted. Restart your connected OpenCode server to apply the change.`,
      }));
    } catch (error) {
      console.error('Failed to delete agent');
      res.status(500).json({ error: error.message || 'Failed to delete agent' });
    }
  });

  app.get('/api/config/mcp', async (req, res) => {
    try {
      const { directory, error } = await resolveOptionalProjectDirectory(req);
      if (error) {
        return res.status(400).json({ error });
      }
      const configs = listMcpConfigs(directory);
      res.json(configs);
    } catch (error) {
      console.error('[API:GET /api/config/mcp] Failed:', error);
      res.status(500).json({ error: error.message || 'Failed to list MCP configs' });
    }
  });

  app.get('/api/config/mcp/:name', async (req, res) => {
    try {
      const name = req.params.name;
      const { directory, error } = await resolveOptionalProjectDirectory(req);
      if (error) {
        return res.status(400).json({ error });
      }
      const config = getMcpConfig(name, directory);
      if (!config) {
        return res.status(404).json({ error: `MCP server "${name}" not found` });
      }
      res.json(config);
    } catch (error) {
      console.error('[API:GET /api/config/mcp/:name] Failed:', error);
      res.status(500).json({ error: error.message || 'Failed to get MCP config' });
    }
  });

  app.post('/api/config/mcp/:name', async (req, res) => {
    try {
      const name = req.params.name;
      const { scope, ...config } = req.body || {};
      const { directory, error } = await resolveOptionalProjectDirectory(req);
      if (error) {
        return res.status(400).json({ error });
      }
      console.log(`[API:POST /api/config/mcp] Creating MCP server: ${name}`);

      await completeMcpMutation(res, 'create', name, () => {
        createMcpConfig(name, config, directory, scope);
      });
    } catch (error) {
      console.error('[API:POST /api/config/mcp/:name] Failed:', error);
      res.status(500).json({ error: error.message || 'Failed to create MCP server' });
    }
  });

  app.patch('/api/config/mcp/:name', async (req, res) => {
    try {
      const name = req.params.name;
      const updates = req.body;
      const { directory, error } = await resolveOptionalProjectDirectory(req);
      if (error) {
        return res.status(400).json({ error });
      }
      console.log(`[API:PATCH /api/config/mcp] Updating MCP server: ${name}`);

      await completeMcpMutation(res, 'update', name, () => {
        updateMcpConfig(name, updates, directory);
      });
    } catch (error) {
      console.error('[API:PATCH /api/config/mcp/:name] Failed:', error);
      if (error?.message === `MCP server "${req.params.name}" not found`) {
        return res.status(404).json({ error: error.message });
      }
      res.status(500).json({ error: error.message || 'Failed to update MCP server' });
    }
  });

  app.delete('/api/config/mcp/:name', async (req, res) => {
    try {
      const name = req.params.name;
      const { directory, error } = await resolveOptionalProjectDirectory(req);
      if (error) {
        return res.status(400).json({ error });
      }
      console.log(`[API:DELETE /api/config/mcp] Deleting MCP server: ${name}`);

      await completeMcpMutation(res, 'delete', name, () => {
        deleteMcpConfig(name, directory);
      });
    } catch (error) {
      console.error('[API:DELETE /api/config/mcp/:name] Failed:', error);
      res.status(500).json({ error: error.message || 'Failed to delete MCP server' });
    }
  });

  app.post('/api/config/commands/metadata', async (req, res) => {
    try {
      const { directory, error } = await resolveProjectDirectory(req);
      if (!directory) {
        return res.status(400).json({ error });
      }
      if (req.body?.catalog === true) {
        if (!getOpenCodePort()) {
          return res.json({ commands: [] });
        }
        const client = createOpencodeClient({
          baseUrl: buildOpenCodeUrl('/', '').replace(/\/$/, ''),
          directory,
          headers: getOpenCodeAuthHeaders(),
          fetch: (request) => fetch(request, { signal: AbortSignal.timeout(8_000) }),
        });
        const response = await client.command.list({ directory });
        const commands = Array.isArray(response?.data) ? response.data : [];
        return res.json({
          commands: commands
            .filter((command) => command?.source !== 'skill')
            .map((command) => {
              const rawName = command?.name;
              if (!isSafeCommandCatalogName(rawName)) return null;
              const name = rawName.trim();
              if (!isSafeCommandCatalogName(name)) return null;
              const sources = getCommandSources(name, directory);
              const scope = sources.md.exists
                ? sources.md.scope
                : (sources.json.exists ? sources.json.scope : null);
              return {
                name,
                description: truncateDescription(command.description),
                agent: typeof command.agent === 'string' ? command.agent : null,
                model: typeof command.model === 'string' ? command.model : null,
                source: typeof command.source === 'string' ? command.source : null,
                scope,
                isBuiltIn: !sources.md.exists && !sources.json.exists,
                reference: sources.md.exists && isSafeCommandCatalogReference(sources.md.path) ? sources.md.path : name,
              };
            })
            .filter(Boolean),
        });
      }
      if (!Array.isArray(req.body?.names)) {
        return res.status(400).json({ error: 'names must be an array' });
      }

      const names = [...new Set(req.body.names
        .filter((name) => typeof name === 'string')
        .map((name) => name.trim())
        .filter(Boolean))]
        .slice(0, 500);
      const commands = {};
      for (const commandName of names) {
        const sources = getCommandSources(commandName, directory);
        const scope = sources.md.exists
          ? sources.md.scope
          : (sources.json.exists ? sources.json.scope : null);
        commands[commandName] = {
          scope,
          isBuiltIn: !sources.md.exists && !sources.json.exists,
        };
      }
      return res.json({ commands });
    } catch (error) {
      console.error('Failed to get command metadata batch:', error);
      return res.status(500).json({ error: 'Failed to get command configuration metadata' });
    }
  });

  app.get('/api/config/commands/:name', async (req, res) => {
    try {
      const commandName = req.params.name;
      const { directory, error } = await resolveProjectDirectory(req);
      if (!directory) {
        return res.status(400).json({ error });
      }
      const sources = getCommandSources(commandName, directory);

      const scope = sources.md.exists
        ? sources.md.scope
        : (sources.json.exists ? sources.json.scope : null);

      res.json({
        name: commandName,
        sources: sources,
        scope,
        isBuiltIn: !sources.md.exists && !sources.json.exists
      });
    } catch (error) {
      console.error('Failed to get command sources:', error);
      res.status(500).json({ error: 'Failed to get command configuration metadata' });
    }
  });

  app.post('/api/config/commands/:name', async (req, res) => {
    try {
      const commandName = req.params.name;
      const { scope, ...config } = req.body;
      const { directory, error } = await resolveProjectDirectory(req);
      if (!directory) {
        return res.status(400).json({ error });
      }

      console.log('[Server] Creating command');

      createCommand(commandName, config, directory, scope);
      await refreshOpenCodeAfterConfigChange('command creation', {
        commandName
      });

      res.json({
        success: true,
        requiresReload: true,
        message: `Command ${commandName} created successfully. Reloading interface…`,
        reloadDelayMs: clientReloadDelayMs,
      });
    } catch (error) {
      console.error('Failed to create command');
      res.status(500).json({ error: error.message || 'Failed to create command' });
    }
  });

  app.patch('/api/config/commands/:name', async (req, res) => {
    try {
      const commandName = req.params.name;
      const updates = req.body;
      const { directory, error } = await resolveProjectDirectory(req);
      if (!directory) {
        return res.status(400).json({ error });
      }

      console.log('[Server] Updating command');

      updateCommand(commandName, updates, directory);
      await refreshOpenCodeAfterConfigChange('command update');

      console.log('[Server] Command updated successfully');

      res.json({
        success: true,
        requiresReload: true,
        message: `Command ${commandName} updated successfully. Reloading interface…`,
        reloadDelayMs: clientReloadDelayMs,
      });
    } catch (error) {
      console.error('[Server] Failed to update command');
      res.status(500).json({ error: error.message || 'Failed to update command' });
    }
  });

  app.delete('/api/config/commands/:name', async (req, res) => {
    try {
      const commandName = req.params.name;
      const { directory, error } = await resolveProjectDirectory(req);
      if (!directory) {
        return res.status(400).json({ error });
      }

      deleteCommand(commandName, directory);
      await refreshOpenCodeAfterConfigChange('command deletion');

      res.json({
        success: true,
        requiresReload: true,
        message: `Command ${commandName} deleted successfully. Reloading interface…`,
        reloadDelayMs: clientReloadDelayMs,
      });
    } catch (error) {
      console.error('Failed to delete command');
      res.status(500).json({ error: error.message || 'Failed to delete command' });
    }
  });

  app.get('/api/config/snippets', async (req, res) => {
    try {
      const { directory, error } = await resolveOptionalProjectDirectory(req);
      if (error) {
        return res.status(400).json({ error });
      }
      res.json(listSnippets(directory));
    } catch (error) {
      console.error('[API:GET /api/config/snippets] Failed:', error);
      res.status(500).json({ error: error.message || 'Failed to list snippets' });
    }
  });

  app.post('/api/config/snippets/expand', async (req, res) => {
    try {
      const { directory, error } = await resolveOptionalProjectDirectory(req);
      if (error) {
        return res.status(400).json({ error });
      }
      res.json({ text: expandSnippets(req.body?.text ?? '', directory) });
    } catch (error) {
      console.error('[API:POST /api/config/snippets/expand] Failed:', error);
      res.status(500).json({ error: error.message || 'Failed to expand snippets' });
    }
  });

  app.get('/api/config/snippets/:name', async (req, res) => {
    try {
      const name = req.params.name;
      const { directory, error } = await resolveOptionalProjectDirectory(req);
      if (error) {
        return res.status(400).json({ error });
      }
      const snippet = getSnippet(name, directory);
      if (!snippet) {
        return res.status(404).json({ error: `Snippet "${name}" not found` });
      }
      res.json(snippet);
    } catch (error) {
      console.error('[API:GET /api/config/snippets/:name] Failed:', error);
      if (error.message?.includes('Snippet name')) {
        return res.status(400).json({ error: error.message });
      }
      res.status(500).json({ error: error.message || 'Failed to get snippet' });
    }
  });

  app.post('/api/config/snippets/:name', async (req, res) => {
    try {
      const name = req.params.name;
      const { directory, error } = await resolveOptionalProjectDirectory(req);
      if (error) {
        return res.status(400).json({ error });
      }
      const snippet = createSnippet(name, req.body || {}, directory, req.body?.scope || 'global');
      res.json({ success: true, snippet });
    } catch (error) {
      console.error('[API:POST /api/config/snippets/:name] Failed:', error);
      if (error.message?.includes('already exists')) {
        return res.status(409).json({ error: error.message });
      }
      if (error.message?.includes('Snippet name') || error.message?.includes('Project directory')) {
        return res.status(400).json({ error: error.message });
      }
      res.status(500).json({ error: error.message || 'Failed to create snippet' });
    }
  });

  app.patch('/api/config/snippets/:name', async (req, res) => {
    try {
      const name = req.params.name;
      const { directory, error } = await resolveOptionalProjectDirectory(req);
      if (error) {
        return res.status(400).json({ error });
      }
      res.json({ success: true, snippet: updateSnippet(name, req.body || {}, directory) });
    } catch (error) {
      console.error('[API:PATCH /api/config/snippets/:name] Failed:', error);
      if (error.message?.includes('not found')) {
        return res.status(404).json({ error: error.message });
      }
      if (error.message?.includes('Snippet name')) {
        return res.status(400).json({ error: error.message });
      }
      res.status(500).json({ error: error.message || 'Failed to update snippet' });
    }
  });

  app.delete('/api/config/snippets/:name', async (req, res) => {
    try {
      const name = req.params.name;
      const { directory, error } = await resolveOptionalProjectDirectory(req);
      if (error) {
        return res.status(400).json({ error });
      }
      deleteSnippet(name, directory);
      res.json({ success: true });
    } catch (error) {
      console.error('[API:DELETE /api/config/snippets/:name] Failed:', error);
      if (error.message?.includes('not found')) {
        return res.status(404).json({ error: error.message });
      }
      if (error.message?.includes('Snippet name')) {
        return res.status(400).json({ error: error.message });
      }
      res.status(500).json({ error: error.message || 'Failed to delete snippet' });
    }
  });
};
