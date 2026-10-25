import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { directFileResource, readRuntimeFileBlob, type FileResourceRequest } from './runtime-file-resource';
import { type RuntimeUrlQuery } from './runtime-url';
import { refreshRuntimeUrlAuthToken, getRuntimeBearerTokenSync, getRuntimeExtraHeadersSync, getRuntimeAuthGeneration } from './runtime-auth';
import { isRelayModeActive } from './relay/runtime-tunnel';
import { getRuntimeGeneration } from './runtime-switch';
import { type DownloadProgress } from './download-progress';

export async function fileResourceBrowserUrl(route: string, query?: RuntimeUrlQuery): Promise<string> {
  // Cookie-only/local Hosts can serve browser URLs without the optional token
  // endpoint. Header-authenticated Hosts must successfully mint their URL token.
  if (getRuntimeBearerTokenSync() || Object.keys(getRuntimeExtraHeadersSync()).length) await refreshRuntimeUrlAuthToken();
  return directFileResource(route, query).url;
}

/** Browser download initiation is not a destination-write confirmation. Large
 * direct downloads remain browser streams; do not materialize them in JS memory. */
export async function downloadRuntimeFile(input: FileResourceRequest & { filename?: string }, onProgress?: DownloadProgress): Promise<void> {
  const generation = getRuntimeGeneration();
  const auth = getRuntimeAuthGeneration();
  const stat = await getRegisteredRuntimeAPIs()?.files.statFile?.(input.path, input);
  input.signal?.throwIfAborted();
  let url: string;
  let revoke = false;
  if (stat && stat.size > 32 * 1024 * 1024 && !isRelayModeActive()) {
    url = await fileResourceBrowserUrl('/api/fs/raw', {
      path: input.path, download: 'true', directory: input.directory,
      allowOutsideWorkspace: input.allowOutsideWorkspace ? 'true' : undefined,
      outsideFileGrant: input.outsideFileGrant,
    });
  } else {
    const blob = await readRuntimeFileBlob(input, onProgress);
    url = URL.createObjectURL(blob);
    revoke = true;
  }
  try {
    input.signal?.throwIfAborted();
    if (generation !== getRuntimeGeneration() || auth !== getRuntimeAuthGeneration()) throw new DOMException('File runtime changed', 'AbortError');
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = input.filename || stat?.filename || input.path.split('/').pop() || 'file';
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  } finally { if (revoke) setTimeout(() => URL.revokeObjectURL(url), 1000); }
}
