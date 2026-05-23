#!/usr/bin/env node
// Bootstrap a fresh 2-of-3 CKB testnet smoke-test setup for ChainPay.
//
// Generates 3 keystores via scripts/make-test-keystore.mjs and computes the
// resulting secp256k1_blake160_multisig_all (V1) treasury address. Writes
// keystore JSONs + a setup.json record to debug/keystores/.
//
// Usage:
//   node scripts/make-smoke-treasury.mjs                # defaults: pw1/pw2/pw3, M=2, N=3
//   node scripts/make-smoke-treasury.mjs --m 2 --n 3
//   node scripts/make-smoke-treasury.mjs --passwords pw1,pw2,pw3
//   node scripts/make-smoke-treasury.mjs --network testnet
//
// Output is written to debug/keystores/ (gitignored). DO NOT use the
// generated keys for mainnet funds — make-test-keystore.mjs uses fast scrypt
// (N=1024) which is testnet-grade only.

import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { blake2b } from "@noble/hashes/blake2b";

const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
// Mirrors apps/desktop/src/lib/chains/ckb/address.ts:SECP256K1_MULTISIG_V1_CODE_HASH
const MULTISIG_V1_CODE_HASH = "5c5069eb0857efc65e1bca0c07df34c31663b3622fd3876c876320fc9634e2a8";

const args = parseArgs(process.argv.slice(2));
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(repoRoot, args.outDir);

mkdirSync(outDir, { recursive: true });

const passwords = args.passwords;
if (passwords.length !== args.n) {
  console.error(`Expected ${args.n} passwords, got ${passwords.length}. Use --passwords pw1,pw2,...`);
  process.exit(1);
}
if (args.m < 1 || args.m > args.n) {
  console.error(`Invalid M=${args.m} for N=${args.n}`);
  process.exit(1);
}

const keystoreScript = resolve(repoRoot, "scripts/make-test-keystore.mjs");
const signers = passwords.map((pw, i) => {
  const proc = spawnSync(process.execPath, [keystoreScript, pw], { encoding: "utf8" });
  if (proc.status !== 0) {
    console.error(`make-test-keystore.mjs failed for signer ${i + 1}: ${proc.stderr}`);
    process.exit(proc.status ?? 1);
  }
  const parsed = JSON.parse(proc.stdout);
  const file = `${outDir}/signer${i + 1}.json`;
  writeFileSync(file, parsed.keystoreJson + "\n");
  return {
    index: i + 1,
    file,
    password: pw,
    pubkeyHash: parsed.pubkeyHash,
    privateKey: parsed.privateKey,
    signerSingleSigAddress: parsed.address,
  };
});

const multisigScript = encodeMultisigScript({
  m: args.m,
  n: args.n,
  pubkeyHashes: signers.map((s) => s.pubkeyHash),
});
const lockArgs = blake160(multisigScript);
const treasuryAddress = encodeCkbFullAddress({
  codeHash: MULTISIG_V1_CODE_HASH,
  hashTypeByte: 0x01, // "type"
  args: lockArgs,
  hrp: args.network === "mainnet" ? "ckb" : "ckt",
});

const setup = {
  generatedAt: new Date().toISOString(),
  network: args.network,
  m: args.m,
  n: args.n,
  multisigCodeHash: "0x" + MULTISIG_V1_CODE_HASH,
  lockArgs: "0x" + bytesToHex(lockArgs),
  treasuryAddress,
  signers: signers.map(({ index, file, password, pubkeyHash, signerSingleSigAddress }) => ({
    index,
    file,
    password,
    pubkeyHash,
    signerSingleSigAddress,
  })),
};
writeFileSync(`${outDir}/setup.json`, JSON.stringify(setup, null, 2) + "\n");

const faucetHost = args.network === "mainnet"
  ? "(no faucet — use exchange withdrawal)"
  : "https://faucet.nervos.org/";

console.log();
console.log(`ChainPay smoke-test setup: ${args.m}-of-${args.n} on ${args.network}`);
console.log("─".repeat(60));
signers.forEach((s) => {
  console.log(`  signer${s.index}: ${s.file}`);
  console.log(`    password:   ${s.password}`);
  console.log(`    pubkeyHash: ${s.pubkeyHash}`);
});
console.log();
console.log(`  Lock args:        0x${bytesToHex(lockArgs)}`);
console.log(`  Treasury address: ${treasuryAddress}`);
console.log(`  Setup record:     ${outDir}/setup.json`);
console.log();
console.log(`Next steps:`);
console.log(`  1. Fund the treasury at: ${faucetHost}`);
console.log(`     Paste address: ${treasuryAddress}`);
console.log(`  2. Wait ~30s for the next testnet block.`);
console.log(`  3. Open the Electron app: cd apps/desktop && npm run dev`);
console.log(`  4. Use SetupMultisig wizard with the 3 pubkey hashes above (M=${args.m}, N=${args.n}).`);
console.log(`  5. TreasuryDetail should show the funded balance.`);
console.log(`  6. PayPanel wizard → recipient → build → load ${args.m} signer JSONs → broadcast.`);
console.log();

// ───── helpers ─────

function parseArgs(argv) {
  const out = {
    m: 2,
    n: 3,
    passwords: ["pw1", "pw2", "pw3"],
    network: "testnet",
    outDir: "debug/keystores",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--m") out.m = Number(argv[++i]);
    else if (a === "--n") out.n = Number(argv[++i]);
    else if (a === "--passwords") out.passwords = argv[++i].split(",");
    else if (a === "--network") out.network = argv[++i];
    else if (a === "--out-dir") out.outDir = argv[++i];
    else if (a === "-h" || a === "--help") {
      console.log(`Usage: node scripts/make-smoke-treasury.mjs [--m 2] [--n 3] [--passwords pw1,pw2,pw3] [--network testnet] [--out-dir debug/keystores]`);
      process.exit(0);
    } else {
      console.error(`Unknown arg: ${a}`);
      process.exit(1);
    }
  }
  if (out.passwords.length !== out.n) {
    out.passwords = Array.from({ length: out.n }, (_, i) => `pw${i + 1}`);
  }
  return out;
}

function encodeMultisigScript({ m, n, pubkeyHashes }) {
  // Layout: S(1)=0 | R(1)=0 | M(1) | N(1) | hash1(20) | ... | hashN(20)
  // Mirrors apps/desktop/src/lib/chains/ckb/multisig.ts:encodeMultisigScript.
  const out = new Uint8Array(4 + 20 * n);
  out[0] = 0;
  out[1] = 0;
  out[2] = m;
  out[3] = n;
  pubkeyHashes.forEach((h, i) => out.set(hexToBytes(h), 4 + 20 * i));
  return out;
}

function blake160(data) {
  // CKB blake160 = blake2b-256("ckb-default-hash")[..20] — NOT blake2b(outlen=20).
  // Matches the in-script multisig hash check and the fix in commit acd1d52.
  const full = blake2b(data, { dkLen: 32, personalization: "ckb-default-hash" });
  return full.slice(0, 20);
}

function encodeCkbFullAddress({ codeHash, hashTypeByte, args, hrp }) {
  // CKB AddressFormat.Full: 0x00 | code_hash(32) | hash_type(1) | args
  const codeHashBytes = hexToBytes(codeHash);
  const payload = new Uint8Array(1 + 32 + 1 + args.length);
  payload[0] = 0x00;
  payload.set(codeHashBytes, 1);
  payload[33] = hashTypeByte;
  payload.set(args, 34);
  return bech32mEncode(hrp, payload);
}

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

function bytesToHex(b) {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex) {
  const s = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}
