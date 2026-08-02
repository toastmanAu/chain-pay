import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTreasuryStore } from "./treasury";
import { useCommIdentityStore } from "./comm-identity";
import { RefusalInvariantError } from "../lib/comm/errors";
import { setOwnIdentityHashGetterForTests } from "../lib/comm/own-identity-hash";
import type { MultisigTreasury, Treasury } from "@chain-pay/shared";
import { MemoryStorage } from "./test-utils/memory-storage";

// ─── Shared helpers ────────────────────────────────────────────────────────

function resetStores(): void {
  useTreasuryStore.setState({ treasuries: [], activeTreasuryId: null });
  useCommIdentityStore.setState({ identity: null });
  globalThis.localStorage?.removeItem("chain-pay:treasuries");
  globalThis.localStorage?.removeItem("chain-pay:comm-identity");
}

const COMM_HASH = new Uint8Array(20).fill(0x55);
const COMM_HASH_HEX: `0x${string}` = `0x${"55".repeat(20)}`;
const OTHER_HASH_HEX: `0x${string}` = `0x${"aa".repeat(20)}`;

const BASE_TREASURY: MultisigTreasury = {
  id: "t-1",
  label: "Test Treasury",
  createdAt: "2026-05-23T00:00:00Z",
  updatedAt: "2026-05-23T00:00:00Z",
  multisig: {
    chain: "ckb:testnet",
    s: 0,
    r: 0,
    m: 2,
    n: 3,
    pubkeyHashes: [OTHER_HASH_HEX, `0x${"bb".repeat(20)}`],
    address: "ckt1qtestnet",
  },
};

const sample: MultisigTreasury = {
  id: "t1",
  label: "ops-testnet",
  createdAt: "2026-05-21T00:00:00Z",
  updatedAt: "2026-05-21T00:00:00Z",
  multisig: {
    chain: "ckb:testnet",
    s: 0,
    r: 0,
    m: 2,
    n: 3,
    pubkeyHashes: [
      "0x44fa9ab6fdacd4827f5ec169c31e9e7ef46ba908",
      "0x0463eacbe31265f36f1ac23d26b28755ed34a767",
      "0xe4d15db3846f6ecd38b760298419450b21391e73",
    ],
    address:
      "ckt1qpw9q60tppt7l3j7r09qcp7lxnp3vcanvgha8pmvsa3jplykxn32sqw4amy0qryz7umdxvh0mpvugn3xyaqv75q7vlphx",
  },
};

// ─── Persistence tests (from Phase 2.6 work) ────────────────────────────────

describe("treasury store persistence", () => {
  beforeEach(() => {
    (globalThis as { localStorage?: Storage }).localStorage = new MemoryStorage();
    vi.resetModules();
  });

  afterEach(() => {
    delete (globalThis as { localStorage?: Storage }).localStorage;
  });

  it("re-hydrates treasuries from localStorage on store re-creation", async () => {
    const first = await import("./treasury");
    first.useTreasuryStore.getState().addTreasury(sample);
    expect(first.useTreasuryStore.getState().treasuries).toHaveLength(1);

    vi.resetModules();
    const second = await import("./treasury");
    expect(second.useTreasuryStore.getState().treasuries).toHaveLength(1);
    expect(second.useTreasuryStore.getState().treasuries[0]?.id).toBe("t1");
    const restored = second.useTreasuryStore.getState().treasuries[0];
    expect(restored && "multisig" in restored ? restored.multisig.address : undefined).toBe(
      sample.multisig.address,
    );
  });

  it("removes treasuries from persisted state on removeTreasury", async () => {
    const first = await import("./treasury");
    first.useTreasuryStore.getState().addTreasury(sample);
    first.useTreasuryStore.getState().removeTreasury("t1");

    vi.resetModules();
    const second = await import("./treasury");
    expect(second.useTreasuryStore.getState().treasuries).toHaveLength(0);
  });

  it("round-trips bigint `since` values without precision loss", async () => {
    if (sample.multisig.chain !== "ckb:testnet") throw new Error("sample must be CKB");
    const withSince: MultisigTreasury = {
      ...sample,
      id: "t2",
      multisig: { ...sample.multisig, since: 0x4000000000000064n },
    };

    const first = await import("./treasury");
    first.useTreasuryStore.getState().addTreasury(withSince);

    vi.resetModules();
    const second = await import("./treasury");
    const revived = second.useTreasuryStore.getState().treasuries[0];
    expect(revived && "multisig" in revived ? revived.multisig : undefined).toMatchObject({
      chain: "ckb:testnet",
    });
    if (revived && "multisig" in revived && revived.multisig.chain === "ckb:testnet") {
      expect(revived.multisig.since).toBe(0x4000000000000064n);
    }
  });
});

