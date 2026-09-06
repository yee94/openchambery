import React, { useCallback, useMemo, useState } from 'react';
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  StyleSheet,
  TextInput,
  View as RNView,
} from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ComposerAutocompleteList } from '@/components/chat/ComposerAutocompleteList';
import { GlassComposerShell } from '@/components/chrome/GlassComposerShell';
import { Text, useThemeColor } from '@/components/Themed';
import { useColorScheme } from '@/components/useColorScheme';
import {
  acceptComposerAutocompleteRow,
  resolveComposerAutocompleteTrigger,
  type ComposerAutocompleteRow,
  type ComposerAutocompleteTrigger,
} from '@/lib/composerAutocomplete';
import { t } from '@/lib/i18n';
import {
  isHeicLike,
  type StagedPromptAttachment,
} from '@/lib/promptAttachmentUpload';
import { impactLight, impactMedium } from '@/lib/systemShell/haptics';

export type ChatComposerProps = {
  value: string;
  onChangeText: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  busy: boolean;
  disabled?: boolean;
  autocompleteRows?: ComposerAutocompleteRow[];
  autocompleteLoading?: boolean;
  onAutocompleteTriggerChange?: (trigger: ComposerAutocompleteTrigger | null) => void;
  attachments?: StagedPromptAttachment[];
  onAttachmentsChange?: (next: StagedPromptAttachment[]) => void;
};

let localAttachSeq = 0;
const nextAttachId = () => {
  localAttachSeq += 1;
  return `att_local_${Date.now().toString(36)}_${localAttachSeq}`;
};

/**
 * Text + Send/Stop + attach + slash/@/# autocomplete list.
 * No mic / TTS (will-not-port). Glass shell left to Track 8 — do not restyle.
 */
