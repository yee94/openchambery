import React from 'react';
import { useEvent, useIsomorphicLayoutEffect } from '@reactuses/core';

import {
    applyMarkdownPinRevealVisibility,
    observeMarkdownPinReveal,
    shouldArmMarkdownPinReveal,
    type MarkdownPinRevealReason,
} from '../lib/markdownPinReveal';

export type UseMarkdownPinRevealInput = {
    scopeKey: string;
    /** Bumped by jump-to-latest so an already-revealed session can hide again. */
    generation?: number;
    root: HTMLElement | null;
    relevantKeys: readonly string[];
    enabled?: boolean;
};

/**
 * Hide the timeline until seeded Markdown rows report ready, then reveal once.
 *
 * `scopeKey` (session / cache key) is a cold open. `generation` is jump-to-latest.
 * Live streaming after the first reveal does not re-arm.
 */
export const useMarkdownPinReveal = ({
    scopeKey,
    generation = 0,
    root,
    relevantKeys,
    enabled = true,
}: UseMarkdownPinRevealInput): boolean => {
    const revealKey = `${scopeKey}:${generation}`;
    const [armedKey, setArmedKey] = React.useState(revealKey);
    const [hidden, setHidden] = React.useState(enabled);
    const revealedScopesRef = React.useRef(new Set<string>());

    if (enabled && armedKey !== revealKey) {
        const reason: MarkdownPinRevealReason = generation > 0 && armedKey.startsWith(`${scopeKey}:`)
            ? 'jump-to-latest'
            : 'session-open';
        const alreadyRevealedForScope = revealedScopesRef.current.has(scopeKey);
        if (shouldArmMarkdownPinReveal({ reason, alreadyRevealedForScope })) {
            setHidden(true);
        }
        setArmedKey(revealKey);
    }

    if (!enabled && hidden) {
        setHidden(false);
    }

    const relevantKeysIdentity = relevantKeys.join('\u0000');
    const relevantKeySet = React.useMemo(
        () => new Set(relevantKeys),
        // Identity is the seed-window contents, not the array reference.
        // eslint-disable-next-line react-hooks/exhaustive-deps -- relevantKeysIdentity
        [relevantKeysIdentity],
    );
    const reveal = useEvent(() => {
        revealedScopesRef.current.add(scopeKey);
        setHidden(false);
    });

    useIsomorphicLayoutEffect(() => {
        if (!enabled || !hidden) {
            applyMarkdownPinRevealVisibility(root, false);
            return;
        }
        applyMarkdownPinRevealVisibility(root, true);
        if (!root) {
            return;
        }
        return observeMarkdownPinReveal({
            root,
            relevantKeys: relevantKeySet,
            onReady: reveal,
        });
        // reveal is useEvent-stable; relevantKeySet identity tracks the seed window.
        // eslint-disable-next-line react-hooks/exhaustive-deps -- reveal is useEvent
    }, [enabled, hidden, root, relevantKeySet, revealKey]);

    return enabled && hidden;
};
