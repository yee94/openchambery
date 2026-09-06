import type { StyleProp, TextStyle, ViewStyle } from 'react-native';

export type NativeComposerChangeTextEvent = {
  text: string;
  selectionStart: number;
  selectionEnd: number;
};

export type NativeComposerSelectionEvent = {
  start: number;
  end: number;
};

export type NativeComposerCollapsedHeightEvent = {
  height: number;
};

export type NativeComposerContentSizeEvent = {
  width: number;
  height: number;
};

export type NativeComposerSubmitEvent = {
  text: string;
};

export type NativeComposerTextViewProps = {
  value?: string;
  placeholder?: string;
  editable?: boolean;
  maxContentHeight?: number;
  /** Occupancy token: collapsed single-line height (expand must not raise accessories). */
  collapsedLineHeight?: number;
  fontSize?: number;
  textColor?: string;
  placeholderTextColor?: string;
  style?: StyleProp<ViewStyle | TextStyle>;
  onChangeText?: (event: { nativeEvent: NativeComposerChangeTextEvent }) => void;
  onFocus?: (event: { nativeEvent: Record<string, never> }) => void;
  onBlur?: (event: { nativeEvent: Record<string, never> }) => void;
  onSubmit?: (event: { nativeEvent: NativeComposerSubmitEvent }) => void;
  onCollapsedHeightChange?: (event: {
    nativeEvent: NativeComposerCollapsedHeightEvent;
  }) => void;
  onContentSizeChange?: (event: { nativeEvent: NativeComposerContentSizeEvent }) => void;
  onSelectionChange?: (event: { nativeEvent: NativeComposerSelectionEvent }) => void;
};
