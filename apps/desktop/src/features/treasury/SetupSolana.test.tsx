// @vitest-environment jsdom
import bs58 from "bs58";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { MemoryRouter } from "react-router-dom";
import { SetupSolana } from "./SetupSolana";
import { useTreasuryStore } from "@/stores/treasury";

const address = bs58.encode(new Uint8Array(32).fill(9));
const secretKey = bs58.encode(new Uint8Array(64).fill(9));

beforeEach(() => useTreasuryStore.setState({ treasuries: [], activeTreasuryId: null }));
afterEach(cleanup);

describe("SetupSolana", () => {
  it("persists only a canonical public watch address", async () => {
    render(<MemoryRouter><SetupSolana /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText("Label"), { target: { value: "Solana reserve" } });
    fireEvent.change(screen.getByLabelText("Network"), { target: { value: "sol:mainnet" } });
    fireEvent.change(screen.getByLabelText("Public account address"), { target: { value: address } });
    fireEvent.click(screen.getByRole("button", { name: "Validate and add" }));
    await waitFor(() => expect(useTreasuryStore.getState().treasuries).toHaveLength(1));
    expect(useTreasuryStore.getState().treasuries[0]).toMatchObject({ kind: "solana-watch", watch: { chain: "sol:mainnet", address } });
    expect(JSON.stringify(useTreasuryStore.getState().treasuries)).not.toContain("secretKey");
  });

  it("rejects a 64-byte base58 secret key without persistence", async () => {
    render(<MemoryRouter><SetupSolana /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText("Label"), { target: { value: "No secrets" } });
    fireEvent.change(screen.getByLabelText("Public account address"), { target: { value: secretKey } });
    fireEvent.click(screen.getByRole("button", { name: "Validate and add" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/32 bytes/i);
    expect(useTreasuryStore.getState().treasuries).toHaveLength(0);
  });
});
