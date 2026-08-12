// @vitest-environment jsdom
//
// Characterization tests for PayPanel — draft, build, packet, signature
// gating and broadcast. Batch lifecycle, resume-hydration and FX live in
// PayPanel.batch.test.tsx. Shared fixtures/harness: PayPanel.fixtures.tsx.
//
// These pin CURRENT behaviour, including behaviour that is wrong. Anything
// marked BUG PIN is a real defect recorded on purpose so the Task 14/15 split
// can be proven behaviour-preserving. Do not "fix" a pinned bug while
// splitting the component.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const listCellsForLock = vi.hoisted(() => vi.fn());
const broadcastTransaction = vi.hoisted(() => vi.fn());
const assertGuardSpy = vi.hoisted(() => vi.fn());
const dumpInputsSpy = vi.hoisted(() => vi.fn());

// Everything that reaches the network, the chain, or the WASM light client is
// replaced. Every *pure* helper (address derivation, unit conversion, FX
// arithmetic, formatting) stays real, so assertions below are computed by
// production code rather than restated by the test.
vi.mock("@/lib/light-client/client", () => ({
  lightClient: () => ({
    listCellsForLock,
    broadcastTransaction,
    // @/stores/sync registers these two at module load.
    onSnapshot: vi.fn(),
    onError: vi.fn(),
    isStarted: () => false,
    currentNetwork: () => null,
    start: vi.fn(),
    stop: vi.fn(),
    setBroadcastRpcUrl: vi.fn(),
    getBroadcastRpcUrl: () => "",
  }),
}));
vi.mock("@/lib/chains/ckb/tx-builder", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/chains/ckb/tx-builder")>()),
  buildPaymentSkeleton: vi.fn(),
}));
vi.mock("@/lib/chains/ckb/transfer-packet", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/chains/ckb/transfer-packet")>()),
  encodeTransferPacket: vi.fn(),
  treasurySighashDigest: vi.fn(),
}));
vi.mock("@/lib/chains/ckb/merge-signatures", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/chains/ckb/merge-signatures")>()),
  mergeSignatures: vi.fn(),
}));
vi.mock("@/lib/fx/coingecko", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/fx/coingecko")>()),
  fetchCkbPrices: vi.fn(),
}));
vi.mock("@/lib/chains/ckb/multisig-assert", () => ({
  assertMultisigBytesMatchTreasury: assertGuardSpy,
  dumpInputsForInspection: dumpInputsSpy,
}));

import { buildPaymentSkeleton } from "@/lib/chains/ckb/tx-builder";
import { encodeTransferPacket } from "@/lib/chains/ckb/transfer-packet";
import { mergeSignatures } from "@/lib/chains/ckb/merge-signatures";
import { useTreasuryStore } from "@/stores/treasury";
import { useNetworkConfigStore } from "@/stores/network-config";
import { treasuryLockScript } from "@/lib/chains/ckb/address";
import { lockFromAddress } from "@/lib/chains/ckb/address-lock";
import {
  addressInputs,
  amountInputs,
  broadcastButton,
  buildButton,
  buildOnce,
  CFG_A,
  CFG_B,
  ckbTreasury,
  currentSkeletonTx,
  DIGEST,
  fillAllSignatures,
  PACKET_JSON,
  primeMocks,
  primeStores,
  RECIPIENT_ADDRESS,
  RECIPIENT_ADDRESS_2,
  renderPanel,
  sigBoxes,
  syncState,
  TREASURY_A,
  TX_HASH,
} from "./PayPanel.fixtures";
import { useSyncStore } from "@/stores/sync";

const spies = {
  listCellsForLock,
  broadcastTransaction,
  assertGuard: assertGuardSpy,
  dumpInputs: dumpInputsSpy,
};

