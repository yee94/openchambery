/**
 * Host-owned isolation markers for system sessions.
 *
 * Sidebar / session-index / notifications hide a session only when these
 * fields are present. Title prefixes are labels and never ownership.
 *
 * Every system session creator (scheduled tasks, LLM attachment gateway,
 * Assistant bindings) must persist the matching patch through the Host
 * session-metadata store. OpenCode create-time `metadata` is a hint only.
 */

export const LLM_SESSION_PURPOSE = 'chat-completions';

const nonEmpty = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);

export const buildScheduledTaskMetadata = ({ projectID, taskID, runID, name } = {}) => {
  const id = nonEmpty(taskID);
  if (!id) {
    throw new Error('scheduled-task metadata requires taskID');
  }
  return {
    openchamber: {
      scheduledTask: {
        taskID: id,
        ...(nonEmpty(projectID) ? { projectID: nonEmpty(projectID) } : {}),
        ...(nonEmpty(runID) ? { runID: nonEmpty(runID) } : {}),
        ...(nonEmpty(name) ? { name: nonEmpty(name) } : {}),
      },
    },
  };
};

export const buildLlmSessionMetadata = (purpose = LLM_SESSION_PURPOSE) => {
  const resolved = nonEmpty(purpose) || LLM_SESSION_PURPOSE;
  return {
    openchamber: {
      llm: { purpose: resolved },
    },
  };
};

export const buildAssistantSessionMetadata = ({ assistantID, name } = {}) => {
  const id = nonEmpty(assistantID);
  if (!id) {
    throw new Error('assistant session metadata requires assistantID');
  }
  return {
    openchamber: {
      assistant: {
        assistantID: id,
        ...(nonEmpty(name) ? { name: nonEmpty(name) } : {}),
      },
    },
  };
};
