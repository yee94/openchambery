import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
} from 'react';
import {
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  StyleSheet,
  View as RNView,
} from 'react-native';
import { LegendList, type LegendListRef } from '@legendapp/list/react-native';

import { MessageBubble } from '@/components/chat/MessageBubble';
import { Text } from '@/components/Themed';
import type { TranscriptRow } from '@/lib/chatTranscript';
import { t } from '@/lib/i18n';

/** Cap native scroll-to-bottom appears after ~80px of upward travel. */
const AWAY_FROM_END_PX = 80;

export type TranscriptListProps = {
  rows: TranscriptRow[];
  /** Bumps only when ids/order change — used as LegendList extraData for structure. */
  structureEpoch: number;
  emptyLabel?: string;
  onMessageLongPress?: (row: TranscriptRow) => void;
  /** True when the user has scrolled up past the live edge (~80px). */
  onAwayFromEndChange?: (away: boolean) => void;
};

export type TranscriptListHandle = {
  scrollToEnd: (animated?: boolean) => void;
};

/**
 * LegendList semantics (not TanStack 1.18):
 * - chronological data (oldest → newest)
 * - initialScrollAtEnd / maintainScrollAtEnd → stick to latest
 * - maintainVisibleContentPosition for prepend stability
 * - re-enter scrolls to latest (1.19.3-beta.5)
 */
export const TranscriptList = forwardRef<TranscriptListHandle, TranscriptListProps>(
  function TranscriptList(
    { rows, structureEpoch, emptyLabel, onMessageLongPress, onAwayFromEndChange },
    ref,
  ) {
    const listRef = useRef<LegendListRef | null>(null);
    const awayRef = useRef(false);

    const keyExtractor = useCallback((item: TranscriptRow) => item.id, []);

    const renderItem = useCallback(({ item }: { item: TranscriptRow }) => {
      return (
        <MessageBubble
          row={item}
          onLongPress={onMessageLongPress ? () => onMessageLongPress(item) : undefined}
        />
      );
    }, [onMessageLongPress]);

    useImperativeHandle(ref, () => ({
      scrollToEnd: (animated = true) => {
        listRef.current?.scrollToEnd?.({ animated });
        if (awayRef.current) {
          awayRef.current = false;
          onAwayFromEndChange?.(false);
        }
      },
    }), [onAwayFromEndChange]);

    // Re-enter / structure mount: scroll to latest edge (1.19.3-beta.5).
    // Depend on structureEpoch only — token updates must not resubscribe scroll.
    useEffect(() => {
      if (rows.length === 0) return;
      const id = requestAnimationFrame(() => {
        listRef.current?.scrollToEnd?.({ animated: false });
        if (awayRef.current) {
          awayRef.current = false;
          onAwayFromEndChange?.(false);
        }
      });
      return () => cancelAnimationFrame(id);
      // eslint-disable-next-line react-hooks/exhaustive-deps -- stick-to-latest on structure/re-enter only
    }, [structureEpoch]);

    const onScroll = useCallback(
      (event: NativeSyntheticEvent<NativeScrollEvent>) => {
        if (!onAwayFromEndChange) return;
        const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
        const distance =
          contentSize.height - layoutMeasurement.height - contentOffset.y;
        const away = distance > AWAY_FROM_END_PX;
        if (away !== awayRef.current) {
          awayRef.current = away;
          onAwayFromEndChange(away);
        }
      },
      [onAwayFromEndChange],
    );

    if (rows.length === 0) {
      return (
        <RNView style={styles.empty}>
          <Text style={styles.emptyText}>{emptyLabel ?? t('mobile.chat.empty')}</Text>
        </RNView>
      );
    }

    return (
      <LegendList
        ref={listRef}
        data={rows}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        extraData={structureEpoch}
        style={styles.list}
        contentContainerStyle={styles.content}
        initialScrollAtEnd
        maintainScrollAtEnd
        maintainVisibleContentPosition
        recycleItems={false}
        estimatedItemSize={72}
        onScroll={onScroll}
        scrollEventThrottle={16}
      />
    );
  },
);

const styles = StyleSheet.create({
  list: {
    flex: 1,
  },
  content: {
    paddingVertical: 8,
    flexGrow: 1,
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  emptyText: {
    opacity: 0.65,
    fontSize: 15,
    textAlign: 'center',
  },
});
