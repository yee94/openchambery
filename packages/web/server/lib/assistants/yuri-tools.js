export function createYuriContactToolGroups(tools) {
  return [
    { id: 'yuri.projects', description: 'Register an existing workspace before opening a coding session.', names: ['register_project'] },
    { id: 'yuri.assistants', description: 'Create a Bot or change its avatar.', names: ['create_assistant', 'update_avatar'] },
    { id: 'yuri.tasks', description: 'Create or update scheduled tasks (including pause/resume).', names: ['schedule_task', 'update_scheduled_task'] },
  ].map(({ id, description, names }) => ({ id, description, tools: tools.filter((tool) => names.includes(tool.name)) }))
    .filter((group) => group.tools.length > 0);
}

const result = (details, isError = false) => ({
  content: [{ type: 'text', text: JSON.stringify(details) }], details, isError, terminate: false,
});

/** Assistant-local business capability; never registered with OpenCode or its skills catalog. */
export function createYuriContactTools({ registerProject } = {}) {
  if (typeof registerProject !== 'function') return [];
  return [{
    name: 'register_project', label: 'Register project',
    description: 'Register an existing user-requested absolute Host directory as a Yuri project, then call assign_session with the returned project.path in the same turn. Does not clone/create files or switch an existing active project. Never register a guessed directory or assistant-workspaces.',
    parameters: { type: 'object', additionalProperties: false, required: ['path'], properties: {
      path: { type: 'string', minLength: 1, maxLength: 4096, description: 'Existing absolute Host directory resolved from the user request or filesystem discovery.' },
      label: { type: 'string', minLength: 1, maxLength: 80, description: 'Optional project display name.' },
    } },
    execute: async (_id, params, signal) => {
      signal?.throwIfAborted();
      if (!params || Array.isArray(params) || typeof params !== 'object'
        || Object.keys(params).some((key) => !['path', 'label'].includes(key))
        || typeof params.path !== 'string' || !params.path.trim() || params.path.length > 4096
        || (params.label !== undefined && (typeof params.label !== 'string' || !params.label.trim() || params.label.length > 80))) {
        return result({ error: 'validation_error' }, true);
      }
      try {
        const { project, created } = await registerProject(params, signal);
        return result({ project: { id: project.id, path: project.path, ...(project.label ? { label: project.label } : {}) }, created });
      } catch (error) {
        signal?.throwIfAborted();
        const code = ['validation_error', 'workspace_forbidden', 'project_unavailable'].includes(error?.code) ? error.code : 'yuri_operation_failed';
        return result({ error: code, message: 'Registration failed. Check the project catalog before retrying; do not claim success.' }, true);
      }
    },
  }];
}
