// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { RescanControl } from "./RescanControl";
import type { Source } from "@chain-pay/shared";

afterEach(cleanup);

const source: Source = {
  id: "a", label: "Ops", chain: "ckb:testnet", address: "ckt1qsource",
  joyidLockArgs: ("0x" + "11".repeat(20)) as `0x${string}`,
  createdAt: "2026-06-25T00:00:00Z", updatedAt: "2026-06-25T00:00:00Z",
};

function setup(rescan = vi.fn(async () => {})) {
  const getTip = vi.fn(async () => 1_000_000n);
  render(<RescanControl source={source} rescan={rescan} getTip={getTip} />);
  return { rescan, getTip };
}

describe("RescanControl", () => {
  it("rescans from genesis (0n) when 'From genesis' is clicked", async () => {
    const { rescan } = setup();
    fireEvent.click(screen.getByRole("button", { name: /rescan/i })); // open disclosure
    fireEvent.click(screen.getByRole("button", { name: /from genesis/i }));
    await waitFor(() => expect(rescan).toHaveBeenCalledWith(source, 0n));
  });

  it("rescans from a valid custom block", async () => {
    const { rescan } = setup();
    fireEvent.click(screen.getByRole("button", { name: /rescan/i }));
    fireEvent.change(screen.getByLabelText(/from block/i), { target: { value: "12345" } });
    fireEvent.click(screen.getByRole("button", { name: /^go$/i }));
    await waitFor(() => expect(rescan).toHaveBeenCalledWith(source, 12_345n));
  });

  it("shows a field error and does not call rescan for invalid input", async () => {
    const { rescan } = setup();
    fireEvent.click(screen.getByRole("button", { name: /rescan/i }));
    fireEvent.change(screen.getByLabelText(/from block/i), { target: { value: "12.5" } });
    fireEvent.click(screen.getByRole("button", { name: /^go$/i }));
    expect(await screen.findByText(/whole number/i)).toBeInTheDocument();
    expect(rescan).not.toHaveBeenCalled();
  });

  it("shows a rescanning status line after a successful rescan", async () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: /rescan/i }));
    fireEvent.click(screen.getByRole("button", { name: /from genesis/i }));
    expect(await screen.findByText(/balance updates as the light client syncs/i)).toBeInTheDocument();
  });
});
