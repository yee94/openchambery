import { useState } from 'react';

import { lynxT } from '../i18n/catalog';
import { LynxScrollView, LynxText, LynxView } from '../lynx-elements';
import { cssVar } from '../theme/tokens';
import {
  LYNX_SHARE_WELCOME_EXAMPLES,
  createLynxShareWelcomeStore,
  type LynxShareWelcomeStore,
} from './shareWelcome';

export type LynxShareWelcomeProps = {
  locale: string;
  /** Auto-open once when true and not dismissed (Cap enabled prop). */
  enabled?: boolean;
  /** Controlled open for Settings re-entry. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Injected store (tests / host persistence). */
  store?: LynxShareWelcomeStore;
  onPersistDismissed?: (dismissed: boolean) => void;
};

/**
 * Cap AssistantShareWelcome education chrome above the share inbox.
 * Images are host-owned assets — Lynx shows numbered example cards with Cap copy spirit.
 */
export function LynxShareWelcome({
  locale,
  enabled = false,
  open,
  onOpenChange,
  store: storeProp,
  onPersistDismissed,
}: LynxShareWelcomeProps) {
  const [store] = useState(() => storeProp ?? createLynxShareWelcomeStore());
  const [, bump] = useState(0);
  const rerender = () => bump((n) => n + 1);

  if (open !== undefined && store.getState().controlledOpen !== open) {
    if (open) store.open();
    else store.dismiss();
  }

  const dialogOpen = open !== undefined
    ? open
    : store.isOpen(enabled);

  if (!dialogOpen) return null;

  const dismiss = () => {
    store.dismiss();
    onPersistDismissed?.(store.shouldPersistDismissed());
    onOpenChange?.(false);
    rerender();
  };

  return (
    <LynxView
      style={{
        margin: '12px 16px',
        padding: '16px',
        borderRadius: '16px',
        backgroundColor: cssVar('surface.elevated'),
      }}
      accessibility-label={lynxT(locale, 'lynx.shareWelcome.title')}
    >
      <LynxText style={{ color: cssVar('surface.foreground'), fontSize: '18px', fontWeight: '700' }}>
        {lynxT(locale, 'lynx.shareWelcome.title')}
      </LynxText>
      <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '13px', marginTop: '8px' }}>
        {lynxT(locale, 'lynx.shareWelcome.description')}
      </LynxText>

      <LynxScrollView style={{ marginTop: '12px' }}>
        {LYNX_SHARE_WELCOME_EXAMPLES.map((example, index) => (
          <LynxView
            key={example.id}
            style={{
              marginBottom: '10px',
              padding: '12px',
              borderRadius: '12px',
              backgroundColor: cssVar('surface.background'),
            }}
          >
            <LynxText style={{ color: cssVar('primary.base'), fontSize: '12px', fontWeight: '700' }}>
              {index + 1}
            </LynxText>
            <LynxText style={{ color: cssVar('surface.foreground'), fontSize: '14px', fontWeight: '600', marginTop: '4px' }}>
              {lynxT(locale, example.titleKey as 'lynx.shareWelcome.example.chat.title')}
            </LynxText>
            <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '12px', marginTop: '4px' }}>
              {lynxT(locale, example.descriptionKey as 'lynx.shareWelcome.example.chat.description')}
            </LynxText>
          </LynxView>
        ))}
      </LynxScrollView>

      <LynxView
        bindtap={dismiss}
        accessibility-role="button"
        accessibility-label={lynxT(locale, 'lynx.shareWelcome.action')}
        style={{
          marginTop: '12px',
          padding: '12px',
          borderRadius: '12px',
          alignItems: 'center',
          backgroundColor: cssVar('primary.base'),
        }}
      >
        <LynxText style={{ color: '#fff', fontWeight: '600' }}>
          {lynxT(locale, 'lynx.shareWelcome.action')}
        </LynxText>
      </LynxView>
    </LynxView>
  );
}
