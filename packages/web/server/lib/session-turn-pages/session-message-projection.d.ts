/**
 * Type surface for session-message-projection.js (consumed by the VS Code
 * turn-page bridge). Runtime implementation stays in the .js module.
 */

export type ProjectedSessionMessage = {
  info: { id: string; role: string; [key: string]: unknown };
  parts: unknown[];
};

export function projectSessionMessage(entry: unknown): ProjectedSessionMessage | null;

export function projectSessionMessageRecords(records: unknown): ProjectedSessionMessage[];
