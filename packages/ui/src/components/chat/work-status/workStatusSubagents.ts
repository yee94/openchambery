import type { Part } from '@/lib/opencode/v2-types';
import {
  isTaskToolName,
  readTaskSessionIdFromOutput,
  readTaskSessionIdFromRecord,
} from '@/components/chat/message/parts/taskToolModel';

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
  /** Agent display name. Not the task title. */
  label: string;
  /** OpenCode task description, which is the child session's initial title. */
  description: string;
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

const readDescription = (...sources: unknown[]): string => {
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    const value = (source as Record<string, unknown>).description;
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return '';
};

/**
 * Same join as the transcript task row. Live `state.metadata` wins; part-level
 * metadata is only an older fallback, so a stale part id cannot merge the row
 * onto a different session than the one the tool row opens.
 */
const readToolSessionId = (part: Part): string | undefined => {
  const state = part.state;
  return readOptionalSessionId(state?.metadata)
    ?? readOptionalSessionId(state)
    ?? readOptionalSessionId(state?.input)
    ?? readOptionalSessionId(part.metadata)
    ?? readTaskSessionIdFromOutput(typeof state?.output === 'string' ? state.output : undefined);
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
          sessionID: readToolSessionId(part),
          label: readAgentLabel(state?.input, part.metadata, state?.metadata),
          description: readDescription(state?.input, part.metadata, state?.metadata),
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
        label: agent ? agent.charAt(0).toUpperCase() + agent.slice(1) : '',
        description,
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
    if (
      a.id !== b.id
      || a.sessionID !== b.sessionID
      || a.label !== b.label
      || a.description !== b.description
      || a.running !== b.running
    ) return false;
  }
  return true;
};

type SubagentDraft = {
  key: string;
  sessionID?: string;
  seed: string;
  description: string;
  agent: string;
  childTitle: string;
  working: boolean;
};

const displayLabel = (draft: SubagentDraft): string => draft.childTitle || draft.description || draft.agent;

const toFace = (draft: SubagentDraft): WorkStatusSubagent => ({
  key: draft.key,
  sessionID: draft.sessionID,
  seed: draft.seed,
  label: displayLabel(draft),
  phase: draft.working ? 'working' : 'done',
});

/**
 * One face per effective child session id. Several task parts can continue
 * the same session (including after a title change); those collapse here.
 * A part that has not published a session id yet stays on its own row.
 * Label prefers the live session title, then the task description OpenCode
 * uses as that title, then the agent name. Working faces stay ahead of
 * completed ones.
 */
export const mergeWorkStatusSubagents = (
  tasks: readonly TranscriptSubagentFace[],
  children: readonly WorkStatusChildSession[],
  busyIds?: ReadonlySet<string>,
): WorkStatusSubagent[] => {
  const childById = new Map(children.map((child) => [child.id, child]));
  const linked = new Set<string>();
  const drafts: SubagentDraft[] = [];
  const indexBySession = new Map<string, number>();

  const absorb = (draft: SubagentDraft) => {
    const sessionID = draft.sessionID;
    if (!sessionID) {
      drafts.push(draft);
      return;
    }
    linked.add(sessionID);
    const index = indexBySession.get(sessionID);
    if (index === undefined) {
      indexBySession.set(sessionID, drafts.length);
      drafts.push({ ...draft, key: sessionID, seed: sessionID, sessionID });
      return;
    }
    const current = drafts[index];
    if (!current) return;
    drafts[index] = {
      ...current,
      description: current.description || draft.description,
      agent: current.agent || draft.agent,
      childTitle: draft.childTitle || current.childTitle,
      working: current.working || draft.working,
    };
  };

  for (const task of tasks) {
    const child = task.sessionID ? childById.get(task.sessionID) : undefined;
    absorb({
      key: task.id,
      sessionID: task.sessionID,
      seed: task.id,
      description: task.description,
      agent: task.label,
      childTitle: child?.title?.trim() || '',
      working: task.running || Boolean(child?.busy) || Boolean(task.sessionID && busyIds?.has(task.sessionID)),
    });
  }
  for (const child of children) {
    if (linked.has(child.id)) continue;
    absorb({
      key: child.id,
      sessionID: child.id,
      seed: child.id,
      description: '',
      agent: '',
      childTitle: child.title?.trim() || '',
      working: child.busy,
    });
  }
  const faces = drafts.map(toFace);
  const working = faces.filter((face) => face.phase === 'working');
  const done = faces.filter((face) => face.phase === 'done');
  return working.length === 0 ? done : done.length === 0 ? working : [...working, ...done];
};
