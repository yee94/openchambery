import React from 'react';
import {
  setCustomComponents,
  withMarkstreamComponentDisplay,
  type NodeComponentProps,
} from 'markstream-react';
import { MarkstreamCodeBlockNode } from './markstreamCodeBlock';
import {
  MarkstreamInlineCodeNode,
  MarkstreamLinkNode,
  MarkstreamTextNode,
} from './markstreamFileReferences';

let customComponentsRegistered = false;

type CodeBlockNodeShape = {
  type: 'code_block';
  language?: string;
  code?: string;
  loading?: boolean;
  raw?: string;
};

type TextNodeShape = {
  type: 'text';
  content: string;
  center?: boolean;
};

/**
 * markstream-react reuses the custom-component map for both AST node types and
 * fenced-block *language* overrides. Looking up language `text` therefore hits
 * the same key as the paragraph `text` node. Without a dispatcher, ```text
 * fences render through MarkstreamTextNode (reads `node.content`) and paint
 * blank — ASCII trees / plaintext dumps disappear. Route code_block nodes to
 * the OpenChamber fence adapter; keep true text nodes on the file-ref path.
 */
function MarkstreamTextMapEntry(
  props: NodeComponentProps<TextNodeShape | CodeBlockNodeShape> & {
    loading?: boolean;
    stream?: boolean;
    indexKey?: React.Key;
  },
) {
  if (props.node?.type === 'code_block') {
    return React.createElement(
      MarkstreamCodeBlockNode,
      props as NodeComponentProps<CodeBlockNodeShape> & {
        loading?: boolean;
        stream?: boolean;
        indexKey?: React.Key;
      },
    );
  }
  return React.createElement(
    MarkstreamTextNode,
    props as NodeComponentProps<TextNodeShape>,
  );
}

/**
 * Registers every OpenChamber Markstream node override once.
 * A single `setCustomComponents({...})` replaces the global map — never call
 * it from multiple modules with partial maps or later registrations wipe earlier ones.
 */
export const ensureMarkstreamCustomComponents = (): void => {
  if (customComponentsRegistered) {
    return;
  }
  customComponentsRegistered = true;
  setCustomComponents({
    text: MarkstreamTextMapEntry,
    inline_code: MarkstreamInlineCodeNode,
    link: MarkstreamLinkNode,
    code_block: withMarkstreamComponentDisplay(MarkstreamCodeBlockNode, 'block'),
  });
};
