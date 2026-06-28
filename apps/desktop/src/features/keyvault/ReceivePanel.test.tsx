// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { ScriptInfo } from "@ckb-ccc/core";
import { ReceivePanel } from "./ReceivePanel";
import { secp256k1AddressFromLockArgs } from "@/lib/chains/ckb/secp256k1-address";
import { useNetworkConfigStore } from "@/stores/network-config";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("qrcode", () => ({
  default: { toDataURL: vi.fn().mockResolvedValue("data:image/png;base64,mockqr") },
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SECP256K1_CODE_HASH =
  "0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8";
const LOCK_ARGS = "0x" + "ab".repeat(20);
const BALANCE_SHANNONS = 7_050_000_000n; // 70.5 CKB

function fakeScriptInfo(): ScriptInfo {
  return ScriptInfo.from({
    codeHash: SECP256K1_CODE_HASH,
    hashType: "type",
    cellDeps: [
      {
        cellDep: {
          outPoint: {
            txHash: "0xf8de3bb47d055cdf460d93a2a6e1b05f7432f9777c8c474abf4eec1d4aee5d37",
            index: 0,
          },
          depType: "depGroup",
        },
      },
    ],
  });
}

function makeDeps(balance: bigint = BALANCE_SHANNONS) {
  return {
    watchLockScript: vi.fn().mockResolvedValue(undefined),
    getLockBalance: vi.fn().mockResolvedValue(balance),
  };
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  // Testnet is the default; pin it so network prefix is "ckt".
  useNetworkConfigStore.setState({ network: "testnet", broadcastRpcUrl: "" });
  // Stub navigator.clipboard in jsdom.
  Object.assign(navigator, {
    clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function expectedAddress(): string {
  return secp256k1AddressFromLockArgs(LOCK_ARGS, "ckt", fakeScriptInfo());
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ReceivePanel — address display", () => {
  it("renders the CKB address as monospace text", async () => {
    const deps = makeDeps();
    render(<ReceivePanel lockArgs={LOCK_ARGS} scriptInfo={fakeScriptInfo()} balanceDeps={deps} />);

    await waitFor(() => {
      expect(screen.getByText(expectedAddress())).toBeInTheDocument();
    });
  });

  it("renders a copy-address button", async () => {
    render(
      <ReceivePanel lockArgs={LOCK_ARGS} scriptInfo={fakeScriptInfo()} balanceDeps={makeDeps()} />,
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /copy address/i })).toBeInTheDocument();
    });
  });

  it("copy button writes the address to the clipboard", async () => {
    render(
      <ReceivePanel lockArgs={LOCK_ARGS} scriptInfo={fakeScriptInfo()} balanceDeps={makeDeps()} />,
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /copy address/i })).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /copy address/i }));
    });

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expectedAddress());
  });

  it("renders a QR image for the address", async () => {
    render(
      <ReceivePanel lockArgs={LOCK_ARGS} scriptInfo={fakeScriptInfo()} balanceDeps={makeDeps()} />,
    );

    await waitFor(() => {
      expect(screen.getByAltText(/address qr/i)).toBeInTheDocument();
    });
  });
});

describe("ReceivePanel — live balance", () => {
  it("shows the formatted CKB balance from the balance hook", async () => {
    render(
      <ReceivePanel lockArgs={LOCK_ARGS} scriptInfo={fakeScriptInfo()} balanceDeps={makeDeps()} />,
    );

    // 7_050_000_000 shannons → "70.5 CKB"
    await waitFor(() => {
      expect(screen.getByText(/70\.5\s*CKB/)).toBeInTheDocument();
    });
  });

  it("shows the syncing hint alongside the balance", async () => {
    render(
      <ReceivePanel lockArgs={LOCK_ARGS} scriptInfo={fakeScriptInfo()} balanceDeps={makeDeps()} />,
    );

    await waitFor(() => {
      expect(screen.getByText(/syncing/i)).toBeInTheDocument();
    });
  });

  it("Refresh button calls the hook's refresh", async () => {
    const deps = makeDeps();
    let refreshCount = 0;
    // Re-render will trigger the hook's refresh implicitly via refreshTick;
    // spy on getLockBalance to verify re-fetch.
    deps.getLockBalance = vi.fn().mockImplementation(async () => {
      refreshCount++;
      return BALANCE_SHANNONS;
    });

    render(<ReceivePanel lockArgs={LOCK_ARGS} scriptInfo={fakeScriptInfo()} balanceDeps={deps} />);

    // Wait for initial fetch
    await waitFor(() => expect(refreshCount).toBeGreaterThanOrEqual(1));
    const fetchesBefore = refreshCount;

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
    });

    await waitFor(() => expect(refreshCount).toBeGreaterThan(fetchesBefore));
  });

  it("shows a zero balance (not a dash) after first successful fetch returns 0", async () => {
    const deps = makeDeps(0n);
    render(<ReceivePanel lockArgs={LOCK_ARGS} scriptInfo={fakeScriptInfo()} balanceDeps={deps} />);

    await waitFor(() => {
      // "0 CKB" should appear — not be hidden
      expect(screen.getByText(/^0\s*CKB$/)).toBeInTheDocument();
    });
  });

  it("surfaces a balance fetch error without throwing", async () => {
    const deps = {
      watchLockScript: vi.fn().mockResolvedValue(undefined),
      getLockBalance: vi.fn().mockRejectedValue(new Error("light client unavailable")),
    };
    render(<ReceivePanel lockArgs={LOCK_ARGS} scriptInfo={fakeScriptInfo()} balanceDeps={deps} />);

    await waitFor(() => {
      expect(screen.getByText(/light client unavailable/i)).toBeInTheDocument();
    });
  });
});

describe("ReceivePanel — loading states", () => {
  it("shows 'Resolving network info' while scriptInfo is not yet available", () => {
    // No scriptInfo injected + the internal resolver will be async → loading state on mount
    // We mock resolveSecp256k1ScriptInfo to never resolve during this test.
    // The easiest way: just don't inject scriptInfo and check for the loading text
    // before the async resolution completes.
    // This test only validates the loading guard; the resolved path is covered above.
    const { unmount } = render(<ReceivePanel lockArgs={LOCK_ARGS} />);
    expect(screen.getByText(/resolving network info/i)).toBeInTheDocument();
    unmount();
  });
});
