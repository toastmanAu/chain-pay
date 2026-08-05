import { createHash } from "node:crypto";
import { secp256k1, schnorr } from "@noble/curves-v2/secp256k1.js";
import {
  Address,
  NETWORK,
  RawTx,
  TEST_NETWORK,
  Transaction,
} from "@scure/btc-signer";
import { hash160, sha256x2 } from "@scure/btc-signer/utils.js";
import type {
  BitcoinBroadcastErrorCode,
  BitcoinBroadcastReview,
  BitcoinBroadcastReviewInput,
  BitcoinBroadcastReviewOutput,
  BitcoinChain,
  BitcoinPaymentAccountingLine,
} from "@chain-pay/shared";

const MAX_RAW_TX_BYTES = 100_000;
const MAX_STANDARD_TX_WEIGHT = 400_000;
const MAX_MONEY = 2_100_000_000_000_000n;
const MAX_ABSOLUTE_FEE = 100_000_000n;
const MAX_FEE_RATE = 1_000n;
const LOCKTIME_THRESHOLD = 500_000_000;
const SEQUENCE_FINAL = 0xffff_ffff;
const SEQUENCE_LOCKTIME_DISABLE_FLAG = 1 << 31;
const CURVE_ORDER = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");

type RawTransaction = ReturnType<typeof RawTx.decode>;

export interface ResolvedBitcoinPrevout {
  txid: string;
  vout: number;
  script: Uint8Array;
  address: string | null;
  value: bigint;
}

export interface BitcoinReviewTip {
  height: number;
  hash: string;
  medianTimePast: number;
}

export interface ParsedFinalBitcoinTransaction {
  rawHex: string;
  rawBytes: Uint8Array;
  raw: RawTransaction;
  transaction: Transaction;
}

export class BitcoinBroadcastValidationError extends Error {
  constructor(
    readonly code: BitcoinBroadcastErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BitcoinBroadcastValidationError";
  }
}

export function parseFinalBitcoinTransaction(rawTxHex: string): ParsedFinalBitcoinTransaction {
  if (typeof rawTxHex !== "string" || rawTxHex.length === 0) {
    throw validation("malformed", "Enter one complete raw Bitcoin transaction as hexadecimal");
  }
  if (rawTxHex.length > MAX_RAW_TX_BYTES * 2) throw validation("oversized", "Raw transaction exceeds 100,000 bytes");
  if (!/^[0-9a-fA-F]+$/.test(rawTxHex)) throw validation("malformed", "Enter one complete raw Bitcoin transaction as hexadecimal");
  if (rawTxHex.length % 2 !== 0) throw validation("malformed", "Raw transaction hexadecimal has an odd length");
  const canonicalHex = rawTxHex.toLowerCase();
  if (canonicalHex.startsWith("70736274ff")) {
    throw validation("unsupported", "PSBT files are not accepted; finalize and export the raw transaction externally");
  }
  const rawBytes = Uint8Array.from(Buffer.from(canonicalHex, "hex"));
  if (rawBytes.length > MAX_RAW_TX_BYTES) throw validation("oversized", "Raw transaction exceeds 100,000 bytes");
  let raw: RawTransaction;
  let transaction: Transaction;
  try {
    raw = RawTx.decode(rawBytes);
    transaction = Transaction.fromRaw(rawBytes);
    if (!equalBytes(RawTx.encode(raw), rawBytes)) throw new Error("non-canonical encoding");
  } catch {
    throw validation("malformed", "Raw transaction is malformed or non-canonical");
  }
  if (raw.inputs.length === 0 || raw.outputs.length === 0) {
    throw validation("policy", "Transaction must contain at least one input and one output");
  }
  if (transaction.weight > MAX_STANDARD_TX_WEIGHT) {
    throw validation("oversized", "Transaction exceeds Bitcoin's standard weight limit");
  }
  if (raw.version !== 1 && raw.version !== 2) {
    throw validation("policy", "Only standard Bitcoin transaction versions 1 and 2 are supported");
  }
  const outpoints = new Set<string>();
  for (const input of raw.inputs) {
    const outpoint = `${toHex(input.txid)}:${input.index}`;
    if (outpoints.has(outpoint)) throw validation("duplicate_input", "Transaction contains a duplicate input");
    outpoints.add(outpoint);
    if (/^0+$/.test(toHex(input.txid)) && input.index === 0xffff_ffff) {
      throw validation("policy", "Coinbase transactions cannot be submitted");
    }
    if (raw.version >= 2 && input.sequence !== SEQUENCE_FINAL && (input.sequence & SEQUENCE_LOCKTIME_DISABLE_FLAG) === 0) {
      throw validation("unsupported", "Relative-locktime inputs are not supported by manual broadcast review");
    }
  }
  return { rawHex: canonicalHex, rawBytes, raw, transaction };
}

