import { describe, it, expect, beforeEach } from "vitest";
import { useCommIdentityStore } from "./comm-identity";

function resetStore(): void {
  useCommIdentityStore.setState({ identity: null });
  globalThis.localStorage?.removeItem("chain-pay:comm-identity");
}

const FIXTURE = {
  mlDsaPub: "0x" + "11".repeat(1952),
  mlKemPub: "0x" + "22".repeat(1184),
  address: "ckt1qmldsa...",
  createdAt: 1747900000_000,
  fundedAt: null,
  profileTxHash: null,
  profilePublishedAt: null,
};

describe("comm-identity store", () => {
  beforeEach(resetStore);

  it("starts with no identity", () => {
    expect(useCommIdentityStore.getState().identity).toBeNull();
  });

  it("setIdentity persists public fields", () => {
    useCommIdentityStore.getState().setIdentity(FIXTURE);
    expect(useCommIdentityStore.getState().identity).toEqual(FIXTURE);
  });

  it("clear() wipes state", () => {
    useCommIdentityStore.getState().setIdentity(FIXTURE);
    useCommIdentityStore.getState().clear();
    expect(useCommIdentityStore.getState().identity).toBeNull();
  });

  it("recordFunded() updates fundedAt without touching other fields", () => {
    useCommIdentityStore.getState().setIdentity(FIXTURE);
    useCommIdentityStore.getState().recordFunded(1747900100_000);
    const got = useCommIdentityStore.getState().identity!;
    expect(got.fundedAt).toBe(1747900100_000);
    expect(got.mlDsaPub).toBe(FIXTURE.mlDsaPub);
  });

  it("recordProfilePublished() updates profileTxHash + profilePublishedAt", () => {
    useCommIdentityStore.getState().setIdentity(FIXTURE);
    useCommIdentityStore.getState().recordProfilePublished("0xprofile", 1747900200_000);
    const got = useCommIdentityStore.getState().identity!;
    expect(got.profileTxHash).toBe("0xprofile");
    expect(got.profilePublishedAt).toBe(1747900200_000);
  });

  it("setIdentity throws if an identity already exists (use clear first)", () => {
    useCommIdentityStore.getState().setIdentity(FIXTURE);
    expect(() => useCommIdentityStore.getState().setIdentity(FIXTURE)).toThrow(
      /identity already exists/i,
    );
  });

  it("recordFunded is a no-op when no identity exists", () => {
    expect(() => useCommIdentityStore.getState().recordFunded(1747900100_000)).not.toThrow();
    expect(useCommIdentityStore.getState().identity).toBeNull();
  });

  it("persists across store recreation via localStorage", () => {
    useCommIdentityStore.getState().setIdentity(FIXTURE);
    useCommIdentityStore.persist.rehydrate();
    expect(useCommIdentityStore.getState().identity).toEqual(FIXTURE);
  });
});
