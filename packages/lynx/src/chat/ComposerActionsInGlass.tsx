/**
 * Cap-order Attach / Agent / model / Send|Stop / Queue chrome that lives
 * **inside** LynxComposerGlassCard (GlassChrome contentView).
 *
 * Do not render autocomplete here — that stays a sibling ABOVE glass.
 */
import { lynxT } from '../i18n/catalog';
import { LynxText, LynxView } from '../lynx-elements';
import { cssVar } from '../theme/tokens';
import {
  resolveLynxComposerInGlassActionOrder,
  type LynxComposerActionsChromeVariant,
} from './composerActionsLayout';

export type LynxComposerActionsInGlassProps = {
  locale: string;
  variant: LynxComposerActionsChromeVariant;
  sessionIsWorking: boolean;
  queueCount?: number;
  /** Short agent label (Cap identicon+name flash). */
  agentLabel?: string | null;
  /** Model chip text (Cap bitmap name). */
  modelLabel?: string | null;
  onAttach: () => void;
  onSend: () => void;
  onStop: () => void;
  onQueue?: () => void;
  onAgent?: () => void;
  onModel?: () => void;
};

function actionPadStyle() {
  return { padding: '6px 8px' } as const;
}

/**
 * Footer (card) or trailing controls (pill) inside glass.
 * Caller supplies the text input separately for card (above this row) or
 * embeds input between attach and send for pill via children slot elsewhere.
 */
export function LynxComposerActionsInGlass({
  locale,
  variant,
  sessionIsWorking,
  queueCount = 0,
  agentLabel,
  modelLabel,
  onAttach,
  onSend,
  onStop,
  onQueue,
  onAgent,
  onModel,
}: LynxComposerActionsInGlassProps) {
  const showQueue = variant === 'card' && sessionIsWorking && typeof onQueue === 'function';
  const order = resolveLynxComposerInGlassActionOrder(variant, {
    showQueue,
    includeInputInPillRow: false,
  });

  const sendOrStop = sessionIsWorking ? (
    <LynxView
      bindtap={onStop}
      accessibility-role="button"
      accessibility-label={lynxT(locale, 'lynx.chat.composer.stop')}
      data-lynx-composer-action="sendOrStop"
      style={actionPadStyle()}
    >
      <LynxText style={{ color: cssVar('primary.base'), fontWeight: '600' }}>
        {lynxT(locale, 'lynx.chat.composer.stop')}
      </LynxText>
    </LynxView>
  ) : (
    <LynxView
      bindtap={onSend}
      accessibility-role="button"
      accessibility-label={lynxT(locale, 'lynx.chat.composer.send')}
      data-lynx-composer-action="sendOrStop"
      style={actionPadStyle()}
    >
      <LynxText style={{ color: cssVar('primary.base'), fontWeight: '600' }}>
        {lynxT(locale, 'lynx.chat.composer.send')}
      </LynxText>
    </LynxView>
  );

  return (
    <LynxView
      data-lynx-composer-actions-in-glass="true"
      data-lynx-composer-actions-variant={variant}
      data-lynx-composer-actions-order={order.join(',')}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        marginTop: variant === 'card' ? '8px' : '0',
      }}
    >
      {order.map((token) => {
        if (token === 'attach') {
          return (
            <LynxView
              key="attach"
              bindtap={onAttach}
              accessibility-role="button"
              accessibility-label={lynxT(locale, 'lynx.chat.composer.attach')}
              data-lynx-composer-action="attach"
              style={actionPadStyle()}
            >
              <LynxText style={{ color: cssVar('surface.mutedForeground'), fontWeight: '600' }}>
                +
              </LynxText>
            </LynxView>
          );
        }
        if (token === 'spacer') {
          return (
            <LynxView
              key="spacer"
              data-lynx-composer-action="spacer"
              style={{ flexGrow: 1, minWidth: '8px' }}
            />
          );
        }
        if (token === 'agent') {
          const label = (agentLabel && agentLabel.trim()) || lynxT(locale, 'lynx.chat.composer.mentionHint');
          return (
            <LynxView
              key="agent"
              bindtap={onAgent}
              accessibility-role="button"
              accessibility-label={label}
              data-lynx-composer-action="agent"
              style={actionPadStyle()}
            >
              <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '12px' }}>
                {label}
              </LynxText>
            </LynxView>
          );
        }
        if (token === 'model') {
          const label = (modelLabel && modelLabel.trim()) || lynxT(locale, 'lynx.chat.composer.modelHint');
          return (
            <LynxView
              key="model"
              bindtap={onModel}
              accessibility-role="button"
              accessibility-label={label}
              data-lynx-composer-action="model"
              style={actionPadStyle()}
            >
              <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '12px' }}>
                {label}
              </LynxText>
            </LynxView>
          );
        }
        if (token === 'sendOrStop') {
          return (
            <LynxView key="sendOrStop" style={{ flexDirection: 'row', alignItems: 'center' }}>
              {sendOrStop}
            </LynxView>
          );
        }
        if (token === 'queue' && onQueue) {
          return (
            <LynxView
              key="queue"
              bindtap={onQueue}
              accessibility-role="button"
              accessibility-label={lynxT(locale, 'lynx.chat.composer.queue')}
              data-lynx-composer-action="queue"
              style={actionPadStyle()}
            >
              <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '12px' }}>
                {lynxT(locale, 'lynx.chat.composer.queue')}
                {queueCount > 0 ? ` (${queueCount})` : ''}
              </LynxText>
            </LynxView>
          );
        }
        return null;
      })}
    </LynxView>
  );
}
