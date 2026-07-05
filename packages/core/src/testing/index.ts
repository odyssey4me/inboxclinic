/**
 * Test-support entry point — exposed as `@inboxclinic/core/testing`.
 *
 * Importable by both `packages/core` tests and `apps/web` tests so the fixture
 * builders, the boundary mock, and the in-memory store fake are shared. Never import
 * this from production code.
 */

export {
  messageMetaBuilder,
  inboxFromSender,
  senderBuilder,
  domainBuilder,
  type MessageMetaOverrides,
} from "./builders";
export { MockGmailClient, type BatchModifyCall } from "./MockGmailClient";
export { MockBackupClient } from "./MockBackupClient";
export { InMemoryStore, createInMemoryStore } from "./inMemoryStore";
