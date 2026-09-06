import {
  INITIAL_LYNX_NAVIGATION_STATE,
  isDockHidden,
  reduceLynxNavigation,
  type LynxNavigationAction,
  type LynxNavigationState,
} from '../shell/navigation';
import {
  resolveLynxEmbedding,
  shouldPaintLynxDock,
  shouldShowHostTabChrome,
  type LynxEmbeddingInput,
} from '../host/embedding';

export type LynxNavigationScenarioStep = {
  action: LynxNavigationAction;
  expectDockHidden: boolean;
};

export type LynxNavigationScenarioResult = {
  state: LynxNavigationState;
  dockHidden: boolean;
  lynxDockPainted: boolean;
  hostTabChromeVisible: boolean;
};

/**
 * Scripted host harness for later 真机 runs: apply actions and assert chrome.
 * Does not talk to a server.
 */
export function runLynxNavigationScenario(
  embeddingInput: LynxEmbeddingInput,
  steps: readonly LynxNavigationScenarioStep[],
): LynxNavigationScenarioResult[] {
  const embedding = resolveLynxEmbedding(embeddingInput);
  let state = INITIAL_LYNX_NAVIGATION_STATE;
  return steps.map((step) => {
    state = reduceLynxNavigation(state, step.action);
    const dockHidden = isDockHidden(state);
    if (dockHidden !== step.expectDockHidden) {
      throw new Error(`dock hidden=${dockHidden}, expected ${step.expectDockHidden}`);
    }
    return {
      state,
      dockHidden,
      lynxDockPainted: shouldPaintLynxDock({ embedding, navigation: state }),
      hostTabChromeVisible: shouldShowHostTabChrome({ embedding, navigation: state }),
    };
  });
}
