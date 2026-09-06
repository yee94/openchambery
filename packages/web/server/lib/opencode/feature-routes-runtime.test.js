import fs from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { createWorktreeTopologyBroadcaster } from './feature-routes-runtime.js';

describe('feature routes runtime composition', () => {
  it('wires scheduled-task upsert into assistant contact tools', async () => {
    const source = await fs.readFile(new URL('./feature-routes-runtime.js', import.meta.url), 'utf8');
    expect(source).toMatch(/registerAssistantRoutes\(app, \{[\s\S]*upsertScheduledTask:[\s\S]*projectConfigRuntime\.upsertScheduledTask/);
    expect(source).toMatch(/registerAssistantRoutes\(app, \{[\s\S]*syncScheduledTaskProject:[\s\S]*scheduledTasksRuntime\.syncProject/);
    expect(source).toMatch(/registerAssistantRoutes\(app, \{[\s\S]*listProjects:/);
  });

  it('registers the managed scheduled-task tool route with its required dependencies', async () => {
    const source = await fs.readFile(new URL('./feature-routes-runtime.js', import.meta.url), 'utf8');
    expect(source).toContain("import { registerScheduledTaskToolRoute } from '../scheduled-tasks/managed-tool-route.js';");
    expect(source).toMatch(/const \{[\s\S]*express,[\s\S]*\} = routeDependencies;/);
    expect(source).toMatch(/registerScheduledTaskToolRoute\(app, \{[\s\S]*express,[\s\S]*validateDirectoryPath,[\s\S]*scheduledTasksRuntime,/);
  });

  it('injects the scheduled-task run history store into scheduled task routes', async () => {
    const source = await fs.readFile(new URL('./feature-routes-runtime.js', import.meta.url), 'utf8');
    expect(source).toMatch(/const \{[\s\S]*runHistoryStore,[\s\S]*\} = routeDependencies;/);
    expect(source).toMatch(/registerScheduledTaskRoutes\(app, \{[\s\S]*runHistoryStore,/);
  });

  it('registers message queue routes with the injected service before proxy composition', async () => {
    const source = await fs.readFile(new URL('./feature-routes-runtime.js', import.meta.url), 'utf8');
    expect(source).toContain("import { registerMessageQueueRoutes } from '../message-queue/routes.js';");
    expect(source).toMatch(/const \{[\s\S]*messageQueueService,[\s\S]*\} = routeDependencies;/);
    expect(source).toContain('registerMessageQueueRoutes(app, { messageQueueService, messageQueueRuntime });');
  });

  it('registers session turn-page routes before proxy composition with OpenCode URL/auth deps', async () => {
    const source = await fs.readFile(new URL('./feature-routes-runtime.js', import.meta.url), 'utf8');
    expect(source).toContain("import { registerSessionTurnPageRoutes } from '../session-turn-pages/routes.js';");
    expect(source).toMatch(/registerSessionTurnPageRoutes\(app, \{[\s\S]*buildOpenCodeUrl,[\s\S]*getOpenCodeAuthHeaders,/);
    // OpenChamber-owned turn-page/reconcile/changes/exact-message registration stays before end of feature composition.
    expect(source).toContain('// OpenChamber-owned turn-window messages API — must register before generic proxy.');
    const turnIdx = source.indexOf('registerSessionTurnPageRoutes(app,');
    expect(turnIdx).toBeGreaterThan(-1);
    // Exact message + Changes live inside registerSessionTurnPageRoutes (same Host composition Electron reuses).
    const routesSource = await fs.readFile(new URL('../session-turn-pages/routes.js', import.meta.url), 'utf8');
    expect(routesSource).toContain("app.get('/api/session/:sessionID/message/:messageID'");
    expect(routesSource).toContain("app.get('/api/openchamber/sessions/:sessionID/changes'");
    const exactIdx = routesSource.indexOf("app.get('/api/session/:sessionID/message/:messageID'");
    const changesIdx = routesSource.indexOf("app.get('/api/openchamber/sessions/:sessionID/changes'");
    const messagesIdx = routesSource.indexOf("app.get('/api/openchamber/sessions/:sessionID/messages'");
    expect(exactIdx).toBeGreaterThan(messagesIdx);
    expect(changesIdx).toBeGreaterThan(exactIdx);
  });

  it('removes broken SSE clients while continuing worktree topology broadcasts', () => {
    const brokenClient = {};
    const healthyClient = {};
    const clients = new Set([brokenClient, healthyClient]);
    const writeSseEvent = vi.fn((client) => {
      if (client === brokenClient) throw new Error('closed stream');
    });
    const broadcast = createWorktreeTopologyBroadcaster({
      getOpenChamberEventClients: () => clients,
      writeSseEvent,
    });

    broadcast({ type: 'openchamber:worktree-topology-changed', properties: {} });

    expect(clients).toEqual(new Set([healthyClient]));
    expect(writeSseEvent).toHaveBeenCalledTimes(2);
  });
});
