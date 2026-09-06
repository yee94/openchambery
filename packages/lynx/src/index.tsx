import './encoding-polyfill';

import { root } from '@lynx-js/react';

import { App } from './App';

/**
 * Rspeedy / Lynx Explorer entry. ReactLynx requires an explicit `root.render`
 * (export default alone does not mount the tree on device). Host LynxView
 * loads the compiled bundle and injects `global-props` for embedding mode,
 * locale, and theme id.
 *
 * encoding-polyfill runs before App (and its ShellApp/chat import graph) so
 * PrimJS gets TextEncoder/TextDecoder before liveTail top-level init.
 *
 * Keep named/default App exports for package consumers and Explorer tooling;
 * only this side-effect mounts the card.
 */
root.render(<App />);

export { App };
export default App;
