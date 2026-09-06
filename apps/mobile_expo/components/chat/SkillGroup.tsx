import React, { memo, useState } from 'react';
import { Pressable, StyleSheet, View as RNView } from 'react-native';

import { ToolCard } from '@/components/chat/ToolCard';
import { Text, useThemeColor } from '@/components/Themed';
import type { SkillGroupModel } from '@/lib/toolCards';
import { t } from '@/lib/i18n';

export type SkillGroupProps = {
  group: SkillGroupModel;
};

function SkillGroupImpl({ group }: SkillGroupProps) {
  const [expanded, setExpanded] = useState(false);
  const textColor = useThemeColor({}, 'text');
  const muted = useThemeColor({}, 'muted');

  return (
    <RNView style={styles.wrap} accessibilityRole="summary">
      <Pressable
        onPress={() => setExpanded((v) => !v)}
        style={styles.header}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={
          expanded ? t('mobile.chat.skill.collapseAria') : t('mobile.chat.skill.expandAria')
        }
      >
        <Text style={[styles.title, { color: textColor }, group.running && styles.running]}>
          {t('mobile.chat.skill.title')}
        </Text>
        {group.summary ? (
          <Text style={[styles.summary, { color: muted }]} numberOfLines={1}>
            {group.summary}
          </Text>
        ) : null}
        <Text style={[styles.chevron, { color: muted }]}>
          {expanded ? t('mobile.chat.tool.collapse') : t('mobile.chat.tool.expand')}
        </Text>
      </Pressable>
      {expanded
        ? group.cards.map((card) => <ToolCard key={card.id} card={card} />)
        : null}
    </RNView>
  );
}

export const SkillGroup = memo(SkillGroupImpl, (a, b) => {
  const x = a.group;
  const y = b.group;
  if (
    x.id !== y.id ||
    x.running !== y.running ||
    x.summary !== y.summary ||
    x.cards.length !== y.cards.length
  ) {
    return false;
  }
  return x.cards.every((card, i) => {
    const other = y.cards[i]!;
    return (
      card.id === other.id &&
      card.status === other.status &&
      card.description === other.description &&
      card.output === other.output &&
      card.error === other.error &&
      card.settled === other.settled
    );
  });
});

const styles = StyleSheet.create({
  wrap: {
    alignSelf: 'stretch',
    marginVertical: 2,
    gap: 2,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 4,
    paddingHorizontal: 2,
  },
  title: {
    fontSize: 13,
    fontWeight: '600',
  },
  running: {
    fontStyle: 'italic',
  },
  summary: {
    flex: 1,
    fontSize: 12,
    minWidth: 0,
  },
  chevron: {
    fontSize: 11,
  },
});
