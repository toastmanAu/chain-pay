// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { Script } from "@ckb-ccc/core";
import { useKeystoreBalance } from "./useKeystoreBalance";

const CODE_HASH = "0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8";
const ARGS = "0x" + "ab".repeat(20);
const BALANCE = 100_000_000n; // 1 CKB in shannons

function makeLock(): Script {
  return Script.from({ codeHash: CODE_HASH, hashType: "type", args: ARGS });
}

function makeDeps(overrides?: {
  getLockBalance?: () => Promise<bigint>;
  watchLockScript?: () => Promise<void>;
}) {
  return {
    watchLockScript: overrides?.watchLockScript ?? vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    getLockBalance: overrides?.getLockBalance ?? vi.fn<() => Promise<bigint>>().mockResolvedValue(BALANCE),
  };
}

describe("useKeystoreBalance", () => {
  it("watches the lock once on mount and resolves balance", async () => {
    const lock = makeLock();
    const deps = makeDeps();

    const { result } = renderHook(() => useKeystoreBalance(lock, deps));

    await waitFor(() => expect(result.current.balance).toBe(BALANCE));

    expect(deps.watchLockScript).toHaveBeenCalledTimes(1);
    expect(deps.watchLockScript).toHaveBeenCalledWith(lock);
    expect(deps.getLockBalance).toHaveBeenCalledTimes(1);
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it("refresh re-fetches balance without calling watchLockScript again", async () => {
    const lock = makeLock();
    const deps = makeDeps();

    const { result } = renderHook(() => useKeystoreBalance(lock, deps));
    await waitFor(() => expect(result.current.balance).toBe(BALANCE));

    act(() => {
      result.current.refresh();
    });

    await waitFor(() => expect(deps.getLockBalance).toHaveBeenCalledTimes(2));

    // watchLockScript still called only once — no re-watch on refresh.
    expect(deps.watchLockScript).toHaveBeenCalledTimes(1);
    expect(result.current.balance).toBe(BALANCE);
    expect(result.current.error).toBeNull();
  });

  it("sets error and leaves balance null when getLockBalance rejects", async () => {
    const lock = makeLock();
    const deps = makeDeps({
      getLockBalance: vi.fn().mockRejectedValue(new Error("rpc unavailable")),
    });

    const { result } = renderHook(() => useKeystoreBalance(lock, deps));

    await waitFor(() => expect(result.current.error).toBe("rpc unavailable"));

    expect(result.current.balance).toBeNull();
    expect(result.current.loading).toBe(false);
    // No throw propagated — hook must not rethrow to caller.
  });

  it("makes no calls when lock is null", () => {
    const deps = makeDeps();

    renderHook(() => useKeystoreBalance(null, deps));

    expect(deps.watchLockScript).not.toHaveBeenCalled();
    expect(deps.getLockBalance).not.toHaveBeenCalled();
  });
});