export function buildBitcoinBroadcastReview(args: {
  chain: BitcoinChain;
  treasuryId: string;
  watchedAddresses: string[];
  parsed: ParsedFinalBitcoinTransaction;
  prevouts: ResolvedBitcoinPrevout[];
  tip: BitcoinReviewTip;
  accounting?: BitcoinPaymentAccountingLine[];
}): BitcoinBroadcastReview {
  const { raw, transaction } = args.parsed;
  if (args.prevouts.length !== raw.inputs.length) throw validation("provider_unavailable", "Every transaction input must have a verified prevout");
  assertFinal(raw, args.tip);
  const watched = new Set(args.watchedAddresses);
  const inputs: BitcoinBroadcastReviewInput[] = [];
  let inputValue = 0n;
  for (let index = 0; index < raw.inputs.length; index++) {
    const input = raw.inputs[index]!;
    const prevout = args.prevouts[index]!;
    if (prevout.txid !== toHex(input.txid) || prevout.vout !== input.index) {
      throw validation("provider_unavailable", "Bitcoin provider returned a mismatched prevout");
    }
    assertMoney(prevout.value, "input");
    const scriptType = verifyFinalInput(index, args.parsed, args.prevouts);
    inputValue += prevout.value;
    if (inputValue > MAX_MONEY) throw validation("policy", "Transaction input value exceeds Bitcoin's money range");
    inputs.push({
      txid: prevout.txid,
      vout: prevout.vout,
      address: prevout.address,
      valueSats: prevout.value.toString(),
      scriptType,
      watched: prevout.address !== null && watched.has(prevout.address),
    });
  }
  if (!inputs.some((input) => input.watched)) {
    throw validation("not_watched", "Transaction does not spend from the selected watch-only treasury");
  }

  const network = args.chain === "btc:mainnet" ? NETWORK : TEST_NETWORK;
  const outputs: BitcoinBroadcastReviewOutput[] = [];
  let outputValue = 0n;
  for (let index = 0; index < raw.outputs.length; index++) {
    const output = raw.outputs[index]!;
    assertMoney(output.amount, "output");
    outputValue += output.amount;
    if (outputValue > MAX_MONEY) throw validation("policy", "Transaction output value exceeds Bitcoin's money range");
    const scriptType = classifyOutputScript(output.script);
    assertStandardOutput(output.amount, output.script, scriptType);
    let address: string | null = null;
    if (scriptType !== "op_return") {
      try {
        address = transaction.getOutputAddress(index, network) ?? null;
      } catch {
        throw validation("policy", "Transaction contains an invalid output script");
      }
      if (!address) throw validation("policy", "Transaction output cannot be represented on the selected Bitcoin network");
    }
    const isWatched = address !== null && watched.has(address);
    outputs.push({
      vout: index,
      address,
      valueSats: output.amount.toString(),
      scriptType,
      watched: isWatched,
      changeCandidate: isWatched,
    });
  }
  if (outputValue >= inputValue) {
    throw validation("policy", outputValue === inputValue ? "Transaction pays no miner fee" : "Transaction outputs exceed its verified inputs");
  }
  const fee = inputValue - outputValue;
  if (fee > MAX_ABSOLUTE_FEE || fee > BigInt(transaction.vsize) * MAX_FEE_RATE) {
    throw validation("policy", "Transaction fee exceeds the manual-broadcast safety limit");
  }
  const warnings: string[] = [];
  const unknownInputCount = inputs.filter((input) => !input.watched).length;
  if (unknownInputCount > 0) warnings.push(`${unknownInputCount} input${unknownInputCount === 1 ? " is" : "s are"} outside the selected treasury; ownership is unverified`);
  if (outputs.some((output) => output.changeCandidate)) warnings.push("Watched outputs are change candidates; signer intent cannot be proven from raw transaction data");
  const reviewWithoutDigest = {
    treasuryId: args.treasuryId,
    chain: args.chain,
    txid: transaction.id,
    wtxid: transaction.hash,
    version: raw.version,
    lockTime: raw.lockTime,
    sizeBytes: args.parsed.rawBytes.length,
    weight: transaction.weight,
    vsize: transaction.vsize,
    inputValueSats: inputValue.toString(),
    outputValueSats: outputValue.toString(),
    feeSats: fee.toString(),
    feeRateSatsPerVbyte: formatRate(fee, transaction.vsize),
    tipHeight: args.tip.height,
    tipHash: args.tip.hash,
    watchSetHash: createHash("sha256").update([...watched].sort().join("\n")).digest("hex"),
    inputs,
    outputs,
    warnings,
  };
  if (args.accounting === undefined) {
    const digest = createHash("sha256")
      .update("chainpay:bitcoin-broadcast-review:v1\n")
      .update(JSON.stringify(reviewWithoutDigest))
      .digest("hex");
    return { digest, ...reviewWithoutDigest };
  }
  const accounting = validateBitcoinAccounting(outputs, args.accounting);
  const v2WithoutDigest = {
    ...reviewWithoutDigest,
    reviewVersion: 2 as const,
    rawTransactionHash: createHash("sha256").update(args.parsed.rawBytes).digest("hex"),
    accounting,
  };
  const digest = createHash("sha256")
    .update("chainpay:bitcoin-broadcast-review:v2\n")
    .update(JSON.stringify(v2WithoutDigest))
    .digest("hex");
  return { digest, ...v2WithoutDigest };
}

