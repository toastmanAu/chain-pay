// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { NetworkRestartModal } from "./NetworkRestartModal";

describe("NetworkRestartModal", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders the from→to network names", () => {
    render(
      <NetworkRestartModal
        fromNetwork="testnet"
        toNetwork="mainnet"
        onCancel={() => {}}
        onConfirm={() => {}}
      />
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toMatch(/testnet/i);
    expect(dialog.textContent).toMatch(/mainnet/i);
    expect(dialog.textContent).toMatch(/switching from/i);
  });

  it("renders the preservation guarantee", () => {
    render(
      <NetworkRestartModal
        fromNetwork="testnet"
        toNetwork="mainnet"
        onCancel={() => {}}
        onConfirm={() => {}}
      />
    );
    expect(
      screen.getByText(/treasuries, payees, and payroll batches are preserved/i)
    ).toBeInTheDocument();
  });

  it("Cancel button fires onCancel", () => {
    const onCancel = vi.fn();
    render(
      <NetworkRestartModal
        fromNetwork="testnet"
        toNetwork="mainnet"
        onCancel={onCancel}
        onConfirm={() => {}}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("Quit button fires onConfirm", () => {
    const onConfirm = vi.fn();
    render(
      <NetworkRestartModal
        fromNetwork="testnet"
        toNetwork="mainnet"
        onCancel={() => {}}
        onConfirm={onConfirm}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /quit/i }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });
});
