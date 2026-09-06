/**
 * Minimal Cap PermissionCard for Expo — once / always / reject.
 */
import React, { memo, useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  View as RNView,
} from 'react-native';

import { Text, useThemeColor } from '@/components/Themed';
import {
  permissionDisplayToolName,
  permissionMetaString,
  type PermissionRequest,
  type PermissionResponse,
} from '@/lib/permissionApi';
import { t } from '@/lib/i18n';

export type PermissionCardProps = {
  permission: PermissionRequest;
  busy?: boolean;
  onRespond: (response: PermissionResponse) => void | Promise<void>;
};

function PermissionCardImpl({ permission, busy = false, onRespond }: PermissionCardProps) {
  const textColor = useThemeColor({}, 'text');
  const muted = useThemeColor({}, 'muted');
  const [localBusy, setLocalBusy] = useState(false);
  const responding = busy || localBusy;
  const toolName = permissionDisplayToolName(permission.permission || 'unknown');
  const command = permissionMetaString(permission.metadata, 'command', 'cmd', 'script');
  const filePath = permissionMetaString(
    permission.metadata,
    'path',
    'file_path',
    'filename',
    'filePath',
  );
  const url = permissionMetaString(permission.metadata, 'url', 'uri', 'endpoint');
  const cwd = permissionMetaString(
    permission.metadata,
    'cwd',
    'working_directory',
    'directory',
  );
  const description = permissionMetaString(permission.metadata, 'description');

  const respond = useCallback(
    async (response: PermissionResponse) => {
      if (responding) return;
      setLocalBusy(true);
      try {
        await onRespond(response);
      } finally {
        setLocalBusy(false);
      }
    },
    [onRespond, responding],
  );

  return (
    <RNView style={styles.wrap} accessibilityRole="summary">
      <RNView style={styles.titleRow}>
        <Text style={[styles.badge, { color: muted }]}>
          {t('mobile.chat.permission.required')}
        </Text>
        <Text style={[styles.tool, { color: muted }]} numberOfLines={1}>
          {toolName}
        </Text>
      </RNView>
      {description ? <Text style={[styles.meta, { color: muted }]}>{description}</Text> : null}
      {cwd ? (
        <Text style={[styles.meta, { color: muted }]} numberOfLines={2}>
          {t('mobile.chat.permission.cwd')}: {cwd}
        </Text>
      ) : null}
      {filePath ? (
        <Text style={[styles.code, { color: textColor }]} numberOfLines={3}>
          {filePath}
        </Text>
      ) : null}
      {url ? (
        <Text style={[styles.code, { color: textColor }]} numberOfLines={3}>
          {url}
        </Text>
      ) : null}
      {command ? (
        <ScrollView style={styles.commandScroll} nestedScrollEnabled>
          <Text style={[styles.code, { color: textColor }]} selectable>
            {command.length > 4000 ? `${command.slice(0, 4000)}…` : command}
          </Text>
        </ScrollView>
      ) : null}
      {permission.patterns.length > 0 ? (
        <RNView style={styles.patterns}>
          <Text style={[styles.meta, { color: muted }]}>
            {t('mobile.chat.permission.patterns')}
          </Text>
          {permission.patterns.slice(0, 8).map((pattern, index) => (
            <Text
              key={`${pattern}-${index}`}
              style={[styles.code, { color: textColor }]}
              numberOfLines={2}
            >
              {pattern}
            </Text>
          ))}
        </RNView>
      ) : null}
      <RNView style={styles.actions}>
        <Pressable
          style={[styles.btn, styles.btnAllow]}
          disabled={responding}
          onPress={() => void respond('once')}
          accessibilityRole="button"
          accessibilityLabel={t('mobile.chat.permission.allowOnce')}
        >
          <Text style={styles.btnAllowText}>{t('mobile.chat.permission.allowOnce')}</Text>
        </Pressable>
        <Pressable
          style={[styles.btn, styles.btnAlways]}
          disabled={responding}
          onPress={() => void respond('always')}
          accessibilityRole="button"
          accessibilityLabel={t('mobile.chat.permission.always')}
        >
          <Text style={styles.btnAllowText}>{t('mobile.chat.permission.always')}</Text>
        </Pressable>
        <Pressable
          style={[styles.btn, styles.btnDeny]}
          disabled={responding}
          onPress={() => void respond('reject')}
          accessibilityRole="button"
          accessibilityLabel={t('mobile.chat.permission.deny')}
        >
          <Text style={styles.btnDenyText}>{t('mobile.chat.permission.deny')}</Text>
        </Pressable>
      </RNView>
      {responding ? (
        <RNView style={styles.busyRow}>
          <ActivityIndicator size="small" />
        </RNView>
      ) : null}
    </RNView>
  );
}

export const PermissionCard = memo(PermissionCardImpl);

const styles = StyleSheet.create({
  wrap: {
    marginHorizontal: 12,
    marginBottom: 8,
    padding: 12,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(127,127,127,0.35)',
    backgroundColor: 'rgba(127,127,127,0.08)',
    gap: 6,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  badge: { fontSize: 12, fontWeight: '600' },
  tool: { fontSize: 12, fontWeight: '500', maxWidth: '48%' },
  meta: { fontSize: 12, lineHeight: 16 },
  code: { fontSize: 12, lineHeight: 16, fontFamily: 'Menlo' },
  commandScroll: { maxHeight: 120 },
  patterns: { gap: 2 },
  actions: { flexDirection: 'row', gap: 6, marginTop: 4 },
  btn: {
    flex: 1,
    minHeight: 36,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  btnAllow: { backgroundColor: 'rgba(34,197,94,0.18)' },
  btnAlways: { backgroundColor: 'rgba(34,197,94,0.28)' },
  btnDeny: { backgroundColor: 'rgba(239,68,68,0.16)' },
  btnAllowText: { fontSize: 12, fontWeight: '600', color: '#16a34a' },
  btnDenyText: { fontSize: 12, fontWeight: '600', color: '#dc2626' },
  busyRow: { alignItems: 'center', paddingTop: 4 },
});