export function computeBitcoinBroadcastReviewDigest(review: Omit<BitcoinBroadcastReview, "digest">): string {
  const version = review.reviewVersion === 2 ? 2 : 1;
  return createHash("sha256")
    .update(`chainpay:bitcoin-broadcast-review:v${version}\n`)
    .update(JSON.stringify(review))
    .digest("hex");
}

export function validateBitcoinBroadcastReview(review: BitcoinBroadcastReview): void {
  const { digest, ...withoutDigest } = review;
  if (!/^[0-9a-f]{64}$/.test(digest) || computeBitcoinBroadcastReviewDigest(withoutDigest) !== digest) {
    throw validation("review_changed", "Bitcoin review digest is invalid");
  }
  if (review.reviewVersion === 2) validateBitcoinAccounting(review.outputs, review.accounting);
}

export function validateFinalizedBitcoinTransaction(review: BitcoinBroadcastReview, rawTxHex: string): ParsedFinalBitcoinTransaction {
  validateBitcoinBroadcastReview(review);
  if (review.reviewVersion !== 2) throw validation("unsupported", "Legacy Bitcoin reviews have no committed accounting intent");
  const parsed = parseFinalBitcoinTransaction(rawTxHex);
  const hash = createHash("sha256").update(parsed.rawBytes).digest("hex");
  if (parsed.transaction.id !== review.txid || parsed.transaction.hash !== review.wtxid || hash !== review.rawTransactionHash ||
      parsed.raw.version !== review.version || parsed.raw.lockTime !== review.lockTime || parsed.rawBytes.length !== review.sizeBytes ||
      parsed.transaction.weight !== review.weight || parsed.transaction.vsize !== review.vsize ||
      parsed.raw.inputs.length !== review.inputs.length || parsed.raw.outputs.length !== review.outputs.length) {
    throw validation("review_changed", "Finalized Bitcoin bytes do not match the immutable review");
  }
  for (let index = 0; index < parsed.raw.inputs.length; index++) {
    const input = parsed.raw.inputs[index]!;
    const reviewed = review.inputs[index]!;
    if (toHex(input.txid) !== reviewed.txid || input.index !== reviewed.vout) throw validation("review_changed", "Finalized Bitcoin inputs do not match the immutable review");
  }
  for (let index = 0; index < parsed.raw.outputs.length; index++) {
    const output = parsed.raw.outputs[index]!;
    const reviewed = review.outputs[index]!;
    const scriptType = classifyOutputScript(output.script);
    let address: string | null = null;
    if (scriptType !== "op_return") {
      try { address = parsed.transaction.getOutputAddress(index, review.chain === "btc:mainnet" ? NETWORK : TEST_NETWORK) ?? null; }
      catch { throw validation("review_changed", "Finalized Bitcoin output scripts do not match the immutable review"); }
    }
    if (reviewed.vout !== index || output.amount.toString() !== reviewed.valueSats || scriptType !== reviewed.scriptType || address !== reviewed.address) {
      throw validation("review_changed", "Finalized Bitcoin outputs do not match the immutable review");
    }
  }
  return parsed;
}

