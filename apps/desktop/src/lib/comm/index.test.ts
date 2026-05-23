import { describe, it, expect, beforeEach } from "vitest";
import { createCommTransport, resetCommTransport } from "./index";
import { useCommIdentityStore } from "../../stores/comm-identity";

function resetStore(): void {
  useCommIdentityStore.setState({ identity: null });
  globalThis.localStorage?.removeItem("chain-pay:comm-identity");
  resetCommTransport();
}

const IDENTITY_A = {
  mlDsaPub: "0x" + "11".repeat(1952),
  mlKemPub: "0x" + "22".repeat(1184),
  address: "ckt1qalice",
  addrHash: "0x" + "33".repeat(20),
  createdAt: 0,
  fundedAt: null,
  profileTxHash: null,
  profilePublishedAt: null,
};

const IDENTITY_B = { ...IDENTITY_A, address: "ckt1qbob" };

describe("createCommTransport singleton", () => {
  beforeEach(resetStore);

  it("returns null when no identity is set", () => {
    expect(createCommTransport()).toBeNull();
  });

  it("returns the same instance across calls with the same identity", () => {
    useCommIdentityStore.setState({ identity: IDENTITY_A });
    const first = createCommTransport();
    const second = createCommTransport();
    expect(first).not.toBeNull();
    expect(first).toBe(second);
  });

  it("rebuilds when identity.address changes", () => {
    useCommIdentityStore.setState({ identity: IDENTITY_A });
    const first = createCommTransport();
    useCommIdentityStore.setState({ identity: IDENTITY_B });
    const second = createCommTransport();
    expect(second).not.toBe(first);
    expect(second).not.toBeNull();
  });

  it("returns null after identity is cleared", () => {
    useCommIdentityStore.setState({ identity: IDENTITY_A });
    expect(createCommTransport()).not.toBeNull();
    useCommIdentityStore.setState({ identity: null });
    expect(createCommTransport()).toBeNull();
  });

  it("resetCommTransport() stops and clears the cached instance", () => {
    useCommIdentityStore.setState({ identity: IDENTITY_A });
    const first = createCommTransport();
    expect(first).not.toBeNull();
    resetCommTransport();
    const second = createCommTransport();
    expect(second).not.toBe(first);
  });

  it("identity address bouncing does not leak old singleton", () => {
    useCommIdentityStore.setState({ identity: IDENTITY_A });
    const first = createCommTransport();
    useCommIdentityStore.setState({ identity: IDENTITY_B });
    const second = createCommTransport();
    useCommIdentityStore.setState({ identity: IDENTITY_A });
    const third = createCommTransport();
    expect(third).not.toBe(first);
    expect(third).not.toBe(second);
  });
});
