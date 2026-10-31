import { createProjectIdFromPath } from './project-id.js';

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const string = (value, field, max = 4096) => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
    fail('validation_error', `${field} must be a nonempty string (maximum ${max} characters).`);
  }
  return value.trim();
};

// Registry mutations share the settings owner's exclusive read/modify/write path.
export const createProjectRegistry = ({ persistSettings, validateDirectoryPath }) => {
  const register = async (input = {}) => {
    const validated = await validateDirectoryPath(string(input.path, 'path'));
    if (!validated.ok) fail('validation_error', validated.error || 'Project directory is unavailable.');
    const directory = validated.directory;
    const label = input.label === undefined ? undefined : string(input.label, 'label', 80);
    let project;
    let created = false;
    const settings = await persistSettings((current) => {
      const projects = Array.isArray(current.projects) ? current.projects : [];
      const existing = projects.find((entry) => entry.path === directory);
      created = !existing;
      project = existing || { id: createProjectIdFromPath(directory), path: directory, addedAt: Date.now(), lastOpenedAt: Date.now(), ...(label ? { label } : {}) };
      return {
        projects: created ? [...projects, project] : projects,
        ...(input.activate === true ? { activeProjectId: project.id, lastDirectory: directory } : {}),
      };
    });
    const saved = settings.projects?.find((entry) => entry.id === project.id);
    if (!saved) fail('project_unavailable', 'The directory disappeared before the project could be registered. No session was opened.');
    return { project: saved, created, settings };
  };

  return { register };
};