export function validateFinalizedBitcoinPrevouts(
  review: BitcoinBroadcastReview,
  parsed: ParsedFinalBitcoinTransaction,
  prevouts: ResolvedBitcoinPrevout[],
): void {
  if (review.reviewVersion !== 2 || prevouts.length !== review.inputs.length || parsed.raw.inputs.length !== prevouts.length) {
    throw validation("review_changed", "Finalized Bitcoin prevouts do not match the immutable review");
  }
  let inputValue = 0n;
  for (let index = 0; index < prevouts.length; index++) {
    const prevout = prevouts[index]!;
    const input = review.inputs[index]!;
    const scriptType = verifyFinalInput(index, parsed, prevouts);
    assertMoney(prevout.value, "input");
    inputValue += prevout.value;
    if (prevout.txid !== input.txid || prevout.vout !== input.vout || prevout.address !== input.address || prevout.value.toString() !== input.valueSats || scriptType !== input.scriptType) {
      throw validation("review_changed", "Finalized Bitcoin input evidence does not match the immutable review");
    }
  }
  const outputValue = parsed.raw.outputs.reduce((sum, output) => sum + output.amount, 0n);
  if (inputValue.toString() !== review.inputValueSats || outputValue.toString() !== review.outputValueSats || (inputValue - outputValue).toString() !== review.feeSats) {
    throw validation("review_changed", "Finalized Bitcoin totals do not match the immutable review");
  }
}

function validateBitcoinAccounting(
  outputs: BitcoinBroadcastReviewOutput[],
  supplied: BitcoinPaymentAccountingLine[],
): BitcoinPaymentAccountingLine[] {
  if (!Array.isArray(supplied)) throw validation("invalid_request", "Bitcoin accounting mapping must be an array");
  const expected = outputs.filter((output) => !output.watched && output.scriptType !== "op_return" && BigInt(output.valueSats) > 0n);
  if (supplied.length !== expected.length) throw validation("policy", "Every external Bitcoin payment output requires one accounting mapping");
  return supplied.map((line, index) => {
    const output = expected[index];
    if (!output || !Number.isSafeInteger(line?.vout) || line.vout !== output.vout || line.destination !== output.address || line.valueSats !== output.valueSats) {
      throw validation("policy", "Bitcoin accounting mappings must match external outputs in canonical vout order");
    }
    if (!/^(0|[1-9]\d*)$/.test(line.fiat?.minor ?? "") || BigInt(line.fiat.minor) <= 0n || BigInt(line.fiat.minor) > 18_446_744_073_709_551_615n || line.fiat.currency !== "USD") {
      throw validation("policy", "Bitcoin accounting values must be positive canonical USD minor units");
    }
    const payeeId = line.payeeId?.trim();
    if (!payeeId || payeeId !== line.payeeId || payeeId.length > 140) throw validation("policy", "Bitcoin payee references are invalid");
    return { vout: line.vout, destination: line.destination, valueSats: line.valueSats, payeeId, fiat: { currency: "USD", minor: line.fiat.minor } };
  });
}