beforeEach(() => {
  primeStores();
  primeMocks(spies);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("PayPanel — empty state", () => {
  it("offers a link to create a multisig when no CKB treasury exists", () => {
    useTreasuryStore.setState({ treasuries: [], activeTreasuryId: null });
    renderPanel();
    expect(screen.getByText(/No CKB treasuries yet\./)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Create a multisig" })).toHaveAttribute(
      "href",
      "/treasury/new",
    );
    expect(screen.queryByPlaceholderText("ckb1… or ckt1…")).not.toBeInTheDocument();
  });
});

describe("PayPanel — draft phase", () => {
  it("starts with exactly one recipient row whose remove button is disabled", () => {
    renderPanel();
    expect(addressInputs()).toHaveLength(1);
    expect(screen.getByRole("button", { name: "×" })).toBeDisabled();
  });

  it("shows the selected treasury's derived address and its M-of-N label", () => {
    renderPanel();
    expect(screen.getByText(TREASURY_A.multisig.address as string)).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Ops treasury (2-of-3)" })).toBeInTheDocument();
  });

  it("adds a recipient row and enables removal once there are two", () => {
    renderPanel();
    fireEvent.click(screen.getByText("+ add recipient"));
    expect(addressInputs()).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "×" })[0]).not.toBeDisabled();
  });

  it("removes the row that was clicked, keeping the others' values", () => {
    renderPanel();
    fireEvent.click(screen.getByText("+ add recipient"));
    fireEvent.change(addressInputs()[0]!, { target: { value: RECIPIENT_ADDRESS } });
    fireEvent.change(addressInputs()[1]!, { target: { value: RECIPIENT_ADDRESS_2 } });
    fireEvent.click(screen.getAllByRole("button", { name: "×" })[0]!);
    const remaining = addressInputs();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toHaveValue(RECIPIENT_ADDRESS_2);
  });

  it("strips non-digits from the fee rate input", () => {
    renderPanel();
    const feeRate = screen.getByDisplayValue("1000");
    fireEvent.change(feeRate, { target: { value: "12a3b" } });
    expect(feeRate).toHaveValue("123");
  });

  it("disables Build until the light client is started", () => {
    useSyncStore.setState({ ckb: syncState({ started: false }) });
    renderPanel();
    expect(screen.getByRole("button", { name: /waiting for sync/ })).toBeDisabled();
  });

  it("still treats a started client with zero peers as not synced", () => {
    useSyncStore.setState({ ckb: syncState({ peers: 0 }) });
    renderPanel();
    expect(screen.getByRole("button", { name: /waiting for sync/ })).toBeDisabled();
  });
});

describe("PayPanel — build", () => {
  it("passes the decoded recipients, treasury script and fee rate to buildPaymentSkeleton", async () => {
    renderPanel();
    fireEvent.click(screen.getByText("+ add recipient"));
    fireEvent.change(addressInputs()[0]!, { target: { value: RECIPIENT_ADDRESS } });
    fireEvent.change(amountInputs()[0]!, { target: { value: "100" } });
    fireEvent.change(addressInputs()[1]!, { target: { value: RECIPIENT_ADDRESS_2 } });
    fireEvent.change(amountInputs()[1]!, { target: { value: "0.5" } });
    fireEvent.change(screen.getByDisplayValue("1000"), { target: { value: "1500" } });
    fireEvent.click(buildButton());

    await waitFor(() => expect(buildPaymentSkeleton).toHaveBeenCalledTimes(1));
    const call = vi.mocked(buildPaymentSkeleton).mock.calls[0]![0];

    // CKB → shannons happens in the panel, not the builder.
    expect(call.recipients.map((r) => r.capacity)).toEqual([10_000_000_000n, 50_000_000n]);
    // Each row's address is decoded to its own lock, in row order.
    expect(call.recipients.map((r) => r.lock.args)).toEqual([
      lockFromAddress(RECIPIENT_ADDRESS).args,
      lockFromAddress(RECIPIENT_ADDRESS_2).args,
    ]);
    expect(call.recipients[0]!.lock.args).not.toBe(call.recipients[1]!.lock.args);
    // The spend source is the selected treasury's multisig lock.
    expect(call.treasuryScript.args).toBe(treasuryLockScript(CFG_A).args);
    expect(call.treasuryConfig).toMatchObject({ m: 2, n: 3, pubkeyHashes: CFG_A.pubkeyHashes });
    expect(call.feeRateShannonsPerByte).toBe(1500n);
    expect(call.network).toBe("testnet");
    expect(call.availableCells).toHaveLength(1);
  });

  it("rejects a non-positive amount before any chain work happens", async () => {
    renderPanel();
    fireEvent.change(addressInputs()[0]!, { target: { value: RECIPIENT_ADDRESS } });
    fireEvent.change(amountInputs()[0]!, { target: { value: "0" } });
    fireEvent.click(buildButton());
    await waitFor(() =>
      expect(screen.getByText("Recipient 1: amount must be a positive number")).toBeInTheDocument(),
    );
    expect(listCellsForLock).not.toHaveBeenCalled();
    expect(buildPaymentSkeleton).not.toHaveBeenCalled();
  });

  it("refuses to build when the treasury has no live cells", async () => {
    listCellsForLock.mockResolvedValue([]);
    renderPanel();
    fireEvent.change(addressInputs()[0]!, { target: { value: RECIPIENT_ADDRESS } });
    fireEvent.change(amountInputs()[0]!, { target: { value: "100" } });
    fireEvent.click(buildButton());
    await waitFor(() =>
      expect(screen.getByText(/no cells found for this treasury/)).toBeInTheDocument(),
    );
    expect(buildPaymentSkeleton).not.toHaveBeenCalled();
  });

  it("surfaces a build failure and stays on the draft form", async () => {
    vi.mocked(buildPaymentSkeleton).mockImplementationOnce(() => {
      throw new Error("no live cells");
    });
    renderPanel();
    fireEvent.change(addressInputs()[0]!, { target: { value: RECIPIENT_ADDRESS } });
    fireEvent.change(amountInputs()[0]!, { target: { value: "100" } });
    fireEvent.click(buildButton());
    await waitFor(() => expect(screen.getByText("no live cells")).toBeInTheDocument());
    expect(addressInputs()[0]).toBeInTheDocument();
    expect(screen.queryByDisplayValue(PACKET_JSON)).not.toBeInTheDocument();
  });

  it("passes the trimmed label into the transfer packet", async () => {
    renderPanel();
    fireEvent.change(screen.getByPlaceholderText("e.g. March payroll batch"), {
      target: { value: "  March payroll batch  " },
    });
    await buildOnce();
    expect(vi.mocked(encodeTransferPacket).mock.calls[0]![0]).toMatchObject({
      label: "March payroll batch",
      network: "testnet",
    });
  });
});

