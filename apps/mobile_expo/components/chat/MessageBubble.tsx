import React, { memo, useMemo } from 'react';
import { Pressable, StyleSheet, View as RNView } from 'react-native';

import { ChatMarkdown } from '@/components/chat/ChatMarkdown';
import { ReasoningDisclosure } from '@/components/chat/ReasoningDisclosure';
import { SkillGroup } from '@/components/chat/SkillGroup';
import { ToolCard } from '@/components/chat/ToolCard';
import { UsedFold } from '@/components/chat/UsedFold';
import { Text, useThemeColor } from '@/components/Themed';
import { useColorScheme } from '@/components/useColorScheme';
import Colors from '@/constants/Colors';
import type { TranscriptRow } from '@/lib/chatTranscript';
import { partsSignature, segmentsFromParts } from '@/lib/toolCards';

export type MessageBubbleProps = {
  onLongPress?: () => void;
  row: TranscriptRow;
};

type Palette = (typeof Colors)['light'] & {
  elevated?: string;
  tint: string;
};

/**
 * Cap ChatMessage optics (chrome — Expo UI) + Cap-parity markdown body (this track):
 * - User: elevated plate, max 85%, radius-xl with tighter bottom-right
 * - Assistant: flat full-bleed text (no gray bubble)
 */
function MessageBubbleImpl({ row, onLongPress }: MessageBubbleProps) {
  const scheme = useColorScheme();
  const colors = Colors[scheme] as Palette;
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

  const elevated =
    colors.elevated ?? (scheme === 'dark' ? '#282726' : '#f7f0e4');
  const bodyColor = textColor;
  const linkColor = tint;
  const codeBg = scheme === 'dark' ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)';
  const codeColor = textColor;

  const renderMarkdown = (content: string, streaming: boolean) => {
    if (!content && streaming) {
      return <Text style={[styles.body, { color: muted }]}>…</Text>;
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
            isUser
              ? [
                  styles.userBubble,
                  {
                    backgroundColor: elevated,
                    borderColor: `${tint}14`,
                  },
                ]
              : styles.assistantFlat,
          ]}
        >
          {renderMarkdown(row.text, row.streaming)}
          {row.streaming && !row.text ? (
            <Text style={[styles.streaming, { color: muted }]}>…</Text>
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
            <RNView key={segment.id} style={styles.assistantFlat}>
              {renderMarkdown(segment.text, Boolean(liveTail))}
            </RNView>
          );
        })}
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
    paddingVertical: 6,
    width: '100%',
  },
  userWrap: {
    alignItems: 'flex-end',
    paddingTop: 8,
  },
  assistantWrap: {
    alignItems: 'flex-start',
    paddingBottom: 4,
  },
  assistantColumn: {
    maxWidth: '100%',
    width: '100%',
    gap: 6,
  },
  userBubble: {
    maxWidth: '85%',
    borderRadius: 16,
    borderBottomRightRadius: 4,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: StyleSheet.hairlineWidth,
  },
  assistantFlat: {
    maxWidth: '100%',
    width: '100%',
    paddingHorizontal: 2,
    paddingVertical: 2,
  },
  body: {
    fontSize: 16,
    lineHeight: 24,
  },
  streaming: {
    marginTop: 2,
    fontSize: 14,
  },
});
