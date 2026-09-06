import { createElement, type ReactNode } from 'react';

import type { BlurViewAttributes } from './glass/blurView';

export type LynxStyle = Record<string, string | number | undefined>;

export type LynxViewProps = {
  id?: string;
  className?: string;
  style?: LynxStyle;
  children?: ReactNode;
  bindtap?: () => void;
  bindlongpress?: () => void;
  'accessibility-label'?: string;
  'accessibility-element'?: boolean;
  'accessibility-role'?: string;
  flatten?: boolean;
  /** Cap composer swipe surface / host layout markers */
  'data-session-swipe-surface'?: string;
  'data-lynx-glass-composer'?: string;
  'data-lynx-composer-glass-variant'?: string;
  'data-lynx-autocomplete-placement'?: string;
  'data-lynx-autocomplete-forbid-glass-content'?: string;
  'data-lynx-composer-actions-in-glass'?: string;
  'data-lynx-composer-actions-variant'?: string;
  'data-lynx-composer-actions-order'?: string;
  'data-lynx-composer-action'?: string;
  'data-mobile-html-preview'?: string;
};

export type LynxPageProps = LynxViewProps & {
  'auto-width'?: boolean;
  'auto-height'?: boolean;
};

export type LynxBlurViewProps = LynxViewProps & BlurViewAttributes;

/**
 * Lynx `<list>` props used for LegendList-semantics timeline.
 * recycle-items must stay false for chat rows.
 */
export type LynxListProps = LynxViewProps & {
  'scroll-orientation'?: 'vertical' | 'horizontal';
  'recycle-items'?: boolean;
  'initial-scroll-index'?: number;
};

function lynxElement(type: string, props: object): ReactNode {
  return createElement(type, props);
}

export function LynxPage(props: LynxPageProps) {
  return lynxElement('page', props);
}

export function LynxView(props: LynxViewProps) {
  return lynxElement('view', props);
}

export function LynxText(props: LynxViewProps) {
  return lynxElement('text', props);
}

export function LynxScrollView(props: LynxViewProps) {
  return lynxElement('scroll-view', props);
}

export function LynxList(props: LynxListProps) {
  return lynxElement('list', props);
}

export function LynxBlurView(props: LynxBlurViewProps) {
  return lynxElement('blur-view', props);
}

export function LynxInput(props: LynxViewProps & {
  value?: string;
  placeholder?: string;
  bindinput?: (event: { detail?: { value?: string } }) => void;
  disabled?: boolean;
}) {
  return lynxElement('input', props);
}
