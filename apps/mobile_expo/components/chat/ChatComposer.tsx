import React, { useCallback, useEffect, useMemo, useState } from 'react';
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
import { NativeComposerTextView } from 'openchamber-system-shell';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ComposerAutocompleteList } from '@/components/chat/ComposerAutocompleteList';
import { ScrollToBottomDisc } from '@/components/chat/ScrollToBottomDisc';
import { GlassComposerShell } from '@/components/chrome/GlassComposerShell';
import { GlassDisc } from '@/components/chrome/GlassDisc';
import { Text, useThemeColor } from '@/components/Themed';
import { useColorScheme } from '@/components/useColorScheme';
import {
  acceptComposerAutocompleteRow,
  resolveComposerAutocompleteTrigger,
  type ComposerAutocompleteRow,
  type ComposerAutocompleteTrigger,
} from '@/lib/composerAutocomplete';
import {
  composeCollapsedPillHeight,
  nextRestOccupancyHeight,
  resolveComposerOccupancyHeight,
} from '@/lib/composerOccupancy';
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
  /** Collapsed-pill occupancy only — expand/autocomplete must not raise accessories. */
  onOccupancyHeightChange?: (height: number) => void;
  /** Cap liquid-glass arrow.down — excluded from occupancy. */
  showScrollToBottom?: boolean;
  onScrollToBottom?: () => void;
};

let localAttachSeq = 0;
const nextAttachId = () => {
  localAttachSeq += 1;
  return `att_local_${Date.now().toString(36)}_${localAttachSeq}`;
};

/**
 * Cap circular +/-/stop discs inside GlassComposerShell.
 * No mic / TTS (will-not-port).
 * iOS: UITextView owns IME via NativeComposerTextView; GlassComposerShell keeps chrome.
 * Android: RN TextInput in solid/Material pill (honest degrade, not fake glass).
 * Autocomplete / scroll-to-bottom stay above the card — never inside UIGlassEffect contentView,
 * and never raise published occupancy (collapsed pill only).
 */
const COLLAPSED_LINE_HEIGHT = 40;
const PILL_VERTICAL_PADDING = 12;

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
  onOccupancyHeightChange,
  showScrollToBottom,
  onScrollToBottom,
}: ChatComposerProps) {
  const insets = useSafeAreaInsets();
  const colorScheme = useColorScheme();
  const dark = colorScheme === 'dark';
  const text = useThemeColor({}, 'text');
  const muted = useThemeColor({}, 'muted');
  const background = useThemeColor({}, 'background');
  const [selection, setSelection] = useState<{ start: number; end: number }>({
    start: value.length,
    end: value.length,
  });
  const [openTrigger, setOpenTrigger] = useState<ComposerAutocompleteTrigger | null>(null);
  const [focused, setFocused] = useState(false);
  const [inputHeight, setInputHeight] = useState(COLLAPSED_LINE_HEIGHT);
  const [lastRestOccupancy, setLastRestOccupancy] = useState<number | null>(null);

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

  const publishOccupancy = useCallback(
    (collapsedLineHeight: number, expanded: boolean) => {
      const pill = composeCollapsedPillHeight({
        collapsedLineHeight,
        pillVerticalPadding: PILL_VERTICAL_PADDING,
      });
      const nextRest = nextRestOccupancyHeight(pill, expanded, lastRestOccupancy);
      if (!expanded) {
        setLastRestOccupancy(nextRest);
      }
      const published = resolveComposerOccupancyHeight({
        collapsedPillHeight: pill,
        contentHeight: inputHeight,
        expanded,
        lastRestHeight: nextRest,
        autocompleteOpen: openTrigger != null,
        scrollToBottomVisible: Boolean(showScrollToBottom),
      });
      onOccupancyHeightChange?.(published);
    },
    [inputHeight, lastRestOccupancy, onOccupancyHeightChange, openTrigger, showScrollToBottom],
  );

  useEffect(() => {
    publishOccupancy(COLLAPSED_LINE_HEIGHT, focused);
    // Seed accessories with collapsed occupancy on mount / contract changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- focused handled by native focus/blur
  }, [publishOccupancy]);

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
      {/* Autocomplete + attachments overlay above the card — never inside glass contentView. */}
      <RNView pointerEvents="box-none" style={styles.overlayRail}>
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
      </RNView>

      {/* Scroll-to-bottom GlassDisc — excluded from published occupancy. */}
      {showScrollToBottom && onScrollToBottom ? (
        <RNView pointerEvents="box-none" style={styles.scrollSlot}>
          <ScrollToBottomDisc visible onPress={onScrollToBottom} />
        </RNView>
      ) : null}

      <GlassComposerShell
        colorScheme={dark ? 'dark' : 'light'}
        style={styles.pill}
      >
        {onAttachmentsChange ? (
          <GlassDisc
            colorScheme={dark ? 'dark' : 'light'}
            accessibilityLabel={t('mobile.chat.attach.title')}
            onPress={openAttachMenu}
            disabled={disabled}
            style={styles.attachDisc}
          >
            <Text style={[styles.attachGlyph, { color: muted }]}>+</Text>
          </GlassDisc>
        ) : null}
        {Platform.OS === 'ios' ? (
          <NativeComposerTextView
            value={value}
            placeholder={t('mobile.chat.composer.placeholder')}
            placeholderTextColor={muted}
            textColor={text}
            editable={!disabled}
            collapsedLineHeight={COLLAPSED_LINE_HEIGHT}
            maxContentHeight={120}
            fontSize={16}
            style={[styles.nativeInput, { height: inputHeight }]}
            onChangeText={(event) => {
              const { text: next, selectionStart, selectionEnd } = event.nativeEvent;
              setSelection({ start: selectionStart, end: selectionEnd });
              handleChangeText(next);
            }}
            onSelectionChange={(event) => {
              const next = event.nativeEvent;
              setSelection({ start: next.start, end: next.end });
              publishTrigger(value, next.end);
            }}
            onFocus={() => {
              setFocused(true);
              publishOccupancy(COLLAPSED_LINE_HEIGHT, true);
            }}
            onBlur={() => {
              setFocused(false);
              publishOccupancy(COLLAPSED_LINE_HEIGHT, false);
            }}
            onCollapsedHeightChange={(event) => {
              publishOccupancy(event.nativeEvent.height, focused);
            }}
            onContentSizeChange={(event) => {
              setInputHeight(event.nativeEvent.height);
              // Occupancy stays collapsed even when content grows.
              publishOccupancy(COLLAPSED_LINE_HEIGHT, focused);
            }}
          />
        ) : (
          <TextInput
            value={value}
            onChangeText={handleChangeText}
            onSelectionChange={(event) => {
              const next = event.nativeEvent.selection;
              setSelection(next);
              publishTrigger(value, next.end);
            }}
            onFocus={() => {
              setFocused(true);
              publishOccupancy(COLLAPSED_LINE_HEIGHT, true);
            }}
            onBlur={() => {
              setFocused(false);
              publishOccupancy(COLLAPSED_LINE_HEIGHT, false);
            }}
            onContentSizeChange={(event) => {
              const next = Math.min(
                Math.max(event.nativeEvent.contentSize.height, COLLAPSED_LINE_HEIGHT),
                120,
              );
              setInputHeight(next);
              publishOccupancy(COLLAPSED_LINE_HEIGHT, focused);
            }}
            selection={selection}
            placeholder={t('mobile.chat.composer.placeholder')}
            placeholderTextColor={muted}
            style={[styles.input, { color: text, height: Math.max(inputHeight, COLLAPSED_LINE_HEIGHT) }]}
            multiline
            editable={!disabled}
            accessibilityLabel={t('mobile.chat.composer.placeholder')}
          />
        )}
        {busy ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('mobile.chat.stop')}
            onPress={() => {
              void impactMedium();
              onStop();
            }}
            style={styles.actionHit}
          >
            <RNView style={[styles.actionCircle, { backgroundColor: text }]}>
              <RNView style={[styles.stopSquare, { backgroundColor: background }]} />
            </RNView>
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
            style={[styles.actionHit, !canSend && styles.disabled]}
          >
            {disabled ? (
              <ActivityIndicator color={muted} size="small" />
            ) : canSend ? (
              <RNView style={[styles.actionCircle, { backgroundColor: text }]}>
                <Text style={[styles.sendArrow, { color: background }]}>↑</Text>
              </RNView>
            ) : (
              <Text style={[styles.sendGhost, { color: muted }]}>↑</Text>
            )}
          </Pressable>
        )}
      </GlassComposerShell>
    </RNView>
  );
}

