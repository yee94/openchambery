import { createElement, type ReactNode } from 'react';

import type { BlurViewAttributes } from './glass/blurView';

export type LynxStyle = Record<string, string | number | undefined>;

export type LynxViewProps = {
  id?: string;
  className?: string;
  style?: LynxStyle;
  children?: ReactNode;
  bindtap?: () => void;
  'accessibility-label'?: string;
  'accessibility-element'?: boolean;
  'accessibility-role'?: string;
  flatten?: boolean;
};

export type LynxPageProps = LynxViewProps & {
  'auto-width'?: boolean;
  'auto-height'?: boolean;
};

export type LynxBlurViewProps = LynxViewProps & BlurViewAttributes;

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

export function LynxBlurView(props: LynxBlurViewProps) {
  return lynxElement('blur-view', props);
}
