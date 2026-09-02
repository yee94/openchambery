/** Toggle/open decision for the shared services panel shortcuts (instance vs usage). */
export function resolveServicesPanelIntent(input: {
  isOpen: boolean;
  activeTab: 'instance' | 'usage' | 'mcp';
  targetTab: 'instance' | 'usage';
}): { open: boolean; tab: 'instance' | 'usage' } {
  if (input.isOpen && input.activeTab === input.targetTab) {
    return { open: false, tab: input.activeTab };
  }
  return { open: true, tab: input.targetTab };
}
