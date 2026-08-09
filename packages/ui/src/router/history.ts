import {
  createBrowserHistory,
  createMemoryHistory,
  type RouterHistory,
} from '@tanstack/react-router';
import { isMemoryRouterRuntime, type RouterRuntime } from './runtime';

export type CreateAppHistoryOptions = {
  /** Initial path for memory history (default `/`). Ignored for browser history. */
  initialPath?: string;
  /**
   * Browser history window override (tests / non-default globals).
   * Only used when runtime is `web`.
   */
  window?: Window;
};

/**
 * Runtime → history matrix:
 * - web: browser history (HTML5 pushState path)
 * - vscode / electron / embedded / mobile: memory history (no hash)
 */
export function createAppHistory(
  runtime: RouterRuntime,
  options: CreateAppHistoryOptions = {},
): RouterHistory {
  if (isMemoryRouterRuntime(runtime)) {
    const initialPath = options.initialPath ?? '/';
    return createMemoryHistory({
      initialEntries: [initialPath],
    });
  }

  return createBrowserHistory(
    options.window ? { window: options.window } : undefined,
  );
}
