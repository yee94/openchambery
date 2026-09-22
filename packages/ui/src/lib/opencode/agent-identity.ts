/**
 * Agent identity boundary for OpenCode v2.
 *
 * Wire catalog rows carry:
 * - `id` — machine key the server expects on prompts / session switches (`build`)
 * - `name` — display label only (`Build`)
 *
 * OpenChamber has always keyed selection, persistence, and send by `name`.
 * Project each wire row so domain `name` equals authoritative `id`, and keep the
 * wire label as `displayName`. Lookup accepts either key so persisted display
 * names still resolve after catalog load. Never blind-case-fold: custom ids may
 * differ only by case.
 */

import type { AgentInfo } from "@opencode/client";

import type { Agent } from "./v2-types";

type AgentLike = {
  id?: string;
  name?: string;
  displayName?: string;
};

const trimKey = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

/**
 * Project a wire AgentInfo (or already-local Agent) into the domain shape.
 * `name` is the send/selection key (wire id); `displayName` is UI-only.
 */
export function projectAgent(info: AgentInfo | Agent | AgentLike): Agent {
  const wireId = trimKey((info as AgentLike).id);
  const wireName = trimKey((info as AgentLike).name);
  const existingDisplay = trimKey((info as AgentLike).displayName);
  const id = wireId ?? wireName;
  if (!id) {
    return {
      ...(info as Agent),
      id: "",
      name: "",
      displayName: existingDisplay ?? "",
    };
  }

  // Already projected: machine key equals name and display label is present.
  if (wireName === id && existingDisplay) {
    return {
      ...(info as Agent),
      id,
      name: id,
      displayName: existingDisplay,
    };
  }

  const displayName = existingDisplay ?? wireName ?? id;
  return {
    ...(info as Agent),
    id,
    name: id,
    displayName,
  };
}

/** UI label: prefer displayName, fall back to the machine key. */
export function agentDisplayName(agent: AgentLike | null | undefined): string {
  if (!agent) return "";
  return trimKey(agent.displayName) ?? trimKey(agent.name) ?? trimKey(agent.id) ?? "";
}

/**
 * Resolve a selection/persistence key against a catalog.
 * Order: domain name (id key) → wire id → displayName (legacy persisted label).
 * Exact match only — no case folding.
 */
export function findAgentBySelectionKey<T extends AgentLike>(
  agents: readonly T[] | null | undefined,
  key: string | null | undefined,
): T | undefined {
  const needle = trimKey(key);
  if (!needle || !agents?.length) return undefined;

  const byName = agents.find((agent) => trimKey(agent.name) === needle);
  if (byName) return byName;

  const byId = agents.find((agent) => trimKey(agent.id) === needle);
  if (byId) return byId;

  const byDisplay = agents.find((agent) => trimKey(agent.displayName) === needle);
  if (byDisplay) return byDisplay;

  return undefined;
}

/**
 * Authoritative identity to send on prompts. Unknown keys pass through so a
 * custom agent missing from a stale catalog is not rewritten.
 */
export function resolveAgentSendIdentity(
  agents: readonly AgentLike[] | null | undefined,
  selection: string | null | undefined,
): string | undefined {
  const needle = trimKey(selection);
  if (!needle) return undefined;
  const found = findAgentBySelectionKey(agents, needle);
  if (!found) return needle;
  return trimKey(found.name) ?? trimKey(found.id) ?? needle;
}
