// SPDX-License-Identifier: Apache-2.0
// Provide an in-memory IndexedDB so the Dexie adapter can be exercised in a plain
// node test environment. See docs/design-testing.md (Decision: fake-indexeddb).
import "fake-indexeddb/auto";
