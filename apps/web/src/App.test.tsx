import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { App } from "./App";

describe("App", () => {
  it("renders the product name", () => {
    render(<App />);
    expect(screen.getByRole("heading", { name: /inbox clinic/i })).toBeInTheDocument();
  });

  it("renders the one-line tagline", () => {
    render(<App />);
    expect(screen.getByText(/take back control of your inbox/i)).toBeInTheDocument();
  });
});
