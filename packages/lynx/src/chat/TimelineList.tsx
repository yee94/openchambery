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
  resolveLynxLoadOlderBusy,
  resolveLynxLoadOlderVisibility,
  shouldIgnoreScrollLoadOlder,
} from './loadOlder';
import type { LynxTimelineEntry, LynxTimelineState } from './timelineModel';

export type LynxTimelineListProps = {
  locale: string;
  state: LynxTimelineState;
  onLoadOlder: () => void;
  renderEntry?: (entry: LynxTimelineEntry) => ReactNode;
  header?: ReactNode;
  footer?: ReactNode;
};

function DefaultEntry({ entry }: { entry: LynxTimelineEntry }) {
  return (
    <LynxView style={{ padding: '10px 16px' }}>
      <LynxText
        style={{
          fontSize: '12px',
          color: cssVar('surface.mutedForeground'),
          marginBottom: '4px',
        }}
      >
        {entry.role}
      </LynxText>
      <LynxText style={{ color: cssVar('surface.foreground'), fontSize: '15px' }}>
        {entry.text || '…'}
      </LynxText>
    </LynxView>
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

  const handleLoadOlderTap = () => {
    // Contract: only the button path may load older history.
    if (shouldIgnoreScrollLoadOlder(LYNX_LOAD_OLDER_TRIGGER)) return;
    if (loadOlderBusy) return;
    onLoadOlder();
  };

  return (
    <LynxList
      style={{ flexGrow: 1 }}
      scroll-orientation="vertical"
      recycle-items={flags.recycleItems && LYNX_RECYCLE_ITEMS}
      accessibility-label={lynxT(locale, 'lynx.chat.timeline.aria')}
      id={`lynx-timeline-${state.sessionId}`}
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
              opacity: loadOlderBusy ? 0.6 : 1,
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
        <LynxView key={entry.key} id={`lynx-timeline-row-${entry.key}`}>
          {renderEntry ? renderEntry(entry) : <DefaultEntry entry={entry} />}
        </LynxView>
      ))}

      <LynxView id="lynx-timeline-footer" style={{ paddingBottom: '8px' }}>
        {footer}
      </LynxView>
    </LynxList>
  );
}
