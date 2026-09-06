import { Link } from 'expo-router';
import React, { useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useConnection } from '@/context/ConnectionContext';
import {
  connectionDisplayUrl,
  relayCandidateOf,
} from '@/lib/connectionCandidates';
import { t } from '@/lib/i18n';

export function ConnectScreen() {
  const insets = useSafeAreaInsets();
  const { controller, state } = useConnection();
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [label, setLabel] = useState('');
  const [pairingLink, setPairingLink] = useState('');
  const [password, setPassword] = useState('');
  const [manualOpen, setManualOpen] = useState(true);

  if (state.phase === 'password' && state.pendingPassword) {
    return (
      <ScrollView
        contentContainerStyle={[styles.container, { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 }]}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.title}>{state.pendingPassword.label}</Text>
        <Text style={styles.description}>{t('mobile.connect.password.label')}</Text>
        <TextInput
          style={styles.input}
          value={password}
          onChangeText={setPassword}
          placeholder={t('mobile.connect.password.placeholder')}
          placeholderTextColor="#888"
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
        />
        {state.error ? <Text style={styles.error}>{state.error}</Text> : null}
        <Pressable
          style={[styles.primaryButton, state.busy && styles.disabled]}
          disabled={state.busy}
          onPress={() => void controller.submitPassword(password)}
        >
          {state.busy ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.primaryButtonText}>{t('mobile.connect.unlockButton')}</Text>
          )}
        </Pressable>
        <Pressable style={styles.secondaryButton} onPress={() => controller.cancelPassword()}>
          <Text style={styles.secondaryButtonText}>{t('mobile.connect.cancelPassword')}</Text>
        </Pressable>
      </ScrollView>
    );
  }

  return (
    <ScrollView
      contentContainerStyle={[styles.container, { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 }]}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={styles.title}>{t('mobile.connect.welcome.title')}</Text>
      <Text style={styles.description}>{t('mobile.connect.welcome.description')}</Text>
      <Text style={styles.hint}>{t('mobile.connect.welcome.scanHint')}</Text>

      <Link href="/qr-scan" asChild>
        <Pressable style={styles.primaryButton}>
          <Text style={styles.primaryButtonText}>{t('mobile.connect.scanQr')}</Text>
        </Pressable>
      </Link>

      <Pressable onPress={() => setManualOpen((v) => !v)} style={styles.toggle}>
        <Text style={styles.toggleText}>{t('mobile.connect.manual.toggle')}</Text>
      </Pressable>

      {manualOpen ? (
        <View style={styles.card}>
          <Text style={styles.label}>{t('mobile.connect.url.label')}</Text>
          <TextInput
            style={styles.input}
            value={url}
            onChangeText={setUrl}
            placeholder={t('mobile.connect.url.placeholder')}
            placeholderTextColor="#888"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />
          <Text style={styles.label}>{t('mobile.connect.label.optional')}</Text>
          <TextInput
            style={styles.input}
            value={label}
            onChangeText={setLabel}
            placeholderTextColor="#888"
            autoCapitalize="none"
          />
          <Text style={styles.label}>{t('mobile.connect.token.label')}</Text>
          <TextInput
            style={styles.input}
            value={token}
            onChangeText={setToken}
            placeholder={t('mobile.connect.token.placeholder')}
            placeholderTextColor="#888"
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
          />
          <Text style={styles.hint}>{t('mobile.connect.token.hint')}</Text>

          <Text style={[styles.label, styles.divider]}>{t('mobile.connect.link.divider')}</Text>
          <TextInput
            style={styles.input}
            value={pairingLink}
            onChangeText={setPairingLink}
            placeholder={t('mobile.connect.link.placeholder')}
            placeholderTextColor="#888"
            autoCapitalize="none"
            autoCorrect={false}
          />

          {state.error ? <Text style={styles.error}>{state.error}</Text> : null}

          <Pressable
            style={[styles.primaryButton, state.busy && styles.disabled]}
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
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.primaryButtonText}>{t('mobile.connect.connectButton')}</Text>
            )}
          </Pressable>
        </View>
      ) : null}

      <Text style={[styles.label, styles.section]}>{t('mobile.connect.saved.title')}</Text>
      {state.connections.length === 0 ? (
        <Text style={styles.hint}>{t('mobile.connect.saved.empty')}</Text>
      ) : (
        state.connections.map((connection) => {
          const hasRelay = Boolean(relayCandidateOf(connection.candidates));
          return (
            <View key={connection.id} style={styles.savedRow}>
              <Pressable
                style={styles.savedMain}
                onPress={() => void controller.connectSaved(connection.id)}
              >
                <Text style={styles.savedLabel}>{connection.label}</Text>
                <Text style={styles.savedUrl}>{connectionDisplayUrl(connection.candidates)}</Text>
                {hasRelay ? <Text style={styles.relayBadge}>{t('mobile.connect.relay.badge')}</Text> : null}
              </Pressable>
              <Pressable onPress={() => void controller.removeConnection(connection.id)}>
                <Text style={styles.delete}>{t('mobile.connect.delete')}</Text>
              </Pressable>
            </View>
          );
        })
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 20,
    backgroundColor: '#111',
    flexGrow: 1,
  },
  title: {
    color: '#fff',
    fontSize: 28,
    fontWeight: '700',
    marginBottom: 8,
  },
  description: {
    color: '#ccc',
    fontSize: 16,
    marginBottom: 8,
  },
  hint: {
    color: '#888',
    fontSize: 13,
    marginBottom: 12,
  },
  card: {
    backgroundColor: '#1c1c1e',
    borderRadius: 16,
    padding: 16,
    marginTop: 8,
  },
  label: {
    color: '#ddd',
    fontSize: 13,
    marginBottom: 6,
    marginTop: 8,
  },
  input: {
    backgroundColor: '#2c2c2e',
    color: '#fff',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
  },
  primaryButton: {
    backgroundColor: '#E07A3D',
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 16,
  },
  primaryButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  secondaryButton: {
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 8,
  },
  secondaryButtonText: {
    color: '#E07A3D',
    fontSize: 15,
  },
  toggle: {
    marginTop: 20,
    marginBottom: 4,
  },
  toggleText: {
    color: '#E07A3D',
    fontSize: 15,
    fontWeight: '600',
  },
  error: {
    color: '#ff6b6b',
    marginTop: 10,
  },
  disabled: {
    opacity: 0.6,
  },
  divider: {
    marginTop: 16,
  },
  section: {
    marginTop: 28,
    fontSize: 15,
    fontWeight: '600',
  },
  savedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1c1c1e',
    borderRadius: 14,
    padding: 14,
    marginTop: 8,
    gap: 12,
  },
  savedMain: {
    flex: 1,
  },
  savedLabel: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  savedUrl: {
    color: '#999',
    fontSize: 12,
    marginTop: 2,
  },
  relayBadge: {
    color: '#E07A3D',
    fontSize: 11,
    marginTop: 4,
  },
  delete: {
    color: '#ff6b6b',
    fontSize: 13,
  },
});
