import { describe, it, expect } from "vitest";
import { treasuryAsFundable, sourceAsFundable, type Source } from "./funding";
import type { Treasury } from "./treasury";

const source: Source = {
  id: "s1",
  label: "Ops wallet",
  chain: "ckb:testnet",
  address: "ckt1qjoyid...",
  joyidLockArgs: "0x1234567890123456789012345678901234567890",
  createdAt: "2026-06-25T00:00:00Z",
  updatedAt: "2026-06-25T00:00:00Z",
};

const treasury: Treasury = {
  id: "t1",
  label: "Main treasury",
  createdAt: "2026-06-25T00:00:00Z",
  updatedAt: "2026-06-25T00:00:00Z",
  multisig: {
    chain: "ckb:testnet",
    s: 0, r: 0, m: 2, n: 3,
    pubkeyHashes: [],
    address: "ckt1qmultisig...",
  },
};

describe("FundableAccount adapters", () => {
  it("maps a Source to a single-sig FundableAccount that cannot co-sign", () => {
    const f = sourceAsFundable(source);
    expect(f).toEqual({
      id: "s1",
      label: "Ops wallet",
      chain: "ckb:testnet",
      address: "ckt1qjoyid...",
      lockKind: "ckb-joyid-single",
      capabilities: { coSign: false },
    });
  });

  it("maps a Treasury to a multisig FundableAccount that can co-sign", () => {
    const f = treasuryAsFundable(treasury);
    expect(f.id).toBe("t1");
    expect(f.address).toBe("ckt1qmultisig...");
    expect(f.lockKind).toBe("ckb-multisig");
    expect(f.capabilities.coSign).toBe(true);
  });
});
