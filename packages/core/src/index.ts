export { keyFor } from "./keys";
export { trustTier, type TrustTier, type TrustTierName, type TrustTierColour } from "./trust/tiers";

// Provider-client port (Gmail).
export {
  GMAIL_READONLY_SCOPE,
  type AccessToken,
  type GmailClient,
  type MessageHeaders,
  type MessageMeta,
  type ScopeTier,
} from "./ports/GmailClient";

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
