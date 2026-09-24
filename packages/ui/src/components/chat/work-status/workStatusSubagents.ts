import type { Part } from '@/lib/opencode/v2-types';
import { isTaskToolName, readTaskSessionIdFromRecord } from '@/components/chat/message/parts/taskToolModel';

export type WorkStatusSubagentPhase = 'working' | 'done';

/** One face in the work-status subagent stack. */
export type WorkStatusSubagent = {
  key: string;
  sessionID?: string;
  seed: string;
  label: string;
  phase: WorkStatusSubagentPhase;
};

/** Task or subtask row projected from the parent transcript. */
export type TranscriptSubagentFace = {
  id: string;
  sessionID?: string;
  label: string;
  running: boolean;
};

export type WorkStatusChildSession = {
  id: string;
  title?: string;
  busy: boolean;
};

const EMPTY_TRANSCRIPT_SUBAGENTS: readonly TranscriptSubagentFace[] = [];

const AGENT_NAME_KEYS = ['subagent_type', 'subagentType', 'agent', 'subagent'] as const;

const readAgentLabel = (...sources: unknown[]): string => {
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    const record = source as Record<string, unknown>;
    for (const key of AGENT_NAME_KEYS) {
      const value = record[key];
      if (typeof value !== 'string') continue;
      const trimmed = value.trim();
      if (trimmed) return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
    }
  }
  return '';
};

const readOptionalSessionId = (value: unknown): string | undefined => {
  const sessionID = readTaskSessionIdFromRecord(value);
  return sessionID || undefined;
};

const isRunningStatus = (status: unknown): boolean => status === 'pending' || status === 'running';

/**
 * Task/subagent tool parts and native subtask parts in transcript order.
 * Pending and running tool state count as still working. A completed tool
 * stays done here; a live child-session status can promote it later.
 */
export const projectTranscriptSubagents = (data: {
  messageOrder: readonly string[];
  partsByMessageID: Readonly<Record<string, readonly Part[] | undefined>>;
}): readonly TranscriptSubagentFace[] => {
  const faces: TranscriptSubagentFace[] = [];
  const seen = new Set<string>();
  for (const messageID of data.messageOrder) {
    const parts = data.partsByMessageID[messageID];
    if (!parts) continue;
    for (const part of parts) {
      if (!part?.id || seen.has(part.id)) continue;
      if (part.type === 'tool' && isTaskToolName(part.tool)) {
        seen.add(part.id);
        const state = part.state;
        faces.push({
          id: part.id,
          sessionID: readOptionalSessionId(part.metadata)
            ?? readOptionalSessionId(state)
            ?? readOptionalSessionId(state?.metadata)
            ?? readOptionalSessionId(state?.input),
          label: readAgentLabel(state?.input, part.metadata, state?.metadata),
          running: isRunningStatus(state?.status),
        });
        continue;
      }
      if (part.type !== 'subtask') continue;
      const record = part as Part & { taskSessionID?: unknown; agent?: unknown; description?: unknown; status?: unknown };
      const sessionID = typeof record.taskSessionID === 'string' ? record.taskSessionID.trim() : '';
      const agent = typeof record.agent === 'string' ? record.agent.trim() : '';
      const description = typeof record.description === 'string' ? record.description.trim() : '';
      seen.add(part.id);
      faces.push({
        id: part.id,
        sessionID: sessionID || undefined,
        label: agent ? agent.charAt(0).toUpperCase() + agent.slice(1) : description,
        running: isRunningStatus(record.status),
      });
    }
  }
  return faces.length === 0 ? EMPTY_TRANSCRIPT_SUBAGENTS : faces;
};

export const transcriptSubagentsEqual = (
  left: readonly TranscriptSubagentFace[],
  right: readonly TranscriptSubagentFace[],
): boolean => {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (!a || !b) return false;
    if (a.id !== b.id || a.sessionID !== b.sessionID || a.label !== b.label || a.running !== b.running) return false;
  }
  return true;
};

/**
 * One face per task/subtask, plus child sessions that are not already linked
 * by session id. A busy or retrying child keeps the face working after the
 * parent tool part has completed. Working faces stay ahead of completed ones.
 */
export const mergeWorkStatusSubagents = (
  tasks: readonly TranscriptSubagentFace[],
  children: readonly WorkStatusChildSession[],
  busyIds?: ReadonlySet<string>,
): WorkStatusSubagent[] => {
  const childById = new Map(children.map((child) => [child.id, child]));
  const linked = new Set<string>();
  const faces: WorkStatusSubagent[] = [];
  for (const task of tasks) {
    if (task.sessionID) linked.add(task.sessionID);
    const child = task.sessionID ? childById.get(task.sessionID) : undefined;
    const working = task.running || Boolean(child?.busy) || Boolean(task.sessionID && busyIds?.has(task.sessionID));
    faces.push({
      key: task.id,
      sessionID: task.sessionID,
      seed: task.id,
      label: task.label || child?.title?.trim() || '',
      phase: working ? 'working' : 'done',
    });
  }
  for (const child of children) {
    if (linked.has(child.id)) continue;
    faces.push({
      key: child.id,
      sessionID: child.id,
      seed: child.id,
      label: child.title?.trim() || '',
      phase: child.busy ? 'working' : 'done',
    });
  }
  const working = faces.filter((face) => face.phase === 'working');
  const done = faces.filter((face) => face.phase === 'done');
  return working.length === 0 ? done : done.length === 0 ? working : [...working, ...done];
};
