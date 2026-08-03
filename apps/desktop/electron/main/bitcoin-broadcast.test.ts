import { describe, expect, it } from "vitest";
import { RawTx } from "@scure/btc-signer";
import {
  BitcoinBroadcastValidationError,
  buildBitcoinBroadcastReview,
  parseFinalBitcoinTransaction,
  validateBitcoinAddresses,
} from "./bitcoin-broadcast";

// BIP143's deployed P2SH-P2WPKH SIGHASH_ALL test vector.
const BIP143_SIGNED = "01000000000101db6b1b20aa0fd7b23880be2ecbd4a98130974cf4748fb66092ac4d3ceb1a5477010000001716001479091972186c449eb1ded22b78e40d009bdf0089feffffff02b8b4eb0b000000001976a914a457b684d7f0d539a46a45bbc043f35b59d0d96388ac0008af2f000000001976a914fd270b1ee6abcaea97fea7ad0402e8bd8ad6d77c88ac02473044022047ac8e878352d3ebbde1c94ce3a10d057c24175747116f8288e5d794d12d482f0220217f36a485cae903c713331d877c1f64677e3622ad4010726870540656fe9dcb012103ad1d8e89212f0b92c74d23bb710c00662ad1470198ac48c43f7d6f93a2a2687392040000";
const PREV_TXID = "77541aeb3c4dac9260b68f74f44c973081a9d4cb2ebe8038b2d70faa201b6bdb";
const PREV_SCRIPT = "a9144733f37cf4db86fbc2efed2500b4f4e49f31202387";
const WATCHED = "38BW8nqpHSWpkf5sXrQd2xYwvnPJwP59ic";

function review(hex = BIP143_SIGNED) {
  return buildBitcoinBroadcastReview({
    chain: "btc:mainnet",
    treasuryId: "treasury-bip143",
    watchedAddresses: [WATCHED],
    parsed: parseFinalBitcoinTransaction(hex),
    prevouts: [{
      txid: PREV_TXID,
      vout: 1,
      script: Uint8Array.from(Buffer.from(PREV_SCRIPT, "hex")),
      address: WATCHED,
      value: 1_000_000_000n,
    }],
    tip: { height: 2_000, hash: "a".repeat(64), medianTimePast: 1_700_000_000 },
  });
}

