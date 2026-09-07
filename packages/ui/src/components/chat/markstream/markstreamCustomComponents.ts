import {
  setCustomComponents,
  withMarkstreamComponentDisplay,
} from 'markstream-react';
import { MarkstreamCodeBlockNode } from './markstreamCodeBlock';
import {
  MarkstreamInlineCodeNode,
  MarkstreamLinkNode,
  MarkstreamTextNode,
} from './markstreamFileReferences';

let customComponentsRegistered = false;

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
    text: MarkstreamTextNode,
    inline_code: MarkstreamInlineCodeNode,
    link: MarkstreamLinkNode,
    code_block: withMarkstreamComponentDisplay(MarkstreamCodeBlockNode, 'block'),
  });
};
