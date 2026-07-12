// SPDX-License-Identifier: Apache-2.0
import type { DiagnosticReport, ReportingClient } from "@inboxclinic/core";
import { createInMemoryStore } from "@inboxclinic/core/testing";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ReportProblem } from "./ReportProblem";

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("ReportProblem", () => {
  it("shows a redacted preview and offers copy/download but no send without a client", async () => {
    const store = createInMemoryStore();
    const { container } = render(
      <ReportProblem
        store={store}
        initial={{ message: "429 for /messages/19efa38b32b35328 (news@retailco.com)" }}
      />,
    );

    // The preview reflects the redacted summary; the message id and email are masked.
    await waitFor(() => expect(screen.getByText(/Exactly what will be sent/)).toBeInTheDocument());
    const preview = container.querySelector("pre")?.textContent ?? "";
    expect(preview).toContain("/messages/[id]");
    expect(preview).toContain("[email]");
    expect(preview).not.toContain("19efa38b32b35328");

    expect(screen.getByRole("button", { name: /^Copy$/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Download$/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /send report/i })).not.toBeInTheDocument();
  });

  it("copies the preview to the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const store = createInMemoryStore();

    render(<ReportProblem store={store} initial={{ message: "boom" }} />);
    fireEvent.click(screen.getByRole("button", { name: /^Copy$/ }));

    await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    expect(writeText.mock.calls[0]?.[0]).toContain("**Summary:** boom");
  });

  it("submits via the client and surfaces the returned reference", async () => {
    const submit = vi.fn(async (_r: DiagnosticReport, _t: string) => ({
      ref: "https://github.com/x/y/issues/1",
    }));
    const client: ReportingClient = { submit };
    const store = createInMemoryStore();

    render(
      <ReportProblem
        store={store}
        initial={{ message: "boom" }}
        client={client}
        getHumanToken={async () => "turnstile-token"}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: /send report/i }));

    await waitFor(() => expect(screen.getByText(/your report was sent/i)).toBeInTheDocument());
    expect(submit).toHaveBeenCalledOnce();
    expect(submit.mock.calls[0]?.[1]).toBe("turnstile-token");
    // The install ID is passed as a field (kept server-side), never shown in the body.
    expect(submit.mock.calls[0]?.[0].installId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
