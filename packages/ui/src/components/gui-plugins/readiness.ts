/** Plugin lifetime changes, unlike panel visibility, invalidate foreign mounts and link matching. */
export function guiPluginReadinessKey(plugins: readonly { id: string; status: string; revision?: string }[], pluginId?: string): string {
  return JSON.stringify(plugins
    .filter(({ id }) => pluginId === undefined || id === pluginId)
    .map(({ id, status, revision }) => [id, status, revision]));
}
