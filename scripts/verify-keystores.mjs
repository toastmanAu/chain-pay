#!/usr/bin/env node
// Cross-check debug/keystores/ — decrypt each keystore with its password from
// setup.json, derive the pubkey hash, and compare against the stored hash.
//
// If any keystore's derived hash doesn't match its setup.json entry, the
// keystores and the on-chain treasury are out of sync — regenerate with
//   node scripts/make-smoke-treasury.mjs
//
// Usage: node scripts/verify-keystores.mjs

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { secp256k1 } from "@noble/curves/secp256k1";
import { scryptAsync } from "@noble/hashes/scrypt";
import { keccak_256 } from "@noble/hashes/sha3";
import { ctr } from "@noble/ciphers/aes";
import { blake2b } from "@noble/hashes/blake2b";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const setupPath = resolve(repoRoot, "debug/keystores/setup.json");
const setup = JSON.parse(readFileSync(setupPath, "utf8"));

let allMatch = true;

for (const signer of setup.signers) {
  const keystore = JSON.parse(readFileSync(signer.file, "utf8"));
  const c = keystore.crypto;
  const salt = hexToBytes(c.kdfparams.salt);
  const iv = hexToBytes(c.cipherparams.iv);
  const ciphertext = hexToBytes(c.ciphertext);
  const expectedMac = c.mac;

  const derived = await scryptAsync(
    new TextEncoder().encode(signer.password),
    salt,
    {
      N: c.kdfparams.n,
      r: c.kdfparams.r,
      p: c.kdfparams.p,
      dkLen: c.kdfparams.dklen,
    },
  );
  const encKey = derived.slice(0, 16);
  const macKey = derived.slice(16, 32);

  const macInput = new Uint8Array(macKey.length + ciphertext.length);
  macInput.set(macKey, 0);
  macInput.set(ciphertext, macKey.length);
  const computedMac = bytesToHex(keccak_256(macInput));
  const macOk = computedMac === expectedMac;

  const privKey = ctr(encKey, iv).decrypt(ciphertext);
  const pubkey = secp256k1.getPublicKey(privKey, true);
  const derivedHash =
    "0x" + bytesToHex(blake2b(pubkey, { dkLen: 32, personalization: "ckb-default-hash" }).slice(0, 20));

  const hashOk = derivedHash.toLowerCase() === signer.pubkeyHash.toLowerCase();
  if (!hashOk) allMatch = false;

  console.log(`signer${signer.index}:`);
  console.log(`  keystore file:    ${signer.file}`);
  console.log(`  password:         ${signer.password}`);
  console.log(`  MAC check:        ${macOk ? "ok" : "FAIL"}`);
  console.log(`  setup.json hash:  ${signer.pubkeyHash}`);
  console.log(`  derived hash:     ${derivedHash}`);
  console.log(`  match:            ${hashOk ? "✓" : "✘"}`);
  console.log();
}

if (allMatch) {
  console.log("✓ all keystores match setup.json — they are the correct ones.");
} else {
  console.log("✘ MISMATCH — regenerate with: node scripts/make-smoke-treasury.mjs");
  process.exit(1);
}

function hexToBytes(hex) {
  const s = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(b) {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}
