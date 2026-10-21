import type { HTMLAttributes } from 'react';

// Chromium invalidates a rich subtree for descendant :hover selectors, even
// with a class-qualified leaf. Attribute invalidation stays leaf-targeted.
// Boundary events update chrome without putting pointer state into React or
// adding scroll listeners; newly streamed leaves inherit the current scope.
export const messageHoverHandlers = {
    onPointerEnter: (event) => {
        if (event.pointerType !== 'touch') event.currentTarget.setAttribute('data-message-hovered', '');
    },
    onPointerLeave: (event) => {
        event.currentTarget.removeAttribute('data-message-hovered');
    },
    onPointerCancel: (event) => {
        event.currentTarget.removeAttribute('data-message-hovered');
    },
} satisfies HTMLAttributes<HTMLDivElement>;
