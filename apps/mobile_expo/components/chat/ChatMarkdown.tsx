import React, { memo, useCallback, useMemo } from 'react';
import { Linking, StyleSheet, Text, View } from 'react-native';

import {
  flattenInlineText,
  isSafeMarkdownHref,
  parseChatMarkdown,
  type ChatMarkdownBlock,
  type ChatMarkdownInline,
} from '@/lib/chatMarkdownModel';
import { segmentStreamingMarkdown } from '@/lib/streamingMarkdown';

export type ChatMarkdownProps = {
  content: string;
  /** When true, isolate trailing open fences (Cap streaming cadence). */
  streaming?: boolean;
  color: string;
  /** Link / accent color (assistant tint). User bubbles pass a light accent. */
  linkColor?: string;
  codeBackground?: string;
  codeColor?: string;
  selectable?: boolean;
};

const HEADING_SIZE: Record<number, { fontSize: number; lineHeight: number }> = {
  1: { fontSize: 22, lineHeight: 28 },
  2: { fontSize: 20, lineHeight: 26 },
  3: { fontSize: 18, lineHeight: 24 },
  4: { fontSize: 16, lineHeight: 22 },
  5: { fontSize: 15, lineHeight: 20 },
  6: { fontSize: 14, lineHeight: 18 },
};

type InlineStyleCtx = {
  color: string;
  linkColor: string;
  codeBackground: string;
  codeColor: string;
  onLinkPress: (href: string) => void;
};

function renderInlines(nodes: ChatMarkdownInline[], ctx: InlineStyleCtx): React.ReactNode[] {
  return nodes.map((node, index) => {
    const key = `${node.kind}-${index}`;
    switch (node.kind) {
      case 'text':
        return (
          <Text key={key} style={{ color: ctx.color }}>
            {node.text}
          </Text>
        );
      case 'strong':
        return (
          <Text key={key} style={[styles.strong, { color: ctx.color }]}>
            {renderInlines(node.children, ctx)}
          </Text>
        );
      case 'em':
        return (
          <Text key={key} style={[styles.em, { color: ctx.color }]}>
            {renderInlines(node.children, ctx)}
          </Text>
        );
      case 'del':
        return (
          <Text key={key} style={[styles.del, { color: ctx.color }]}>
            {renderInlines(node.children, ctx)}
          </Text>
        );
      case 'codespan':
        return (
          <Text
            key={key}
            style={[
              styles.codespan,
              { color: ctx.codeColor, backgroundColor: ctx.codeBackground },
            ]}
          >
            {node.text}
          </Text>
        );
      case 'link': {
        const label = flattenInlineText(node.children) || node.href;
        const safe = isSafeMarkdownHref(node.href);
        return (
          <Text
            key={key}
            style={[styles.link, { color: safe ? ctx.linkColor : ctx.color }]}
            onPress={safe ? () => ctx.onLinkPress(node.href) : undefined}
            accessibilityRole={safe ? 'link' : undefined}
          >
            {label}
          </Text>
        );
      }
      case 'br':
        return (
          <Text key={key} style={{ color: ctx.color }}>
            {'\n'}
          </Text>
        );
      default:
        return null;
    }
  });
}

function BlockView({
  block,
  ctx,
  selectable,
  index,
}: {
  block: ChatMarkdownBlock;
  ctx: InlineStyleCtx;
  selectable?: boolean;
  index: number;
}) {
  switch (block.kind) {
    case 'space':
      return <View style={styles.space} />;
    case 'hr':
      return <View style={[styles.hr, { backgroundColor: ctx.codeBackground }]} />;
    case 'plain':
      return (
        <Text style={[styles.body, { color: ctx.color }]} selectable={selectable}>
          {block.text}
        </Text>
      );
    case 'paragraph':
      return (
        <Text style={[styles.body, { color: ctx.color }]} selectable={selectable}>
          {renderInlines(block.children, ctx)}
        </Text>
      );
    case 'heading': {
      const size = HEADING_SIZE[block.depth] ?? HEADING_SIZE[3]!;
      return (
        <Text
          style={[styles.heading, size, { color: ctx.color }]}
          selectable={selectable}
        >
          {renderInlines(block.children, ctx)}
        </Text>
      );
    }
    case 'code':
      return (
        <View
          style={[styles.codeBlock, { backgroundColor: ctx.codeBackground }]}
          accessibilityLabel={block.lang ? `code ${block.lang}` : 'code'}
        >
          {block.lang ? (
            <Text style={[styles.codeLang, { color: ctx.linkColor }]}>{block.lang}</Text>
          ) : null}
          <Text style={[styles.codeText, { color: ctx.codeColor }]} selectable={selectable}>
            {block.text.replace(/\n$/, '')}
          </Text>
        </View>
      );
    case 'list':
      return (
        <View style={styles.list}>
          {block.items.map((item, i) => {
            const marker = block.ordered ? `${block.start + i}.` : '•';
            return (
              <View key={`${index}-li-${i}`} style={styles.listItem}>
                <Text style={[styles.listMarker, { color: ctx.color }]}>{marker}</Text>
                <View style={styles.listBody}>
                  <Text style={[styles.body, { color: ctx.color }]} selectable={selectable}>
                    {renderInlines(item, ctx)}
                  </Text>
                </View>
              </View>
            );
          })}
        </View>
      );
    case 'blockquote':
      return (
        <View
          style={[
            styles.blockquote,
            { borderLeftColor: ctx.linkColor, backgroundColor: ctx.codeBackground },
          ]}
        >
          {block.children.map((child, i) => (
            <BlockView
              key={`${index}-bq-${i}`}
              block={child}
              ctx={ctx}
              selectable={selectable}
              index={i}
            />
          ))}
        </View>
      );
    default:
      return null;
  }
}

