import { useLayoutEffect, type RefObject } from 'react';
import { useEvent, useEventListener } from '@reactuses/core';
import { useHeightSnap, type HeightSnapPoint } from '../ui/useHeightSnap';
import { resolveComposerTextareaAutosize } from './composerTextareaAutosize';

type ComposerSnap = 'auto' | 'min' | 'full';

export function useMobileComposerSnap({ enabled, hasContent, draftID, inputRef }: {
  enabled: boolean;
  hasContent: boolean;
  draftID: string | null;
  inputRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const active = enabled && hasContent;
  const controller = useHeightSnap<ComposerSnap>({
    surfaceRef: inputRef,
    initialPoint: 'auto',
    getPoints: (): HeightSnapPoint<ComposerSnap>[] => {
      const input = inputRef.current;
      if (!input) return [];
      const surface = input.closest('[data-mobile-composer-surface]') ?? input;
      const inputRect = input.getBoundingClientRect();
      const surfaceRect = surface.getBoundingClientRect();
      const style = getComputedStyle(input);
      const lineHeight = parseFloat(style.lineHeight) || 22;
      const paddingTotal = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
      const minimum = Math.max(parseFloat(style.minHeight) || 0, lineHeight + paddingTotal);
      const viewport = window.visualViewport;
      let top = viewport?.offsetTop ?? 0;
      // Find the navigation belonging to this conversation, not an underlying tab.
      for (let ancestor = surface.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const header = ancestor.querySelector<HTMLElement>('.oc-mobile-detail-navigation, [data-mobile-chat-header]');
        if (header) { top = Math.max(top, header.getBoundingClientRect().bottom); break; }
      }
      const bottom = Math.min(surfaceRect.bottom, (viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight));
      const chrome = surfaceRect.height - inputRect.height;
      const maximum = Math.max(minimum, bottom - top - chrome);
      const previousHeight = input.style.height;
      const previousScroll = input.scrollTop;
      input.style.height = '0px';
      const natural = resolveComposerTextareaAutosize({ scrollHeight: input.scrollHeight, dictationHeight: 0, lineHeight, paddingTotal }).height;
      input.style.height = previousHeight;
      input.scrollTop = previousScroll;
      // Prefer auto when two physical positions coincide.
      return [
        { id: 'auto', height: Math.min(maximum, Math.max(minimum, natural)) },
        { id: 'min', height: minimum },
        { id: 'full', height: maximum },
      ];
    },
  });
  const { reset } = controller;
  useLayoutEffect(() => { reset(); }, [active, draftID, reset]);
  const refresh = useEvent(() => {
    if (active && controller.snapPoint === 'full') controller.settleAt('full', undefined, false);
  });
  useEventListener('resize', refresh, () => active ? window : null);
  useEventListener('oc:keyboard-settled', refresh, () => active ? window : null);
  useEventListener('resize', refresh, () => active ? window.visualViewport : null);
  useEventListener('scroll', refresh, () => active ? window.visualViewport : null);
  return {
    ...controller,
    visible: active,
    manualHeight: active && (controller.dragging || controller.settling || controller.snapPoint !== 'auto'),
  };
}
