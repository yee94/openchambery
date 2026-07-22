import type { Agent } from '@opencode-ai/sdk/v2';
import { filterVisibleAgents } from '@/stores/useAgentsStore';
import { isPrimaryMode } from './mobileControlsUtils';

/**
 * Shared composer agent catalog filtering for primary chat and Assistant.
 * Drop hidden internals (title/summary/compaction), then keep primary-selectable
 * agents so model/agent pickers and cycle shortcuts stay isomorphic.
 */
export const resolveComposerVisibleAgents = (
  agents: readonly Agent[] | null | undefined,
): Agent[] => filterVisibleAgents([...(agents ?? [])]);

export const resolveComposerPrimaryAgents = (
  agents: readonly Agent[] | null | undefined,
): Agent[] => resolveComposerVisibleAgents(agents).filter((agent) => isPrimaryMode(agent.mode));
