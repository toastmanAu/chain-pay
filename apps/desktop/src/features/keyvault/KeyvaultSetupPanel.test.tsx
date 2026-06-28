// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { KeyvaultSetupPanel } from "./KeyvaultSetupPanel";
import { useKeyvaultStore } from "./keyvault-store";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const LOCK_ARGS = "0x" + "ab".repeat(20);
const TEST_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

function makeMockBridge(opts?: {
  statusExists?: boolean;
  createLockArgs?: string;
  createMnemonic?: string;
  importLockArgs?: string;
  createReject?: Error;
  importReject?: Error;
}) {
  return {
    status: vi.fn().mockResolvedValue({ exists: opts?.statusExists ?? false }),
    create: opts?.createReject
      ? vi.fn().mockRejectedValue(opts.createReject)
      : vi.fn().mockResolvedValue({
          id: "main",
          lockArgs: opts?.createLockArgs ?? LOCK_ARGS,
          mnemonic: opts?.createMnemonic ?? TEST_MNEMONIC,
        }),
    import: opts?.importReject
      ? vi.fn().mockRejectedValue(opts.importReject)
      : vi.fn().mockResolvedValue({ id: "main", lockArgs: opts?.importLockArgs ?? LOCK_ARGS }),
    delete: vi.fn().mockResolvedValue({ ok: true }),
  };
}

function mountBridge(bridge: ReturnType<typeof makeMockBridge>): void {
  // In jsdom the global IS window — patch chainpay directly rather than
  // replacing the entire window object (which would break document / waitFor).
  (globalThis as Record<string, unknown>)["chainpay"] = { keyvault: bridge };
}

function resetStore(): void {
  useKeyvaultStore.setState({ exists: false, lockArgs: null, address: null });
}

function seedActiveStore(): void {
  useKeyvaultStore.setState({ exists: true, lockArgs: LOCK_ARGS, address: null });
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  mountBridge(makeMockBridge());
  resetStore();
});

afterEach(() => {
  cleanup();
  resetStore();
  delete (globalThis as Record<string, unknown>)["chainpay"];
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("KeyvaultSetupPanel — idle state (no wallet)", () => {
  it("shows Create and Import buttons when no vault exists", () => {
    render(<KeyvaultSetupPanel />);
    expect(screen.getByRole("button", { name: /create new wallet/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /import mnemonic/i })).toBeInTheDocument();
  });

  it("does NOT show the lock-args box in idle state", () => {
    render(<KeyvaultSetupPanel />);
    expect(screen.queryByText(/lock args/i)).not.toBeInTheDocument();
  });
});

describe("KeyvaultSetupPanel — create flow", () => {
  it("transitions to password form on Create click", () => {
    render(<KeyvaultSetupPanel />);
    fireEvent.click(screen.getByRole("button", { name: /create new wallet/i }));
    expect(screen.getByLabelText(/wallet password/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /create wallet/i })).toBeInTheDocument();
  });

  it("disables Create wallet button until password is ≥8 chars", () => {
    render(<KeyvaultSetupPanel />);
    fireEvent.click(screen.getByRole("button", { name: /create new wallet/i }));
    const createBtn = screen.getByRole("button", { name: /create wallet/i });

    fireEvent.change(screen.getByLabelText(/wallet password/i), { target: { value: "short" } });
    expect(createBtn).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/wallet password/i), {
      target: { value: "longenough!" },
    });
    expect(createBtn).not.toBeDisabled();
  });

  it("shows entropy strength label as the user types", () => {
    render(<KeyvaultSetupPanel />);
    fireEvent.click(screen.getByRole("button", { name: /create new wallet/i }));
    fireEvent.change(screen.getByLabelText(/wallet password/i), {
      target: { value: "abc" },
    });
    // Strength label should be visible
    expect(screen.getByText(/strength:/i)).toBeInTheDocument();
  });

  it("shows the mnemonic after successful creation", async () => {
    render(<KeyvaultSetupPanel />);
    fireEvent.click(screen.getByRole("button", { name: /create new wallet/i }));
    fireEvent.change(screen.getByLabelText(/wallet password/i), {
      target: { value: "strongPass!1" },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /create wallet/i }));
    });

    await waitFor(() => {
      expect(screen.getByRole("list", { name: /recovery mnemonic/i })).toBeInTheDocument();
    });
    // "about" is the unique 12th word in the test mnemonic — avoids multi-match on "abandon".
    expect(screen.getByText("about")).toBeInTheDocument();
  });

  it("clears the mnemonic from the DOM when the user confirms", async () => {
    render(<KeyvaultSetupPanel />);
    fireEvent.click(screen.getByRole("button", { name: /create new wallet/i }));
    fireEvent.change(screen.getByLabelText(/wallet password/i), {
      target: { value: "strongPass!1" },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /create wallet/i }));
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /i've written it down/i })).toBeInTheDocument();
    });

    // Confirm — this should clear the mnemonic and transition to active.
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /i've written it down/i }));
    });

    // Mnemonic words should no longer be visible.
    expect(screen.queryByRole("list", { name: /recovery mnemonic/i })).not.toBeInTheDocument();
    // Lock-args box visible in active state.
    expect(screen.getByText(/lock args/i)).toBeInTheDocument();
  });

  it("shows an error banner when createNew rejects", async () => {
    const bridge = makeMockBridge({ createReject: new Error("wrong password format") });
    mountBridge(bridge);
    render(<KeyvaultSetupPanel />);
    fireEvent.click(screen.getByRole("button", { name: /create new wallet/i }));
    fireEvent.change(screen.getByLabelText(/wallet password/i), {
      target: { value: "strongPass!1" },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /create wallet/i }));
    });

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
      expect(screen.getByText(/wrong password format/i)).toBeInTheDocument();
    });
  });
});

