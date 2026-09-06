import { useCallback, useEffect, useRef, useState } from 'react';

import type { ActiveRuntime } from '@/lib/connectionController';
import {
  type ComposerAutocompleteRow,
  type ComposerAutocompleteTrigger,
} from '@/lib/composerAutocomplete';
import {
  buildAutocompleteRows,
  loadAgents,
  loadInstalledSkills,
  loadSlashCommands,
  loadSnippets,
  searchMentionFiles,
  type AgentCatalogItem,
  type SkillCatalogItem,
  type SlashCommandCatalogItem,
  type SnippetCatalogItem,
} from '@/lib/composerCatalogApi';

export type ComposerAutocompleteView = {
  rows: ComposerAutocompleteRow[];
  loading: boolean;
  onTriggerChange: (trigger: ComposerAutocompleteTrigger | null) => void;
};

/**
 * Loads Cap catalog endpoints when a slash/@/# trigger opens and filters rows.
 */
export function useComposerAutocomplete(
  active: ActiveRuntime | null,
  directory: string | null,
): ComposerAutocompleteView {
  const [trigger, setTrigger] = useState<ComposerAutocompleteTrigger | null>(null);
  const [rows, setRows] = useState<ComposerAutocompleteRow[]>([]);
  const [loading, setLoading] = useState(false);

  const commandsRef = useRef<SlashCommandCatalogItem[] | null>(null);
  const skillsRef = useRef<SkillCatalogItem[] | null>(null);
  const snippetsRef = useRef<SnippetCatalogItem[] | null>(null);
  const agentsRef = useRef<AgentCatalogItem[] | null>(null);
  const requestId = useRef(0);

  // Invalidate catalogs when directory/runtime changes.
  useEffect(() => {
    commandsRef.current = null;
    skillsRef.current = null;
    snippetsRef.current = null;
    agentsRef.current = null;
  }, [active, directory]);

  useEffect(() => {
    if (!active || !trigger) {
      setRows([]);
      setLoading(false);
      return;
    }

    const id = ++requestId.current;
    let cancelled = false;
    const run = async () => {
      setLoading(true);
      try {
        if (trigger.kind === 'slash-command') {
          if (!commandsRef.current) {
            commandsRef.current = await loadSlashCommands(active, directory);
          }
        } else if (trigger.kind === 'slash-skill') {
          if (!skillsRef.current) {
            skillsRef.current = await loadInstalledSkills(active, directory);
          }
        } else if (trigger.kind === 'snippet') {
          if (!snippetsRef.current) {
            snippetsRef.current = await loadSnippets(active, directory);
          }
        } else if (trigger.kind === 'mention') {
          if (!agentsRef.current) {
            try {
              agentsRef.current = await loadAgents(active, directory);
            } catch {
              agentsRef.current = [];
            }
          }
        }

        let files: Awaited<ReturnType<typeof searchMentionFiles>> = [];
        if (trigger.kind === 'mention' && directory && trigger.query.trim().length > 0) {
          try {
            files = await searchMentionFiles(active, {
              directory,
              query: trigger.query,
              limit: 20,
            });
          } catch {
            files = [];
          }
        }

        if (cancelled || id !== requestId.current) return;
        setRows(
          buildAutocompleteRows(trigger.kind, trigger.query, {
            commands: commandsRef.current ?? [],
            skills: skillsRef.current ?? [],
            snippets: snippetsRef.current ?? [],
            agents: agentsRef.current ?? [],
            files,
          }),
        );
      } catch {
        if (cancelled || id !== requestId.current) return;
        setRows([]);
      } finally {
        if (!cancelled && id === requestId.current) setLoading(false);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [active, directory, trigger]);

  const onTriggerChange = useCallback((next: ComposerAutocompleteTrigger | null) => {
    setTrigger(next);
    if (!next) {
      setRows([]);
      setLoading(false);
    }
  }, []);

  return { rows, loading, onTriggerChange };
}
