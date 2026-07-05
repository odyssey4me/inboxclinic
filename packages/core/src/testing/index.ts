// SPDX-License-Identifier: Apache-2.0
/**
 * Test-support entry point — exposed as `@inboxclinic/core/testing`.
 *
 * The in-memory fakes and fixture builders are the **shippable** implementations from
 * `../demo` (`@inboxclinic/core/demo`); this barrel re-exports them under their
 * historical test names (`MockGmailClient`, `MockBackupClient`) so tests read naturally.
 * Never import this from production code — production uses `@inboxclinic/core/demo`.
 */

export {
  messageMetaBuilder,
  inboxFromSender,
  senderBuilder,
  domainBuilder,
  type MessageMetaOverrides,
} from "../demo/builders";
export {
  InMemoryGmailClient as MockGmailClient,
  type BatchModifyCall,
} from "../demo/inMemoryGmail";
export { InMemoryBackupClient as MockBackupClient } from "../demo/inMemoryBackup";
export { InMemoryStore, createInMemoryStore } from "../demo/inMemoryStore";
