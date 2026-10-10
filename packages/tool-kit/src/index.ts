export { classifyCommand, isVerificationCommand } from "./commandClassifier";
export { classifyGitAction, isReworkGitAction } from "./gitActionClassifier";
export { classifyWorkMilestone, invitesDebrief } from "./workMilestoneClassifier";
export { autonomyBand } from "./autonomyBand";
export type { AutonomyBand } from "./autonomyBand";
export { classifyModelClass } from "./modelClassifier";
export { bucketLinesChanged, bucketDurationMs } from "./buckets";
export {
  isAfterHours,
  isOutsideBusinessHours,
  BUSINESS_DAY,
  utcOffsetMinutesAt,
  localHourAt,
} from "./afterHours";
export { getString, getNumber, getNested, getNestedString, getNestedNumber, inferOutcome, outcomeForHook, looksLikeCorrection, mintIdempotencyKey } from "./payload";
export { COLLECTOR_VERSION, UNRELEASED_COLLECTOR_VERSION, describeCollectorVersion } from "./collectorVersion";
export { AscendaEventSender, AscendaSemanticEventError, TOKEN_RENEW_LEAD_MS, buildEventPayload } from "./eventSender";
export type { EventIdentity, EventSenderConfig, MappedEvent, MappedSemanticEvent, OutboxDrainReport } from "./eventSender";
export { EVENT_LOG_ENV_VAR, EVENT_LOG_OFF, appendEventLog, defaultEventLogPath, describeEventLog, expandUserPath, parseEventLogFlag, resolveEventLog, resolveEventLogPath } from "./eventLog";
export type { EventLogEntry, EventLogOptions, EventLogSetting, EventLogSource } from "./eventLog";
export {
  DEFAULT_API_BASE_URL,
  MissingInstallationIdError,
  deliverHookEvents,
  loadCliAgentConfig,
  resolveCliAgentInstallationId,
  resolveContextHashes
} from "./hookAdapter";
export type { CliAgentConfig, CliAgentIdentity, HookDeliveryOptions, InstallationIdSource, ResolvedInstallationId } from "./hookAdapter";
export {
  cliAgentHookBinPath,
  findStaleHookCommands,
  isCliAgentManagementCommand,
  registeredHookSets,
  runCliAgentSetup,
  writeHookSettings
} from "./cliAgentSetup";
export type { CliAgentSetupSpec, HookSettingsFormat, SetupScope } from "./cliAgentSetup";
export { ALWAYS_SENT, FAMILY_SENTENCES, FREE_TEXT_KEYS, REFUSALS, renderSetupDisclosure } from "./setupDisclosure";
export type { DisclosureFamily, SetupDisclosureOptions } from "./setupDisclosure";
export {
  credentialsFilePath,
  isLocalOnlyHostInstall,
  readHostCredentials,
  readMachineCredentials,
  removeHostCredentials,
  writeHostCredentials,
  writeEventLogSetting,
  writeMachineCredentials,
  writeTopLevelCredentials
} from "./credentials";
export type { HostCredentials, MachineCredentials } from "./credentials";
export { consumeTurnDurationMs, recordTurnStart } from "./turnState";
export {
  EVENT_TOKEN_TTL_MS,
  ascendaHome,
  defaultTokenFilePath,
  listPersistedToolInstallationIds,
  persistEventWriteToken,
  readTokenExpiry,
  readTokenFile,
  tokenExpiryFilePath
} from "./tokenStore";
export {
  defaultStateFilePath,
  readCollectorState,
  recordSendOutcome,
  shouldAnnounceFailure,
  markFailureNotified,
  unresolvedStateFilePath,
  unresolvedToolInstallationId,
  recordOutboxDiscard
} from "./stateStore";
export type { CollectorState, OutcomeDetail, SendOutcome, OutboxDiscardReason, OutboxDiscardRecord } from "./stateStore";
export {
  OUTBOX_DRAIN_ENV_VAR,
  DEFAULT_OUTBOX_MAX_ENTRIES,
  DEFAULT_OUTBOX_MAX_AGE_MS,
  DEFAULT_OUTBOX_DRAIN_BATCH_SIZE,
  outboxDrainEnabled,
  defaultOutboxFilePath,
  appendToOutbox,
  readOutboxSummary,
  claimOutbox,
  enforceOutboxBounds
} from "./outbox";
export type { OutboxEntry, OutboxBounds, OutboxDiscard, OutboxSummary, ClaimedOutbox } from "./outbox";
export { systemTimeProvider, fixedTimeProvider } from "./timeProvider";
export type { TimeProvider } from "./timeProvider";
export { machineSaltFilePath, readOrCreateMachineSalt, hashWithMachineSalt } from "./salt";
export { deriveWorkContext, deriveBranchHash, deriveBranchHashForCwd, normalizeBranchName, readBranchName } from "./workContext";
export type { WorkContext } from "./workContext";
export {
  recordWorkContext,
  recordWorkContextAlias,
  readWorkContextRegistry,
  workContextRegistryFilePath
} from "./contextRegistry";
export type { WorkContextRegistry, WorkContextRegistryEntry } from "./contextRegistry";
export {
  forgeProjectHash,
  parseForgeFullName,
  readForgeFullName,
  forgeFullNameFromConfig,
  recordForgeProjectAlias
} from "./forgeProject";
export { emitLiveSignal, deliverLine, bucketPromptSize, liveBusSocketPath, liveBusSocketCandidates, LIVE_BUS_BACKGROUND_TRUST_MS } from "./liveBus";
export { holdForSaver, heldForSaver, probeSocket, readSaverStatuses, saverContainerDir, saverReplayPath, saverStatusDir, saverSupportDir, SAVER_REPLAY_WINDOW_MS } from "./saverHandoff";
export type { SaverStatus, SaverStatusReading, SocketState } from "./saverHandoff";
export { colourEnabled, terminalStyle } from "./terminalStyle";
export type { TerminalStyle, Tone } from "./terminalStyle";
export { describeAge, hookLauncherScript, hookRunnerCommand, hookRunnerPaths, installHookRunner, lastHookPath, readLastHook, removeHookRunner, resolveHookNode, stampLastHook, tidyHomePath } from "./hookRunner";
export type { HookLauncherOptions, HookRunnerPaths, LastHook, NodeResolution } from "./hookRunner";
export { DOCTOR_VALUE_COLUMN, doctorRow, liveSignalDoctorLines } from "./liveSignalDoctor";
export type { HookRegistration, LiveSignalDoctorOptions } from "./liveSignalDoctor";
export type { LiveBusEvent, LiveBusSignal, LiveBusStopFailureKind, PromptSizeBucket } from "./liveBus";
export { HOOK_SET_FLAG, UNVERSIONED_HOOK_SET, describeHookSetChanges, hookSetArgument, hookSetChanges, hookSetOfCommand, isHookSet, readHookSet, readViaPlugin } from "./hookSet";
export type { HookSetChanges } from "./hookSet";
export { AGENT_PROCESS, findAgentPid, findAgentProcess, livePidFields, psArgsLookup, psLookup, scriptMarkerIn } from "./agentProcess";
export type { AgentProcessMatch, AgentProcessRule, FindAgentPidOptions, ProcessArgsLookup, ProcessInfo, ProcessLookup } from "./agentProcess";
export {
  AscendaApiError,
  createPairingSession,
  getPairingStatus,
  getStudyJoinStatus,
  renewToolToken,
  postToolEvent,
  postToolEventsBatch,
  parseIngestResponse,
  isRetryableStatus,
  readInitiatives,
  readStudyNotices,
  markStudyNoticeShown,
  setStudyObjection,
  startStudyJoin
} from "./http";
export type { IngestOutcome, IngestBatchItemResult, InitiativesRead, StudyNoticesRead } from "./http";
export { INITIATIVE_COPY, initiativesStatusLines, renderInitiatives } from "./initiatives";
export type { InitiativeCopy, InitiativesStatusContext } from "./initiatives";
export { NOTICED_PURPOSES, renderStudyNotices, runStudyObjection, studyNoticeStatus } from "./studyNotices";
export type { NoticedPurpose, StudyNoticesStatus, StudyNoticesStatusContext, StudyObjectionContext } from "./studyNotices";
export { runStudyJoin } from "./studyJoin";
export type { StudyJoinContext } from "./studyJoin";
