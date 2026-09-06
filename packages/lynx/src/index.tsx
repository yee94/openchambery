import { App } from './App';

/**
 * Rspeedy / Lynx Explorer entry. The host LynxView loads the compiled bundle
 * and injects `global-props` for embedding mode, locale, and theme id.
 */
export default App;

export { App } from './App';
export { createHostGlobalProps, resolveLynxEmbedding } from './host/embedding';
export { reduceLynxNavigation, INITIAL_LYNX_NAVIGATION_STATE } from './shell/navigation';
export { LYNX_TABS } from './shell/tabs';
export { resolveBlurViewAttributes } from './glass/blurView';
