import React, { memo, useEffect, useState } from 'react';
import { Pressable, StyleSheet, View as RNView } from 'react-native';

import { ChatMarkdown } from '@/components/chat/ChatMarkdown';
import { Text, useThemeColor } from '@/components/Themed';
import { useColorScheme } from '@/components/useColorScheme';
import type { ReasoningModel } from '@/lib/toolCards';
import { t } from '@/lib/i18n';

export type ReasoningDisclosureProps = {
  reasoning: ReasoningModel;
};

function ReasoningDisclosureImpl({ reasoning }: ReasoningDisclosureProps) {
  const scheme = useColorScheme();
  const muted = useThemeColor({}, 'muted');
  const tint = useThemeColor({}, 'tint');
  const [expanded, setExpanded] = useState(reasoning.streaming);
  const [userToggled, setUserToggled] = useState(false);

  useEffect(() => {
    if (userToggled) return;
    // Cap: default collapsed; stream auto-expands.
    setExpanded(reasoning.streaming);
  }, [reasoning.streaming, userToggled]);

  const summary =
    reasoning.summary ||
    (reasoning.streaming ? t('mobile.chat.reasoning.thinking') : t('mobile.chat.reasoning.thought'));

  const codeBg = scheme === 'dark' ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)';

  return (
    <RNView style={styles.wrap}>
      <Pressable
        onPress={() => {
          setUserToggled(true);
          setExpanded((v) => !v);
        }}
        style={styles.header}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={t('mobile.chat.reasoning.toggleAria')}
      >
        <Text style={[styles.label, { color: muted }]} numberOfLines={1}>
          {expanded ? t('mobile.chat.reasoning.expanded') : summary}
        </Text>
      </Pressable>
      {expanded && reasoning.text ? (
        <RNView style={styles.body}>
          <ChatMarkdown
            content={reasoning.text}
            streaming={reasoning.streaming}
            variant="reasoning"
            color={muted}
            linkColor={tint}
            codeBackground={codeBg}
            codeColor={muted}
          />
        </RNView>
      ) : null}
    </RNView>
  );
}

export const ReasoningDisclosure = memo(ReasoningDisclosureImpl, (a, b) => {
  return (
    a.reasoning.id === b.reasoning.id &&
    a.reasoning.text === b.reasoning.text &&
    a.reasoning.summary === b.reasoning.summary &&
    a.reasoning.streaming === b.reasoning.streaming
  );
});

const styles = StyleSheet.create({
  wrap: {
    alignSelf: 'stretch',
    marginVertical: 2,
  },
  header: {
    paddingVertical: 4,
    paddingHorizontal: 2,
  },
  label: {
    fontSize: 12,
    fontStyle: 'italic',
  },
  body: {
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderLeftWidth: 2,
    borderLeftColor: 'rgba(127,127,127,0.4)',
    marginLeft: 2,
    opacity: 0.85,
  },
});
