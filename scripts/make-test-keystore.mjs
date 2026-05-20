#!/usr/bin/env node
// Generate a CKB-cli-compatible v3 keystore for testing the multisig flow.
// Uses FAST scrypt params (N=1024) so it decrypts in milliseconds — DO NOT
// use the output to protect mainnet funds.
//
// Usage:
//   node scripts/make-test-keystore.mjs <password> [hex_privkey]
//
// If hex_privkey is omitted, a fresh random key is generated.
// Output is JSON to stdout: {keystoreJson, pubkeyHash, privateKey, address}
//
// Run it three times with different passwords to set up a 2-of-3 testnet
// smoke test:
//   node scripts/make-test-keystore.mjs pw1 > signer1.json
//   node scripts/make-test-keystore.mjs pw2 > signer2.json
//   node scripts/make-test-keystore.mjs pw3 > signer3.json

import { randomBytes } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1";
import { scryptAsync } from "@noble/hashes/scrypt";
import { keccak_256 } from "@noble/hashes/sha3";
import { ctr } from "@noble/ciphers/aes";
import { blake2b } from "@noble/hashes/blake2b";

const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

const password = process.argv[2];
if (!password) {
  console.error("usage: node scripts/make-test-keystore.mjs <password> [hex_privkey]");
  process.exit(1);
}

const privKeyArg = process.argv[3];
const privateKey = privKeyArg ? hexToBytes(privKeyArg) : randomBytes(32);
if (privateKey.length !== 32) {
  console.error("private key must be 32 bytes");
  process.exit(1);
}

// Derive compressed pubkey + blake160 hash.
const pubkey = secp256k1.getPublicKey(privateKey, true);
const pubkeyHash = blake160(pubkey);

// CKB testnet single-sig address: prefix ckt + format=Full + Secp256k1Blake160
// code hash + hashType=type + args=pubkeyHash. Encoded as bech32m.
const address = encodeCkbAddress(pubkeyHash, "ckt");

// Generate a v3 keystore JSON using fast scrypt (N=1024).
const salt = randomBytes(32);
const iv = randomBytes(16);
const ivForRecord = new Uint8Array(iv); // snapshot before ctr mutates it
const N = 1024;
const r = 8;
const p = 1;
const dkLen = 32;

const derived = await scryptAsync(new TextEncoder().encode(password), salt, {
  N,
  r,
  p,
  dkLen,
});
const encKey = derived.slice(0, 16);
const macKey = derived.slice(16, 32);

const cipher = ctr(encKey, iv);
const ciphertext = cipher.encrypt(privateKey);

const macInput = new Uint8Array(macKey.length + ciphertext.length);
macInput.set(macKey, 0);
macInput.set(ciphertext, macKey.length);
const mac = keccak_256(macInput);

const keystoreJson = JSON.stringify(
  {
    version: 3,
    id: randomUuid(),
    address: bytesToHex(pubkeyHash), // for display only
    crypto: {
      cipher: "aes-128-ctr",
      cipherparams: { iv: bytesToHex(ivForRecord) },
      ciphertext: bytesToHex(ciphertext),
      kdf: "scrypt",
      kdfparams: { dklen: dkLen, n: N, r, p, salt: bytesToHex(salt) },
      mac: bytesToHex(mac),
    },
  },
  null,
  2,
);

console.log(
  JSON.stringify(
    {
      pubkeyHash: "0x" + bytesToHex(pubkeyHash),
      privateKey: "0x" + bytesToHex(privateKey),
      address,
      keystoreJson,
    },
    null,
    2,
  ),
);

// ───── helpers ─────

function bytesToHex(b) {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex) {
  const s = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function blake160(data) {
  // CKB blake160 = first 20 bytes of blake2b-256 (with "ckb-default-hash"
  // personalization). NOT blake2b(outlen=20) — different IVs produce different hashes.
  const full = blake2b(data, { dkLen: 32, personalization: "ckb-default-hash" });
  return full.slice(0, 20);
}

function randomUuid() {
  const b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = bytesToHex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// Minimal bech32m for CKB Full-format address. We avoid a dep by inlining.
function encodeCkbAddress(pubkeyHash, hrp) {
  // CKB Secp256k1Blake160 code hash (mainnet + testnet).
  const codeHash = hexToBytes("9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8");
  const hashTypeByte = 0x01; // "type"
  const payload = new Uint8Array(1 + 32 + 1 + pubkeyHash.length);
  payload[0] = 0x00; // AddressFormat.Full
  payload.set(codeHash, 1);
  payload[33] = hashTypeByte;
  payload.set(pubkeyHash, 34);
  return bech32mEncode(hrp, payload);
}

// bech32m encoding, the only piece of crypto we need to inline.
function bech32mEncode(hrp, data) {
  const words = toWords(data);
  const combined = [...words, ...createChecksum(hrp, words)];
  return hrp + "1" + combined.map((v) => BECH32_CHARSET[v]).join("");
}
function toWords(bytes) {
  const out = [];
  let acc = 0;
  let bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out.push((acc >> bits) & 0x1f);
    }
  }
  if (bits > 0) out.push((acc << (5 - bits)) & 0x1f);
  return out;
}
function polymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= GEN[i];
  }
  return chk;
}
function hrpExpand(hrp) {
  const out = [];
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
  return out;
}
function createChecksum(hrp, data) {
  const values = [...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0];
  const mod = polymod(values) ^ 0x2bc830a3; // bech32m constant
  const out = [];
  for (let i = 0; i < 6; i++) out.push((mod >> (5 * (5 - i))) & 31);
  return out;
}