function ChatMarkdownImpl({
  content,
  streaming = false,
  color,
  linkColor,
  codeBackground,
  codeColor,
  selectable = true,
}: ChatMarkdownProps) {
  const resolvedLink = linkColor ?? '#3b82f6';
  const resolvedCodeBg = codeBackground ?? 'rgba(127,127,127,0.22)';
  const resolvedCodeColor = codeColor ?? color;

  const onLinkPress = useCallback((href: string) => {
    if (!isSafeMarkdownHref(href)) return;
    void Linking.openURL(href).catch(() => undefined);
  }, []);

  const ctx = useMemo<InlineStyleCtx>(
    () => ({
      color,
      linkColor: resolvedLink,
      codeBackground: resolvedCodeBg,
      codeColor: resolvedCodeColor,
      onLinkPress,
    }),
    [color, resolvedLink, resolvedCodeBg, resolvedCodeColor, onLinkPress],
  );

  const segments = useMemo(
    () => segmentStreamingMarkdown(content, streaming),
    [content, streaming],
  );

  const docs = useMemo(
    () =>
      segments.map((seg) => {
        if (seg.openFence) {
          const stripped = seg.raw.replace(/^[ \t]{0,3}(`{3,}|~{3,})[^\n]*\n?/, '');
          return {
            openFence: true as const,
            doc: parseChatMarkdown(''),
            plain: stripped.length > 0 ? stripped : seg.raw,
          };
        }
        return { openFence: false as const, doc: parseChatMarkdown(seg.raw), plain: '' };
      }),
    [segments],
  );

  if (!content) {
    return null;
  }

  return (
    <View style={styles.root}>
      {docs.map((piece, i) => {
        if (piece.openFence) {
          return (
            <View
              key={`live-fence-${i}`}
              style={[styles.codeBlock, { backgroundColor: resolvedCodeBg }]}
            >
              <Text style={[styles.codeText, { color: resolvedCodeColor }]} selectable={selectable}>
                {piece.plain}
              </Text>
            </View>
          );
        }
        return (
          <React.Fragment key={`doc-${i}`}>
            {piece.doc.blocks.map((block, j) => (
              <BlockView
                key={`${i}-${j}`}
                block={block}
                ctx={ctx}
                selectable={selectable}
                index={j}
              />
            ))}
          </React.Fragment>
        );
      })}
    </View>
  );
}

export const ChatMarkdown = memo(ChatMarkdownImpl);

const styles = StyleSheet.create({
  root: {
    width: '100%',
    gap: 6,
  },
  body: {
    fontSize: 16,
    lineHeight: 22,
  },
  heading: {
    fontWeight: '700',
  },
  strong: {
    fontWeight: '700',
  },
  em: {
    fontStyle: 'italic',
  },
  del: {
    textDecorationLine: 'line-through',
  },
  codespan: {
    fontFamily: 'monospace',
    fontSize: 14,
    borderRadius: 4,
    overflow: 'hidden',
  },
  link: {
    textDecorationLine: 'underline',
  },
  codeBlock: {
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    width: '100%',
  },
  codeLang: {
    fontSize: 11,
    marginBottom: 4,
    fontWeight: '600',
    textTransform: 'lowercase',
  },
  codeText: {
    fontFamily: 'monospace',
    fontSize: 13,
    lineHeight: 18,
  },
  list: {
    width: '100%',
    gap: 4,
  },
  listItem: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
  },
  listMarker: {
    fontSize: 16,
    lineHeight: 22,
    minWidth: 18,
  },
  listBody: {
    flex: 1,
    minWidth: 0,
  },
  blockquote: {
    borderLeftWidth: 3,
    paddingLeft: 10,
    paddingVertical: 4,
    borderRadius: 6,
    gap: 4,
  },
  hr: {
    height: StyleSheet.hairlineWidth,
    width: '100%',
    marginVertical: 4,
  },
  space: {
    height: 4,
  },
});
