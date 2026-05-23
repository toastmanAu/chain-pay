import { describe, it, expect, beforeEach } from "vitest";
import { getOwnIdentityHash, setOwnIdentityHashGetterForTests } from "./own-identity-hash";
import { useCommIdentityStore } from "../../stores/comm-identity";

function resetStore(): void {
  useCommIdentityStore.setState({ identity: null });
  globalThis.localStorage?.removeItem("chain-pay:comm-identity");
}

const FIXTURE_IDENTITY = {
  mlDsaPub: "0x00",
  mlKemPub: "0x00",
  address: "ckt1qmldsa-fixture",
  addrHash: "0x" + "ab".repeat(20),
  createdAt: 0,
  fundedAt: null,
  profileTxHash: null,
  profilePublishedAt: null,
};

describe("getOwnIdentityHash (production path)", () => {
  beforeEach(() => {
    resetStore();
    setOwnIdentityHashGetterForTests(null);
  });

  it("returns null when no identity is set", () => {
    expect(getOwnIdentityHash()).toBeNull();
  });

  it("returns the parsed bytes of identity.addrHash when set", () => {
    useCommIdentityStore.setState({ identity: FIXTURE_IDENTITY });
    const hash = getOwnIdentityHash();
    expect(hash).not.toBeNull();
    expect(hash!.length).toBe(20);
    expect(hash![0]).toBe(0xab);
    expect(hash![19]).toBe(0xab);
  });

  it("test override takes precedence over store", () => {
    useCommIdentityStore.setState({ identity: FIXTURE_IDENTITY });
    const override = new Uint8Array(20).fill(0x77);
    setOwnIdentityHashGetterForTests(() => override);
    expect(getOwnIdentityHash()).toEqual(override);
  });
});