function verifyFinalInput(
  index: number,
  parsed: ParsedFinalBitcoinTransaction,
  prevouts: ResolvedBitcoinPrevout[],
): BitcoinBroadcastReviewInput["scriptType"] {
  const input = parsed.raw.inputs[index]!;
  const witness = parsed.raw.witnesses?.[index] ?? [];
  const prevout = prevouts[index]!;
  const script = prevout.script;
  const p2pkh = matchScript(script, "76a914", 20, "88ac");
  const p2wpkh = matchScript(script, "0014", 20, "");
  const p2sh = matchScript(script, "a914", 20, "87");
  const p2tr = matchScript(script, "5120", 32, "");

  if (p2pkh) {
    if (witness.length !== 0) throw validation("unsigned", "P2PKH input contains an unexpected witness");
    const pushes = decodeMinimalPushes(input.finalScriptSig);
    if (pushes.length !== 2) throw validation("unsigned", "P2PKH input is not fully signed");
    verifyEcdsa(index, parsed, prevout, pushes[0]!, pushes[1]!, p2pkh, "legacy");
    return "p2pkh";
  }
  if (p2wpkh) {
    if (input.finalScriptSig.length !== 0 || witness.length !== 2) throw validation("unsigned", "P2WPKH input is not fully signed");
    verifyEcdsa(index, parsed, prevout, witness[0]!, witness[1]!, p2wpkh, "witness");
    return "p2wpkh";
  }
  if (p2sh) {
    const pushes = decodeMinimalPushes(input.finalScriptSig);
    if (pushes.length !== 1 || witness.length !== 2) throw validation("unsupported", "Only fully signed P2SH-P2WPKH inputs are supported");
    const redeem = pushes[0]!;
    const nestedHash = matchScript(redeem, "0014", 20, "");
    if (!nestedHash || !equalBytes(hash160(redeem), p2sh)) throw validation("unsupported", "Only valid P2SH-P2WPKH inputs are supported");
    verifyEcdsa(index, parsed, prevout, witness[0]!, witness[1]!, nestedHash, "witness");
    return "p2sh-p2wpkh";
  }
  if (p2tr) {
    if (input.finalScriptSig.length !== 0 || witness.length !== 1) throw validation("unsupported", "Only Taproot key-path inputs without annexes are supported");
    const signature = witness[0]!;
    if (signature.length !== 64 && signature.length !== 65) throw validation("unsigned", "Taproot key-path signature is invalid");
    const sighash = signature.length === 65 ? signature[64]! : 0;
    if (signature.length === 65 && sighash === 0) throw validation("policy", "Explicit SIGHASH_DEFAULT Taproot signatures are non-standard");
    if (sighash !== 0 && sighash !== 1) throw validation("unsupported", "Only SIGHASH_DEFAULT or SIGHASH_ALL Taproot signatures are supported");
    const message = parsed.transaction.preimageWitnessV1(index, prevouts.map((item) => item.script), sighash, prevouts.map((item) => item.value));
    if (!schnorr.verify(signature.subarray(0, 64), message, p2tr)) throw validation("unsigned", "Taproot key-path signature verification failed");
    return "p2tr-keypath";
  }
  throw validation("unsupported", "Input script type is not supported for manual broadcast");
}

