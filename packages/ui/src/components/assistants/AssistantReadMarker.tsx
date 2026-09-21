import React from 'react';
import { useEvent, useEventListener, useIntersectionObserver, useInterval, useMutationObserver } from '@reactuses/core';
import { isCapacitorApp } from '@/lib/platform';
import { getRuntimeGeneration, getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import { markAssistantContactRead } from '@/queries/assistantQueries';
import type { AssistantReadPosition } from '@/queries/assistantDTO';

/** Mounted for the latest loaded visible row in the active, gap-free contact surface. */
export function AssistantReadMarker({ assistantID, position }: { assistantID: string; position: AssistantReadPosition }) {
  const marker = React.useRef<HTMLSpanElement>(null);
  const intersecting = React.useRef(false);
  const request = React.useRef({ busy: false, done: false, retryAt: 0 });
  const [runtime] = React.useState(() => ({ transport: getRuntimeTransportIdentity(), generation: getRuntimeGeneration() }));
  const report = useEvent(() => {
    const node = marker.current;
    if (!node || !intersecting.current || request.current.busy || request.current.done || Date.now() < request.current.retryAt) return;
    if (runtime.transport !== getRuntimeTransportIdentity() || runtime.generation !== getRuntimeGeneration()) return;
    if (document.visibilityState !== 'visible') return;
    if (isCapacitorApp() ? !document.documentElement.classList.contains('oc-native-app-active') : !document.hasFocus()) return;
    if (node.parentElement?.closest('[inert], [aria-hidden="true"]')) return;
    const scroller = node.closest<HTMLElement>('[data-assistant-contact-transcript]');
    if (!scroller || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight > 2) return;
    const rect = node.getBoundingClientRect();
    const viewport = scroller.getBoundingClientRect();
    const visualViewport = window.visualViewport;
    const visibleTop = visualViewport?.offsetTop ?? 0;
    const visibleBottom = visibleTop + (visualViewport?.height ?? window.innerHeight);
    if (rect.height <= 0 || rect.width <= 0 || rect.bottom > Math.min(viewport.bottom, visibleBottom) || rect.top < Math.max(viewport.top, visibleTop)) return;
    if (rect.right <= Math.max(viewport.left, 0) || rect.left >= Math.min(viewport.right, window.innerWidth)) return;
    request.current.busy = true;
    void markAssistantContactRead(assistantID, position).then(() => {
      request.current.done = true;
    }).catch(() => {
      request.current.retryAt = Date.now() + 15_000;
    }).finally(() => { request.current.busy = false; });
  });
  useIntersectionObserver(marker, useEvent((entries: IntersectionObserverEntry[]) => {
    intersecting.current = entries.some((entry) => entry.isIntersecting && entry.intersectionRatio === 1);
    report();
  }), { threshold: 1 });
  useEventListener('visibilitychange', report, () => document);
  useEventListener('focus', report, () => window);
  useEventListener('resize', report, () => window.visualViewport);
  useEventListener('scroll', report, () => marker.current?.closest<HTMLElement>('[data-assistant-contact-transcript]'), { passive: true });
  useMutationObserver(report, () => document.documentElement, { attributes: true, attributeFilter: ['class'] });
  useInterval(report, 15_000);
  return <span ref={marker} aria-hidden="true" className="block h-px w-px shrink-0" data-assistant-read-marker="" />;
}
