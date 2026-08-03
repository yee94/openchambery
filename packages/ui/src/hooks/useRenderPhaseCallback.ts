import React from 'react';

/**
 * A stable-identity callback that is safe to call during the render phase.
 *
 * `useEvent` is the right tool for event handlers, but it refreshes its handler
 * ref inside a layout effect — one commit *after* the render that produced the
 * new closure. A render prop runs inside the very render whose inputs changed,
 * so through `useEvent` it reads the previous render's values. When the output
 * is handed to a memoized child, that stale render is what commits, and nothing
 * schedules the correction: the child keeps its identical props and the wrong
 * output stays on screen for good.
 *
 * Writing the ref during render keeps the identity stable — so memoized
 * children still bail out — while always dispatching to the current closure.
 */
export const useRenderPhaseCallback = <TArgs extends unknown[], TResult>(
    callback: (...args: TArgs) => TResult,
): ((...args: TArgs) => TResult) => {
    const callbackRef = React.useRef(callback);
    callbackRef.current = callback;

    return React.useMemo(() => (
        (...args: TArgs) => callbackRef.current(...args)
    ), []);
};
