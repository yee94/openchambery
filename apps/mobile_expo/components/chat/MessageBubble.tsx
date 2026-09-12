import React, { memo, useMemo } from 'react';
import { Pressable, StyleSheet, View as RNView } from 'react-native';

import { ChatMarkdown } from '@/components/chat/ChatMarkdown';
import { ReasoningDisclosure } from '@/components/chat/ReasoningDisclosure';
import { SkillGroup } from '@/components/chat/SkillGroup';
import { ToolCard } from '@/components/chat/ToolCard';
import { UsedFold } from '@/components/chat/UsedFold';
import { Text, useThemeColor } from '@/components/Themed';
import type { TranscriptRow } from '@/lib/chatTranscript';
import { partsSignature, segmentsFromParts } from '@/lib/toolCards';

export type MessageBubbleProps = {
  onLongPress?: () => void;
  row: TranscriptRow;
};

function MessageBubbleImpl({ row, onLongPress }: MessageBubbleProps) {
  const textColor = useThemeColor({}, 'text');
  const muted = useThemeColor({}, 'muted');
  const tint = useThemeColor({}, 'tint');
  const isUser = row.role === 'user';

  const segments = useMemo(
    () => segmentsFromParts(row.parts, { isTurnLive: row.streaming }),
    [row.parts, row.streaming],
  );
  const hasStructured = segments.some(
    (s) =>
      s.kind === 'tool' ||
      s.kind === 'reasoning' ||
      s.kind === 'used-fold' ||
      s.kind === 'skill-group',
  );

  const bodyColor = isUser ? '#fff' : textColor;
  const linkColor = isUser ? '#FFE4C4' : tint;
  const codeBg = isUser ? 'rgba(0,0,0,0.22)' : 'rgba(127,127,127,0.22)';
  const codeColor = isUser ? '#fff' : textColor;

  const renderMarkdown = (content: string, streaming: boolean) => {
    if (!content && streaming) {
      return <Text style={[styles.body, { color: bodyColor }]}>…</Text>;
    }
    if (!content) return null;
    return (
      <ChatMarkdown
        content={content}
        streaming={streaming}
        color={bodyColor}
        linkColor={linkColor}
        codeBackground={codeBg}
        codeColor={codeColor}
      />
    );
  };

  if (isUser || !hasStructured) {
    return (
      <Pressable
        onLongPress={onLongPress}
        style={[styles.wrap, isUser ? styles.userWrap : styles.assistantWrap]}
        accessibilityRole="text"
      >
        <RNView
          style={[
            styles.bubble,
            isUser ? styles.userBubble : styles.assistantBubble,
          ]}
        >
          {renderMarkdown(row.text, row.streaming)}
          {row.streaming ? (
            <Text style={[styles.streaming, { color: isUser ? 'rgba(255,255,255,0.7)' : muted }]}>
              streaming
            </Text>
          ) : null}
        </RNView>
      </Pressable>
    );
  }

  return (
    <Pressable onLongPress={onLongPress} style={[styles.wrap, styles.assistantWrap]} accessibilityRole="text">
      <RNView style={styles.assistantColumn}>
        {segments.map((segment) => {
          if (segment.kind === 'reasoning') {
            return <ReasoningDisclosure key={segment.id} reasoning={segment.reasoning} />;
          }
          if (segment.kind === 'used-fold') {
            return <UsedFold key={segment.id} fold={segment.fold} />;
          }
          if (segment.kind === 'skill-group') {
            return <SkillGroup key={segment.id} group={segment.group} />;
          }
          if (segment.kind === 'tool') {
            return <ToolCard key={segment.id} card={segment.card} />;
          }
          const liveTail = row.streaming && segments[segments.length - 1] === segment;
          if (!segment.text && !row.streaming) return null;
          return (
            <RNView key={segment.id} style={[styles.bubble, styles.assistantBubble]}>
              {renderMarkdown(segment.text, Boolean(liveTail))}
            </RNView>
          );
        })}
        {row.streaming ? (
          <Text style={[styles.streaming, { color: muted }]}>streaming</Text>
        ) : null}
      </RNView>
    </Pressable>
  );
}

export const MessageBubble = memo(MessageBubbleImpl, (prev, next) => {
  return (
    prev.row.id === next.row.id &&
    prev.row.text === next.row.text &&
    prev.row.streaming === next.row.streaming &&
    prev.row.role === next.row.role &&
    partsSignature(prev.row.parts) === partsSignature(next.row.parts)
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
  assistantColumn: {
    maxWidth: '96%',
    width: '100%',
    gap: 4,
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
    maxWidth: '100%',
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
