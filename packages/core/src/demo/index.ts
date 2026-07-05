// SPDX-License-Identifier: Apache-2.0
/**
 * Demo-mode entry point — exposed as `@inboxclinic/core/demo`.
 *
 * A **production-shippable** module (unlike `@inboxclinic/core/testing`): the in-memory
 * client fakes plus curated fixtures that power the app's no-Google "Explore the demo"
 * path (design-frontend.md — Demo mode). The tests re-use the same fakes via the
 * `testing` barrel; nothing here depends on a test framework.
 */

export {
  createDemoEnvironment,
  seedDemoStore,
  type DemoEnvironment,
  type SeedDemoOptions,
} from "./seedDemo";
export { DEMO_ACCOUNT_EMAIL, DEMO_HISTORY_ID, demoInbox, DEMO_DECISIONS } from "./demoData";
export { InMemoryGmailClient, type BatchModifyCall } from "./inMemoryGmail";
export { InMemoryBackupClient } from "./inMemoryBackup";
export { InMemoryStore, createInMemoryStore } from "./inMemoryStore";
