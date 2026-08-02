import React from 'react';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeTransportIdentity, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { isAbsoluteFilePath, normalizeFilePath, toAbsoluteFilePath } from '@/lib/path-utils';

const decodeFileUrlPart = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const fileUrlToPath = (source: string): string => {
  try {
    const url = new URL(source);
    const hostname = decodeFileUrlPart(url.hostname);
    let pathname = decodeFileUrlPart(url.pathname);
    if (/^[A-Za-z]$/.test(hostname)) {
      pathname = `${hostname.toUpperCase()}:${pathname}`;
    } else if (hostname && hostname.toLowerCase() !== 'localhost') {
      pathname = `//${hostname}${pathname}`;
    }
    if (/^\/[A-Za-z]:[\\/]/.test(pathname)) {
      pathname = pathname.slice(1);
    }
    return normalizeFilePath(pathname);
  } catch {
    let pathname = decodeFileUrlPart(source.replace(/^file:\/\//i, ''));
    if (/^\/[A-Za-z]:[\\/]/.test(pathname)) {
      pathname = pathname.slice(1);
    }
    return normalizeFilePath(pathname);
  }
};

export const resolveImageSource = (source: string, effectiveDirectory: string) => {
  const trimmed = source.trim();
  if (!trimmed || /^https?:/i.test(trimmed) || /^(?:data|blob):/i.test(trimmed) || /^\/api(?=\/|[?#]|$)/.test(trimmed)) {
    return { kind: 'direct', source: trimmed };
  }

  if (/^file:\/\//i.test(trimmed)) {
    return { kind: 'runtime-file', source: trimmed, path: fileUrlToPath(trimmed) };
  }

  if (/^[a-z][a-z\d+.-]*:/i.test(trimmed) && !/^[A-Za-z]:[\\/]/.test(trimmed)) {
    return { kind: 'direct', source: trimmed };
  }

  const pathSource = decodeFileUrlPart(trimmed);
  const path = isAbsoluteFilePath(pathSource)
    ? normalizeFilePath(pathSource)
    : toAbsoluteFilePath(effectiveDirectory, pathSource);
  return { kind: 'runtime-file', source: trimmed, path };
};

export const fetchRuntimeImageObjectUrl = async (
  path: string,
  signal: AbortSignal,
): Promise<string> => {
  const response = await runtimeFetch('/api/fs/raw', {
    method: 'GET',
    cache: 'no-store',
    query: { path },
    signal,
  });
  if (!response.ok) {
    throw new Error(`Image source request failed with status ${response.status}`);
  }
  return URL.createObjectURL(await response.blob());
};

export const isRelayTransport = (transportIdentity: string): boolean => transportIdentity.startsWith('relay:');

const subscribeTransport = (onStoreChange: () => void): (() => void) => (
  subscribeRuntimeEndpointChanged(() => onStoreChange())
);

export const useResolvedImageSource = (source: string, effectiveDirectory: string): string => {
  const transportIdentity = React.useSyncExternalStore(
    subscribeTransport,
    getRuntimeTransportIdentity,
    getRuntimeTransportIdentity,
  );
  const resolved = React.useMemo(
    () => resolveImageSource(source, effectiveDirectory),
    [effectiveDirectory, source],
  );
  const usesRelayFileSource = isRelayTransport(transportIdentity) && resolved.kind === 'runtime-file';
  const resolutionKey = `${transportIdentity}\n${effectiveDirectory}\n${source}`;
  const immediateSource = usesRelayFileSource ? '' : resolved.source;
  const [display, setDisplay] = React.useState({
    key: resolutionKey,
    source: immediateSource,
  });

  React.useEffect(() => {
    if (!usesRelayFileSource || resolved.kind !== 'runtime-file') {
      setDisplay({ key: resolutionKey, source: resolved.source });
      return;
    }

    setDisplay({ key: resolutionKey, source: '' });
    if (!resolved.path) {
      return;
    }

    const controller = new AbortController();
    let objectUrl = '';
    void fetchRuntimeImageObjectUrl(resolved.path, controller.signal)
      .then((nextObjectUrl) => {
        if (controller.signal.aborted || getRuntimeTransportIdentity() !== transportIdentity) {
          URL.revokeObjectURL(nextObjectUrl);
          return;
        }
        objectUrl = nextObjectUrl;
        setDisplay({ key: resolutionKey, source: nextObjectUrl });
      })
      .catch(() => undefined);

    return () => {
      controller.abort();
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [resolutionKey, resolved, transportIdentity, usesRelayFileSource]);

  return display.key === resolutionKey ? display.source : immediateSource;
};
