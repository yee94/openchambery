export default async function scheduledTaskPlugin() {
  const bridgeOrigin = process.env.OPENCHAMBER_SCHEDULED_TASK_BRIDGE_ORIGIN;
  const bridgePath = process.env.OPENCHAMBER_SCHEDULED_TASK_BRIDGE_PATH;
  const tokenHeader = process.env.OPENCHAMBER_SCHEDULED_TASK_TOKEN_HEADER;
  const bridgeToken = process.env.OPENCHAMBER_SCHEDULED_TASK_BRIDGE_TOKEN;
  const operations = ['list', 'create', 'update', 'delete', 'run'];

  const requestSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      operation: { type: 'string', enum: operations, description: 'list, create, update, delete, or run' },
      taskId: { type: 'string', description: 'Task id for update, delete, or run' },
      name: { type: 'string', description: 'Task name' },
      enabled: { type: 'boolean', description: 'false pauses a task; true resumes it' },
      schedule: {
        type: 'object',
        description: 'Schedule with kind daily, weekly, once, or cron. weekdays uses 0=Sunday through 6=Saturday.',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', enum: ['daily', 'weekly', 'once', 'cron'] },
          time: { type: 'string', description: 'Local HH:mm time for daily, weekly, or once schedules' },
          times: { type: 'array', items: { type: 'string' }, description: 'Local HH:mm times for daily or weekly schedules' },
          weekdays: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 6 } },
          date: { type: 'string', description: 'YYYY-MM-DD date for once schedules' },
          cron: { type: 'string', description: 'Cron expression for cron schedules' },
          timezone: { type: 'string' },
        },
      },
      execution: {
        type: 'object',
        description: 'Scheduled prompt and execution settings. providerID and modelID default to the current session model.',
        additionalProperties: false,
        properties: {
          prompt: { type: 'string' }, providerID: { type: 'string' }, modelID: { type: 'string' }, agent: { type: 'string' }, variant: { type: 'string' }, goalEnabled: { type: 'boolean' }, goalTokenBudget: { type: 'number', minimum: 1 },
        },
      },
    },
    oneOf: [
      { required: ['operation'], properties: { operation: { enum: ['list'] } }, allOf: [{ not: { required: ['taskId'] } }, { not: { required: ['name'] } }, { not: { required: ['enabled'] } }, { not: { required: ['schedule'] } }, { not: { required: ['execution'] } }] },
      { required: ['operation', 'name', 'schedule', 'execution'], properties: { operation: { enum: ['create'] }, execution: { type: 'object', required: ['prompt'] } }, not: { required: ['taskId'] } },
      { required: ['operation', 'taskId'], properties: { operation: { enum: ['update'] } } },
      { required: ['operation', 'taskId'], properties: { operation: { enum: ['delete'] } }, allOf: [{ not: { required: ['name'] } }, { not: { required: ['enabled'] } }, { not: { required: ['schedule'] } }, { not: { required: ['execution'] } }] },
      { required: ['operation', 'taskId'], properties: { operation: { enum: ['run'] } }, allOf: [{ not: { required: ['name'] } }, { not: { required: ['enabled'] } }, { not: { required: ['schedule'] } }, { not: { required: ['execution'] } }] },
    ],
  };

  const addDefaultAsk = (permission) => {
    if (typeof permission === 'undefined') return { scheduled_task: 'ask' };
    if (typeof permission === 'string') return permission;
    if (!permission || typeof permission !== 'object' || Array.isArray(permission)) return permission;
    if (Object.prototype.hasOwnProperty.call(permission, 'scheduled_task') || Object.prototype.hasOwnProperty.call(permission, '*')) {
      return permission;
    }
    return { ...permission, scheduled_task: 'ask' };
  };

  return {
    config: async (config) => {
      config.permission = addDefaultAsk(config.permission);
    },
    tool: {
      scheduled_task: {
        description: 'Manage OpenChamber schedules. Daily uses time or times; weekly uses weekdays (0=Sunday) with time or times; once uses date and time; cron uses cron. The current session model is the execution default. Update with enabled:false pauses and enabled:true resumes.',
        args: { request: requestSchema },
        execute: async (args, context) => {
          const request = args?.request;
          const operation = request?.operation;
          if (!operations.includes(operation)) throw new Error('scheduled_task requires a supported request.operation');
          if (!bridgeOrigin || !bridgePath || !tokenHeader || !bridgeToken) throw new Error('scheduled_task bridge is unavailable');
          if (['create', 'update', 'delete', 'run'].includes(operation)) {
            await context.ask({
              permission: 'scheduled_task',
              patterns: [operation],
              always: [operation],
              metadata: { operation, taskId: request.taskId || null },
            });
          }
          const { operation: _operation, ...input } = request;
          const payload = {
            operation,
            context: {
              sessionID: context.sessionID,
              messageID: context.messageID,
              directory: context.directory,
              worktree: context.worktree,
              agent: context.agent,
            },
            input,
          };
          let response;
          try {
            response = await fetch(new URL(bridgePath, bridgeOrigin), {
              method: 'POST',
              headers: { 'content-type': 'application/json', [tokenHeader]: bridgeToken },
              body: JSON.stringify(payload),
            });
          } catch (error) {
            throw new Error(`scheduled_task bridge request failed: ${error instanceof Error ? error.message : String(error)}`);
          }
          const body = await response.json().catch(() => ({}));
          if (!response.ok) {
            const safeError = typeof body?.error === 'string' && body.error.trim() ? body.error.trim() : 'Schedule request failed';
            throw new Error(`scheduled_task bridge responded with ${response.status}: ${safeError}`);
          }
          try {
            return JSON.stringify(body);
          } catch {
            return '{}';
          }
        },
      },
    },
  };
}
