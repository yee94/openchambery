/** Turn-local disclosure of already-granted tools; business execution stays with each owner. */
export function createProgressiveTools({ tools, groups }) {
  const granted = new Set(tools);
  const available = groups.map((group) => ({ ...group, tools: group.tools.filter((tool) => granted.has(tool)) }))
    .filter((group) => group.tools.length > 0);
  const deferred = new Set(available.flatMap((group) => group.tools));
  const active = tools.filter((tool) => !deferred.has(tool));
  if (available.length === 0) return { getTools: () => [...active] };
  const loaded = new Set();
  const result = (details, isError = false) => ({
    content: [{ type: 'text', text: JSON.stringify(details) }], details, isError, terminate: false,
  });
  active.push({
    name: 'load_tools', label: 'Load tools',
    description: `Load a capability group for this assistant turn only, then call its tools in the next response. ${available.map(({ id, description }) => `${id}: ${description}`).join(' ')}`,
    parameters: { type: 'object', additionalProperties: false, required: ['domain'], properties: {
      domain: { type: 'string', enum: available.map((group) => group.id) },
    } },
    execute: async (_id, params, signal) => {
      signal?.throwIfAborted();
      const group = params && !Array.isArray(params) && Object.keys(params).length === 1
        && available.find((entry) => entry.id === params.domain);
      if (!group) return result({ error: 'validation_error' }, true);
      const alreadyLoaded = loaded.has(group.id);
      const added = alreadyLoaded ? [] : group.tools.filter((tool) => !active.includes(tool));
      loaded.add(group.id);
      active.push(...added);
      return { ...result({ domain: group.id, tools: group.tools.map((tool) => tool.name), alreadyLoaded }),
        addedToolNames: added.map((tool) => tool.name) };
    },
  });
  return { getTools: () => [...active] };
}
