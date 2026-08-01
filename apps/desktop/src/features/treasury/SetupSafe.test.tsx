// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { MemoryRouter } from "react-router-dom";
import { SetupSafe } from "./SetupSafe";
import { useTreasuryStore } from "@/stores/treasury";
import { readSafeSnapshot } from "@/lib/chains/evm/safe-reader";

vi.mock("@/lib/chains/evm/safe-reader", () => ({ readSafeSnapshot: vi.fn() }));

const SAFE = "0x1234567890123456789012345678901234567890";

beforeEach(() => {
  useTreasuryStore.setState({ treasuries: [], activeTreasuryId: null });
  vi.mocked(readSafeSnapshot).mockResolvedValue({
    chainId: 11155111,
    address: SAFE,
    owners: [
      "0x1111111111111111111111111111111111111111",
      "0x2222222222222222222222222222222222222222",
    ],
    threshold: 2,
    version: "1.4.1",
    balanceWei: 0n,
    blockNumber: 7_000_000n,
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SetupSafe", () => {
  it("verifies and persists Safe-owned configuration", async () => {
    render(
      <MemoryRouter>
        <SetupSafe />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByLabelText("Label"), { target: { value: "Ops Safe" } });
    fireEvent.change(screen.getByLabelText("Safe contract address"), { target: { value: SAFE } });
    fireEvent.click(screen.getByRole("button", { name: "Verify and add Safe" }));

    await waitFor(() => expect(useTreasuryStore.getState().treasuries).toHaveLength(1));
    expect(readSafeSnapshot).toHaveBeenCalledWith(11155111, SAFE);
    expect(useTreasuryStore.getState().treasuries[0]?.multisig).toMatchObject({
      chain: "evm:11155111",
      address: SAFE,
      threshold: 2,
      version: "1.4.1",
    });
  });

  it("surfaces verification errors without saving", async () => {
    vi.mocked(readSafeSnapshot).mockRejectedValue(new Error("No contract is deployed"));
    render(
      <MemoryRouter>
        <SetupSafe />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByLabelText("Label"), { target: { value: "Not a Safe" } });
    fireEvent.change(screen.getByLabelText("Safe contract address"), { target: { value: SAFE } });
    fireEvent.click(screen.getByRole("button", { name: "Verify and add Safe" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("No contract is deployed");
    expect(useTreasuryStore.getState().treasuries).toHaveLength(0);
  });
});