function verifyEcdsa(
  index: number,
  parsed: ParsedFinalBitcoinTransaction,
  prevout: ResolvedBitcoinPrevout,
  signatureWithHashType: Uint8Array,
  publicKey: Uint8Array,
  expectedHash: Uint8Array,
  mode: "legacy" | "witness",
): void {
  if (signatureWithHashType.length < 9 || signatureWithHashType.at(-1) !== 1) {
    throw validation("unsupported", "Only SIGHASH_ALL ECDSA signatures are supported");
  }
  if ((publicKey.length !== 33 || (publicKey[0] !== 2 && publicKey[0] !== 3)) && (mode === "witness" || publicKey.length !== 65 || publicKey[0] !== 4)) {
    throw validation("policy", "Input public key encoding is non-standard");
  }
  if (!equalBytes(hash160(publicKey), expectedHash)) throw validation("unsigned", "Input public key does not match its prevout");
  const compact = decodeStrictDer(signatureWithHashType.subarray(0, -1));
  const message = mode === "witness"
    ? parsed.transaction.preimageWitnessV0(index, Uint8Array.from([0x76, 0xa9, 0x14, ...expectedHash, 0x88, 0xac]), 1, prevout.value)
    : legacySighashAll(parsed.raw, index, prevout.script);
  try {
    if (!secp256k1.verify(compact, message, publicKey, { lowS: true, prehash: false })) {
      throw validation("unsigned", "ECDSA signature verification failed");
    }
  } catch (error) {
    if (error instanceof BitcoinBroadcastValidationError) throw error;
    throw validation("unsigned", "ECDSA signature verification failed");
  }
}

function legacySighashAll(raw: RawTransaction, index: number, prevoutScript: Uint8Array): Uint8Array {
  const encoded = RawTx.encode({
    version: raw.version,
    segwitFlag: false,
    inputs: raw.inputs.map((input, inputIndex) => ({
      ...input,
      finalScriptSig: inputIndex === index ? prevoutScript : new Uint8Array(),
    })),
    outputs: raw.outputs,
    lockTime: raw.lockTime,
  });
  return sha256x2(encoded, Uint8Array.from([1, 0, 0, 0]));
}

function decodeStrictDer(der: Uint8Array): Uint8Array {
  if (der.length < 8 || der.length > 72 || der[0] !== 0x30 || der[1] !== der.length - 2 || der[2] !== 0x02) {
    throw validation("unsigned", "ECDSA signature is not strict DER");
  }
  const rLength = der[3]!;
  const rStart = 4;
  const sMarker = rStart + rLength;
  if (rLength === 0 || sMarker + 2 > der.length || der[sMarker] !== 0x02) throw validation("unsigned", "ECDSA signature is not strict DER");
  const sLength = der[sMarker + 1]!;
  const sStart = sMarker + 2;
  if (sLength === 0 || sStart + sLength !== der.length) throw validation("unsigned", "ECDSA signature is not strict DER");
  const r = der.subarray(rStart, sMarker);
  const s = der.subarray(sStart);
  if ((r[0]! & 0x80) !== 0 || (s[0]! & 0x80) !== 0 || (r.length > 1 && r[0] === 0 && (r[1]! & 0x80) === 0) || (s.length > 1 && s[0] === 0 && (s[1]! & 0x80) === 0)) {
    throw validation("unsigned", "ECDSA signature is not strict DER");
  }
  const normalizedR = r[0] === 0 ? r.subarray(1) : r;
  const normalizedS = s[0] === 0 ? s.subarray(1) : s;
  if (normalizedR.length > 32 || normalizedS.length > 32) throw validation("unsigned", "ECDSA signature is out of range");
  const sValue = bytesToBigInt(normalizedS);
  if (sValue === 0n || sValue > CURVE_ORDER / 2n || bytesToBigInt(normalizedR) === 0n) throw validation("policy", "ECDSA signature is not low-S standard form");
  const compact = new Uint8Array(64);
  compact.set(normalizedR, 32 - normalizedR.length);
  compact.set(normalizedS, 64 - normalizedS.length);
  return compact;
}