describe("PayPanel — transfer packet", () => {
  it("renders the encoded packet and the in/out/fee totals once the skeleton builds", async () => {
    renderPanel();
    await buildOnce();
    expect(screen.getByDisplayValue(PACKET_JSON)).toHaveAttribute("readonly");
    expect(screen.getByText(/in 300 · out 100 · fee 0\.001 CKB/)).toBeInTheDocument();
    // The draft form is replaced by the packet + signature steps.
    expect(screen.queryByPlaceholderText("ckb1… or ckt1…")).not.toBeInTheDocument();
  });

  it("opens exactly M signature slots labelled with the M-of-N threshold", async () => {
    renderPanel();
    await buildOnce();
    expect(screen.getByText("6. Collect signatures (2 of 3 needed)")).toBeInTheDocument();
    expect(sigBoxes()).toHaveLength(2);
    // Each slot can be pointed at any of the N signers.
    expect(screen.getAllByRole("option", { name: /^1: 0x1111111111…111111$/ })).toHaveLength(2);
  });
});

describe("PayPanel — signature gating", () => {
  it("keeps broadcast disabled while any signature slot is empty", async () => {
    renderPanel();
    await buildOnce();
    expect(broadcastButton()).toBeDisabled();
    fireEvent.change(sigBoxes()[0]!, { target: { value: `0x${"11".repeat(65)}` } });
    expect(broadcastButton()).toBeDisabled();
  });

  it("enables broadcast only when every slot is filled, and disables again when one is cleared", async () => {
    renderPanel();
    await buildOnce();
    fillAllSignatures();
    expect(broadcastButton()).toBeEnabled();
    fireEvent.change(sigBoxes()[1]!, { target: { value: "   " } });
    expect(broadcastButton()).toBeDisabled();
  });
});