// ─── Refusal invariant tests (from Phase 2.7a work) ─────────────────────────

describe("treasury store CRUD", () => {
  beforeEach(resetStores);
  afterEach(() => setOwnIdentityHashGetterForTests(null));

  it("starts empty", () => {
    expect(useTreasuryStore.getState().treasuries).toEqual([]);
  });

  it("addTreasury appends when no comm identity is set", () => {
    useTreasuryStore.getState().addTreasury(BASE_TREASURY);
    expect(useTreasuryStore.getState().treasuries).toHaveLength(1);
    expect(useTreasuryStore.getState().treasuries[0]).toEqual(BASE_TREASURY);
  });

  it("addTreasury appends when comm identity is set but no signer matches", () => {
    setOwnIdentityHashGetterForTests(() => COMM_HASH);
    useTreasuryStore.getState().addTreasury(BASE_TREASURY);
    expect(useTreasuryStore.getState().treasuries).toHaveLength(1);
  });

  it("removeTreasury drops by id", () => {
    useTreasuryStore.getState().addTreasury(BASE_TREASURY);
    useTreasuryStore.getState().removeTreasury("t-1");
    expect(useTreasuryStore.getState().treasuries).toEqual([]);
  });

  it("findByMultisig finds by chain+address", () => {
    useTreasuryStore.getState().addTreasury(BASE_TREASURY);
    const found = useTreasuryStore.getState().findByMultisig({
      chain: "ckb:testnet",
      s: 0,
      r: 0,
      m: 2,
      n: 3,
      pubkeyHashes: [],
      address: "ckt1qtestnet",
    });
    expect(found).toEqual(BASE_TREASURY);
  });

  it("rejects duplicate Bitcoin watch sources and can find the canonical source", () => {
    const bitcoin: Treasury = {
      id: "btc-1",
      kind: "bitcoin-watch",
      label: "Reserve",
      createdAt: "2026-08-03T00:00:00Z",
      updatedAt: "2026-08-03T00:00:00Z",
      watch: {
        chain: "btc:mainnet",
        gapLimit: 20,
        source: {
          kind: "address",
          address: "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu",
          scriptType: "p2wpkh",
        },
      },
    };
    useTreasuryStore.getState().addTreasury(bitcoin);
    expect(useTreasuryStore.getState().findByBitcoinWatch(bitcoin.watch)).toEqual(bitcoin);
    expect(() =>
      useTreasuryStore.getState().addTreasury({ ...bitcoin, id: "btc-2", label: "Duplicate" }),
    ).toThrow(/already exists/i);
    expect(useTreasuryStore.getState().treasuries).toHaveLength(1);
  });
});

