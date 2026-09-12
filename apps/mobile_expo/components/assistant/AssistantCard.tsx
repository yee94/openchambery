import React, { useRef, useState } from 'react';
import {
  ActionSheetIOS,
  Alert,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  View as RNView,
} from 'react-native';

import { Text } from '@/components/Themed';
import { t } from '@/lib/i18n';
import { getAssistantPresentation } from '@/lib/assistantPresentation';
import type { AssistantDTO } from '@/lib/assistantsApi';
import Colors from '@/constants/Colors';

type Props = {
  assistant: AssistantDTO;
  dark: boolean;
  muted: string;
  surface: string;
  opening: boolean;
  onOpen: () => void;
  onEdit: () => void;
  onDelete: () => void;
};

const LONG_PRESS_MS = 420;
/** Cap --oc-mobile-surface-radius / assistant card shell. */
const SURFACE_RADIUS = 24;
const AVATAR = 40;

export function AssistantCard({
  assistant,
  dark,
  muted,
  surface,
  opening,
  onOpen,
  onEdit,
  onDelete,
}: Props) {
  const presentation = getAssistantPresentation(assistant.name);
  const displayName = presentation.displayName || assistant.name;
  const modeLabel =
    assistant.mode === 'stateless'
      ? t('assistants.mode.stateless')
      : t('assistants.mode.continuous');
  const summary =
    assistant.defaultPrompt.trim() ||
    (assistant.mode === 'stateless'
      ? t('assistants.conversation.statelessHint')
      : t('assistants.conversation.continuousHint'));
  const [menuOpen, setMenuOpen] = useState(false);
  const longPressTriggered = useRef(false);

  const openMenu = () => {
    longPressTriggered.current = true;
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: [
            t('assistants.actions.cancel'),
            t('assistants.menu.edit'),
            t('assistants.settings.delete'),
          ],
          destructiveButtonIndex: 2,
          cancelButtonIndex: 0,
        },
        (index) => {
          longPressTriggered.current = false;
          if (index === 1) onEdit();
          if (index === 2) onDelete();
        },
      );
      return;
    }
    if (Platform.OS === 'android') {
      Alert.alert(displayName, undefined, [
        { text: t('assistants.menu.edit'), onPress: onEdit },
        {
          text: t('assistants.settings.delete'),
          style: 'destructive',
          onPress: onDelete,
        },
        { text: t('assistants.actions.cancel'), style: 'cancel' },
      ]);
      longPressTriggered.current = false;
      return;
    }
    setMenuOpen(true);
  };

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={displayName}
        disabled={opening}
        onPress={() => {
          if (longPressTriggered.current || menuOpen) return;
          onOpen();
        }}
        onLongPress={openMenu}
        delayLongPress={LONG_PRESS_MS}
        style={({ pressed }) => [
          styles.card,
          {
            backgroundColor: surface,
            opacity: assistant.enabled ? (pressed || opening ? 0.85 : 1) : 0.65,
          },
        ]}
      >
        <RNView
          style={[
            styles.avatar,
            presentation.avatarEmoji ? styles.avatarEmoji : styles.avatarVisual,
            { backgroundColor: dark ? 'rgba(255,255,255,0.08)' : 'rgba(24,24,27,0.06)' },
          ]}
        >
          <Text style={styles.avatarText}>
            {presentation.avatarEmoji ?? displayName.slice(0, 1).toUpperCase()}
          </Text>
        </RNView>
        <RNView style={styles.content}>
          <RNView style={styles.header}>
            <Text style={styles.name} numberOfLines={1}>
              {displayName}
            </Text>
            <Text style={[styles.mode, { color: muted }]}>{modeLabel}</Text>
          </RNView>
          <Text style={[styles.summary, { color: muted }]} numberOfLines={2}>
            {summary}
          </Text>
        </RNView>
      </Pressable>

      <Modal visible={menuOpen} transparent animationType="fade" onRequestClose={() => setMenuOpen(false)}>
        <Pressable
          style={styles.menuBackdrop}
          onPress={() => {
            setMenuOpen(false);
            longPressTriggered.current = false;
          }}
        >
          <Pressable
            style={[styles.menu, { backgroundColor: dark ? Colors.dark.card : Colors.light.card }]}
            onPress={(e) => e.stopPropagation?.()}
          >
            <Pressable
              style={styles.menuItem}
              onPress={() => {
                setMenuOpen(false);
                longPressTriggered.current = false;
                onEdit();
              }}
            >
              <Text style={styles.menuLabel}>{t('assistants.menu.edit')}</Text>
            </Pressable>
            <Pressable
              style={styles.menuItem}
              onPress={() => {
                setMenuOpen(false);
                longPressTriggered.current = false;
                onDelete();
              }}
            >
              <Text style={[styles.menuLabel, styles.menuDestructive]}>
                {t('assistants.settings.delete')}
              </Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    borderRadius: SURFACE_RADIUS,
    paddingHorizontal: 16,
    paddingVertical: 16,
    minHeight: 112,
    shadowColor: '#000',
    shadowOpacity: 0.06,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
  },
  avatar: {
    width: AVATAR,
    height: AVATAR,
    borderRadius: AVATAR / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarEmoji: {},
  avatarVisual: {},
  avatarText: {
    fontSize: 18,
    fontWeight: '600',
  },
  content: {
    flex: 1,
    minWidth: 0,
    gap: 6,
    paddingTop: 2,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  name: {
    flex: 1,
    fontSize: 16,
    fontWeight: '600',
    letterSpacing: -0.2,
  },
  mode: {
    fontSize: 12,
    fontWeight: '500',
  },
  summary: {
    fontSize: 13,
    lineHeight: 18,
  },
  menuBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
    justifyContent: 'center',
    paddingHorizontal: 40,
  },
  menu: {
    borderRadius: 14,
    overflow: 'hidden',
  },
  menuItem: {
    minHeight: 48,
    paddingHorizontal: 16,
    justifyContent: 'center',
  },
  menuLabel: {
    fontSize: 16,
  },
  menuDestructive: {
    color: '#dc2626',
  },
});
