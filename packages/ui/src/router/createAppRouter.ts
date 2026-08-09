import { createRouter } from '@tanstack/react-router';
import { createAppHistory } from './history';
import { routeTree, type AppRouterContext } from './routes/tree';
import type { RouterRuntime } from './runtime';

export type CreateAppRouterOptions = {
  runtime: RouterRuntime;
  /** Memory history initial path only. */
  initialPath?: string;
};

export function createAppRouter(options: CreateAppRouterOptions) {
  const history = createAppHistory(options.runtime, {
    initialPath: options.initialPath,
  });

  const context: AppRouterContext = {
    runtime: options.runtime,
  };

  return createRouter({
    routeTree,
    history,
    context,
    // Ticket 01: no default pending UI; product shells still own rendering.
    defaultPreload: false,
  });
}

export type AppRouter = ReturnType<typeof createAppRouter>;
