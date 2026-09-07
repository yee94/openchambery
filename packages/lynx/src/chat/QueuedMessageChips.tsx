/**
 * Cap QueuedMessageChips spirit for Lynx — queue chips above composer.
 *
 * Placement: sibling ABOVE LynxComposerGlassCard (Cap composer-queue stack).
 * Source: Cap server message-queue when wired via composerActions; else local.
 * Reorder: portable ↑/↓ (no @dnd-kit). Trailing: SessionGoal strip when present.
 */
import type { ReactNode } from 'react';

import { lynxT } from '../i18n/catalog';
import { LynxText, LynxView } from '../lynx-elements';
import { cssVar } from '../theme/tokens';
import {
  canRemoveLynxQueueChip,
  canSendNowLynxQueueChip,
  lynxQueuedMessagePreviewLine,
  shouldShowLynxQueueShell,
  type LynxQueueChipItem,
} from './queuedMessageChips';

export type LynxQueuedMessageChipsProps = {
  locale: string;
  items: readonly LynxQueueChipItem[];
  sessionIsWorking?: boolean;
  onRemove: (id: string) => void;
  onSendNow: (id: string) => void;
  onMove?: (id: string, direction: 'up' | 'down') => void;
  /** Cap trailing slot (SessionGoalRow). */
  trailing?: ReactNode;
};

export function LynxQueuedMessageChips({
  locale,
  items,
  sessionIsWorking = false,
  onRemove,
  onSendNow,
  onMove,
  trailing = null,
}: LynxQueuedMessageChipsProps) {
  const hasTrailing = Boolean(trailing);
  if (!shouldShowLynxQueueShell(items.length, hasTrailing)) {
    return null;
  }

  return (
    <LynxView
      data-lynx-queue-chips="true"
      data-oc-queue-card=""
      accessibility-label={lynxT(locale, 'lynx.chat.queue.aria')}
      style={{
        marginBottom: '-8px',
        paddingLeft: '8px',
        paddingRight: '8px',
      }}
    >
      <LynxView
        style={{
          borderRadius: '16px',
          borderWidth: '1px',
          borderColor: cssVar('surface.mutedForeground'),
          backgroundColor: cssVar('surface.muted'),
          overflow: 'hidden',
          paddingLeft: '8px',
          paddingRight: '8px',
          paddingTop: '6px',
          paddingBottom: '14px',
          opacity: 0.95,
        }}
      >
        {items.map((item, index) => {
          const preview = lynxQueuedMessagePreviewLine(item.text)
            || lynxT(locale, 'lynx.chat.queue.empty');
          const canRemove = canRemoveLynxQueueChip(item);
          const canSend = canSendNowLynxQueueChip(item, { sessionIsWorking });
          const canUp = Boolean(onMove) && index > 0 && !item.sending;
          const canDown = Boolean(onMove) && index < items.length - 1 && !item.sending;

          return (
            <LynxView
              key={item.id}
              data-lynx-queue-chip={item.id}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                paddingTop: '4px',
                paddingBottom: '4px',
                gap: '6px',
              }}
            >
              {onMove ? (
                <LynxView style={{ flexDirection: 'row', gap: '2px', flexShrink: 0 }}>
                  <LynxView
                    bindtap={() => { if (canUp) onMove(item.id, 'up'); }}
                    accessibility-role="button"
                    accessibility-label={lynxT(locale, 'lynx.chat.queue.reorderUp')}
                    style={{ padding: '4px', opacity: canUp ? 1 : 0.35 }}
                  >
                    <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '11px' }}>
                      ↑
                    </LynxText>
                  </LynxView>
                  <LynxView
                    bindtap={() => { if (canDown) onMove(item.id, 'down'); }}
                    accessibility-role="button"
                    accessibility-label={lynxT(locale, 'lynx.chat.queue.reorderDown')}
                    style={{ padding: '4px', opacity: canDown ? 1 : 0.35 }}
                  >
                    <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '11px' }}>
                      ↓
                    </LynxText>
                  </LynxView>
                </LynxView>
              ) : null}

              <LynxView
                bindtap={() => { if (canRemove) onRemove(item.id); }}
                accessibility-role="button"
                accessibility-label={lynxT(locale, 'lynx.chat.queue.remove')}
                style={{ padding: '4px', flexShrink: 0, opacity: canRemove ? 1 : 0.4 }}
              >
                <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '12px' }}>
                  ×
                </LynxText>
              </LynxView>

              <LynxText
                style={{
                  flexGrow: 1,
                  flexShrink: 1,
                  color: cssVar('surface.foreground'),
                  fontSize: '12px',
                  lineHeight: '18px',
                }}
              >
                {preview}
              </LynxText>

              {item.sending ? (
                <LynxText style={{
                  color: cssVar('surface.mutedForeground'),
                  fontSize: '11px',
                  flexShrink: 0,
                }}
                >
                  {lynxT(locale, 'lynx.chat.queue.sending')}
                </LynxText>
              ) : (
                <LynxView
                  bindtap={() => { if (canSend) onSendNow(item.id); }}
                  accessibility-role="button"
                  accessibility-label={lynxT(locale, 'lynx.chat.queue.send')}
                  style={{ padding: '4px 6px', flexShrink: 0, opacity: canSend ? 1 : 0.4 }}
                >
                  <LynxText style={{
                    color: cssVar('surface.mutedForeground'),
                    fontSize: '11px',
                    fontWeight: '600',
                  }}
                  >
                    {lynxT(locale, 'lynx.chat.queue.send')}
                  </LynxText>
                </LynxView>
              )}
            </LynxView>
          );
        })}

        {hasTrailing ? (
          <>
            {items.length > 0 ? (
              <LynxView
                aria-hidden="true"
                style={{
                  height: '1px',
                  marginTop: '4px',
                  marginBottom: '4px',
                  backgroundColor: cssVar('surface.mutedForeground'),
                  opacity: 0.35,
                }}
              />
            ) : null}
            {trailing}
          </>
        ) : null}
      </LynxView>
    </LynxView>
  );
}
