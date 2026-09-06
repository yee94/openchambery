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
  applyLynxDeepLinkIntent,
  applyLynxDeepLinkUrl,
  registerLynxDeepLinkHandlers,
  setLynxDeepLinkConnectReady,
  peekLynxPendingDeepLink,
  type LynxDeepLinkHandlers,
  type LynxDeepLinkNavCommand,
} from './deep-links/apply';
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

export {
  loadAssistantSnapshot,
  loadAssistantCapability,
  ensureAssistantSession,
  parseLynxAssistantSnapshot,
  type LynxAssistantDTO,
  type LynxAssistantSnapshot,
  type LynxAssistantLoadResult,
} from './assistants';
export {
  loadGlobalScheduledTasks,
  loadScheduledTaskRuns,
  upsertScheduledTask,
  type LynxScheduledTask,
  type LynxGlobalScheduledTasksResponse,
  type LynxScheduledLoadResult,
} from './scheduled';
export { filterLynxProjectsHomeForSearch } from './projects';
export type { LynxHomeWorktreeGroup } from './session-index/homeModel';

export {
  loadLynxSettings,
  saveLynxSettings,
  loadLynxSystemInfo,
  appearancePatchFromThemeChoice,
  LYNX_APPEARANCE_THEME_IDS,
  type LynxSettingsBlob,
} from './settings/api';
export {
  loadProvidersCatalog,
  loadAgentsCatalog,
  loadMcpCatalog,
  loadPluginsCatalog,
  loadInstalledSkillsCatalog,
  loadCommandsCatalog,
  loadMagicPromptsCatalog,
  loadSnippetsCatalog,
  loadUsageRows,
  catalogLoaderForSlug,
} from './settings/catalogs';
export {
  computeLynxTitleCollapseProgress,
  LYNX_TITLE_COLLAPSE_DISTANCE,
} from './shell/tabPageHeader';
export {
  resolveLynxConnectGate,
  nextAutoConnectPhase,
  type LynxAutoConnectPhase,
} from './connect/autoConnectPhase';
export { parsePastedPairingLink } from './connect/pairingPaste';

export {
  loadLynxGitStatus,
  loadLynxGitFileDiff,
  commitLynxGitChanges,
  syncLynxGit,
} from './chat/changesSurface';
export { listLynxDirectory, readLynxFile } from './chat/filesSurface';
export {
  loadLynxProviderAuthMethods,
  saveLynxProviderApiKey,
  startLynxProviderOAuth,
  completeLynxProviderOAuth,
  LYNX_PROVIDER_OAUTH_HOST_ONLY_STEPS,
} from './settings/providerAuth';
export {
  createLynxNativePushRegistration,
  guardLynxFcmApplicationId,
  LYNX_FCM_APPLICATION_IDS,
  LYNX_FCM_LEGACY_NAMESPACE,
} from './host/pushRegistration';
export { createLynxShareInbox } from './assistants/shareInbox';
export type { LynxShareEnvelope, LynxShareInbox } from './assistants/shareInbox';

export {
  buildLynxSessionMenuItems,
  archiveLynxSession,
  deleteLynxSession,
  createLynxSession,
  toggleLynxSessionPin,
} from './projects';
export {
  createLynxShareWelcomeStore,
  LYNX_ASSISTANT_SHARE_WELCOME_STORAGE_KEY,
  LYNX_SHARE_WELCOME_EXAMPLES,
} from './assistants/shareWelcome';
export {
  runLynxListPerfHarness,
  resolveLynxStreamingCadenceNotes,
  CAP_STREAMING_RENDER_CADENCE,
} from './harness/listPerfHarness';
export {
  parseLynxMessageParts,
  buildLynxTurnCard,
  projectLynxActivity,
} from './chat/messageParts';
export { materializeLynxDraftSession } from './chat/DraftComposer';
export {
  normalizeLynxOpenCodeEvent,
  projectLynxLiveEvent,
  LYNX_GLOBAL_EVENT_SSE_PATH,
  applyLynxLivePatch,
  createLynxSseOpenFromRuntimeFetch,
  subscribeLynxLiveTail,
  LYNX_IME_OCCUPANCY_CONTRACT,
  resolveLynxComposerOccupancyInset,
} from './chat';

export {
  createLynxHapticsAdapter,
  resolveLynxHapticMethod,
  LYNX_HAPTICS_CONTRACT,
  applyLynxEdgeSwipeHaptic,
} from './host/haptics';
export {
  createLynxMediaAdapter,
  pickLynxComposerAttachments,
  isLynxHeicMime,
  LYNX_MEDIA_CONTRACT,
  LYNX_NATIVE_MEDIA_PICK_LIMIT,
} from './host/media';
export {
  buildLynxContextDisplay,
  buildLynxChatContextChrome,
  fetchLynxModelContextLimit,
  getLynxLatestAssistantTotalTokens,
  getLynxLatestUserMessageModel,
} from './chat/contextUsage';
export {
  createLynxEdgeSwipeSessionSwitchMachine,
  shouldStartLynxSessionSwipe,
  evaluateLynxSwipeDirection,
  LYNX_EDGE_SWIPE_HOST_CONTRACT,
} from './chat/edgeSwipeSessionSwitch';
export {
  armLynxMarkdownPinReveal,
  createLynxMarkdownPinRevealState,
  markLynxMarkdownPinReady,
  resolveLynxMarkdownPinRevealKeys,
} from './chat/markdownPinReveal';
export { canAcceptLynxLoadOlderTap } from './chat/loadOlder';

export { createLynxCameraAdapter } from './host/camera';
export type { LynxCameraAdapter, LynxQrScanResult } from './host/camera';
export {
  createLynxVirtualAssetAdapter,
  lynxVirtualAssetUrl,
  normalizeLynxVirtualAssetMime,
  LYNX_VIRTUAL_ASSET_SCHEME,
} from './host/virtualAsset';
export {
  resolveLynxPredictiveBackPolicy,
  clampLynxBackProgress,
  LYNX_PREDICTIVE_BACK_WIRING_NOTES,
} from './host/predictiveBack';
export {
  admitLynxAssistantMessage,
  parseLynxMessageAdmission,
} from './assistants/admission';
export {
  loadLynxDictationStatus,
  requestLynxDictationModelDownload,
  deleteLynxDictationModel,
  LYNX_DICTATION_VOICE_POLICY,
} from './settings/dictation';
export {
  createLynxDiagnosticsRecorder,
  exportLynxDiagnostics,
  LYNX_CLIENT_DIAGNOSTICS_SCHEMA,
} from './settings/diagnostics';
export {
  loadLynxFsHome,
  addLynxProjectFromPath,
  buildLynxBrowseRows,
} from './projects/directoryExplorer';
export {
  detectLynxComposerTrigger,
  loadLynxComposerCatalogs,
  suggestionsForTrigger,
} from './chat/composerCatalog';
