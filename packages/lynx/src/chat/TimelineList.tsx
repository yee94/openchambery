import type { ReactNode } from 'react';

import { lynxT } from '../i18n/catalog';
import { LynxList, LynxText, LynxView } from '../lynx-elements';
import { cssVar } from '../theme/tokens';
import {
  LYNX_LOAD_OLDER_TRIGGER,
  LYNX_RECYCLE_ITEMS,
  resolveLynxTimelineListFlags,
} from './listSemantics';
import {
  canAcceptLynxLoadOlderTap,
  resolveLynxLoadOlderBusy,
  resolveLynxLoadOlderVisibility,
  shouldIgnoreScrollLoadOlder,
} from './loadOlder';
import {
  lynxMarkdownPinRevealVisibility,
  mergeLynxMarkdownPinRevealStyle,
  type LynxMarkdownPinRevealPhase,
} from './markdownPinReveal';
import type { LynxTimelineEntry, LynxTimelineState } from './timelineModel';
import { LynxTurnCard } from './TurnCards';

export type LynxTimelineListProps = {
  locale: string;
  state: LynxTimelineState;
  onLoadOlder: () => void;
  renderEntry?: (entry: LynxTimelineEntry) => ReactNode;
  header?: ReactNode;
  footer?: ReactNode;
  /**
   * Cap markdown pin-reveal phase. `pending` hides the list (layout still runs)
   * until seed rows report ready / timeout. Live-tail must stay `ready`.
   */
  pinRevealPhase?: LynxMarkdownPinRevealPhase;
};

function DefaultEntry({ locale, entry }: { locale: string; entry: LynxTimelineEntry }) {
  return (
    <LynxTurnCard
      locale={locale}
      messageId={entry.messageId}
      role={entry.role}
      parts={entry.parts ?? []}
      textFallback={entry.text}
    />
  );
}

/**
 * One Lynx `<list>` owns history + live tail (LegendList 1.19 semantics).
 * Header hosts the load-older **button**; footer is a list slot so
 * maintainScrollAtEnd sees composer inset growth. `recycle-items` is hard-false.
 * Bounce / scroll-top must not call `onLoadOlder` (button trigger only).
 */
export function LynxTimelineList({
  locale,
  state,
  onLoadOlder,
  renderEntry,
  header,
  footer,
  pinRevealPhase = 'ready',
}: LynxTimelineListProps) {
  const flags = resolveLynxTimelineListFlags({
    followEnabled: state.followEnabled,
    historyAnchorActive: state.historyAnchorKeys !== null,
    sessionIsWorking: state.sessionIsWorking,
    endSettledOnce: state.endSettledOnce,
    prependSettling: state.prependSettling,
    knownKeys: state.historyAnchorKeys ?? undefined,
  });

  const showLoadOlder = resolveLynxLoadOlderVisibility({
    canLoadEarlier: state.canLoadEarlier,
    isLoadingOlder: state.isLoadingOlder,
  });
  const loadOlderBusy = resolveLynxLoadOlderBusy({ isLoadingOlder: state.isLoadingOlder });
  const acceptLoadOlder = canAcceptLynxLoadOlderTap({
    canLoadEarlier: state.canLoadEarlier,
    isLoadingOlder: state.isLoadingOlder,
    prependSettling: state.prependSettling,
  });

  const handleLoadOlderTap = () => {
    // Contract: only the button path may load older history.
    if (shouldIgnoreScrollLoadOlder(LYNX_LOAD_OLDER_TRIGGER)) return;
    if (!acceptLoadOlder) return;
    onLoadOlder();
  };

  const listStyle = mergeLynxMarkdownPinRevealStyle(
    { flexGrow: 1 },
    pinRevealPhase,
  );
  const pinVisibility = lynxMarkdownPinRevealVisibility(pinRevealPhase);

  return (
    <LynxList
      style={listStyle}
      scroll-orientation="vertical"
      recycle-items={flags.recycleItems && LYNX_RECYCLE_ITEMS}
      accessibility-label={lynxT(locale, 'lynx.chat.timeline.aria')}
      id={`lynx-timeline-${state.sessionId}`}
      data-markdown-pin-reveal={pinRevealPhase === 'pending' ? 'pending' : 'ready'}
      data-pin-visibility={pinVisibility}
    >
      <LynxView style={{ padding: '8px 16px' }} id="lynx-timeline-header">
        {header}
        {showLoadOlder ? (
          <LynxView
            bindtap={handleLoadOlderTap}
            accessibility-label={lynxT(locale, 'lynx.chat.loadOlder')}
            accessibility-role="button"
            style={{
              padding: '10px 12px',
              alignItems: 'center',
              opacity: acceptLoadOlder ? 1 : 0.6,
            }}
          >
            <LynxText style={{ color: cssVar('primary.base'), fontSize: '14px' }}>
              {loadOlderBusy
                ? lynxT(locale, 'lynx.chat.loadOlder.busy')
                : lynxT(locale, 'lynx.chat.loadOlder')}
            </LynxText>
          </LynxView>
        ) : null}
        {state.loadOlderError ? (
          <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '12px' }}>
            {lynxT(locale, 'lynx.chat.loadOlder.failed')}: {state.loadOlderError}
          </LynxText>
        ) : null}
      </LynxView>

      {state.initialError ? (
        <LynxView style={{ padding: '16px' }}>
          <LynxText style={{ color: cssVar('surface.mutedForeground') }}>
            {lynxT(locale, 'lynx.chat.timeline.loadError')}: {state.initialError}
          </LynxText>
        </LynxView>
      ) : null}

      {state.entries.map((entry) => (
        <LynxView
          key={entry.key}
          id={`lynx-timeline-row-${entry.key}`}
          data-turn-entry={entry.key}
          data-markdown-ready="true"
        >
          {renderEntry ? renderEntry(entry) : <DefaultEntry locale={locale} entry={entry} />}
        </LynxView>
      ))}

      <LynxView id="lynx-timeline-footer" style={{ paddingBottom: '8px' }}>
        {footer}
      </LynxView>
    </LynxList>
  );
}
