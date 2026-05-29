import { describe, expect, it } from "vitest";
import type { InvoiceApprovalStatus } from "@chain-pay/shared";
import { assertCanTransitionInvoice, canTransitionInvoice, isTerminalInvoice, nextInvoiceStates } from "./state-machine";

describe("invoice state machine", () => {
  it("draft → in-review is legal", () => {
    expect(canTransitionInvoice("draft", "in-review")).toBe(true);
  });

  it("draft → signed is illegal (must pass through in-review and queued)", () => {
    expect(canTransitionInvoice("draft", "signed")).toBe(false);
  });

  it("in-review → queued-for-signing is legal", () => {
    expect(canTransitionInvoice("in-review", "queued-for-signing")).toBe(true);
  });

  it("in-review → rejected is legal", () => {
    expect(canTransitionInvoice("in-review", "rejected")).toBe(true);
  });

  it("queued-for-signing → signed is legal", () => {
    expect(canTransitionInvoice("queued-for-signing", "signed")).toBe(true);
  });

  it("queued-for-signing → rejected is illegal (cancel batch first)", () => {
    expect(canTransitionInvoice("queued-for-signing", "rejected")).toBe(false);
  });

  it("signed is terminal", () => {
    expect(isTerminalInvoice("signed")).toBe(true);
    expect(canTransitionInvoice("signed", "rejected")).toBe(false);
  });

  it("rejected is terminal", () => {
    expect(isTerminalInvoice("rejected")).toBe(true);
  });

  it("same-state transitions always illegal", () => {
    const all: InvoiceApprovalStatus[] = ["draft", "in-review", "queued-for-signing", "signed", "rejected", "auto-rejected"];
    for (const s of all) expect(canTransitionInvoice(s, s)).toBe(false);
  });

  it("assertCanTransitionInvoice throws on illegal", () => {
    expect(() => assertCanTransitionInvoice("signed", "draft")).toThrow(/invalid invoice transition/);
  });

  it("nextInvoiceStates returns forward set for in-review", () => {
    expect(nextInvoiceStates("in-review").sort()).toEqual(["queued-for-signing", "rejected"]);
  });
});
