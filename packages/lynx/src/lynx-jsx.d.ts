/**
 * Lynx 3.8 intrinsic elements used by this scaffold.
 * When the rspeedy bundle job lands, prefer `@lynx-js/types` BlurViewProps.
 */
import type { ReactNode } from 'react';

import type { BlurViewAttributes } from './glass/blurView';

type LynxStyle = Record<string, string | number | undefined>;

type LynxViewProps = {
  id?: string;
  className?: string;
  style?: LynxStyle;
  children?: ReactNode;
  'bindtap'?: () => void;
  'accessibility-label'?: string;
  'accessibility-element'?: boolean;
  'accessibility-role'?: string;
  flatten?: boolean;
};

type LynxTextProps = LynxViewProps;

type LynxPageProps = LynxViewProps & {
  'auto-width'?: boolean;
  'auto-height'?: boolean;
};

type LynxBlurViewProps = LynxViewProps & BlurViewAttributes;

declare global {
  namespace JSX {
    interface IntrinsicElements {
      page: LynxPageProps;
      view: LynxViewProps;
      text: LynxTextProps;
      scroll-view: LynxViewProps;
      'blur-view': LynxBlurViewProps;
    }
  }
}

export {};
