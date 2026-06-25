// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { SendHistory } from "./SendHistory";
import { useSendsStore } from "@/stores/sends";
import type { SendRecord } from "@chain-pay/shared";

afterEach(cleanup);

beforeEach(() => {
  const mem = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
    clear: () => mem.clear(),
    key: () => null,
    length: 0,
  } as Storage;
  useSendsStore.setState({ sends: [] });
});

function makeSend(id: string, state: SendRecord["state"]): SendRecord {
  return {
    id,
    sourceId: "src1",
    chain: "ckb:testnet",
    outputs: [
      {
        payeeId: "p1",
        payeeAddress: "ckt1qpayee000000000000000000",
        amount: { asset: "CKB", value: 7_000_000_000n, decimals: 8 },
        fiat: { currency: "AUD", minor: 10000n },
      },
    ],
    feeShannons: 1200n,
    state,
    txHash: "0xabcdef1234567890",
    createdAt: "2026-06-25T00:00:00Z",
    updatedAt: "2026-06-25T00:00:00Z",
  };
}

describe("SendHistory — Mark confirmed button", () => {
  it("renders a 'Mark confirmed' button for a broadcasted send and clicking it transitions to confirmed", () => {
    useSendsStore.setState({ sends: [makeSend("send-1", "broadcasted")] });
    render(<SendHistory />);

    const btn = screen.getByRole("button", { name: /mark confirmed/i });
    expect(btn).toBeInTheDocument();

    fireEvent.click(btn);

    const updated = useSendsStore.getState().sends.find((s) => s.id === "send-1");
    expect(updated?.state).toBe("confirmed");
  });

  it("does NOT render a 'Mark confirmed' button for a send in any other state", () => {
    useSendsStore.setState({ sends: [makeSend("send-2", "posted")] });
    render(<SendHistory />);

    expect(
      screen.queryByRole("button", { name: /mark confirmed/i }),
    ).toBeNull();
  });
});