export function ChatComposer({
  value,
  onChangeText,
  onSend,
  onStop,
  busy,
  disabled,
  autocompleteRows = [],
  autocompleteLoading,
  onAutocompleteTriggerChange,
  attachments = [],
  onAttachmentsChange,
}: ChatComposerProps) {
  const insets = useSafeAreaInsets();
  const colorScheme = useColorScheme();
  const text = useThemeColor({}, 'text');
  const muted = useThemeColor({}, 'muted');
  const [selection, setSelection] = useState<{ start: number; end: number }>({
    start: value.length,
    end: value.length,
  });
  const [openTrigger, setOpenTrigger] = useState<ComposerAutocompleteTrigger | null>(null);

  const canSend =
    (value.trim().length > 0 || attachments.length > 0) && !disabled;

  const publishTrigger = useCallback(
    (nextText: string, cursor: number) => {
      const trigger = resolveComposerAutocompleteTrigger(nextText, cursor);
      setOpenTrigger(trigger);
      onAutocompleteTriggerChange?.(trigger);
    },
    [onAutocompleteTriggerChange],
  );

  const handleChangeText = useCallback(
    (next: string) => {
      onChangeText(next);
      const cursor = Math.min(selection.end, next.length);
      publishTrigger(next, cursor);
    },
    [onChangeText, publishTrigger, selection.end],
  );

  const handleSelectAutocomplete = useCallback(
    (row: ComposerAutocompleteRow) => {
      const accepted = acceptComposerAutocompleteRow(
        value,
        selection.end,
        openTrigger,
        row.insertText,
      );
      if (!accepted) return;
      onChangeText(accepted.text);
      setSelection({ start: accepted.caret, end: accepted.caret });
      setOpenTrigger(null);
      onAutocompleteTriggerChange?.(null);
      void impactLight();
    },
    [onAutocompleteTriggerChange, onChangeText, openTrigger, selection.end, value],
  );

  const stageFiles = useCallback(
    (files: StagedPromptAttachment[]) => {
      if (!onAttachmentsChange || files.length === 0) return;
      const heic = files.filter((file) => isHeicLike(file.mime, file.filename));
      if (heic.length > 0) {
        // Honest residual: Cap OpenChamberMedia.transcode is device-native;
        // Expo pickers may still yield HEIC — upload as-is when host accepts.
        Alert.alert(
          t('mobile.chat.attach.heicTitle'),
          t('mobile.chat.attach.heicBody'),
        );
      }
      onAttachmentsChange([...attachments, ...files]);
    },
    [attachments, onAttachmentsChange],
  );

  const pickImages = useCallback(async () => {
    if (!onAttachmentsChange) return;
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert(t('mobile.chat.attach.permissionDenied'));
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsMultipleSelection: true,
      quality: 1,
      // Prefer compatible representations when the platform supports it.
      preferredAssetRepresentationMode:
        ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
    });
    if (result.canceled) return;
    const staged = result.assets.flatMap((asset) => {
      const uri = asset.uri;
      if (!uri) return [];
      const filename =
        asset.fileName
        || uri.split('/').pop()
        || `image-${Date.now()}.jpg`;
      const mime = asset.mimeType || 'image/jpeg';
      return [
        {
          localId: nextAttachId(),
          filename,
          mime,
          uri,
          byteSize: typeof asset.fileSize === 'number' ? asset.fileSize : undefined,
        } satisfies StagedPromptAttachment,
      ];
    });
    stageFiles(staged);
  }, [onAttachmentsChange, stageFiles]);

  const pickDocuments = useCallback(async () => {
    if (!onAttachmentsChange) return;
    try {
      const result = await DocumentPicker.getDocumentAsync({
        multiple: true,
        copyToCacheDirectory: true,
      });
      if (result.canceled) return;
      const staged = result.assets.flatMap((asset) => {
        if (!asset.uri) return [];
        return [
          {
            localId: nextAttachId(),
            filename: asset.name || `file-${Date.now()}`,
            mime: asset.mimeType || 'application/octet-stream',
            uri: asset.uri,
            byteSize: typeof asset.size === 'number' ? asset.size : undefined,
          } satisfies StagedPromptAttachment,
        ];
      });
      stageFiles(staged);
    } catch {
      Alert.alert(t('mobile.chat.attach.pickerUnavailable'));
    }
  }, [onAttachmentsChange, stageFiles]);

  const openAttachMenu = useCallback(() => {
    if (!onAttachmentsChange || disabled) return;
    const options = [
      t('mobile.chat.attach.photos'),
      t('mobile.chat.attach.files'),
      t('mobile.chat.attach.cancel'),
    ];
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options,
          cancelButtonIndex: 2,
        },
        (index) => {
          if (index === 0) void pickImages();
          if (index === 1) void pickDocuments();
        },
      );
      return;
    }
    Alert.alert(t('mobile.chat.attach.title'), undefined, [
      { text: t('mobile.chat.attach.photos'), onPress: () => void pickImages() },
      { text: t('mobile.chat.attach.files'), onPress: () => void pickDocuments() },
      { text: t('mobile.chat.attach.cancel'), style: 'cancel' },
    ]);
  }, [disabled, onAttachmentsChange, pickDocuments, pickImages]);

  const showAutocomplete = openTrigger != null && (autocompleteLoading || autocompleteRows.length > 0);

  const attachmentChips = useMemo(
    () =>
      attachments.map((file) => (
        <RNView key={file.localId} style={styles.attachChip}>
          <Text style={[styles.attachName, { color: text }]} numberOfLines={1}>
            {file.filename}
          </Text>
          <Pressable
            onPress={() =>
              onAttachmentsChange?.(attachments.filter((item) => item.localId !== file.localId))
            }
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={t('mobile.chat.attach.removeAria')}
          >
            <Text style={{ color: muted }}>×</Text>
          </Pressable>
        </RNView>
      )),
    [attachments, muted, onAttachmentsChange, text],
  );

  return (
    <RNView
      pointerEvents="box-none"
      style={[
        styles.shell,
        {
          paddingBottom: Math.max(insets.bottom, 8),
        },
      ]}
    >
      {showAutocomplete ? (
        <ComposerAutocompleteList
          rows={autocompleteRows}
          loading={autocompleteLoading}
          onSelect={handleSelectAutocomplete}
        />
      ) : null}

      {attachments.length > 0 ? (
        <RNView style={styles.attachRow}>{attachmentChips}</RNView>
      ) : null}

      <GlassComposerShell colorScheme={colorScheme === 'dark' ? 'dark' : 'light'} style={styles.pill}>
        {onAttachmentsChange ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('mobile.chat.attach.title')}
            onPress={openAttachMenu}
            disabled={disabled}
            style={styles.attachButton}
          >
            <Text style={[styles.attachButtonLabel, { color: muted }]}>+</Text>
          </Pressable>
        ) : null}
        <TextInput
          value={value}
          onChangeText={handleChangeText}
          onSelectionChange={(event) => {
            const next = event.nativeEvent.selection;
            setSelection(next);
            publishTrigger(value, next.end);
          }}
          selection={selection}
          placeholder={t('mobile.chat.composer.placeholder')}
          placeholderTextColor={muted}
          style={[styles.input, { color: text }]}
          multiline
          editable={!disabled}
          accessibilityLabel={t('mobile.chat.composer.placeholder')}
        />
        {busy ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('mobile.chat.stop')}
            onPress={() => {
              void impactMedium();
              onStop();
            }}
            style={[styles.action, styles.stop]}
          >
            <Text style={styles.actionLabel}>{t('mobile.chat.stop')}</Text>
          </Pressable>
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('mobile.chat.send')}
            onPress={() => {
              if (!canSend) return;
              void impactLight();
              onSend();
            }}
            disabled={!canSend}
            style={[styles.action, styles.send, !canSend && styles.disabled]}
          >
            {disabled ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <Text style={styles.actionLabel}>{t('mobile.chat.send')}</Text>
            )}
          </Pressable>
        )}
      </GlassComposerShell>
    </RNView>
  );
}

const styles = StyleSheet.create({
  shell: {
    paddingHorizontal: 12,
    paddingTop: 8,
    backgroundColor: 'transparent',
  },
  pill: {
    minHeight: 48,
    borderRadius: 24,
    paddingLeft: 6,
    paddingRight: 6,
    paddingVertical: 6,
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
  },
  input: {
    flex: 1,
    maxHeight: 120,
    fontSize: 16,
    lineHeight: 22,
    paddingTop: 8,
    paddingBottom: 8,
  },
  action: {
    minWidth: 64,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  send: {
    backgroundColor: '#E87722',
  },
  stop: {
    backgroundColor: '#B42318',
  },
  disabled: {
    opacity: 0.45,
  },
  actionLabel: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 14,
  },
  attachButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  attachButtonLabel: {
    fontSize: 24,
    lineHeight: 28,
    fontWeight: '500',
  },
  attachRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginBottom: 6,
    paddingHorizontal: 2,
  },
  attachChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    maxWidth: '100%',
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: 'rgba(127,127,127,0.16)',
  },
  attachName: {
    fontSize: 12,
    maxWidth: 160,
  },
});
