import { describe, it, expect } from "vitest";
import { encodeEnvelope, decodeEnvelope, ENVELOPE_HEADER_LEN } from "./envelope";
import { EnvelopeMalformedError } from "./errors";
import type { OutgoingPacket, OutgoingSignature } from "./types";

const SENDER_HASH = new Uint8Array(20).fill(0xab);

const PACKET: OutgoingPacket = {
  txHash: "0xdeadbeef",
  treasuryAddress: "ckt1qxxx",
  expiresAt: 1747900000,
  packet: { kind: "transfer", payments: [] } as never,
};

const SIGNATURE: OutgoingSignature = {
  txHash: "0xdeadbeef",
  slotIndex: 1,
  signature: "0x" + "11".repeat(65),
};

describe("envelope", () => {
  it("roundtrips a packet envelope", () => {
    const bytes = encodeEnvelope({ kind: "packet", senderAddrHash: SENDER_HASH, payload: PACKET });
    const decoded = decodeEnvelope(bytes);
    expect(decoded.kind).toBe("packet");
    expect(decoded.senderAddrHash).toEqual(SENDER_HASH);
    expect(decoded.payload).toEqual(PACKET);
  });

  it("roundtrips a signature envelope", () => {
    const bytes = encodeEnvelope({ kind: "signature", senderAddrHash: SENDER_HASH, payload: SIGNATURE });
    const decoded = decodeEnvelope(bytes);
    expect(decoded.kind).toBe("signature");
    expect(decoded.payload).toEqual(SIGNATURE);
  });

  it("rejects version > 1", () => {
    const bytes = encodeEnvelope({ kind: "packet", senderAddrHash: SENDER_HASH, payload: PACKET });
    bytes[0] = 0x02;
    expect(() => decodeEnvelope(bytes)).toThrow(EnvelopeMalformedError);
  });

  it("rejects unknown kind byte", () => {
    const bytes = encodeEnvelope({ kind: "packet", senderAddrHash: SENDER_HASH, payload: PACKET });
    bytes[1] = 0xff;
    expect(() => decodeEnvelope(bytes)).toThrow(EnvelopeMalformedError);
  });

  it("rejects input shorter than header", () => {
    const truncated = new Uint8Array(ENVELOPE_HEADER_LEN - 1);
    expect(() => decodeEnvelope(truncated)).toThrow(EnvelopeMalformedError);
  });

  it("rejects sender_addr_hash not exactly 20 bytes on encode", () => {
    expect(() =>
      encodeEnvelope({ kind: "packet", senderAddrHash: new Uint8Array(19), payload: PACKET }),
    ).toThrow();
  });

  it("roundtrips an ack envelope", () => {
    const payload = { txHash: "0x123", received: true };
    const bytes = encodeEnvelope({ kind: "ack", senderAddrHash: SENDER_HASH, payload });
    const decoded = decodeEnvelope(bytes);
    expect(decoded.kind).toBe("ack");
    expect(decoded.payload).toEqual(payload);
  });

  it("preserves sender_addr_hash byte-for-byte across roundtrip", () => {
    const gradientHash = new Uint8Array(20).map((_, i) => i % 256);
    const bytes = encodeEnvelope({ kind: "packet", senderAddrHash: gradientHash, payload: PACKET });
    const decoded = decodeEnvelope(bytes);
    for (let i = 0; i < 20; i++) {
      expect(decoded.senderAddrHash[i]).toBe(i % 256);
    }
  });

  it("rejects truncated payload (missing JSON brace)", () => {
    const bytes = encodeEnvelope({ kind: "packet", senderAddrHash: SENDER_HASH, payload: PACKET });
    const truncated = bytes.slice(0, bytes.length - 1);
    expect(() => decodeEnvelope(truncated)).toThrow(EnvelopeMalformedError);
  });

  it("rejects non-JSON payload bytes", () => {
    const header = new Uint8Array(ENVELOPE_HEADER_LEN);
    header[0] = 0x01; // version
    header[1] = 0x01; // kind: packet
    header.set(SENDER_HASH, 2);
    const badPayload = new Uint8Array([0xff, 0xfe]);
    const combined = new Uint8Array(ENVELOPE_HEADER_LEN + badPayload.length);
    combined.set(header, 0);
    combined.set(badPayload, ENVELOPE_HEADER_LEN);
    let caught: unknown;
    try {
      decodeEnvelope(combined);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(EnvelopeMalformedError);
    expect((caught as EnvelopeMalformedError).cause).toBeDefined();
  });

  it("encodes deterministically for the same input", () => {
    const args = { kind: "packet" as const, senderAddrHash: SENDER_HASH, payload: PACKET };
    const bytes1 = encodeEnvelope(args);
    const bytes2 = encodeEnvelope(args);
    expect(bytes1).toEqual(bytes2);
  });

  it("preserves nested object payloads", () => {
    const nestedPayload: OutgoingPacket = {
      txHash: "0xabc",
      treasuryAddress: "ckt1qyyy",
      expiresAt: 1748000000,
      packet: {
        kind: "transfer",
        payments: [
          { to: "addr1", amountShannons: "100" } as never,
          { to: "addr2", amountShannons: "200" } as never,
          { to: "addr3", amountShannons: "300" } as never,
        ],
      } as never,
    };
    const bytes = encodeEnvelope({ kind: "packet", senderAddrHash: SENDER_HASH, payload: nestedPayload });
    const decoded = decodeEnvelope<OutgoingPacket>(bytes);
    expect(decoded.payload).toEqual(nestedPayload);
  });
});
