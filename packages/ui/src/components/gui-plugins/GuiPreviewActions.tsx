import React from 'react';

/** React owns the slot wrapper; the panel lifecycle owns its foreign contents. */
export function GuiPreviewActions({ target }: { target: HTMLElement }) {
  const container = React.useRef<HTMLDivElement>(null);
  React.useLayoutEffect(() => {
    container.current?.append(target);
    return () => { target.remove(); };
  }, [target]);
  return <div ref={container} className="relative z-30 flex items-center gap-1 empty:hidden [&>div]:flex [&>div]:items-center [&>div]:gap-1" data-gui-preview-actions />;
}
