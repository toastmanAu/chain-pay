// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { MemoryRouter } from "react-router-dom";
import { SetupBitcoin } from "./SetupBitcoin";
import { useTreasuryStore } from "@/stores/treasury";

const ADDRESS = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";
const XPRV =
  "xprvA1RpRA33e1JQ7ifknakTFpgNXPmW2YvmhqLQYMmrj4xJXXWYpDPS3xz7iAxn8L39njGVyuoseXzU6rcxFLJ8HFsTjSyQbLYnMpCqE2VbFWc";

beforeEach(() => {
  useTreasuryStore.setState({ treasuries: [], activeTreasuryId: null });
});

afterEach(cleanup);

function renderSetup(): void {
  render(<MemoryRouter><SetupBitcoin /></MemoryRouter>);
}

describe("SetupBitcoin", () => {
  it("validates and persists a network- and script-bound watch address", async () => {
    renderSetup();
    fireEvent.change(screen.getByLabelText("Label"), { target: { value: "Bitcoin reserve" } });
    fireEvent.change(screen.getByLabelText("Network"), { target: { value: "btc:mainnet" } });
    fireEvent.change(screen.getByLabelText("Bitcoin address"), { target: { value: ADDRESS } });
    fireEvent.click(screen.getByRole("button", { name: "Validate and add" }));

    await waitFor(() => expect(useTreasuryStore.getState().treasuries).toHaveLength(1));
    expect(useTreasuryStore.getState().treasuries[0]).toMatchObject({
      kind: "bitcoin-watch",
      label: "Bitcoin reserve",
      watch: {
        chain: "btc:mainnet",
        source: { kind: "address", address: ADDRESS, scriptType: "p2wpkh" },
      },
    });
  });

  it("rejects cross-network addresses without persisting", async () => {
    renderSetup();
    fireEvent.change(screen.getByLabelText("Label"), { target: { value: "Wrong network" } });
    fireEvent.change(screen.getByLabelText("Bitcoin address"), { target: { value: ADDRESS } });
    fireEvent.click(screen.getByRole("button", { name: "Validate and add" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/testnet/i);
    expect(useTreasuryStore.getState().treasuries).toHaveLength(0);
  });

  it("refuses private extended keys in the xpub flow", async () => {
    renderSetup();
    fireEvent.change(screen.getByLabelText("Label"), { target: { value: "No secrets" } });
    fireEvent.change(screen.getByLabelText("Network"), { target: { value: "btc:mainnet" } });
    fireEvent.click(screen.getByRole("button", { name: "Account xpub" }));
    fireEvent.change(screen.getByLabelText("Account xpub"), { target: { value: XPRV } });
    fireEvent.click(screen.getByRole("button", { name: "Validate and add" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/private extended keys/i);
    expect(useTreasuryStore.getState().treasuries).toHaveLength(0);
  });
});
