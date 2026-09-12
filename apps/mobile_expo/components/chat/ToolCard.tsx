import React, { memo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View as RNView } from 'react-native';

import { ChatMarkdown } from '@/components/chat/ChatMarkdown';
import { Text, useThemeColor } from '@/components/Themed';
import { useColorScheme } from '@/components/useColorScheme';
import type { ToolCardModel } from '@/lib/toolCards';
import { truncateToolCardBody } from '@/lib/toolCards';
import { t } from '@/lib/i18n';

export type ToolCardProps = {
  card: ToolCardModel;
};

function statusLabel(status: ToolCardModel['status']): string {
  switch (status) {
    case 'pending':
      return t('mobile.chat.tool.status.pending');
    case 'running':
      return t('mobile.chat.tool.status.running');
    case 'completed':
      return t('mobile.chat.tool.status.completed');
    case 'error':
      return t('mobile.chat.tool.status.error');
    case 'aborted':
      return t('mobile.chat.tool.status.aborted');
    default:
      return t('mobile.chat.tool.status.unknown');
  }
}

function ToolCardImpl({ card }: ToolCardProps) {
  const [expanded, setExpanded] = useState(false);
  const scheme = useColorScheme();
  const textColor = useThemeColor({}, 'text');
  const muted = useThemeColor({}, 'muted');
  const tint = useThemeColor({}, 'tint');
  const rawBody = card.error?.trim() || card.output?.trim() || null;
  const body = rawBody ? truncateToolCardBody(rawBody) : null;
  const canExpand = Boolean(body);
  const codeBg = scheme === 'dark' ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)';

  return (
    <RNView style={styles.wrap} accessibilityRole="summary">
      <Pressable
        onPress={() => {
          if (canExpand) setExpanded((v) => !v);
        }}
        disabled={!canExpand}
        style={styles.header}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={`${card.displayName}${card.description ? `, ${card.description}` : ''}`}
      >
        <RNView style={styles.titleRow}>
          <Text style={[styles.title, { color: textColor }]} numberOfLines={1}>
            {card.displayName}
          </Text>
          <Text style={[styles.status, { color: muted }]}>{statusLabel(card.status)}</Text>
        </RNView>
        {card.description ? (
          <Text style={[styles.description, { color: muted }]} numberOfLines={1}>
            {card.description}
          </Text>
        ) : null}
        {canExpand ? (
          <Text style={[styles.chevron, { color: muted }]}>
            {expanded ? t('mobile.chat.tool.collapse') : t('mobile.chat.tool.expand')}
          </Text>
        ) : null}
      </Pressable>
      {expanded && body ? (
        <ScrollView style={styles.body} nestedScrollEnabled>
          <ChatMarkdown
            content={body}
            variant="tool"
            color={textColor}
            linkColor={tint}
            codeBackground={codeBg}
            codeColor={textColor}
          />
        </ScrollView>
      ) : null}
    </RNView>
  );
}

export const ToolCard = memo(ToolCardImpl, (a, b) => {
  const x = a.card;
  const y = b.card;
  return (
    x.id === y.id &&
    x.displayName === y.displayName &&
    x.status === y.status &&
    x.description === y.description &&
    x.output === y.output &&
    x.error === y.error &&
    x.settled === y.settled
  );
});

const styles = StyleSheet.create({
  wrap: {
    alignSelf: 'stretch',
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(127,127,127,0.35)',
    backgroundColor: 'rgba(127,127,127,0.08)',
    marginVertical: 3,
    overflow: 'hidden',
  },
  header: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    gap: 2,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  title: {
    flex: 1,
    fontSize: 13,
    fontWeight: '600',
  },
  status: {
    fontSize: 11,
  },
  description: {
    fontSize: 12,
  },
  chevron: {
    marginTop: 2,
    fontSize: 11,
  },
  body: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(127,127,127,0.25)',
    paddingHorizontal: 10,
    paddingVertical: 8,
    maxHeight: 220,
  },
});
