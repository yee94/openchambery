import React from 'react';

const EMPTY_VISIBLE_TURNS: ReadonlySet<string> = new Set();

// Observe mounted transcript nodes, not the full history or scroll events.
// Both grouped turns and standalone/live message rows can represent a prompt.
export function useVisiblePromptTurns(
    scrollRef: React.RefObject<HTMLDivElement | null> | undefined,
    turnByMessageId: ReadonlyMap<string, string> | undefined,
): ReadonlySet<string> {
    const [visible, setVisible] = React.useState(EMPTY_VISIBLE_TURNS);
    React.useEffect(() => {
        const root = scrollRef?.current;
        setVisible(EMPTY_VISIBLE_TURNS);
        if (!root || !turnByMessageId || typeof IntersectionObserver === 'undefined') return;

        const nodes = new Map<Element, string>();
        const intersecting = new Set<Element>();
        const publish = () => {
            const next = new Set<string>();
            for (const node of intersecting) {
                const id = nodes.get(node);
                if (id) next.add(id);
            }
            setVisible((previous) => previous.size === next.size && [...next].every((id) => previous.has(id))
                ? previous : next);
        };
        const observer = new IntersectionObserver((entries) => {
            for (const entry of entries) {
                if (!nodes.has(entry.target)) continue;
                if (entry.isIntersecting && entry.intersectionRect.height > 0) intersecting.add(entry.target);
                else intersecting.delete(entry.target);
            }
            publish();
        }, { root, threshold: 0 });

        const visit = (node: Node, callback: (element: HTMLElement) => void) => {
            if (!(node instanceof HTMLElement)) return;
            if (node.matches('[data-turn-id], [data-message-id]')) callback(node);
            node.querySelectorAll<HTMLElement>('[data-turn-id], [data-message-id]').forEach(callback);
        };
        const register = (element: HTMLElement) => {
            if (nodes.has(element)) return;
            const key = element.dataset.scrollSpyId ?? element.dataset.turnId ?? element.dataset.messageId;
            const id = key ? turnByMessageId.get(key) : undefined;
            if (!id) return;
            nodes.set(element, id);
            observer.observe(element);
        };
        const unregister = (element: HTMLElement) => {
            observer.unobserve(element);
            nodes.delete(element);
            intersecting.delete(element);
        };
        visit(root, register);
        const mutations = new MutationObserver((records) => {
            for (const record of records) {
                if (record.type === 'attributes' && record.target instanceof HTMLElement) {
                    unregister(record.target);
                    register(record.target);
                    continue;
                }
                record.removedNodes.forEach((node) => visit(node, unregister));
                record.addedNodes.forEach((node) => visit(node, register));
            }
            publish();
        });
        mutations.observe(root, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['data-turn-id', 'data-message-id', 'data-scroll-spy-id'],
        });
        return () => {
            mutations.disconnect();
            observer.disconnect();
        };
    }, [scrollRef, turnByMessageId]);
    return visible;
}
