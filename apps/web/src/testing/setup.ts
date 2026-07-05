// SPDX-License-Identifier: Apache-2.0
import "@testing-library/jest-dom/vitest";

import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// With `globals: false`, Testing Library's automatic afterEach cleanup is not
// registered, so unmount rendered trees between tests explicitly.
afterEach(() => {
  cleanup();
});
