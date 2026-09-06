import React, { useCallback } from 'react';
import { TextInput, type NativeSyntheticEvent, type TextInputSelectionChangeEventData, type TextStyle } from 'react-native';

import type { NativeComposerTextViewProps } from './NativeComposerTextView.types';

/**
 * Android / web fallback: honest RN TextInput — never claimed as UIGlassEffect IME.
 * ChatComposer prefers this path on Android inside the solid Material pill.
 */
export function NativeComposerTextView({
  value,
  placeholder,
  editable = true,
  maxContentHeight = 120,
  collapsedLineHeight = 40,
  fontSize = 16,
  textColor,
  placeholderTextColor,
  style,
  onChangeText,
  onFocus,
  onBlur,
  onSubmit,
  onCollapsedHeightChange,
  onContentSizeChange,
  onSelectionChange,
}: NativeComposerTextViewProps) {
  const emitCollapsed = useCallback(() => {
    onCollapsedHeightChange?.({ nativeEvent: { height: collapsedLineHeight } });
  }, [collapsedLineHeight, onCollapsedHeightChange]);

  return (
    <TextInput
      value={value}
      placeholder={placeholder}
      editable={editable}
      multiline
      placeholderTextColor={placeholderTextColor}
      onFocus={() => {
        emitCollapsed();
        onFocus?.({ nativeEvent: {} });
      }}
      onBlur={() => {
        emitCollapsed();
        onBlur?.({ nativeEvent: {} });
      }}
      onChangeText={(text) => {
        onChangeText?.({
          nativeEvent: {
            text,
            selectionStart: text.length,
            selectionEnd: text.length,
          },
        });
        emitCollapsed();
      }}
      onSelectionChange={(event: NativeSyntheticEvent<TextInputSelectionChangeEventData>) => {
        const { start, end } = event.nativeEvent.selection;
        onSelectionChange?.({ nativeEvent: { start, end } });
      }}
      onContentSizeChange={(event) => {
        const { width, height } = event.nativeEvent.contentSize;
        onContentSizeChange?.({
          nativeEvent: {
            width,
            height: Math.min(Math.max(height, collapsedLineHeight), maxContentHeight),
          },
        });
        emitCollapsed();
      }}
      onSubmitEditing={() => onSubmit?.({ nativeEvent: { text: value ?? '' } })}
      onLayout={emitCollapsed}
      style={[
        {
          flex: 1,
          maxHeight: maxContentHeight,
          fontSize,
          color: textColor,
          paddingTop: 8,
          paddingBottom: 8,
        } satisfies TextStyle,
        style as TextStyle | undefined,
      ]}
    />
  );
}

export default NativeComposerTextView;
