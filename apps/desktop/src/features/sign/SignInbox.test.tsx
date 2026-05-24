// @vitest-environment jsdom
// apps/desktop/src/features/sign/SignInbox.test.tsx
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { TransferPacket } from "@chain-pay/shared";
import type { OutgoingPacket } from "@/lib/comm/types";
import { SignInbox } from "./SignInbox";
import { useIncomingPacketsStore } from "@/stores/incoming-packets";
import { usePeerBookStore } from "@/stores/peer-book";

const SENDER_A_HASH = `0x${"aa".repeat(20)}` as const;
const SENDER_B_HASH = `0x${"bb".repeat(20)}` as const;

function packetFor(label: string, expiresAt: number): OutgoingPacket {
  return {
    txHash: `0x${label.padEnd(64, "0")}`,
    treasuryAddress: "ckt1qtrz",
    expiresAt,
    packet: `encoded-${label}` as TransferPacket,
  };
}

function reset(): void {
  useIncomingPacketsStore.setState({ bySighash: {} });
  usePeerBookStore.setState({ peers: [], knownSignersGetter: () => [] });
  globalThis.localStorage?.clear?.();
}

describe("SignInbox", () => {
  beforeEach(reset);
  afterEach(cleanup);

  it("renders empty-state copy when no entries", () => {
    render(<SignInbox onClaim={() => {}} />);
    expect(screen.getByText(/no comm packets pending/i)).toBeInTheDocument();
  });

  it("renders one row per entry", () => {
    const p1 = packetFor("aa", Math.floor(Date.now() / 1000) + 3600);
    const p2 = packetFor("bb", Math.floor(Date.now() / 1000) + 7200);
    useIncomingPacketsStore.getState().enqueue({
      sighashDigest: p1.txHash, packet: p1, senderAddrHash: SENDER_A_HASH, receivedAt: 1,
    });
    useIncomingPacketsStore.getState().enqueue({
      sighashDigest: p2.txHash, packet: p2, senderAddrHash: SENDER_B_HASH, receivedAt: 2,
    });
    render(<SignInbox onClaim={() => {}} />);
    expect(screen.getAllByRole("button", { name: /sign/i })).toHaveLength(2);
  });

  it("clicking Sign calls onClaim with that entry", () => {
    const p = packetFor("aa", Math.floor(Date.now() / 1000) + 3600);
    useIncomingPacketsStore.getState().enqueue({
      sighashDigest: p.txHash, packet: p, senderAddrHash: SENDER_A_HASH, receivedAt: 1,
    });
    const onClaim = vi.fn();
    render(<SignInbox onClaim={onClaim} />);
    fireEvent.click(screen.getByRole("button", { name: /sign/i }));
    expect(onClaim).toHaveBeenCalledWith(expect.objectContaining({ sighashDigest: p.txHash }));
  });

  it("clicking Dismiss removes the entry from the store", () => {
    const p = packetFor("aa", Math.floor(Date.now() / 1000) + 3600);
    useIncomingPacketsStore.getState().enqueue({
      sighashDigest: p.txHash, packet: p, senderAddrHash: SENDER_A_HASH, receivedAt: 1,
    });
    render(<SignInbox onClaim={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(useIncomingPacketsStore.getState().bySighash[p.txHash]).toBeUndefined();
  });

  it("filters out expired entries (does not render)", () => {
    const expiredP = packetFor("aa", Math.floor(Date.now() / 1000) - 60);
    useIncomingPacketsStore.getState().enqueue({
      sighashDigest: expiredP.txHash, packet: expiredP, senderAddrHash: SENDER_A_HASH, receivedAt: 1,
    });
    render(<SignInbox onClaim={() => {}} />);
    expect(screen.getByText(/no comm packets pending/i)).toBeInTheDocument();
  });

  it("sorts entries newest-first by receivedAt", () => {
    const older = packetFor("aa", Math.floor(Date.now() / 1000) + 3600);
    const newer = packetFor("bb", Math.floor(Date.now() / 1000) + 3600);
    useIncomingPacketsStore.getState().enqueue({
      sighashDigest: older.txHash, packet: older, senderAddrHash: SENDER_A_HASH, receivedAt: 1,
    });
    useIncomingPacketsStore.getState().enqueue({
      sighashDigest: newer.txHash, packet: newer, senderAddrHash: SENDER_B_HASH, receivedAt: 2,
    });
    render(<SignInbox onClaim={() => {}} />);
    const buttons = screen.getAllByRole("button", { name: /sign/i });
    // First button (top of list) is for the newer entry.
    expect(buttons[0]!.closest("li")).toHaveTextContent(/bb/);
  });
});
