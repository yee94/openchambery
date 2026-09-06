export {
  buildPairingConnectionPayload,
  encodePairingConnectionPayload,
  parsePairingConnectionPayload,
  parsePairingConnectionPayloadString,
  type PairingConnectionPayload,
  type PairingEndpointCandidate,
  type PairingDirectCandidate,
  type PairingRelayCandidate,
} from './pairing/payload';
export {
  parseConnectionPayload,
  type LynxConnectionPayload,
  type LynxPairingPayload,
} from './pairing/scan';
export {
  DEEP_LINK_SCHEME,
  parseDeepLink,
  buildDeepLink,
  type DeepLinkIntent,
  type SessionsFilter,
  type ViewTarget,
} from './deep-links/intents';
export {
  normalizeConnectionUrl,
  getConnectionLabel,
  connectionDisplayUrl,
  relayConnectionRuntimeKey,
  secureTokenKeyOf,
  mobileConnectionKey,
  isSameConnectionUrl,
} from './connection/urls';
export {
  pairingCandidatesToMobile,
  buildCandidatesFromInput,
  candidateSetsMatch,
  parseRelayConfig,
} from './connection/candidates';
export {
  RELAY_RACE_HEADSTART_MS,
  CONNECT_TIMEOUT_MS,
  FAST_PROBE_TIMEOUT_MS,
} from './connection/http';
export {
  probeConnectionCandidates,
  establishLiveTransport,
  validateMobileConnectionSession,
  type ProbeResult,
  type ProbeDeps,
} from './connection/probe';
export {
  createLynxConnectionClient,
  type LynxConnectionClient,
  type LynxConnectionClientDeps,
} from './connection/client';
export {
  createMemoryKvStore,
  createMemorySecureStore,
  CONNECTIONS_STORAGE_KEY,
  DEVICE_ID_STORAGE_KEY,
} from './connection/persist';
export type {
  LynxSavedConnection,
  LynxTransportCandidate,
  LynxRelayConfig,
  LynxConnectInput,
  LynxConnectResult,
  LynxPendingConnection,
  LynxHttpClient,
  LynxHttpResponse,
  LynxSecureStore,
  LynxKvStore,
  LynxClock,
  LynxRuntimeIdentity,
  LynxRelayTunnel,
  LynxRelayTunnelFactory,
} from './connection/types';
export { createRuntimeIdentityStore, type LynxRuntimeIdentityStore } from './runtime/identity';
export { createRuntimeFetch, isRuntimeServicePath, type LynxRuntimeFetch } from './runtime/fetch';
export {
  loadSessionIndexSnapshot,
  lookupSessionIndexById,
  pinSession,
  unpinSession,
  startSessionIndexBackgroundSync,
} from './session-index/api';
export {
  createLynxSessionIndexStore,
  createSessionIndexHomeBindings,
  type LynxSessionIndexStore,
} from './session-index/store';
export { normalizePath } from './path';
export {
  projectSessionIndexHome,
  formatHomeSessionSubtitle,
  getProjectLabel,
  getSessionActivityUpdatedAt,
  type LynxProjectsHomeModel,
  type LynxHomeProject,
  type LynxHomeSessionRow,
} from './session-index/homeModel';
export type {
  SessionIndexSnapshot,
  SessionIndexSession,
  SessionIndexDirectory,
  SessionIndexLoadResult,
  SessionIndexState,
  SessionIndexLookupHit,
} from './session-index/types';

export {
  LYNX_CHAT_LIST_ENGINE,
  resolveLynxTimelineListFlags,
  createLynxComposerActions,
  fetchSessionMessages,
  promptAsync,
  abortSession,
  createEmptyTimelineState,
  applyInitialPage,
  beginLoadOlder,
  applyOlderPage,
} from './chat';
export {
  LYNX_SETTINGS_PAGE_METADATA,
  groupLynxSettingsPages,
  filterLynxSettingsPages,
  getLynxSettingsPageMeta,
} from './settings/metadata';
