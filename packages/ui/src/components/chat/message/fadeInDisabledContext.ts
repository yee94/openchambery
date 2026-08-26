import React from 'react';

// Context to allow parent components (like VirtualMessageList) to disable animations
// for items entering the viewport due to scrolling rather than new content
export const FadeInDisabledContext = React.createContext(false);

export const useFadeInDisabled = (): boolean => React.useContext(FadeInDisabledContext);