function decodeMinimalPushes(script: Uint8Array): Uint8Array[] {
  const pushes: Uint8Array[] = [];
  let offset = 0;
  while (offset < script.length) {
    const length = script[offset++]!;
    if (length < 1 || length > 75 || offset + length > script.length) return [];
    pushes.push(script.subarray(offset, offset + length));
    offset += length;
  }
  return pushes;
}

function classifyOutputScript(script: Uint8Array): BitcoinBroadcastReviewOutput["scriptType"] {
  if (matchScript(script, "76a914", 20, "88ac")) return "p2pkh";
  if (matchScript(script, "a914", 20, "87")) return "p2sh";
  if (matchScript(script, "0014", 20, "")) return "p2wpkh";
  if (matchScript(script, "0020", 32, "")) return "p2wsh";
  if (matchScript(script, "5120", 32, "")) return "p2tr";
  if (script[0] === 0x6a && script.length <= 83) return "op_return";
  throw validation("unsupported", "Transaction contains an unsupported output script");
}

function assertStandardOutput(amount: bigint, script: Uint8Array, type: BitcoinBroadcastReviewOutput["scriptType"]): void {
  if (type === "op_return") {
    if (amount !== 0n) throw validation("policy", "OP_RETURN outputs must have zero value");
    if (script.length > 1 && decodeMinimalPushes(script.subarray(1)).length !== 1) throw validation("policy", "OP_RETURN output is non-standard");
    return;
  }
  const dust = type === "p2pkh" ? 546n : type === "p2sh" ? 540n : type === "p2wpkh" ? 294n : 330n;
  if (amount < dust) throw validation("policy", "Transaction contains a dust output");
}

function assertFinal(raw: RawTransaction, tip: BitcoinReviewTip): void {
  if (raw.lockTime === 0 || raw.inputs.every((input) => input.sequence === SEQUENCE_FINAL)) return;
  const comparison = raw.lockTime < LOCKTIME_THRESHOLD ? tip.height + 1 : tip.medianTimePast;
  if (raw.lockTime >= comparison) throw validation("non_final", "Transaction locktime has not yet matured at the reviewed chain tip");
}

function assertMoney(value: bigint, label: string): void {
  if (value < 0n || value > MAX_MONEY) throw validation("policy", `Transaction ${label} value is outside Bitcoin's money range`);
}

function matchScript(script: Uint8Array, prefixHex: string, dataLength: number, suffixHex: string): Uint8Array | null {
  const prefix = fromHex(prefixHex);
  const suffix = fromHex(suffixHex);
  if (script.length !== prefix.length + dataLength + suffix.length || !equalBytes(script.subarray(0, prefix.length), prefix) || !equalBytes(script.subarray(script.length - suffix.length), suffix)) return null;
  return script.subarray(prefix.length, prefix.length + dataLength);
}

export function validateBitcoinAddresses(chain: BitcoinChain, addresses: string[]): void {
  if (!Array.isArray(addresses) || addresses.length < 1 || addresses.length > 10_000 || new Set(addresses).size !== addresses.length) {
    throw validation("invalid_request", "Bitcoin watch addresses are invalid");
  }
  const coder = Address(chain === "btc:mainnet" ? NETWORK : TEST_NETWORK);
  try {
    for (const address of addresses) {
      const decoded = coder.decode(address);
      if (!decoded || coder.encode(decoded) !== address) throw new Error("non-canonical address");
    }
  } catch {
    throw validation("wrong_network", "Watch addresses do not belong to the selected Bitcoin network");
  }
}

function formatRate(fee: bigint, vsize: number): string {
  const scaled = fee * 1_000n / BigInt(vsize);
  const whole = scaled / 1_000n;
  const fraction = (scaled % 1_000n).toString().padStart(3, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  return bytes.length === 0 ? 0n : BigInt(`0x${toHex(bytes)}`);
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

export function fromHex(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

function validation(code: BitcoinBroadcastErrorCode, message: string): BitcoinBroadcastValidationError {
  return new BitcoinBroadcastValidationError(code, message);
}