describe("PayPanel — broadcast", () => {
  it("merges the collected signatures and reports success with a testnet explorer link", async () => {
    renderPanel();
    await buildOnce();
    fillAllSignatures();
    fireEvent.click(broadcastButton());

    expect(await screen.findByText("Broadcast successful")).toBeInTheDocument();
    expect(screen.getByText(TX_HASH)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /View on explorer/ })).toHaveAttribute(
      "href",
      `https://pudge.explorer.nervos.org/transaction/${TX_HASH}`,
    );
    expect(mergeSignatures).toHaveBeenCalledTimes(1);
    const [, cfgArg, digestArg, partials] = vi.mocked(mergeSignatures).mock.calls[0]!;
    expect(cfgArg).toMatchObject({ m: 2, n: 3, pubkeyHashes: CFG_A.pubkeyHashes });
    expect(digestArg).toBe(DIGEST);
    expect(partials.map((p) => p.slotIndex)).toEqual([0, 1]);
    expect(broadcastTransaction).toHaveBeenCalledTimes(1);
  });

  it("links to the mainnet explorer when the treasury is on ckb:mainnet", async () => {
    // NB: the explorer host is driven by treasury.multisig.chain, NOT by
    // useNetworkConfigStore — network-config is left on "testnet" here on
    // purpose to prove the panel does not consult it for this decision.
    const mainnet = ckbTreasury({
      id: "ckb-main",
      label: "Mainnet treasury",
      cfg: CFG_A,
      chain: "ckb:mainnet",
    });
    useTreasuryStore.setState({ treasuries: [mainnet], activeTreasuryId: mainnet.id });
    renderPanel();
    await buildOnce();
    expect(vi.mocked(buildPaymentSkeleton).mock.calls[0]![0].network).toBe("mainnet");
    fillAllSignatures();
    fireEvent.click(broadcastButton());
    expect(await screen.findByText("Broadcast successful")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /View on explorer/ })).toHaveAttribute(
      "href",
      `https://explorer.nervos.org/transaction/${TX_HASH}`,
    );
    expect(useNetworkConfigStore.getState().network).toBe("testnet");
  });

  it("invokes the pre-broadcast multisig guard with the live tx, config and treasury", async () => {
    renderPanel();
    await buildOnce();
    fillAllSignatures();
    fireEvent.click(broadcastButton());
    await screen.findByText("Broadcast successful");

    // If Task 14/15 drops this call site, only this assertion notices — the
    // guard's own unit tests pass whether or not anybody calls it.
    expect(assertGuardSpy).toHaveBeenCalledTimes(1);
    const [txArg, cfgArg, multisigArg] = assertGuardSpy.mock.calls[0]!;
    expect(txArg).toBe(currentSkeletonTx());
    expect(cfgArg).toMatchObject({ m: 2, n: 3, pubkeyHashes: CFG_A.pubkeyHashes });
    expect(multisigArg).toEqual(TREASURY_A.multisig);
    // …and it must run BEFORE the transaction leaves the renderer.
    expect(assertGuardSpy.mock.invocationCallOrder[0]!).toBeLessThan(
      broadcastTransaction.mock.invocationCallOrder[0]!,
    );
    expect(dumpInputsSpy).toHaveBeenCalledTimes(1);
  });

  it("aborts the broadcast when the real guard detects treasury/config drift", async () => {
    const actual = await vi.importActual<typeof import("@/lib/chains/ckb/multisig-assert")>(
      "@/lib/chains/ckb/multisig-assert",
    );
    assertGuardSpy.mockImplementation(actual.assertMultisigBytesMatchTreasury);
    // Address derived from CFG_B while the config in play is CFG_A.
    const drifted = ckbTreasury({
      id: "ckb-1",
      label: "Drifted treasury",
      cfg: CFG_A,
      addressFromCfg: CFG_B,
    });
    useTreasuryStore.setState({ treasuries: [drifted], activeTreasuryId: drifted.id });

    renderPanel();
    await buildOnce();
    fillAllSignatures();
    fireEvent.click(broadcastButton());

    expect(await screen.findByText(/Treasury config drift/)).toBeInTheDocument();
    expect(broadcastTransaction).not.toHaveBeenCalled();
    expect(screen.queryByText("Broadcast successful")).not.toBeInTheDocument();
  });

  it("appends the input outpoints to a broadcast failure so they can be pasted into an explorer", async () => {
    broadcastTransaction.mockRejectedValue(new Error("PoolRejectedTransactionByMinFeeRate"));
    renderPanel();
    await buildOnce();
    fillAllSignatures();
    fireEvent.click(broadcastButton());
    const banner = await screen.findByText(/PoolRejectedTransactionByMinFeeRate/);
    expect(banner.textContent).toContain("Tx inputs:");
    expect(banner.textContent).toContain(`[0] 0x${"ab".repeat(32)} #0`);
  });

  it("BUG PIN: Send another clears the packet and sigs but KEEPS the recipient rows", async () => {
    renderPanel();
    await buildOnce();
    fillAllSignatures();
    fireEvent.click(broadcastButton());
    await screen.findByText("Broadcast successful");
    fireEvent.click(screen.getByRole("button", { name: "Send another" }));

    // reset() touches only the tx-lifecycle state; recipients, fee rate and
    // label survive. An operator clicking "Send another" is one Build click
    // away from repeating the payment they just made.
    expect(addressInputs()).toHaveLength(1);
    expect(addressInputs()[0]).toHaveValue(RECIPIENT_ADDRESS);
    expect(amountInputs()[0]).toHaveValue("100");
    expect(screen.queryByDisplayValue(PACKET_JSON)).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("0x… (130 hex chars)")).not.toBeInTheDocument();
    expect(screen.queryByText("Broadcast successful")).not.toBeInTheDocument();
  });
});
