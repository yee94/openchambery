import {
  createRootRouteWithContext,
  createRoute,
  Outlet,
} from '@tanstack/react-router';
import type { RouterRuntime } from '../runtime';

export type AppRouterContext = {
  runtime: RouterRuntime;
};

/**
 * Minimal route tree for Ticket 01.
 * Catch-all keeps any path matched so createAppRouter can mount without product routes yet.
 * Domain routes land in later tickets.
 */
const rootRoute = createRootRouteWithContext<AppRouterContext>()({
  component: () => <Outlet />,
});

const catchAllRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/$',
});

export const routeTree = rootRoute.addChildren([catchAllRoute]);