describe("manual Bitcoin broadcast validation", () => {
  it("matches the authoritative BIP143 transaction id, size, signature, values, and fee", () => {
    const result = review();
    expect(result).toMatchObject({
      txid: "ef48d9d0f595052e0f8cdcf825f7a5e50b6a388a81f206f3f4846e5ecd7a0c23",
      wtxid: "230c7acd5e6e84f4f306f2818a386a0be5a5f725f8dc8c0f2e0595f5d0d948ef",
      sizeBytes: 251,
      weight: 677,
      vsize: 170,
      inputValueSats: "1000000000",
      outputValueSats: "999996600",
      feeSats: "3400",
      feeRateSatsPerVbyte: "20",
    });
    expect(result.inputs).toEqual([
      expect.objectContaining({ scriptType: "p2sh-p2wpkh", watched: true, valueSats: "1000000000" }),
    ]);
    expect(result.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(review().digest).toBe(result.digest);
  });

  it("rejects PSBT, trailing bytes, missing signatures, and tampered signatures", () => {
    expect(() => parseFinalBitcoinTransaction("70736274ff00")).toThrowError(
      expect.objectContaining({ code: "unsupported" }),
    );
    expect(() => parseFinalBitcoinTransaction(`${BIP143_SIGNED}00`)).toThrowError(
      expect.objectContaining({ code: "malformed" }),
    );
    const unsigned = BIP143_SIGNED.replace(/02473044[0-9a-f]+92040000$/, "000092040000");
    expect(() => review(unsigned)).toThrowError(BitcoinBroadcastValidationError);
    const tampered = `${BIP143_SIGNED.slice(0, -12)}${BIP143_SIGNED.slice(-12, -10) === "00" ? "01" : "00"}${BIP143_SIGNED.slice(-10)}`;
    expect(() => review(tampered)).toThrowError(BitcoinBroadcastValidationError);
  });

  it("rejects oversized, duplicate-input, non-final, wrong-network, and unbound transactions", () => {
    expect(() => parseFinalBitcoinTransaction("00".repeat(100_001))).toThrowError(
      expect.objectContaining({ code: "oversized" }),
    );
    const parsed = parseFinalBitcoinTransaction(BIP143_SIGNED);
    const duplicate = RawTx.encode({
      ...parsed.raw,
      inputs: [parsed.raw.inputs[0]!, parsed.raw.inputs[0]!],
      witnesses: [parsed.raw.witnesses![0]!, parsed.raw.witnesses![0]!],
    });
    expect(() => parseFinalBitcoinTransaction(Buffer.from(duplicate).toString("hex"))).toThrowError(
      expect.objectContaining({ code: "duplicate_input" }),
    );
    const relativeLock = RawTx.encode({
      ...parsed.raw,
      version: 2,
      inputs: [{ ...parsed.raw.inputs[0]!, sequence: 0 }],
    });
    expect(() => parseFinalBitcoinTransaction(Buffer.from(relativeLock).toString("hex"))).toThrowError(
      expect.objectContaining({ code: "unsupported" }),
    );
    expect(() => buildBitcoinBroadcastReview({
      chain: "btc:mainnet",
      treasuryId: "locked",
      watchedAddresses: [WATCHED],
      parsed,
      prevouts: [{ txid: PREV_TXID, vout: 1, script: Uint8Array.from(Buffer.from(PREV_SCRIPT, "hex")), address: WATCHED, value: 1_000_000_000n }],
      tip: { height: 1_000, hash: "a".repeat(64), medianTimePast: 1_700_000_000 },
    })).toThrowError(expect.objectContaining({ code: "non_final" }));
    expect(() => validateBitcoinAddresses("btc:testnet", [WATCHED])).toThrowError(
      expect.objectContaining({ code: "wrong_network" }),
    );
    expect(() => buildBitcoinBroadcastReview({
      chain: "btc:mainnet",
      treasuryId: "unbound",
      watchedAddresses: ["1C6Rc3w25VHud3dLDamutaqfKWqhrLRTaD"],
      parsed,
      prevouts: [{ txid: PREV_TXID, vout: 1, script: Uint8Array.from(Buffer.from(PREV_SCRIPT, "hex")), address: WATCHED, value: 1_000_000_000n }],
      tip: { height: 2_000, hash: "a".repeat(64), medianTimePast: 1_700_000_000 },
    })).toThrowError(expect.objectContaining({ code: "not_watched" }));
  });

  it("binds the digest to treasury, network tip, and the complete witness transaction", () => {
    const first = review();
    const changedTreasury = buildBitcoinBroadcastReview({
      chain: "btc:mainnet",
      treasuryId: "other-treasury",
      watchedAddresses: [WATCHED],
      parsed: parseFinalBitcoinTransaction(BIP143_SIGNED),
      prevouts: [{ txid: PREV_TXID, vout: 1, script: Uint8Array.from(Buffer.from(PREV_SCRIPT, "hex")), address: WATCHED, value: 1_000_000_000n }],
      tip: { height: 2_000, hash: "a".repeat(64), medianTimePast: 1_700_000_000 },
    });
    expect(changedTreasury.digest).not.toBe(first.digest);
    const changedTip = buildBitcoinBroadcastReview({
      chain: "btc:mainnet",
      treasuryId: "treasury-bip143",
      watchedAddresses: [WATCHED, "1C6Rc3w25VHud3dLDamutaqfKWqhrLRTaD"],
      parsed: parseFinalBitcoinTransaction(BIP143_SIGNED),
      prevouts: [{ txid: PREV_TXID, vout: 1, script: Uint8Array.from(Buffer.from(PREV_SCRIPT, "hex")), address: WATCHED, value: 1_000_000_000n }],
      tip: { height: 2_001, hash: "b".repeat(64), medianTimePast: 1_700_000_600 },
    });
    expect(changedTip.digest).not.toBe(first.digest);
    expect(changedTip.watchSetHash).not.toBe(first.watchSetHash);
  });

  it.each([
    {
      type: "p2pkh",
      raw: "02000000018d326fb6a4c7c1d1cf64c5ac35f3455205103cc42669fdc5dea47152408b92cb000000006a4730440220665a20fbb74cb2e511b9e328a3ef9b08b2da0bd4acaeed26fc159596731f52740220116789e59591ec91dcf5f8ed78fb84f9a28993047401196c11869bfca20cd5e70121031b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078fffffffff01b8820100000000001976a91479b000887626b294a914501a4cd226b58b23598388ac00000000",
      txid: "cb928b405271a4dec5fd6926c43c10055245f335acc564cfd1c1c7a4b66f328d",
      script: "76a91479b000887626b294a914501a4cd226b58b23598388ac",
      address: "1C6Rc3w25VHud3dLDamutaqfKWqhrLRTaD",
    },
    {
      type: "p2wpkh",
      raw: "0200000000010111111111111111111111111111111111111111111111111111111111111111110000000000ffffffff01b88201000000000016001479b000887626b294a914501a4cd226b58b235983024730440220095e2f4c2a12eb0cdbdad5efc77a97da9e1591df3004dd9b7c5767dabe0c287f02207c7b491b9686d091d61a6eb6a8e6dd937d302e27b8045fc11cae71fcefa25f660121031b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f00000000",
      txid: "11".repeat(32),
      script: "001479b000887626b294a914501a4cd226b58b235983",
      address: "bc1q0xcqpzrky6eff2g52qdye53xkk9jxkvrh6yhyw",
    },
    {
      type: "p2tr-keypath",
      raw: "0200000000010111111111111111111111111111111111111111111111111111111111111111110000000000ffffffff01b8820100000000002251208c5db7f797196d6edc4dd7df6048f4ea6b883a6af6af032342088f436543790f01409f12d24a69e7c214f2fc72dba77567de9c656281863792f5a2a820506f7438a6296f7b1ae4a4859eb78dc36c4d7224b3adf985220203785b8d3988268b02b3ca00000000",
      txid: "11".repeat(32),
      script: "51208c5db7f797196d6edc4dd7df6048f4ea6b883a6af6af032342088f436543790f",
      address: "bc1p33wm0auhr9kkahzd6l0kqj85af4cswn276hsxg6zpz85xe2r0y8syx4e5t",
    },
  ])("cryptographically verifies a finalized $type spend", (fixture) => {
    const result = buildBitcoinBroadcastReview({
      chain: "btc:mainnet",
      treasuryId: "standard-spend",
      watchedAddresses: [fixture.address],
      parsed: parseFinalBitcoinTransaction(fixture.raw),
      prevouts: [{
        txid: fixture.txid,
        vout: 0,
        script: Uint8Array.from(Buffer.from(fixture.script, "hex")),
        address: fixture.address,
        value: 100_000n,
      }],
      tip: { height: 900_000, hash: "a".repeat(64), medianTimePast: 1_700_000_000 },
    });
    expect(result.inputs[0]?.scriptType).toBe(fixture.type);
    expect(result.feeSats).toBe("1000");
  });
});
