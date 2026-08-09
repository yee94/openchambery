/**
 * Router module for URL-based navigation in OpenChamber.
 *
 * Path mode (history):
 * - `/session/<id>` — open session (chat default)
 * - `/session/<id>/<tab>` — workspace tab (git, diff, …)
 * - `/session/<id>/diff?file=` — diff with file
 * - `/session/<id>?mode=plan` — plan mode
 * - `/settings/<slug>` — settings overlay
 * - `/new` — new session draft
 *
 * No legacy query routing (`?session=` / `?tab=` / `?settings=`).
 */

export type { RouteState } from './types';

export { parseRoute, hasRouteParams, routeStateFromPath } from './parseRoute';

export type { AppRouteState } from './serializeRoute';
export {
  updateBrowserURL,
  serializeAppPath,
} from './serializeRoute';
