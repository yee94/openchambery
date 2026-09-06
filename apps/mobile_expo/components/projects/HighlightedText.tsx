import { Text, type TextProps, type TextStyle } from 'react-native';

import { highlightTextSegments } from '@/lib/highlightText';
import { useThemeColor } from '@/components/Themed';

type HighlightedTextProps = TextProps & {
  text: string;
  query?: string;
  highlightStyle?: TextStyle;
};

/** Keyword highlight for session titles / `项目 · 分支` subtitles. */
export function HighlightedText({
  text,
  query,
  style,
  highlightStyle,
  ...rest
}: HighlightedTextProps) {
  const tint = useThemeColor({}, 'tint');
  const segments = highlightTextSegments(text, query ?? '');

  return (
    <Text style={style} {...rest}>
      {segments.map((segment, index) =>
        segment.highlighted ? (
          <Text
            key={`h-${index}`}
            style={[
              {
                backgroundColor: tint,
                color: '#fff',
              },
              highlightStyle,
            ]}
          >
            {segment.text}
          </Text>
        ) : (
          <Text key={`t-${index}`}>{segment.text}</Text>
        ),
      )}
    </Text>
  );
}
