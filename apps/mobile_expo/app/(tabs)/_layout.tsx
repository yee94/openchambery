import { SymbolView } from 'expo-symbols';
import { Tabs } from 'expo-router';
import React from 'react';
import {
  Pressable,
  StyleSheet,
  type GestureResponderEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { useColorScheme } from '@/components/useColorScheme';
import Colors from '@/constants/Colors';
import { t } from '@/lib/i18n';

type DockTabButtonProps = {
  wash: string;
  children: React.ReactNode;
  onPress?: ((event: GestureResponderEvent) => void) | null;
  onLongPress?: ((event: GestureResponderEvent) => void) | null;
  accessibilityRole?: 'button' | 'tab' | string;
  accessibilityState?: { selected?: boolean; disabled?: boolean };
  accessibilityLabel?: string;
  testID?: string;
  style?: StyleProp<ViewStyle>;
};

/**
 * Four dock roots only. Chat is a pushed stack route (`/chat/[sessionId]`),
 * not a tab. Native iOS UITabBar / UIGlassEffect is owned by Expo 负责人 later.
 * Selected wash covers the full tab slot (Cap MobileTabBar contract).
 */
function DockTabButton({
  wash,
  children,
  onPress,
  onLongPress,
  accessibilityRole,
  accessibilityState,
  accessibilityLabel,
  testID,
  style,
}: DockTabButtonProps) {
  const selected = accessibilityState?.selected ?? false;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      accessibilityLabel={accessibilityLabel}
      testID={testID}
      onPress={onPress}
      onLongPress={onLongPress}
      style={[styles.tabSlot, style, selected ? { backgroundColor: wash } : null]}
    >
      {children}
    </Pressable>
  );
}

export default function TabLayout() {
  const colorScheme = useColorScheme();
  const colors = Colors[colorScheme];
  const wash =
    colorScheme === 'dark' ? 'rgba(255,255,255,0.12)' : 'rgba(24,24,27,0.08)';

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: colors.tint,
        tabBarInactiveTintColor: colors.tabIconDefault,
        headerShown: false,
        tabBarStyle: {
          backgroundColor:
            colorScheme === 'dark' ? 'rgba(24,24,27,0.92)' : 'rgba(255,255,255,0.92)',
          borderTopColor:
            colorScheme === 'dark' ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)',
          height: 64,
          paddingBottom: 6,
          paddingTop: 4,
        },
        tabBarLabelStyle: {
          fontSize: 11,
          fontWeight: '600',
          marginTop: 2,
        },
        tabBarItemStyle: {
          borderRadius: 14,
          marginHorizontal: 2,
          marginVertical: 4,
          overflow: 'hidden',
        },
        tabBarButton: (props) => (
          <DockTabButton
            wash={wash}
            onPress={props.onPress}
            onLongPress={props.onLongPress}
            accessibilityRole={props.accessibilityRole}
            accessibilityState={props.accessibilityState}
            accessibilityLabel={props.accessibilityLabel}
            testID={props.testID}
            style={props.style as StyleProp<ViewStyle>}
          >
            {props.children}
          </DockTabButton>
        ),
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: t('mobile.tabs.projects'),
          tabBarIcon: ({ color }) => (
            <SymbolView
              name={{ ios: 'folder', android: 'folder', web: 'folder' }}
              tintColor={color}
              size={23}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="assistant"
        options={{
          title: t('mobile.tabs.assistant'),
          tabBarIcon: ({ color }) => (
            <SymbolView
              name={{ ios: 'sparkles', android: 'auto_awesome', web: 'auto_awesome' }}
              tintColor={color}
              size={23}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="scheduled"
        options={{
          title: t('mobile.tabs.scheduled'),
          tabBarIcon: ({ color }) => (
            <SymbolView
              name={{ ios: 'calendar', android: 'calendar_month', web: 'calendar_month' }}
              tintColor={color}
              size={23}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: t('mobile.tabs.settings'),
          tabBarIcon: ({ color }) => (
            <SymbolView
              name={{ ios: 'gearshape', android: 'settings', web: 'settings' }}
              tintColor={color}
              size={23}
            />
          ),
        }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  tabSlot: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 14,
    overflow: 'hidden',
  },
});
