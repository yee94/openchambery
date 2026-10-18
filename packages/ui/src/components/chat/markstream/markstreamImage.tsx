import React from 'react';
import { useEvent } from '@reactuses/core';
import type { ImageNode, NodeComponentProps } from 'markstream-react';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useResolvedImageSource } from '../imageSource';
import { MarkstreamCodeBlockNode } from './markstreamCodeBlock';
import { useMarkstreamHostContext } from './markstreamHostContext';

type ImageNodeShape = React.ComponentProps<typeof ImageNode>['node'];
type FenceProps = React.ComponentProps<typeof MarkstreamCodeBlockNode>;

function RuntimeImage({ node }: NodeComponentProps<ImageNodeShape>) {
  const directory = useEffectiveDirectory() ?? '';
  const source = useResolvedImageSource(node.src, directory);
  const { onShowPopup } = useMarkstreamHostContext();
  const handleKeyDown = useEvent((event: React.KeyboardEvent<HTMLImageElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    event.currentTarget.click();
  });
  return (
    <img
      src={source || undefined}
      data-md-image-source={node.src}
      alt={node.alt}
      title={node.title ?? undefined}
      className="max-w-full h-auto object-contain rounded-lg"
      role={onShowPopup ? 'button' : undefined}
      tabIndex={onShowPopup ? 0 : undefined}
      onKeyDown={onShowPopup ? handleKeyDown : undefined}
    />
  );
}

// Language overrides share this map: ```image must remain a code fence.
export function MarkstreamImageNode(props: NodeComponentProps<ImageNodeShape> | FenceProps) {
  if (props.node.type === 'code_block') {
    return <MarkstreamCodeBlockNode {...props as FenceProps} />;
  }
  return <RuntimeImage {...props as NodeComponentProps<ImageNodeShape>} />;
}