describe("KeyvaultSetupPanel — import flow", () => {
  it("transitions to import form on Import click", () => {
    render(<KeyvaultSetupPanel />);
    fireEvent.click(screen.getByRole("button", { name: /import mnemonic/i }));
    expect(screen.getByLabelText(/mnemonic phrase/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/wallet password/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /import wallet/i })).toBeInTheDocument();
  });

  it("disables Import button until mnemonic and password are filled", () => {
    render(<KeyvaultSetupPanel />);
    fireEvent.click(screen.getByRole("button", { name: /import mnemonic/i }));
    const importBtn = screen.getByRole("button", { name: /import wallet/i });
    expect(importBtn).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/mnemonic phrase/i), {
      target: { value: TEST_MNEMONIC },
    });
    expect(importBtn).toBeDisabled(); // still needs password

    fireEvent.change(screen.getByLabelText(/wallet password/i), {
      target: { value: "myPassword1!" },
    });
    expect(importBtn).not.toBeDisabled();
  });

  it("calls importMnemonic on the store and transitions to active", async () => {
    render(<KeyvaultSetupPanel />);
    fireEvent.click(screen.getByRole("button", { name: /import mnemonic/i }));
    fireEvent.change(screen.getByLabelText(/mnemonic phrase/i), {
      target: { value: TEST_MNEMONIC },
    });
    fireEvent.change(screen.getByLabelText(/wallet password/i), {
      target: { value: "myPassword1!" },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /import wallet/i }));
    });

    await waitFor(() => {
      expect(screen.getByText(/lock args/i)).toBeInTheDocument();
    });
    expect(useKeyvaultStore.getState().exists).toBe(true);
    expect(useKeyvaultStore.getState().lockArgs).toBe(LOCK_ARGS);
  });

  it("shows an error banner when import rejects", async () => {
    const bridge = makeMockBridge({ importReject: new Error("invalid mnemonic") });
    mountBridge(bridge);
    render(<KeyvaultSetupPanel />);
    fireEvent.click(screen.getByRole("button", { name: /import mnemonic/i }));
    fireEvent.change(screen.getByLabelText(/mnemonic phrase/i), {
      target: { value: "bad mnemonic phrase here" },
    });
    fireEvent.change(screen.getByLabelText(/wallet password/i), {
      target: { value: "myPassword1!" },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /import wallet/i }));
    });

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
      expect(screen.getByText(/invalid mnemonic/i)).toBeInTheDocument();
    });
  });

  it("Cancel returns to idle from import flow", () => {
    render(<KeyvaultSetupPanel />);
    fireEvent.click(screen.getByRole("button", { name: /import mnemonic/i }));
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(screen.getByRole("button", { name: /create new wallet/i })).toBeInTheDocument();
  });
});

describe("KeyvaultSetupPanel — active state", () => {
  it("renders lock-args when vault exists in store", () => {
    seedActiveStore();
    render(<KeyvaultSetupPanel />);
    expect(screen.getByText(/lock args/i)).toBeInTheDocument();
    expect(screen.getByText(LOCK_ARGS)).toBeInTheDocument();
  });

  it("shows delete confirmation flow", async () => {
    seedActiveStore();
    render(<KeyvaultSetupPanel />);
    fireEvent.click(screen.getByRole("button", { name: /delete wallet/i }));
    expect(screen.getByRole("button", { name: /yes, delete/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument();
  });

  it("calls deleteVault and returns to idle on confirm", async () => {
    seedActiveStore();
    render(<KeyvaultSetupPanel />);
    fireEvent.click(screen.getByRole("button", { name: /delete wallet/i }));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /yes, delete/i }));
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /create new wallet/i })).toBeInTheDocument();
    });
    expect(useKeyvaultStore.getState().exists).toBe(false);
  });

  it("Cancel from delete confirmation stays in active state", () => {
    seedActiveStore();
    render(<KeyvaultSetupPanel />);
    fireEvent.click(screen.getByRole("button", { name: /delete wallet/i }));
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    // Still on active view
    expect(screen.getByText(/lock args/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /yes, delete/i })).not.toBeInTheDocument();
  });
});
