// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { Treasury } from "@chain-pay/shared";

// The AddPeerForm needs to derive a 20-byte hash from the pasted address. We
// mock peerHashFromAddress so tests don't need a real cemp-pq lock address —
// any string is acceptable and the resulting hash is deterministic per input.
vi.mock("@/lib/comm/peer-hash", () => ({
  peerHashFromAddress: async (addr: string) => {
    const out = new Uint8Array(20);
    // Cheap deterministic hash: char codes mod 256.
    for (let i = 0; i < 20; i++) out[i] = addr.charCodeAt(i % addr.length) & 0xff;
    return out;
  },
}));

import { PeerBookSection } from "./PeerBookSection";
import { usePeerBookStore } from "@/stores/peer-book";
import { useTreasuryStore } from "@/stores/treasury";

const HASH_A = `0x${"a1".repeat(20)}` as const;
const HASH_B = `0x${"b2".repeat(20)}` as const;

function makeTreasury(label: string, hashes: readonly `0x${string}`[]): Treasury {
  return {
    id: `t-${label}`,
    label,
    multisig: {
      chain: "ckb:testnet",
      s: 0,
      r: 0,
      m: hashes.length,
      n: hashes.length,
      pubkeyHashes: [...hashes],
      address: `ckt1qmultisig-${label}`,
    },
    createdAt: "2026-05-01T00:00:00Z",
    updatedAt: "2026-05-01T00:00:00Z",
  };
}

function reset(): void {
  usePeerBookStore.setState({ peers: [], knownSignersGetter: () => [] });
  useTreasuryStore.setState({ treasuries: [] });
  globalThis.localStorage?.removeItem("chain-pay:peer-book");
  globalThis.localStorage?.removeItem("chain-pay:treasuries");
}

describe("PeerBookSection", () => {
  beforeEach(reset);
  afterEach(cleanup);

  it("renders the empty-state message when no peers are paired", () => {
    render(<PeerBookSection />);
    expect(screen.getByText(/no peers paired yet/i)).toBeInTheDocument();
  });

  it("renders one PeerRow per peer in the store", () => {
    usePeerBookStore.getState().addPeer(
      { nickname: "Alice", address: "ckt1qalice", pairedAt: 0 },
      new Uint8Array(20),
    );
    usePeerBookStore.getState().addPeer(
      { nickname: "Bob", address: "ckt1qbob", pairedAt: 0 },
      new Uint8Array(20).fill(0x01),
    );
    render(<PeerBookSection />);
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("Bob")).toBeInTheDocument();
  });

  it("opens the AddPeerForm when Add peer is clicked and adds a peer on submit", async () => {
    render(<PeerBookSection />);
    fireEvent.click(screen.getByRole("button", { name: /add peer/i }));

    fireEvent.change(screen.getByLabelText(/nickname/i), { target: { value: "Charlie" } });
    fireEvent.change(screen.getByLabelText(/address/i), { target: { value: "ckt1qcharlie" } });
    fireEvent.click(screen.getByRole("button", { name: /add peer/i }));

    await waitFor(() =>
      expect(usePeerBookStore.getState().peers.some((p) => p.nickname === "Charlie")).toBe(true),
    );
  });

  it("AddPeerForm enumerates signer options from every treasury's pubkeyHashes", () => {
    useTreasuryStore.setState({
      treasuries: [makeTreasury("Main", [HASH_A]), makeTreasury("Backup", [HASH_B])],
    });
    render(<PeerBookSection />);
    fireEvent.click(screen.getByRole("button", { name: /add peer/i }));
    const select = screen.getByLabelText(/associated signer/i) as HTMLSelectElement;
    const opts = Array.from(select.options).map((o) => o.textContent);
    expect(opts.some((t) => t?.includes("Main — slot 0"))).toBe(true);
    expect(opts.some((t) => t?.includes("Backup — slot 0"))).toBe(true);
  });

  it("AddPeerForm surfaces RefusalInvariantError when the address collides with a treasury signer", async () => {
    const collidingHash = new Uint8Array(20);
    // Same deterministic hash the mock produces for this address — char codes mod 256.
    const addr = "ckt1qcollision";
    for (let i = 0; i < 20; i++) collidingHash[i] = addr.charCodeAt(i % addr.length) & 0xff;
    usePeerBookStore.setState({
      knownSignersGetter: () => [{ treasuryId: "t1", pubkeyHash: collidingHash }],
    });

    render(<PeerBookSection />);
    fireEvent.click(screen.getByRole("button", { name: /add peer/i }));
    fireEvent.change(screen.getByLabelText(/nickname/i), { target: { value: "Mallory" } });
    fireEvent.change(screen.getByLabelText(/address/i), { target: { value: addr } });
    fireEvent.click(screen.getByRole("button", { name: /add peer/i }));

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(usePeerBookStore.getState().peers).toHaveLength(0);
  });

  it("PeerRow remove button drops the peer from the store", () => {
    usePeerBookStore.getState().addPeer(
      { nickname: "Alice", address: "ckt1qalice", pairedAt: 0 },
      new Uint8Array(20),
    );
    render(<PeerBookSection />);
    fireEvent.click(screen.getByRole("button", { name: /remove/i }));
    expect(usePeerBookStore.getState().peers).toEqual([]);
  });

  it("PeerRow edit lets the operator rename + reassociate", async () => {
    usePeerBookStore.getState().addPeer(
      { nickname: "Alice", address: "ckt1qalice", pairedAt: 0 },
      new Uint8Array(20),
    );
    useTreasuryStore.setState({ treasuries: [makeTreasury("Main", [HASH_A])] });

    render(<PeerBookSection />);
    fireEvent.click(screen.getByRole("button", { name: /edit/i }));

    fireEvent.change(screen.getByLabelText(/edit nickname/i), { target: { value: "Alicia" } });
    fireEvent.change(screen.getByLabelText(/edit associated signer/i), { target: { value: HASH_A } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => {
      const updated = usePeerBookStore.getState().peers[0]!;
      expect(updated.nickname).toBe("Alicia");
      expect(updated.associatedSignerHash).toBe(HASH_A);
    });
  });

  it("PeerRow edit surfaces an error when reassociating to a hash another peer already owns", async () => {
    usePeerBookStore.getState().addPeer(
      { nickname: "Alice", address: "ckt1qalice", pairedAt: 0, associatedSignerHash: HASH_A },
      new Uint8Array(20),
    );
    usePeerBookStore.getState().addPeer(
      { nickname: "Bob", address: "ckt1qbob", pairedAt: 0 },
      new Uint8Array(20).fill(0x01),
    );
    useTreasuryStore.setState({ treasuries: [makeTreasury("Main", [HASH_A, HASH_B])] });

    render(<PeerBookSection />);
    // Edit Bob (index 1) — click the second edit button.
    const editButtons = screen.getAllByRole("button", { name: /edit/i });
    fireEvent.click(editButtons[1]!);

    fireEvent.change(screen.getByLabelText(/edit associated signer/i), { target: { value: HASH_A } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    // Bob unchanged
    expect(usePeerBookStore.getState().peers[1]!.associatedSignerHash).toBeUndefined();
  });
});
