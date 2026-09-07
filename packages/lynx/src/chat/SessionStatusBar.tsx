/**
 * Cap MobileSessionStatusBar spirit for Lynx — slim related-session strip.
 *
 * Placement: sibling ABOVE LynxQueuedMessageChips / SessionGoal and ABOVE
 * LynxComposerGlassCard (Cap composer accessory stack). Not the full Cap
 * sessions sheet (~1900 lines) — list/switch + busy indicator only.
 */
import { useMemo } from 'react';

import { lynxT } from '../i18n/catalog';
import { LynxText, LynxView } from '../lynx-elements';
import { cssVar } from '../theme/tokens';
import {
  buildLynxSessionStatusBarItems,
  countLynxRunningSessions,
  isLynxSessionStatusWorking,
  shouldShowLynxSessionBusyIndicator,
  shouldShowLynxSessionStatusBar,
  type LynxSessionStatusBarItem,
  type LynxSessionStatusBarRelatedInput,
} from './sessionStatusBar';

export type LynxSessionStatusBarProps = {
  locale: string;
  sessionId: string;
  related: readonly LynxSessionStatusBarRelatedInput[];
  /** Live timeline working — Cap SSE may be fresher than session-index. */
  sessionIsWorking?: boolean;
  onSelectSession: (sessionId: string) => void;
  /**
   * Cap opens the full MobileSessionStatusBar sheet from chrome.
   * Honest stub: only fires when host/shell provides a handler.
   */
  onOpenSessionsSheet?: () => void;
};

function LynxSessionBusyGlyph({ size = 12 }: { size?: number }) {
  // Cap SessionBusyIndicator is an SVG spin ring. Lynx paints a compact glyph
  // (no invent DOM SVG animate) — host can restyle via data attribute later.
  return (
    <LynxText
      data-lynx-session-busy-indicator="true"
            style={{
        color: cssVar('surface.mutedForeground'),
        fontSize: `${size}px`,
        lineHeight: `${size}px`,
        width: `${size}px`,
        textAlign: 'center',
      }}
    >
      ◐
    </LynxText>
  );
}

function SessionChip({
  item,
  onSelect,
}: {
  item: LynxSessionStatusBarItem;
  onSelect: (sessionId: string) => void;
}) {
  const working = isLynxSessionStatusWorking(item.statusType);
  return (
    <LynxView
      data-lynx-session-status-chip={item.id}
      data-lynx-session-status-current={item.isCurrent ? 'true' : 'false'}
      data-lynx-session-status-type={item.statusType}
      bindtap={() => {
        if (!item.isCurrent) onSelect(item.id);
      }}
      accessibility-role="button"
      accessibility-label={item.title}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingLeft: '10px',
        paddingRight: '10px',
        paddingTop: '6px',
        paddingBottom: '6px',
        marginRight: '6px',
        borderRadius: '999px',
        borderWidth: '1px',
        borderColor: item.isCurrent
          ? cssVar('primary.base')
          : cssVar('surface.mutedForeground'),
        backgroundColor: item.isCurrent
          ? cssVar('surface.elevated')
          : cssVar('surface.muted'),
        opacity: item.isCurrent ? 1 : 0.92,
        maxWidth: '180px',
      }}
    >
      {working ? (
        <LynxView style={{ marginRight: '6px' }}>
          <LynxSessionBusyGlyph size={11} />
        </LynxView>
      ) : item.needsAttention && !item.isCurrent ? (
        <LynxView
          data-lynx-session-status-unread="true"
          style={{
            width: '6px',
            height: '6px',
            borderRadius: '3px',
            marginRight: '6px',
            backgroundColor: 'var(--status-info)',
          }}
        />
      ) : null}
      <LynxText
        style={{
          color: cssVar('surface.foreground'),
          fontSize: '12px',
          fontWeight: item.isCurrent ? '700' : '500',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {item.title}
      </LynxText>
    </LynxView>
  );
}

export function LynxSessionStatusBar({
  locale,
  sessionId,
  related,
  sessionIsWorking = false,
  onSelectSession,
  onOpenSessionsSheet,
}: LynxSessionStatusBarProps) {
  const items = useMemo(
    () => buildLynxSessionStatusBarItems(related, sessionId),
    [related, sessionId],
  );
  const running = countLynxRunningSessions(items);
  const showBusy = shouldShowLynxSessionBusyIndicator({
    items,
    currentSessionIsWorking: sessionIsWorking,
  });
  const visible = shouldShowLynxSessionStatusBar({
    items,
    currentSessionIsWorking: sessionIsWorking,
  });

  if (!visible) return null;

  return (
    <LynxView
      data-lynx-session-status-bar="true"
      accessibility-label={lynxT(locale, 'lynx.chat.sessionStatus.aria')}
      style={{
        marginBottom: '6px',
        paddingLeft: '8px',
        paddingRight: '8px',
      }}
    >
      <LynxView
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          borderRadius: '14px',
          borderWidth: '1px',
          borderColor: cssVar('surface.mutedForeground'),
          backgroundColor: cssVar('surface.muted'),
          paddingLeft: '8px',
          paddingRight: '8px',
          paddingTop: '6px',
          paddingBottom: '6px',
          opacity: 0.96,
        }}
      >
        {showBusy ? (
          <LynxView
            style={{ flexDirection: 'row', alignItems: 'center', marginRight: '8px' }}
            accessibility-label={lynxT(locale, 'lynx.chat.sessionStatus.busy')}
          >
            <LynxSessionBusyGlyph size={12} />
            {running > 0 ? (
              <LynxText
                data-lynx-session-status-running-count={String(running)}
                style={{
                  marginLeft: '4px',
                  color: cssVar('surface.mutedForeground'),
                  fontSize: '12px',
                }}
              >
                {running}
              </LynxText>
            ) : null}
          </LynxView>
        ) : null}

        <LynxView
          style={{ flexGrow: 1, flexShrink: 1, flexDirection: 'row', alignItems: 'center', overflow: 'hidden' }}
        >
          {items.map((item) => (
            <SessionChip key={item.id} item={item} onSelect={onSelectSession} />
          ))}
        </LynxView>

        {typeof onOpenSessionsSheet === 'function' ? (
          <LynxView
            bindtap={onOpenSessionsSheet}
            accessibility-role="button"
            accessibility-label={lynxT(locale, 'lynx.chat.sessionStatus.openSheet')}
            data-lynx-session-status-open-sheet="true"
            style={{ marginLeft: '6px', paddingLeft: '6px', paddingRight: '2px' }}
          >
            <LynxText style={{ color: cssVar('primary.base'), fontSize: '12px', fontWeight: '600' }}>
              {lynxT(locale, 'lynx.chat.sessionStatus.openSheet')}
            </LynxText>
          </LynxView>
        ) : null}
      </LynxView>
    </LynxView>
  );
}
