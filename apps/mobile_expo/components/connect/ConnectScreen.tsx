import { Link } from 'expo-router';
import React, { useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Text, useThemeColor } from '@/components/Themed';
import { useColorScheme } from '@/components/useColorScheme';
import Colors from '@/constants/Colors';
import { useConnection } from '@/context/ConnectionContext';
import {
  connectionDisplayUrl,
  relayCandidateOf,
} from '@/lib/connectionCandidates';
import { t } from '@/lib/i18n';

/** Cap MobileConnectionWelcome: QR primary; manual collapsed when scan is available. */
export function ConnectScreen() {
  const insets = useSafeAreaInsets();
  const scheme = useColorScheme();
  const colors = Colors[scheme];
  const text = useThemeColor({}, 'text');
  const muted = useThemeColor({}, 'muted');
  const { controller, state } = useConnection();
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [label, setLabel] = useState('');
  const [pairingLink, setPairingLink] = useState('');
  const [password, setPassword] = useState('');
  const [manualOpen, setManualOpen] = useState(false);

  const pad = {
    paddingTop: insets.top + 28,
    paddingBottom: insets.bottom + 28,
    backgroundColor: colors.background,
  };

  if (state.phase === 'password' && state.pendingPassword) {
    return (
      <ScrollView
        contentContainerStyle={[styles.container, pad]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.centerStack}>
          <View style={[styles.hostChip, { backgroundColor: colors.elevated, borderColor: colors.border }]}>
            <View style={[styles.hostIcon, { backgroundColor: colors.secondary }]}>
              <Text style={{ color: text, fontSize: 16 }}>🔒</Text>
            </View>
            <View style={styles.hostMeta}>
              <Text style={[styles.hostLabel, { color: text }]} numberOfLines={1}>
                {state.pendingPassword.label}
              </Text>
              <Text style={[styles.hostHint, { color: muted }]} numberOfLines={1}>
                {t('mobile.connect.password.label')}
              </Text>
            </View>
          </View>
          <TextInput
            style={[
              styles.input,
              {
                color: text,
                backgroundColor: colors.elevated,
                borderColor: colors.border,
              },
            ]}
            value={password}
            onChangeText={setPassword}
            placeholder={t('mobile.connect.password.placeholder')}
            placeholderTextColor={muted}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
          />
          {state.error ? (
            <Text style={[styles.error, { color: colors.destructive }]}>{state.error}</Text>
          ) : null}
          <Pressable
            style={[
              styles.primaryButton,
              { backgroundColor: colors.tint },
              state.busy && styles.disabled,
            ]}
            disabled={state.busy}
            onPress={() => void controller.submitPassword(password)}
          >
            {state.busy ? (
              <ActivityIndicator color={colors.primaryForeground} />
            ) : (
              <Text style={[styles.primaryButtonText, { color: colors.primaryForeground }]}>
                {t('mobile.connect.unlockButton')}
              </Text>
            )}
          </Pressable>
          <Pressable style={styles.ghostButton} onPress={() => controller.cancelPassword()}>
            <Text style={[styles.ghostButtonText, { color: muted }]}>
              {t('mobile.connect.cancelPassword')}
            </Text>
          </Pressable>
        </View>
      </ScrollView>
    );
  }

  return (
    <ScrollView
      contentContainerStyle={[styles.container, pad]}
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.centerStack}>
        <View style={styles.hero}>
          <Image
            source={require('@/assets/images/icon.png')}
            style={styles.logo}
            accessibilityIgnoresInvertColors
          />
          <Text style={[styles.title, { color: text }]}>{t('mobile.connect.welcome.title')}</Text>
        </View>

        <Link href="/qr-scan" asChild>
          <Pressable
            style={[styles.primaryButton, { backgroundColor: colors.tint }, state.busy && styles.disabled]}
            disabled={state.busy}
          >
            <Text style={[styles.primaryButtonText, { color: colors.primaryForeground }]}>
              {state.busy ? t('mobile.connect.connecting') : t('mobile.connect.scanQr')}
            </Text>
          </Pressable>
        </Link>
        <Text style={[styles.scanHint, { color: muted }]}>{t('mobile.connect.welcome.scanHint')}</Text>

        {state.error && !manualOpen ? (
          <Text style={[styles.error, { color: colors.destructive }]}>{state.error}</Text>
        ) : null}

        {state.connections.length > 0 ? (
          <View style={styles.savedBlock}>
            <Text style={[styles.savedTitle, { color: muted }]}>
              {t('mobile.connect.saved.title')}
            </Text>
            <View
              style={[
                styles.savedCard,
                { backgroundColor: colors.elevated, borderColor: colors.border },
              ]}
            >
              {state.connections.map((connection, index) => {
                const hasRelay = Boolean(relayCandidateOf(connection.candidates));
                const last = index === state.connections.length - 1;
                return (
                  <View
                    key={connection.id}
                    style={[
                      styles.savedRow,
                      !last && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
                    ]}
                  >
                    <Pressable
                      style={styles.savedMain}
                      onPress={() => void controller.connectSaved(connection.id)}
                    >
                      <View style={[styles.hostIcon, { backgroundColor: colors.secondary }]}>
                        <Text style={{ color: text, fontSize: 14 }}>⌂</Text>
                      </View>
                      <View style={styles.hostMeta}>
                        <Text style={[styles.hostLabel, { color: text }]} numberOfLines={1}>
                          {connection.label}
                        </Text>
                        <Text style={[styles.hostHint, { color: muted }]} numberOfLines={1}>
                          {hasRelay
                            ? t('mobile.connect.relay.badge')
                            : t('mobile.instances.status.saved')}
                        </Text>
                        {!hasRelay ? (
                          <Text style={[styles.savedUrl, { color: muted }]} numberOfLines={1}>
                            {connectionDisplayUrl(connection.candidates)}
                          </Text>
                        ) : null}
                      </View>
                    </Pressable>
                    <Pressable onPress={() => void controller.removeConnection(connection.id)} hitSlop={8}>
                      <Text style={{ color: colors.destructive, fontSize: 13 }}>
                        {t('mobile.connect.delete')}
                      </Text>
                    </Pressable>
                  </View>
                );
              })}
            </View>
          </View>
        ) : null}

        <Pressable
          onPress={() => setManualOpen((v) => !v)}
          style={styles.toggle}
          accessibilityRole="button"
          accessibilityState={{ expanded: manualOpen }}
        >
          <Text style={[styles.toggleText, { color: muted }]}>
            {t('mobile.connect.manual.toggle')}
            {manualOpen ? ' ▴' : ' ▾'}
          </Text>
        </Pressable>

        {manualOpen ? (
          <View style={styles.manualBlock}>
            <TextInput
              style={[
                styles.input,
                { color: text, backgroundColor: colors.elevated, borderColor: colors.border },
              ]}
              value={pairingLink}
              onChangeText={setPairingLink}
              placeholder={t('mobile.connect.link.placeholder')}
              placeholderTextColor={muted}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Text style={[styles.dividerLabel, { color: muted }]}>
              {t('mobile.connect.address.divider')}
            </Text>
            <TextInput
              style={[
                styles.input,
                { color: text, backgroundColor: colors.elevated, borderColor: colors.border },
              ]}
              value={url}
              onChangeText={setUrl}
              placeholder={t('mobile.connect.url.placeholder')}
              placeholderTextColor={muted}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
            />
            <TextInput
              style={[
                styles.input,
                { color: text, backgroundColor: colors.elevated, borderColor: colors.border },
              ]}
              value={label}
              onChangeText={setLabel}
              placeholder={t('mobile.connect.label.optional')}
              placeholderTextColor={muted}
              autoCapitalize="none"
            />
            <TextInput
              style={[
                styles.input,
                { color: text, backgroundColor: colors.elevated, borderColor: colors.border },
              ]}
              value={token}
              onChangeText={setToken}
              placeholder={t('mobile.connect.token.placeholder')}
              placeholderTextColor={muted}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
            />
            <Text style={[styles.tokenHint, { color: muted }]}>{t('mobile.connect.token.hint')}</Text>

            {state.error ? (
              <Text style={[styles.error, { color: colors.destructive }]}>{state.error}</Text>
            ) : null}

            <Pressable
              style={[
                styles.outlineButton,
                { borderColor: colors.border },
                state.busy && styles.disabled,
              ]}
              disabled={state.busy}
              onPress={() => {
                if (pairingLink.trim()) {
                  void controller.redeemPairingLink(pairingLink.trim());
                  return;
                }
                void controller.connectWithUrl({
                  url: url.trim(),
                  clientToken: token.trim() || undefined,
                  label: label.trim() || undefined,
                });
              }}
            >
              {state.busy ? (
                <ActivityIndicator color={colors.tint} />
              ) : (
                <Text style={[styles.outlineButtonText, { color: text }]}>
                  {t('mobile.connect.connectButton')}
                </Text>
              )}
            </Pressable>
          </View>
        ) : null}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
    paddingHorizontal: 24,
  },
  centerStack: {
    width: '100%',
    maxWidth: 360,
    alignSelf: 'center',
    alignItems: 'stretch',
    gap: 12,
    paddingVertical: 32,
  },
  hero: {
    alignItems: 'center',
    gap: 20,
    marginBottom: 12,
  },
  logo: {
    width: 72,
    height: 72,
    borderRadius: 16,
  },
  title: {
    fontSize: 26,
    fontWeight: '700',
    letterSpacing: -0.4,
    textAlign: 'center',
  },
  scanHint: {
    fontSize: 13,
    lineHeight: 18,
    textAlign: 'center',
    paddingHorizontal: 8,
    marginBottom: 4,
  },
  hostChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  hostIcon: {
    width: 36,
    height: 36,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  hostMeta: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  hostLabel: {
    fontSize: 15,
    fontWeight: '600',
  },
  hostHint: {
    fontSize: 12,
  },
  input: {
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 16,
    minHeight: 48,
  },
  primaryButton: {
    borderRadius: 16,
    minHeight: 48,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryButtonText: {
    fontSize: 16,
    fontWeight: '600',
  },
  outlineButton: {
    borderRadius: 16,
    minHeight: 48,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    marginTop: 4,
  },
  outlineButtonText: {
    fontSize: 16,
    fontWeight: '600',
  },
  ghostButton: {
    paddingVertical: 12,
    alignItems: 'center',
  },
  ghostButtonText: {
    fontSize: 15,
  },
  toggle: {
    alignSelf: 'center',
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  toggleText: {
    fontSize: 13,
    fontWeight: '500',
  },
  manualBlock: {
    gap: 10,
    paddingTop: 4,
  },
  dividerLabel: {
    fontSize: 11,
    textAlign: 'center',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginVertical: 4,
  },
  tokenHint: {
    fontSize: 11,
    textAlign: 'center',
    lineHeight: 15,
  },
  error: {
    fontSize: 13,
    textAlign: 'center',
  },
  disabled: {
    opacity: 0.6,
  },
  savedBlock: {
    gap: 10,
    marginTop: 8,
  },
  savedTitle: {
    fontSize: 11,
    fontWeight: '600',
    textAlign: 'center',
    textTransform: 'uppercase',
    letterSpacing: 1.4,
  },
  savedCard: {
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  savedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 56,
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 12,
  },
  savedMain: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minWidth: 0,
  },
  savedUrl: {
    fontSize: 11,
    marginTop: 1,
  },
});