const ACTION_DISC = 32;
const ACTION_GLYPH = 24;

const styles = StyleSheet.create({
  shell: {
    paddingHorizontal: 12,
    paddingTop: 8,
    backgroundColor: 'transparent',
    overflow: 'visible',
    zIndex: 5,
  },
  overlayRail: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: '100%',
    zIndex: 6,
  },
  scrollSlot: {
    position: 'absolute',
    right: 18,
    bottom: '100%',
    marginBottom: 8,
    zIndex: 7,
  },
  pill: {
    minHeight: 48,
    borderRadius: 24,
    paddingLeft: 4,
    paddingRight: 4,
    paddingVertical: 6,
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 6,
  },
  input: {
    flex: 1,
    maxHeight: 120,
    fontSize: 16,
    lineHeight: 22,
    paddingTop: 8,
    paddingBottom: 8,
  },
  nativeInput: {
    flex: 1,
    maxHeight: 120,
    minHeight: COLLAPSED_LINE_HEIGHT,
  },
  attachDisc: {
    width: 36,
    height: 36,
    borderRadius: 18,
  },
  attachGlyph: {
    fontSize: 22,
    lineHeight: 26,
    fontWeight: '500',
    marginTop: -1,
  },
  actionHit: {
    width: ACTION_DISC,
    height: ACTION_DISC,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 2,
  },
  actionCircle: {
    width: ACTION_GLYPH,
    height: ACTION_GLYPH,
    borderRadius: ACTION_GLYPH / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stopSquare: {
    width: ACTION_GLYPH * 0.38,
    height: ACTION_GLYPH * 0.38,
    borderRadius: ACTION_GLYPH * 0.38 * 0.2,
  },
  sendArrow: {
    fontSize: 14,
    fontWeight: '700',
    lineHeight: 16,
    marginTop: -1,
  },
  sendGhost: {
    fontSize: 18,
    fontWeight: '600',
    lineHeight: 22,
  },
  disabled: {
    opacity: 0.45,
  },
  attachRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginBottom: 6,
    paddingHorizontal: 14,
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
