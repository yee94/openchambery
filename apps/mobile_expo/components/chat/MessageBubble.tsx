import React, { memo, useMemo } from 'react';
import { StyleSheet, View as RNView } from 'react-native';

import { Text, useThemeColor } from '@/components/Themed';
import type { TranscriptRow } from '@/lib/chatTranscript';
import { safeStreamingMarkdownText } from '@/lib/streamingMarkdown';

export type MessageBubbleProps = {
  row: TranscriptRow;
};

function MessageBubbleImpl({ row }: MessageBubbleProps) {
  const textColor = useThemeColor({}, 'text');
  const muted = useThemeColor({}, 'muted');
  const isUser = row.role === 'user';
  const display = useMemo(
    () => safeStreamingMarkdownText(row.text, row.streaming),
    [row.text, row.streaming],
  );

  return (
    <RNView
      style={[styles.wrap, isUser ? styles.userWrap : styles.assistantWrap]}
      accessibilityRole="text"
    >
      <RNView
        style={[
          styles.bubble,
          isUser ? styles.userBubble : styles.assistantBubble,
        ]}
      >
        <Text style={[styles.body, { color: isUser ? '#fff' : textColor }]}>
          {display || (row.streaming ? '…' : '')}
        </Text>
        {row.streaming ? (
          <Text style={[styles.streaming, { color: isUser ? 'rgba(255,255,255,0.7)' : muted }]}>
            streaming
          </Text>
        ) : null}
      </RNView>
    </RNView>
  );
}

export const MessageBubble = memo(MessageBubbleImpl, (prev, next) => {
  // Only re-render when this row's visible fields change — neighbors stay cold.
  return (
    prev.row.id === next.row.id &&
    prev.row.text === next.row.text &&
    prev.row.streaming === next.row.streaming &&
    prev.row.role === next.row.role
  );
});

const styles = StyleSheet.create({
  wrap: {
    paddingHorizontal: 14,
    paddingVertical: 4,
    width: '100%',
  },
  userWrap: {
    alignItems: 'flex-end',
  },
  assistantWrap: {
    alignItems: 'flex-start',
  },
  bubble: {
    maxWidth: '92%',
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  userBubble: {
    backgroundColor: '#E87722',
  },
  assistantBubble: {
    backgroundColor: 'rgba(127,127,127,0.18)',
  },
  body: {
    fontSize: 16,
    lineHeight: 22,
  },
  streaming: {
    marginTop: 4,
    fontSize: 11,
  },
});
