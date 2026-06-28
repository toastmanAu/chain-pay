import { describe, it, expect, vi, afterEach } from "vitest";
import { derToP1363, normalizeSignResult, assembleSignedCkbTx } from "./witness";

vi.mock("@joyid/ckb", () => ({
  buildSignedTx: vi.fn((tx, data, idx) => ({ tx, data, idx })),
}));

import { buildSignedTx } from "@joyid/ckb";

afterEach(() => {
  vi.clearAllMocks();
});

describe("derToP1363", () => {
  // DER: 30 44 02 20 <32B r> 02 20 <32B s>  → 64B r||s
  it("converts a 0x44-len DER sig with 32-byte r and s to 128 hex chars", () => {
    const r = "a".repeat(64);
    const s = "b".repeat(64);
    const der = "3044" + "0220" + r + "0220" + s;
    expect(derToP1363(der)).toBe(r + s);
  });

  it("strips a leading 0x00 sign byte and left-pads to 32 bytes", () => {
    // r is 33 bytes (leading 00 because high bit set), s is 31 bytes (needs pad)
    const r33 = "00" + "f".repeat(64); // 33 bytes -> keep last 64 hex
    const s31 = "c".repeat(62); // 31 bytes -> pad to 64
    const der = "30" + "43" + "0221" + r33 + "021f" + s31;
    const out = derToP1363(der);
    expect(out.length).toBe(128);
    expect(out.slice(0, 64)).toBe("f".repeat(64));
    expect(out.slice(64)).toBe(s31.padStart(64, "0"));
  });

  it("passes through an already-64-byte (128 hex) signature unchanged via normalize", () => {
    const already = "1".repeat(128);
    const out = normalizeSignResult({
      signature: already,
      message: "0xdead",
      pubkey: "0x01",
      keyType: "main_session_key",
      alg: -7,
    });
    expect(out.signature).toBe(already);
  });
});

describe("assembleSignedCkbTx", () => {
  it("forwards bare-hex normalized fields + witnessIndexes to buildSignedTx", () => {
    assembleSignedCkbTx(
      { any: "tx" },
      {
        signature: "0x" + "1".repeat(128),
        message: "0xdead",
        pubkey: "0xabcd",
        keyType: "main_key",
        alg: -7,
      },
      [0, 1],
    );

    const mock = buildSignedTx as unknown as ReturnType<typeof vi.fn>;
    expect(mock).toHaveBeenCalledTimes(1);

    const [, data, idx] = mock.mock.calls[0] as unknown[];
    expect((data as Record<string, unknown>).signature).toBe("1".repeat(128));
    expect((data as Record<string, unknown>).message).toBe("dead");
    expect((data as Record<string, unknown>).pubkey).toBe("abcd");
    expect(idx).toEqual([0, 1]);
  });
});