describe("treasury store — refusal invariant against comm identity", () => {
  beforeEach(resetStores);
  afterEach(() => setOwnIdentityHashGetterForTests(null));

  it("addTreasury refuses when a signer matches the current comm-identity hash", () => {
    setOwnIdentityHashGetterForTests(() => COMM_HASH);

    useCommIdentityStore.setState({
      identity: {
        mlDsaPub: "0x00",
        mlKemPub: "0x00",
        address: "ckt1qzzzzz",
        addrHash: COMM_HASH_HEX,
        createdAt: 0,
        fundedAt: null,
        profileTxHash: null,
        profilePublishedAt: null,
      },
    });

    const treasury: Treasury = {
      id: "t-conflict",
      label: "Conflicting Treasury",
      createdAt: "2026-05-23T00:00:00Z",
      updatedAt: "2026-05-23T00:00:00Z",
      multisig: {
        chain: "ckb:testnet",
        s: 0,
        r: 0,
        m: 2,
        n: 3,
        pubkeyHashes: [OTHER_HASH_HEX, COMM_HASH_HEX],
        address: "ckt1qconflict",
      },
    };

    expect(() => useTreasuryStore.getState().addTreasury(treasury)).toThrow(RefusalInvariantError);
    expect(useTreasuryStore.getState().treasuries).toHaveLength(0);
  });

  it("addTreasury refuses even when the comm-identity hash is the first signer", () => {
    setOwnIdentityHashGetterForTests(() => COMM_HASH);

    const treasury: Treasury = {
      id: "t-conflict-first",
      label: "First Signer Conflict",
      createdAt: "2026-05-23T00:00:00Z",
      updatedAt: "2026-05-23T00:00:00Z",
      multisig: {
        chain: "ckb:testnet",
        s: 0,
        r: 0,
        m: 1,
        n: 1,
        pubkeyHashes: [COMM_HASH_HEX],
        address: "ckt1qfirstconflict",
      },
    };

    expect(() => useTreasuryStore.getState().addTreasury(treasury)).toThrow(RefusalInvariantError);
    expect(useTreasuryStore.getState().treasuries).toHaveLength(0);
  });

  it("addTreasury allows EVM treasury regardless of comm identity", () => {
    setOwnIdentityHashGetterForTests(() => COMM_HASH);

    const evmTreasury: Treasury = {
      id: "t-evm",
      label: "EVM Safe",
      createdAt: "2026-05-23T00:00:00Z",
      updatedAt: "2026-05-23T00:00:00Z",
      multisig: {
        chain: "evm:1",
        address: "0xSafe",
        owners: ["0xOwner1", "0xOwner2"],
        threshold: 2,
        version: "1.3.0",
      },
    };

    useTreasuryStore.getState().addTreasury(evmTreasury);
    expect(useTreasuryStore.getState().treasuries).toHaveLength(1);
  });

  it("addTreasury is a no-op refusal-check when getterOverride returns null (no identity)", () => {
    const treasury: Treasury = {
      id: "t-safe",
      label: "Safe Treasury",
      createdAt: "2026-05-23T00:00:00Z",
      updatedAt: "2026-05-23T00:00:00Z",
      multisig: {
        chain: "ckb:testnet",
        s: 0,
        r: 0,
        m: 1,
        n: 1,
        pubkeyHashes: [COMM_HASH_HEX],
        address: "ckt1qsafe",
      },
    };

    useTreasuryStore.getState().addTreasury(treasury);
    expect(useTreasuryStore.getState().treasuries).toHaveLength(1);
  });

  it("v1→v2 migration backfills activeTreasuryId from first treasury", async () => {
    (globalThis as { localStorage?: Storage }).localStorage = new MemoryStorage();
    const v1Blob = {
      state: {
        treasuries: [
          {
            id: "t_legacy",
            label: "Legacy Treasury",
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
            multisig: {
              chain: "ckb:testnet",
              s: 0,
              r: 0,
              m: 2,
              n: 3,
              pubkeyHashes: [OTHER_HASH_HEX, `0x${"bb".repeat(20)}`],
              address: "ckt1qlegacy",
            },
          },
        ],
        // No activeTreasuryId — the field didn't exist in v1.
      },
      version: 1,
    };
    globalThis.localStorage?.setItem("chain-pay:treasuries", JSON.stringify(v1Blob));

    vi.resetModules();
    const { useTreasuryStore: freshStore } = await import("./treasury");
    await freshStore.persist.rehydrate();

    expect(freshStore.getState().activeTreasuryId).toBe("t_legacy");
    expect(freshStore.getState().treasuries).toHaveLength(1);
  });

  it("v1→v2 migration leaves empty treasuries → activeTreasuryId null", async () => {
    (globalThis as { localStorage?: Storage }).localStorage = new MemoryStorage();
    const v1Blob = {
      state: { treasuries: [] },
      version: 1,
    };
    globalThis.localStorage?.setItem("chain-pay:treasuries", JSON.stringify(v1Blob));

    vi.resetModules();
    const { useTreasuryStore: freshStore } = await import("./treasury");
    await freshStore.persist.rehydrate();

    expect(freshStore.getState().activeTreasuryId).toBeNull();
  });
});
