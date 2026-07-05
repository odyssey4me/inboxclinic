export { keyFor } from "./keys";
export { trustTier, type TrustTier, type TrustTierName, type TrustTierColour } from "./trust/tiers";

// Provider-client port (Gmail).
export {
  GMAIL_READONLY_SCOPE,
  GMAIL_MODIFY_SCOPE,
  GMAIL_SETTINGS_BASIC_SCOPE,
  SCOPES_BY_TIER,
  StaleHistoryError,
  type AccessToken,
  type FilterSpec,
  type GmailClient,
  type HistoryList,
  type HistoryMessage,
  type HistoryRecord,
  type ListHistoryOptions,
  type MessageHeaders,
  type MessageLabelEdit,
  type MessageMeta,
  type NativeFilter,
  type ScopeTier,
} from "./ports/GmailClient";

// Backup-transport port (Google Drive today).
export {
  BACKUP_FILE_NAME,
  BackupNotFoundError,
  DRIVE_FILE_SCOPE,
  type BackupClient,
  type BackupFile,
} from "./ports/BackupClient";

// Backup / restore orchestration (over the BackupClient + Store ports).
export {
  backupToDrive,
  getBackupState,
  restoreFromDrive,
  setBackupEnabled,
  BACKUP_ENABLED_KEY,
  BACKUP_FILE_ID_KEY,
  BACKUP_LAST_AT_KEY,
  type BackupOptions,
  type BackupResult,
  type BackupState,
  type RestoreResult,
} from "./backup/backup";

// On-device store ports and entity types.
export type {
  AnalyticsStore,
  AuthSignals,
  BlockAction,
  DailyAnalytics,
  DecidedVia,
  Decision,
  DecisionContext,
  DecisionScope,
  Domain,
  FilterSyncState,
  Frequency,
  MonthlyAnalytics,
  PriorityComponents,
  Profile,
  ProfilePrivacy,
  ProfileStore,
  Prompt,
  PromptRepo,
  RecencyBuckets,
  Repo,
  Sender,
  SenderCategory,
  Setting,
  SingletonStore,
  Store,
  TrustStatus,
} from "./store";

// Sender / domain extraction and categorisation (pure).
export {
  categorise,
  extractSenders,
  frequencyFor,
  parseAuthResults,
  parseFromHeader,
  HIGH_VOLUME_THRESHOLD,
  type CategorySignals,
  type ExtractResult,
  type ParsedAddress,
} from "./senders/extract";

// Recency bucketing / weighting helpers (pure).
export {
  ageInDays,
  aggregateRecency,
  bucketForAgeDays,
  emptyBuckets,
  RECENCY_WEIGHTS,
  type RecencyBucket,
} from "./senders/recency";

// Trust scoring (pure; v1 User×0.77 + Compliance×0.23, Network deferred).
export { computeTrustScore, type TrustScoreResult, type TrustSignal } from "./scoring/trustScore";
export { senderToSnapshot, type SenderSnapshot } from "./scoring/senderSnapshot";

// Prompt prioritisation (pure).
export {
  emptyDecisionHistory,
  prioritisePrompts,
  type PrioritisedPrompt,
  type UserDecisionHistory,
} from "./prioritisation/promptPriority";

// Prompt generation for persistence (pure).
export {
  generatePrompts,
  PROMPT_TTL_MS,
  type GeneratePromptsOptions,
} from "./prompts/generatePrompts";

// Trust-decision application + precedence (depends only on the Store port).
export {
  applyDecision,
  DEFER_DECAY,
  type ApplyDecisionInput,
  type ApplyDecisionResult,
} from "./decisions/applyDecision";
export {
  resolveEffectiveDecision,
  type EffectiveDecision,
  type EffectiveDecisionInput,
} from "./decisions/resolveEffectiveDecision";
export { defaultBlockActions } from "./decisions/blockActions";

// Bounded metadata scan orchestration (pure over the ports).
export { buildScanQuery, runScan, type RunScanOptions, type ScanResult } from "./scan/runScan";

// Incremental History-API sync (pure over the ports; M5).
export {
  incrementalSync,
  type IncrementalSyncOptions,
  type IncrementalSyncResult,
} from "./scan/incrementalSync";

// Native-filter compilation + reconciliation (pure).
export {
  compileFilters,
  reconcileFilters,
  BLOCK_FILTER_ADD_LABEL_IDS,
  BLOCK_FILTER_REMOVE_LABEL_IDS,
  DEFAULT_DOMAIN_BLOCK_THRESHOLD,
  DEFAULT_MAX_DOMAINS_PER_FILTER,
  DEFAULT_FILTER_SOFT_CAP,
  type CompileFiltersOptions,
  type CompiledFilters,
  type FilterReconcilePlan,
} from "./enforcement/compileFilters";

// Action planning (pure).
export { planActions, type ActionPlan, type PlanActionsInput } from "./enforcement/planActions";

// Enforcement orchestration (over the GmailClient + Store ports).
export {
  enforce,
  reconcileNativeFilters,
  FILTER_SYNC_KEY,
  type EnforceOptions,
  type EnforceResult,
  type EnforceFailure,
  type FilterReconcileOutcome,
} from "./enforcement/enforce";

// Analytics metrics (pure) — health, time-saved, breakdowns, achievements (M6).
export {
  achievements,
  categoryBreakdown,
  estimatedTimeSaved,
  healthInputFromSenders,
  inboxHealthScore,
  topDomainsByVolume,
  HEALTH_COVERAGE_WEIGHT,
  HEALTH_HYGIENE_WEIGHT,
  HEALTH_NEUTRAL,
  HEALTH_READ_WEIGHT,
  SECONDS_PER_BLOCKED_EMAIL,
  type Achievement,
  type AchievementInput,
  type CategoryStat,
  type DomainVolume,
  type InboxHealthInput,
  type TopDomainsOptions,
} from "./analytics/metrics";

// Analytics recording (thin over the Store port) + key helpers.
export {
  dateKey,
  emptyDaily,
  monthKey,
  recordDailyAnalytics,
  type DailyDelta,
} from "./analytics/record";

// Analytics summary, monthly rollup, and shareable snapshot (M6).
export {
  analyticsSummary,
  buildAnalyticsSummary,
  buildMonthlyAnalytics,
  buildSnapshot,
  snapshotText,
  timeSavedMinutes,
  DEFAULT_WINDOW_DAYS as ANALYTICS_WINDOW_DAYS,
  SNAPSHOT_VERSION,
  type AnalyticsSnapshot,
  type AnalyticsSummary,
  type AnalyticsSummaryOptions,
  type BuildAnalyticsSummaryInput,
  type TrendPoint,
  type WindowTotals,
} from "./analytics/summary";
