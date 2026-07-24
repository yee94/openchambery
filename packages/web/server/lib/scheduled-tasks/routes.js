const asNonEmptyString = (value) => {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const parseProjectID = (req) => asNonEmptyString(req?.params?.projectId);
const parseTaskID = (req) => asNonEmptyString(req?.params?.taskId);

export const registerScheduledTaskRoutes = (app, dependencies) => {
  const {
    readSettingsFromDiskMigrated,
    sanitizeProjects,
    projectConfigRuntime,
    scheduledTasksRuntime,
    getOpenChamberEventClients,
    writeSseEvent,
    scheduleSyncRetry = (retry) => {
      const timer = setTimeout(retry, 1_000);
      timer.unref?.();
      return timer;
    },
  } = dependencies;

  const syncAfterMutation = async (projectID) => {
    try {
      await scheduledTasksRuntime.syncProject(projectID);
      return true;
    } catch (error) {
      console.error('[ScheduledTasks] scheduler sync failed:', error);
      try {
        scheduleSyncRetry(() => {
          Promise.resolve(scheduledTasksRuntime.syncProject(projectID)).catch((retryError) => {
            console.error('[ScheduledTasks] scheduler sync retry failed:', retryError);
          });
        });
      } catch (scheduleError) {
        console.error('[ScheduledTasks] failed to schedule scheduler sync retry:', scheduleError);
      }
      return false;
    }
  };

  const findProjectByID = async (projectID) => {
    const settings = await readSettingsFromDiskMigrated();
    const projects = sanitizeProjects(settings?.projects || []);
    return projects.find((project) => project.id === projectID) || null;
  };

  app.get('/api/openchamber/scheduled-tasks', async (_req, res) => {
    let projects;

    try {
      const settings = await readSettingsFromDiskMigrated();
      projects = sanitizeProjects(settings?.projects || []);
    } catch {
      console.error('[ScheduledTasks] failed to read projects for scheduled task list');
      return res.status(500).json({ error: 'Failed to load schedules' });
    }

    const results = await Promise.all(projects.map(async (project) => {
      try {
        const tasks = await projectConfigRuntime.listScheduledTasks(project.id);
        return { tasks: tasks.map((task) => ({ projectId: project.id, task })) };
      } catch {
        console.error(`[ScheduledTasks] failed to load scheduled tasks for project ${project.id}`);
        return { failedProjectId: project.id };
      }
    }));

    const tasks = [];
    const failedProjectIds = [];

    for (const result of results) {
      if (result.failedProjectId) {
        failedProjectIds.push(result.failedProjectId);
      } else {
        tasks.push(...result.tasks);
      }
    }

    return res.json({ tasks, failedProjectIds });
  });

  app.get('/api/projects/:projectId/scheduled-tasks', async (req, res) => {
    const projectID = parseProjectID(req);
    if (!projectID) {
      return res.status(400).json({ error: 'projectId is required' });
    }

    try {
      const project = await findProjectByID(projectID);
      if (!project) {
        return res.status(404).json({ error: 'Project not found' });
      }

      const tasks = await projectConfigRuntime.listScheduledTasks(projectID);
      return res.json({ tasks });
    } catch (error) {
      console.error('[ScheduledTasks] failed to load tasks:', error);
      return res.status(500).json({ error: 'Failed to load schedules' });
    }
  });

  app.put('/api/projects/:projectId/scheduled-tasks', async (req, res) => {
    const projectID = parseProjectID(req);
    if (!projectID) {
      return res.status(400).json({ error: 'projectId is required' });
    }

    const taskInput = req.body && typeof req.body === 'object' ? req.body.task : null;
    if (!taskInput || typeof taskInput !== 'object') {
      return res.status(400).json({ error: 'task payload is required' });
    }

    try {
      const project = await findProjectByID(projectID);
      if (!project) {
        return res.status(404).json({ error: 'Project not found' });
      }

      const upserted = await projectConfigRuntime.upsertScheduledTask(projectID, taskInput);
      const schedulerSynced = await syncAfterMutation(projectID);

      return res.json({
        tasks: upserted.tasks,
        task: upserted.task,
        created: upserted.created,
        schedulerSynced,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to save schedule';
      const statusCode = message.toLowerCase().includes('required') || message.toLowerCase().includes('invalid')
        ? 400
        : 500;
      if (statusCode === 500) {
        console.error('[ScheduledTasks] failed to save task:', error);
      }
      return res.status(statusCode).json({ error: message });
    }
  });

  app.delete('/api/projects/:projectId/scheduled-tasks/:taskId', async (req, res) => {
    const projectID = parseProjectID(req);
    const taskID = parseTaskID(req);
    if (!projectID) {
      return res.status(400).json({ error: 'projectId is required' });
    }
    if (!taskID) {
      return res.status(400).json({ error: 'taskId is required' });
    }

    try {
      const project = await findProjectByID(projectID);
      if (!project) {
        return res.status(404).json({ error: 'Project not found' });
      }

      const result = await projectConfigRuntime.deleteScheduledTask(projectID, taskID);
      if (!result.deleted) {
        return res.status(404).json({ error: 'Schedule not found' });
      }
      const schedulerSynced = await syncAfterMutation(projectID);
      return res.json({ tasks: result.tasks, schedulerSynced });
    } catch (error) {
      console.error('[ScheduledTasks] failed to delete task:', error);
      return res.status(500).json({ error: 'Failed to delete schedule' });
    }
  });

  app.post('/api/projects/:projectId/scheduled-tasks/:taskId/run', async (req, res) => {
    const projectID = parseProjectID(req);
    const taskID = parseTaskID(req);
    if (!projectID) {
      return res.status(400).json({ error: 'projectId is required' });
    }
    if (!taskID) {
      return res.status(400).json({ error: 'taskId is required' });
    }

    try {
      const project = await findProjectByID(projectID);
      if (!project) {
        return res.status(404).json({ error: 'Project not found' });
      }

      const result = await scheduledTasksRuntime.runNow(projectID, taskID);
      if (result.running || result.queued) {
        return res.status(409).json({ error: result.error || 'Schedule already running' });
      }
      if (result.skipped) {
        return res.status(404).json({ error: 'Schedule not found or disabled' });
      }
      if (!result.ok) {
        return res.status(500).json({
          error: result.error || 'Schedule run failed',
          task: result.task,
        });
      }

      return res.json({
        ok: true,
        task: result.task,
        sessionId: result.sessionID,
      });
    } catch (error) {
      console.error('[ScheduledTasks] failed to run task:', error);
      return res.status(500).json({ error: 'Failed to run schedule' });
    }
  });

  app.get('/api/openchamber/scheduled-tasks/status', async (_req, res) => {
    try {
      if (typeof scheduledTasksRuntime.getStatus === 'function') {
        return res.json(scheduledTasksRuntime.getStatus());
      }

      const settings = await readSettingsFromDiskMigrated();
      const projects = sanitizeProjects(settings?.projects || []);

      let enabledCount = 0;
      let runningCount = 0;

      for (const project of projects) {
        try {
          const tasks = await projectConfigRuntime.listScheduledTasks(project.id);
          for (const task of tasks) {
            if (task?.enabled) {
              enabledCount += 1;
            }
            if (task?.state?.lastStatus === 'running') {
              runningCount += 1;
            }
          }
        } catch {
        }
      }

      return res.json({
        hasEnabledScheduledTasks: enabledCount > 0,
        hasRunningScheduledTasks: runningCount > 0,
        enabledScheduledTasksCount: enabledCount,
        runningScheduledTasksCount: runningCount,
      });
    } catch (error) {
      console.error('[ScheduledTasks] failed to resolve scheduled task status:', error);
      return res.status(500).json({ error: 'Failed to resolve schedule status' });
    }
  });

  app.get('/api/openchamber/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const clients = getOpenChamberEventClients();
    clients.add(res);

    try {
      writeSseEvent(res, {
        type: 'openchamber:event-stream-ready',
        properties: {
          connectedAt: Date.now(),
        },
      });
    } catch {
    }

    const heartbeat = setInterval(() => {
      try {
        writeSseEvent(res, {
          type: 'openchamber:heartbeat',
          properties: {
            timestamp: Date.now(),
          },
        });
      } catch {
        clearInterval(heartbeat);
        clients.delete(res);
      }
    }, 25_000);

    req.on('close', () => {
      clearInterval(heartbeat);
      clients.delete(res);
    });
  });
};
