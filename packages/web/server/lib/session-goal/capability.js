/**
 * Session-goal Host capability for the current OpenCode surface.
 *
 * Goal records live in the OpenChamber session-metadata store
 * (`packages/web/server/lib/session-metadata/`), not OpenCode SessionInfo.
 * When the store + scheduled-task / route persist seams are wired, advertise
 * supported so create·resume·edit paths write trackable goal state.
 *
 * `SESSION_GOAL_UNSUPPORTED_REASON` remains for structured refusals if a
 * future surface must advertise unsupported again.
 */

export const SESSION_GOAL_UNSUPPORTED_REASON = 'v2_goal_state_unavailable';

/**
 * @returns {{ supported: false, reason: typeof SESSION_GOAL_UNSUPPORTED_REASON }
 *   | { supported: true, reason?: undefined }}
 */
export function getSessionGoalCapability() {
  return {
    supported: true,
  };
}

export function isSessionGoalSupported() {
  return getSessionGoalCapability().supported === true;
}

/**
 * Human-readable refusal for APIs / run history when goal state is unavailable.
 * @param {{ supported: boolean, reason?: string }} [capability]
 */
export function sessionGoalUnavailableMessage(capability = getSessionGoalCapability()) {
  const reason = typeof capability?.reason === 'string' && capability.reason.trim()
    ? capability.reason.trim()
    : SESSION_GOAL_UNSUPPORTED_REASON;
  return `session goal is unavailable (${reason})`;
}

/**
 * Throw a structured refusal for create / edit / resume / objective-write paths.
 * @param {{ operation?: string }} [options]
 */
export function assertSessionGoalSupported(options = {}) {
  const capability = getSessionGoalCapability();
  if (capability.supported) {
    return capability;
  }
  const operation = typeof options.operation === 'string' && options.operation.trim()
    ? options.operation.trim()
    : 'goal';
  const error = new Error(`${sessionGoalUnavailableMessage(capability)}: cannot ${operation}`);
  error.statusCode = 501;
  error.code = capability.reason || SESSION_GOAL_UNSUPPORTED_REASON;
  error.capability = capability;
  throw error;
}
