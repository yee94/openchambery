/**
 * Router runtime kinds that select history implementation.
 * Injected by surface entrypoints — do not auto-detect in components.
 */
export type RouterRuntime =
  | 'web'
  | 'vscode'
  | 'electron'
  | 'embedded'
  | 'mobile';

export const MEMORY_ROUTER_RUNTIMES: readonly RouterRuntime[] = [
  'vscode',
  'electron',
  'embedded',
  'mobile',
] as const;

export const isMemoryRouterRuntime = (runtime: RouterRuntime): boolean =>
  runtime !== 'web';
