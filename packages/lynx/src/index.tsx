import './encoding-polyfill';

import { App } from './App';

/**
 * Rspeedy / Lynx Explorer entry. The host LynxView loads the compiled bundle
 * and injects `global-props` for embedding mode, locale, and theme id.
 *
 * encoding-polyfill runs before App (and its ShellApp/chat import graph) so
 * PrimJS gets TextEncoder/TextDecoder before liveTail top-level init.
 */
export default App;

export { App } from './App';
