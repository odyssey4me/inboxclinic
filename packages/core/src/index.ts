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
  DailyAnalytics,
  Domain,
  FilterSyncState,
  MonthlyAnalytics,
  Profile,
  ProfilePrivacy,
  ProfileStore,
  Prompt,
  PromptRepo,
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
  parseFromHeader,
  HIGH_VOLUME_THRESHOLD,
  type CategorySignals,
  type ExtractResult,
  type ParsedAddress,
} from "./senders/extract";

// Bounded metadata scan orchestration (pure over the ports).
export { buildScanQuery, runScan, type RunScanOptions, type ScanResult } from "./scan/runScan";
