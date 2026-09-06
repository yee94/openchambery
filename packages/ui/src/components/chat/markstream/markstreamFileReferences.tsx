import React from 'react';
import {
  InlineCodeNode,
  LinkNode,
  TextNode,
  setCustomComponents,
  type NodeComponentProps,
} from 'markstream-react';
import type { EditorAPI } from '@/lib/api/types';
import { isMobileSurfaceRuntime } from '@/lib/runtimeSurface';
import { isLikelyFilePath } from '../fileReferenceDecorate';
import {
  FILE_REFERENCE_OPEN_TITLE,
  getFileReferenceLinkLimit,
  getResolvedReference,
  peekFileReferenceInfo,
  probeFileReference,
  shouldOfferFileReference,
  type FileReferenceInfo,
  type OpenFileReferenceOptions,
} from '../fileReferenceActions';
import { splitParagraphPathTokens } from '../fileReferenceSplit';
import type { ToolPopupContent } from '../message/types';

type MarkstreamFileReferenceContextValue = OpenFileReferenceOptions & {
  enabled: boolean;
  insideLink: boolean;
  isMobileSurface: boolean;
  slots: { used: number; limit: number };
};

const DISABLED_FILE_REFERENCE_CONTEXT: MarkstreamFileReferenceContextValue = {
  enabled: false,
  insideLink: false,
  isMobileSurface: false,
  effectiveDirectory: '',
  preferRuntimeEditor: false,
  slots: { used: 0, limit: 0 },
};

const MarkstreamFileReferenceContext = React.createContext<MarkstreamFileReferenceContextValue>(
  DISABLED_FILE_REFERENCE_CONTEXT,
);

let fileReferenceComponentsRegistered = false;

/** Registers Markstream node overrides once (module load / first Provider). */
const ensureMarkstreamFileReferenceComponents = (): void => {
  if (fileReferenceComponentsRegistered) {
    return;
  }
  fileReferenceComponentsRegistered = true;
  setCustomComponents({
    text: MarkstreamTextNode,
    inline_code: MarkstreamInlineCodeNode,
    link: MarkstreamLinkNode,
  });
};

// Side-effect registration when this module is imported (Provider or host).
ensureMarkstreamFileReferenceComponents();

export const MarkstreamFileReferenceProvider: React.FC<{
  enabled: boolean;
  effectiveDirectory: string;
  editor?: EditorAPI;
  preferRuntimeEditor: boolean;
  onShowPopup?: (content: ToolPopupContent) => void;
  content: string;
  children: React.ReactNode;
}> = ({
  enabled,
  effectiveDirectory,
  editor,
  preferRuntimeEditor,
  onShowPopup,
  content,
  children,
}) => {
  const value = React.useMemo<MarkstreamFileReferenceContextValue>(() => ({
    enabled,
    insideLink: false,
    isMobileSurface: isMobileSurfaceRuntime(),
    effectiveDirectory,
    editor,
    preferRuntimeEditor,
    onShowPopup,
    slots: { used: 0, limit: getFileReferenceLinkLimit() },
  }), [enabled, effectiveDirectory, editor, preferRuntimeEditor, onShowPopup, content]);

  return (
    <MarkstreamFileReferenceContext.Provider value={value}>
      {children}
    </MarkstreamFileReferenceContext.Provider>
  );
};

const FileReferenceToken: React.FC<{
  raw: string;
  children?: React.ReactNode;
}> = ({ raw, children }) => {
  const ctx = React.useContext(MarkstreamFileReferenceContext);
  const resolved = getResolvedReference(raw, ctx.effectiveDirectory);
  const claimedRef = React.useRef(false);
  if (ctx.enabled && resolved && !claimedRef.current && ctx.slots.used < ctx.slots.limit) {
    ctx.slots.used += 1;
    claimedRef.current = true;
  }

  const [info, setInfo] = React.useState<FileReferenceInfo | null>(
    resolved ? peekFileReferenceInfo(resolved.resolvedPath) ?? null : null,
  );

  const resolvedPath = resolved?.resolvedPath;
  React.useEffect(() => {
    if (!ctx.enabled || !resolvedPath || !claimedRef.current) {
      return;
    }
    let cancelled = false;
    void probeFileReference(resolvedPath, ctx.effectiveDirectory).then((next) => {
      if (!cancelled) {
        setInfo(next);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [ctx.enabled, ctx.effectiveDirectory, resolvedPath]);

  if (!resolved) {
    return children ?? raw;
  }

  const offered = Boolean(
    claimedRef.current
    && info
    && shouldOfferFileReference(resolved.resolvedPath, info, ctx.isMobileSurface),
  );

  return (
    <span
      data-openchamber-block-path-token="true"
      {...(offered
        ? {
          'data-openchamber-file-link': 'true',
          'data-openchamber-file-ref': raw,
          'data-openchamber-file-path': resolved.resolvedPath,
          'data-openchamber-file-binary': String(info?.isBinary === true),
          title: FILE_REFERENCE_OPEN_TITLE,
          ...(children ? {} : { role: 'button', tabIndex: 0 }),
        }
        : {})}
    >
      {children ?? raw}
    </span>
  );
};

function MarkstreamTextNode(props: NodeComponentProps<{ type: 'text'; content: string; center?: boolean }>) {
  const ctx = React.useContext(MarkstreamFileReferenceContext);
  const content = props.node.content ?? '';
  if (!ctx.enabled || ctx.insideLink) {
    return <TextNode {...props} />;
  }
  const segments = splitParagraphPathTokens(content);
  if (segments.length === 1 && segments[0]?.kind !== 'path') {
    return <TextNode {...props} />;
  }

  return (
    <>
      {segments.map((segment, index) => (
        segment.kind === 'path'
          ? <FileReferenceToken key={`path-${index}-${segment.value}`} raw={segment.value} />
          : <TextNode key={`text-${index}`} {...props} node={{ ...props.node, content: segment.value }} />
      ))}
    </>
  );
}

function MarkstreamInlineCodeNode(props: NodeComponentProps<{ type: 'inline_code'; code: string }>) {
  const ctx = React.useContext(MarkstreamFileReferenceContext);
  const code = props.node.code ?? '';
  if (!ctx.enabled || !isLikelyFilePath(code)) {
    return <InlineCodeNode {...props} />;
  }

  return (
    <InlineCodeNode {...props}>
      <FileReferenceToken raw={code} />
    </InlineCodeNode>
  );
}

function MarkstreamLinkNode(props: React.ComponentProps<typeof LinkNode>) {
  const ctx = React.useContext(MarkstreamFileReferenceContext);
  const href = props.node.href ?? '';
  const fileHref = ctx.enabled && isLikelyFilePath(href);

  return (
    <MarkstreamFileReferenceContext.Provider value={{ ...ctx, insideLink: true }}>
      {fileHref
        ? (
          <FileReferenceToken raw={href}>
            <LinkNode {...props} />
          </FileReferenceToken>
        )
        : <LinkNode {...props} />}
    </MarkstreamFileReferenceContext.Provider>
  );
}
