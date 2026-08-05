import bs58 from "bs58";
import { ed25519 } from "@noble/curves-v2/ed25519.js";
import { describe, expect, it, vi } from "vitest";
import type { SolanaPaymentProposal, SolanaSignatureEnvelope } from "@chain-pay/shared";
import {
  SolanaProviderError,
  getSolanaTransactionStatus,
  parseSolanaAddress,
  parseSolanaSignature,
  scanSolanaAddress,
  solanaProviderConfigFromEnvironment,
  prepareSolanaPayment,
  submitSolanaPayment,
  getFinalizedSolanaPaymentEvidence,
} from "./solana-provider";
import { assembleSignedSolanaTransaction, buildSolanaPaymentTransaction, solanaReviewApprovalBytes } from "./solana-payment-transaction";

const address = bs58.encode(new Uint8Array(32));
const otherAddress = bs58.encode(new Uint8Array(32).fill(2));
const signature = bs58.encode(new Uint8Array(64).fill(3));
const blockhashA = bs58.encode(new Uint8Array(32).fill(4));
const blockhashB = bs58.encode(new Uint8Array(32).fill(5));
const config = { rpcUrl: "https://rpc.example.test", bearerToken: "never-render-this" };
const paymentSource = paymentKey(21);
const paymentDestination = paymentKey(22);
const paymentAuthority = paymentKey(23);
const paymentFeePayer = paymentKey(24);
const paymentNonceAccount = paymentKey(25);
const paymentNonce = paymentKey(26);

describe("Solana provider", () => {
  it("loads only secure main-process configuration and removes URL credentials/query data", () => {
    expect(solanaProviderConfigFromEnvironment("sol:devnet", {
      SOLANA_DEVNET_RPC_URL: "https://user:pass@rpc.example.test/path?api-key=secret#fragment",
      SOLANA_DEVNET_RPC_BEARER_TOKEN: " bearer-secret ",
    })).toEqual({ rpcUrl: "https://rpc.example.test/path", bearerToken: "bearer-secret" });
    expect(solanaProviderConfigFromEnvironment("sol:mainnet", { SOLANA_MAINNET_RPC_URL: "http://rpc.example.test" })).toBeNull();
    expect(solanaProviderConfigFromEnvironment("sol:devnet", { SOLANA_DEVNET_RPC_URL: "http://127.0.0.1:8899" }))
      .toEqual({ rpcUrl: "http://127.0.0.1:8899" });
  });

  it("validates canonical public addresses and transaction signatures by byte length", () => {
    expect(parseSolanaAddress(address)).toBe(address);
    expect(parseSolanaSignature(signature)).toBe(signature);
    expect(() => parseSolanaAddress(signature)).toThrow(/address is invalid/);
    expect(() => parseSolanaSignature(address)).toThrow(/signature is invalid/);
  });

  it("preserves exact lamports above Number.MAX_SAFE_INTEGER and attributes fees", async () => {
    const fetchImpl = rpcFetch((method, _params, id) => {
      if (method === "getLatestBlockhash") {
        const call = latestCalls++;
        return result(id, { context: { slot: call === 0 ? 100 : 102 }, value: { blockhash: call === 0 ? blockhashA : blockhashB, lastValidBlockHeight: 250 } });
      }
      if (method === "getBalance") return result(id, { context: { slot: 101 }, value: big("9007199254740993") });
      if (method === "getSignaturesForAddress") return result(id, [{ signature, slot: 99, err: null, memo: null, blockTime: 1_700_000_000, confirmationStatus: "confirmed" }]);
      if (method === "getTransaction") return result(id, {
        slot: 99,
        blockTime: 1_700_000_001,
        version: "legacy",
        meta: {
          err: null,
          fee: big("9007199254740995"),
          preBalances: [big("9007199254740993"), 0],
          postBalances: [big("9007199254741000"), 0],
        },
        transaction: { signatures: [signature], message: { accountKeys: [address, otherAddress] } },
      });
      throw new Error(`unexpected ${method}`);
    });
    let latestCalls = 0;

    const response = await scanSolanaAddress({ chain: "sol:devnet", address, config, fetchImpl });

    expect(response.snapshot.balanceLamports).toBe("9007199254740993");
    expect(response.snapshot.transactions[0]).toMatchObject({
      netLamports: "7",
      feeLamports: "9007199254740995",
      feePaidByWatched: true,
      state: "confirmed",
    });
    expect(response.snapshot.slot).toBe("102");
    expect(JSON.stringify(response)).not.toContain("never-render-this");
  });

  it("maps finalized, failed, and unknown signature status without fabricating confirmations", async () => {
    const finalized = await getSolanaTransactionStatus({
      signature,
      config,
      fetchImpl: rpcFetch((_method, _params, id) => result(id, { context: { slot: 44 }, value: [{ slot: 42, confirmations: null, err: null, confirmationStatus: "finalized" }] })),
    });
    expect(finalized).toEqual({ state: "finalized", slot: "42", confirmations: null });

    const failed = await getSolanaTransactionStatus({
      signature,
      config,
      fetchImpl: rpcFetch((_method, _params, id) => result(id, { context: { slot: 44 }, value: [{ slot: 43, confirmations: 0, err: { InstructionError: [0, "Custom"] }, confirmationStatus: "processed" }] })),
    });
    expect(failed.state).toBe("failed");

    const unknown = await getSolanaTransactionStatus({
      signature,
      config,
      fetchImpl: rpcFetch((_method, _params, id) => result(id, { context: { slot: 44 }, value: [null] })),
    });
    expect(unknown).toEqual({ state: "unknown", slot: null, confirmations: null });
  });

  it("prepares an exact durable-nonce payment from strictly classified accounts", async () => {
    const methods: string[] = [];
    const fetchImpl = rpcFetch((method, params, id) => {
      methods.push(method);
      if (method === "getLatestBlockhash") return result(id, { context: { slot: 100 }, value: { blockhash: blockhashA, lastValidBlockHeight: 200 } });
      if (method === "getAccountInfo") {
        const requested = params[0];
        if (requested === paymentNonceAccount.address) return result(id, accountResult(nonceAccountValue()));
        return result(id, accountResult(walletValue(requested === paymentSource.address ? "9007199254740993" : "100000")));
      }
      if (method === "getMinimumBalanceForRentExemption") return result(id, 1_447_680);
      if (method === "getFeeForMessage") return result(id, { context: { slot: 101 }, value: 15_000 });
      if (method === "simulateTransaction") return result(id, { context: { slot: 101 }, value: { err: null, unitsConsumed: 3000 } });
      throw new Error(`unexpected ${method}`);
    });

    const response = await prepareSolanaPayment({
      request: {
        chain: "sol:devnet",
        treasuryId: "sol-1",
        source: paymentSource.address,
        destination: paymentDestination.address,
        amountLamports: "9007199254700000",
        nonceAccount: paymentNonceAccount.address,
        nonceAuthority: paymentAuthority.address,
        feePayer: paymentFeePayer.address,
      },
      config,
      fetchImpl,
    });

    expect(response.proposal).toMatchObject({
      chain: "sol:devnet",
      sourceBalanceLamports: "9007199254740993",
      amountLamports: "9007199254700000",
      feeLamports: "15000",
      durableNonce: paymentNonce.address,
    });
    expect(response.proposal.requiredSigners).toEqual(expect.arrayContaining([
      paymentSource.address,
      paymentAuthority.address,
      paymentFeePayer.address,
    ]));
    expect(methods).toEqual(expect.arrayContaining(["getAccountInfo", "getFeeForMessage", "simulateTransaction"]));
    expect(JSON.stringify(response)).not.toContain("never-render-this");
  });

  it("rejects unsafe native-SOL destinations, stale nonce fees, and insufficient balances", async () => {
    const request = {
      chain: "sol:devnet" as const,
      treasuryId: "sol-1",
      source: paymentSource.address,
      destination: paymentDestination.address,
      amountLamports: "50000",
      nonceAccount: paymentNonceAccount.address,
      nonceAuthority: paymentAuthority.address,
      feePayer: paymentFeePayer.address,
    };
    const fetchFor = (mode: "unsafe" | "stale" | "poor") => rpcFetch((method, params, id) => {
      if (method === "getLatestBlockhash") return result(id, { context: { slot: 100 }, value: { blockhash: blockhashA, lastValidBlockHeight: 200 } });
      if (method === "getAccountInfo") {
        const requested = params[0];
        if (requested === paymentNonceAccount.address) return result(id, accountResult(nonceAccountValue()));
        if (mode === "unsafe" && requested === paymentDestination.address) return result(id, accountResult({ ...walletValue("1"), owner: otherAddress }));
        return result(id, accountResult(walletValue(mode === "poor" && requested === paymentSource.address ? "1" : "100000")));
      }
      if (method === "getMinimumBalanceForRentExemption") return result(id, 1_447_680);
      if (method === "getFeeForMessage") return result(id, { context: { slot: 101 }, value: mode === "stale" ? null : 15_000 });
      if (method === "simulateTransaction") return result(id, { context: { slot: 101 }, value: { err: null } });
      throw new Error(`unexpected ${method}`);
    });
    await expect(prepareSolanaPayment({ request, config, fetchImpl: fetchFor("unsafe") })).rejects.toMatchObject({ code: "unsafe_account" });
    await expect(prepareSolanaPayment({ request, config, fetchImpl: fetchFor("stale") })).rejects.toMatchObject({ code: "stale_nonce" });
    await expect(prepareSolanaPayment({ request, config, fetchImpl: fetchFor("poor") })).rejects.toMatchObject({ code: "insufficient_funds" });
  });

  it("rejects an existing System-owned off-curve destination", async () => {
    const fetchImpl = rpcFetch((method, params, id) => {
      if (method === "getLatestBlockhash") return result(id, { context: { slot: 100 }, value: { blockhash: blockhashA, lastValidBlockHeight: 200 } });
      if (method === "getAccountInfo") {
        if (params[0] === paymentNonceAccount.address) return result(id, accountResult(nonceAccountValue()));
        return result(id, accountResult(walletValue("100000")));
      }
      if (method === "getMinimumBalanceForRentExemption") return result(id, 1_447_680);
      throw new Error(`unexpected ${method}`);
    });
    await expect(prepareSolanaPayment({
      request: { chain: "sol:devnet", treasuryId: "sol-1", source: paymentSource.address, destination: otherAddress, amountLamports: "1", nonceAccount: paymentNonceAccount.address, nonceAuthority: paymentAuthority.address, feePayer: paymentFeePayer.address },
      config,
      fetchImpl,
    })).rejects.toMatchObject({ code: "unsafe_account", message: expect.stringMatching(/on-curve/i) });
  });

  it("rejects nonce authority/state/rent failures and exact-message simulation failure", async () => {
    const request = { chain: "sol:devnet" as const, treasuryId: "sol-1", source: paymentSource.address, destination: paymentDestination.address, amountLamports: "1", nonceAccount: paymentNonceAccount.address, nonceAuthority: paymentAuthority.address, feePayer: paymentFeePayer.address };
    const fetchFor = (mode: "authority" | "state" | "rent" | "simulation") => rpcFetch((method, params, id) => {
      if (method === "getLatestBlockhash") return result(id, { context: { slot: 100 }, value: { blockhash: blockhashA, lastValidBlockHeight: 200 } });
      if (method === "getAccountInfo") {
        if (params[0] === paymentNonceAccount.address) return result(id, accountResult(nonceAccountValue(paymentNonce.address, {
          ...(mode === "authority" ? { authority: paymentDestination.address } : {}),
          ...(mode === "state" ? { state: 0 } : {}),
          ...(mode === "rent" ? { lamports: 1 } : {}),
        })));
        return result(id, accountResult(walletValue("100000")));
      }
      if (method === "getMinimumBalanceForRentExemption") return result(id, 1_447_680);
      if (method === "getFeeForMessage") return result(id, { context: { slot: 101 }, value: 5000 });
      if (method === "simulateTransaction") return result(id, { context: { slot: 101 }, value: { err: mode === "simulation" ? { InstructionError: [1, "InvalidArgument"] } : null } });
      throw new Error(`unexpected ${method}`);
    });
    await expect(prepareSolanaPayment({ request, config, fetchImpl: fetchFor("authority") })).rejects.toMatchObject({ code: "unsafe_account" });
    await expect(prepareSolanaPayment({ request, config, fetchImpl: fetchFor("state") })).rejects.toMatchObject({ code: "unsafe_account" });
    await expect(prepareSolanaPayment({ request, config, fetchImpl: fetchFor("rent") })).rejects.toMatchObject({ code: "unsafe_account" });
    await expect(prepareSolanaPayment({ request, config, fetchImpl: fetchFor("simulation") })).rejects.toMatchObject({ code: "simulation_failed" });
  });

  it("revalidates, simulates, and broadcasts the exact fully signed reviewed bytes", async () => {
    const proposal = paymentProposal();
    const signatures = paymentEnvelopes(proposal);
    let simulationWire: unknown;
    let sendParams: unknown[] | undefined;
    const fetchImpl = rpcFetch((method, params, id) => {
      if (method === "getSignatureStatuses") return result(id, { context: { slot: 100 }, value: [null] });
      if (method === "getLatestBlockhash") return result(id, { context: { slot: 100 }, value: { blockhash: blockhashA, lastValidBlockHeight: 200 } });
      if (method === "getAccountInfo") {
        const requested = params[0];
        if (requested === paymentNonceAccount.address) return result(id, accountResult(nonceAccountValue()));
        return result(id, accountResult(walletValue("100000")));
      }
      if (method === "getMinimumBalanceForRentExemption") return result(id, 1_447_680);
      if (method === "simulateTransaction") {
        simulationWire = params[0];
        return result(id, { context: { slot: 101 }, value: { err: null } });
      }
      if (method === "sendTransaction") {
        sendParams = params;
        return result(id, signatures[0]!.signature);
      }
      throw new Error(`unexpected ${method}`);
    });

    const response = await submitSolanaPayment({
      request: { chain: proposal.chain, treasuryId: proposal.treasuryId, proposal, signatures },
      config,
      fetchImpl,
    });
    expect(response.receipt).toMatchObject({ signature: signatures[0]!.signature, reviewDigest: proposal.reviewDigest, alreadySubmitted: false });
    expect(sendParams?.[0]).toBe(simulationWire);
    expect(sendParams?.[0]).not.toBe(proposal.unsignedTransactionBase64);
    expect(sendParams?.[1]).toEqual({ encoding: "base64", skipPreflight: false, preflightCommitment: "confirmed", minContextSlot: 100, maxRetries: 3 });
  });

  it("returns an idempotent receipt without rebroadcast and rejects a consumed nonce", async () => {
    const proposal = paymentProposal();
    const signatures = paymentEnvelopes(proposal);
    const knownMethods: string[] = [];
    const known = await submitSolanaPayment({
      request: { chain: proposal.chain, treasuryId: proposal.treasuryId, proposal, signatures },
      config,
      fetchImpl: rpcFetch((method, _params, id) => {
        knownMethods.push(method);
        return result(id, { context: { slot: 101 }, value: [{ slot: 100, confirmations: 1, err: null, confirmationStatus: "confirmed" }] });
      }),
    });
    expect(known.receipt).toMatchObject({ signature: signatures[0]!.signature, alreadySubmitted: true });
    expect(knownMethods).toEqual(["getSignatureStatuses"]);

    const staleFetch = rpcFetch((method, params, id) => {
      if (method === "getSignatureStatuses") return result(id, { context: { slot: 100 }, value: [null] });
      if (method === "getLatestBlockhash") return result(id, { context: { slot: 100 }, value: { blockhash: blockhashA, lastValidBlockHeight: 200 } });
      if (method === "getAccountInfo") {
        const requested = params[0];
        if (requested === paymentNonceAccount.address) return result(id, accountResult(nonceAccountValue(blockhashB)));
        return result(id, accountResult(walletValue("100000")));
      }
      if (method === "getMinimumBalanceForRentExemption") return result(id, 1_447_680);
      throw new Error(`unexpected ${method}`);
    });
    await expect(submitSolanaPayment({ request: { chain: proposal.chain, treasuryId: proposal.treasuryId, proposal, signatures }, config, fetchImpl: staleFetch }))
      .rejects.toMatchObject({ code: "stale_nonce" });
  });

  it("blocks signed simulation failures and a provider signature mismatch", async () => {
    const proposal = paymentProposal();
    const signatures = paymentEnvelopes(proposal);
    const fetchFor = (mode: "simulation" | "mismatch", sends: { count: number }) => rpcFetch((method, params, id) => {
      if (method === "getSignatureStatuses") return result(id, { context: { slot: 100 }, value: [null] });
      if (method === "getLatestBlockhash") return result(id, { context: { slot: 100 }, value: { blockhash: blockhashA, lastValidBlockHeight: 200 } });
      if (method === "getAccountInfo") {
        if (params[0] === paymentNonceAccount.address) return result(id, accountResult(nonceAccountValue()));
        return result(id, accountResult(walletValue("100000")));
      }
      if (method === "getMinimumBalanceForRentExemption") return result(id, 1_447_680);
      if (method === "simulateTransaction") return result(id, { context: { slot: 101 }, value: { err: mode === "simulation" ? { InstructionError: [0, "InvalidArgument"] } : null } });
      if (method === "sendTransaction") {
        sends.count++;
        return result(id, signature);
      }
      throw new Error(`unexpected ${method}`);
    });
    const simulationSends = { count: 0 };
    await expect(submitSolanaPayment({ request: { chain: proposal.chain, treasuryId: proposal.treasuryId, proposal, signatures }, config, fetchImpl: fetchFor("simulation", simulationSends) }))
      .rejects.toMatchObject({ code: "simulation_failed" });
    expect(simulationSends.count).toBe(0);

    const mismatchSends = { count: 0 };
    await expect(submitSolanaPayment({ request: { chain: proposal.chain, treasuryId: proposal.treasuryId, proposal, signatures }, config, fetchImpl: fetchFor("mismatch", mismatchSends) }))
      .rejects.toMatchObject({ code: "txid_mismatch" });
    expect(mismatchSends.count).toBe(1);
  });

  it("accepts only exact finalized legacy transaction evidence for a version-2 review", async () => {
    const proposal = accountingPaymentProposal();
    const signatures = paymentEnvelopes(proposal);
    const assembled = assembleSignedSolanaTransaction(proposal, signatures);
    const receipt = { signature: assembled.firstSignature, reviewDigest: proposal.reviewDigest, submittedAt: "2026-08-05T00:02:00.000Z", alreadySubmitted: false };
    const fetchImpl = rpcFetch((method, params, id) => {
      expect(method).toBe("getTransaction");
      expect(params).toEqual([receipt.signature, { commitment: "finalized", encoding: "base64", maxSupportedTransactionVersion: 0 }]);
      return result(id, {
        slot: 102,
        blockTime: 1_786_000_000,
        version: "legacy",
        meta: { err: null, fee: 5000 },
        transaction: [Buffer.from(assembled.wireBytes).toString("base64"), "base64"],
      });
    });
    const response = await getFinalizedSolanaPaymentEvidence({ request: { chain: proposal.chain, treasuryId: proposal.treasuryId, proposal, receipt, signatures }, config, fetchImpl });
    expect(response.evidence).toMatchObject({
      chain: "sol:devnet",
      signature: receipt.signature,
      reviewDigest: proposal.reviewDigest,
      slot: "102",
      transactionVersion: "legacy",
      amountLamports: "42",
      feeLamports: "5000",
      feePayerPolicy: "transaction_fee_payer",
    });
    expect(response.evidence.finalizedAt).toBe("2026-08-06T07:06:40.000Z");
  });

  it("rejects legacy, unavailable, fee-mismatched, and wrong-message finalized evidence", async () => {
    const legacy = paymentProposal();
    const legacyReceipt = { signature, reviewDigest: legacy.reviewDigest, submittedAt: "2026-08-05T00:02:00.000Z", alreadySubmitted: false };
    await expect(getFinalizedSolanaPaymentEvidence({ request: { chain: legacy.chain, treasuryId: legacy.treasuryId, proposal: legacy, receipt: legacyReceipt, signatures: [] }, config, fetchImpl: vi.fn() as unknown as typeof fetch }))
      .rejects.toMatchObject({ code: "invalid_request" });

    const proposal = accountingPaymentProposal();
    const signatures = paymentEnvelopes(proposal);
    const assembled = assembleSignedSolanaTransaction(proposal, signatures);
    const receipt = { signature: assembled.firstSignature, reviewDigest: proposal.reviewDigest, submittedAt: "2026-08-05T00:02:00.000Z", alreadySubmitted: false };
    const request = { chain: proposal.chain, treasuryId: proposal.treasuryId, proposal, receipt, signatures };
    await expect(getFinalizedSolanaPaymentEvidence({ request, config, fetchImpl: rpcFetch((_method, _params, id) => result(id, null)) }))
      .rejects.toMatchObject({ code: "not_finalized" });

    const responseFor = (fee: number, wire: Uint8Array) => rpcFetch((_method, _params, id) => result(id, {
      slot: 102, blockTime: 1_786_000_000, version: "legacy", meta: { err: null, fee }, transaction: [Buffer.from(wire).toString("base64"), "base64"],
    }));
    await expect(getFinalizedSolanaPaymentEvidence({ request, config, fetchImpl: responseFor(5001, assembled.wireBytes) }))
      .rejects.toMatchObject({ code: "evidence_mismatch" });
    const other = accountingPaymentProposal("other-payee", "43");
    const otherWire = assembleSignedSolanaTransaction(other, paymentEnvelopes(other)).wireBytes;
    await expect(getFinalizedSolanaPaymentEvidence({ request, config, fetchImpl: responseFor(5000, otherWire) }))
      .rejects.toMatchObject({ code: "evidence_mismatch" });
  });

  it("paginates newest-first with before cursors and deduplicates overlapping pages", async () => {
    const signatures = Array.from({ length: 26 }, (_, index) => bs58.encode(new Uint8Array(64).fill(index + 10)));
    const historyParams: unknown[][] = [];
    let latestCalls = 0;
    const fetchImpl = rpcFetch((method, params, id) => {
      if (method === "getLatestBlockhash") {
        latestCalls++;
        return result(id, { context: { slot: latestCalls === 1 ? 100 : 101 }, value: { blockhash: latestCalls === 1 ? blockhashA : blockhashB, lastValidBlockHeight: 200 } });
      }
      if (method === "getBalance") return result(id, { context: { slot: 100 }, value: 0 });
      if (method === "getSignaturesForAddress") {
        historyParams.push(params);
        const page = historyParams.length === 1 ? signatures.slice(0, 25) : [signatures[24]!, signatures[25]!];
        return result(id, page.map((item, index) => ({ signature: item, slot: 99 - index, err: null, memo: null, blockTime: null, confirmationStatus: "confirmed" })));
      }
      if (method === "getTransaction") return result(id, null);
      throw new Error(`unexpected ${method}`);
    });

    const response = await scanSolanaAddress({ chain: "sol:devnet", address, config, fetchImpl });

    expect(response.snapshot.transactions).toHaveLength(26);
    expect(response.snapshot.transactions.map((item) => item.signature)).toEqual(signatures);
    expect(historyParams[1]?.[1]).toMatchObject({ before: signatures[24], limit: 25, commitment: "confirmed" });
    expect(response.snapshot.historyTruncated).toBe(false);
  });

  it("rejects a provider context that moves backwards", async () => {
    let latestCalls = 0;
    const fetchImpl = rpcFetch((method, _params, id) => {
      if (method === "getLatestBlockhash") {
        latestCalls++;
        return result(id, { context: { slot: latestCalls === 1 ? 100 : 99 }, value: { blockhash: blockhashA, lastValidBlockHeight: 200 } });
      }
      if (method === "getBalance") return result(id, { context: { slot: 100 }, value: 0 });
      if (method === "getSignaturesForAddress") return result(id, []);
      throw new Error("unexpected method");
    });
    await expect(scanSolanaAddress({ chain: "sol:devnet", address, config, fetchImpl }))
      .rejects.toMatchObject({ code: "unavailable" });
  });

  it("rejects malformed and oversized responses", async () => {
    const malformed = vi.fn(async () => new Response("not-json", { status: 200 })) as unknown as typeof fetch;
    await expect(getSolanaTransactionStatus({ signature, config, fetchImpl: malformed })).rejects.toMatchObject({ code: "invalid_response" });
    const oversized = vi.fn(async () => new Response("{}", { status: 200, headers: { "content-length": String(16 * 1024 * 1024 + 1) } })) as unknown as typeof fetch;
    await expect(getSolanaTransactionStatus({ signature, config, fetchImpl: oversized })).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("sanitizes transport failures", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 503 })) as unknown as typeof fetch;
    let caught: unknown;
    try {
      await getSolanaTransactionStatus({ signature, config, fetchImpl });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SolanaProviderError);
    expect(caught).toMatchObject({ code: "unavailable", message: "Solana provider is unavailable" });
    expect(JSON.stringify(caught)).not.toContain("never-render-this");
    expect(JSON.stringify(caught)).not.toContain("rpc.example.test");
  });
});

type BigToken = { __rawBig: string };
function big(value: string): BigToken { return { __rawBig: value }; }

function result(id: number, value: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, result: value }).replace(/\{"__rawBig":"(\d+)"\}/g, "$1");
}

function rpcFetch(handler: (method: string, params: unknown[], id: number) => string): typeof fetch {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as { method: string; params: unknown[]; id: number };
    return new Response(handler(request.method, request.params, request.id), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

function paymentKey(fill: number): { secret: Uint8Array; address: string } {
  const secret = new Uint8Array(32).fill(fill);
  return { secret, address: bs58.encode(ed25519.getPublicKey(secret)) };
}

function walletValue(lamports: string): Record<string, unknown> {
  return {
    data: ["", "base64"],
    executable: false,
    lamports: BigInt(lamports) > BigInt(Number.MAX_SAFE_INTEGER) ? big(lamports) : Number(lamports),
    owner: "11111111111111111111111111111111",
    rentEpoch: big("18446744073709551615"),
    space: 0,
  };
}

function nonceAccountValue(
  nonce = paymentNonce.address,
  overrides: { authority?: string; lamports?: number; state?: number } = {},
): unknown {
  const bytes = Buffer.alloc(80);
  bytes.writeUInt32LE(0, 0);
  bytes.writeUInt32LE(overrides.state ?? 1, 4);
  Buffer.from(bs58.decode(overrides.authority ?? paymentAuthority.address)).copy(bytes, 8);
  Buffer.from(bs58.decode(nonce)).copy(bytes, 40);
  bytes.writeBigUInt64LE(5000n, 72);
  return {
    data: [bytes.toString("base64"), "base64"],
    executable: false,
    lamports: overrides.lamports ?? 1_500_000,
    owner: "11111111111111111111111111111111",
    rentEpoch: big("18446744073709551615"),
    space: 80,
  };
}

function paymentProposal(): SolanaPaymentProposal {
  return buildSolanaPaymentTransaction({
    inspection: {
      chain: "sol:devnet",
      source: paymentSource.address,
      nonceAccount: paymentNonceAccount.address,
      nonceAuthority: paymentAuthority.address,
      feePayer: paymentFeePayer.address,
      sourceBalanceLamports: "100000",
      nonceBalanceLamports: "1500000",
      nonceRentMinimumLamports: "1447680",
      feePayerBalanceLamports: "100000",
      durableNonce: paymentNonce.address,
      slot: "100",
    },
    treasuryId: "sol-1",
    destination: paymentDestination.address,
    amountLamports: "42",
    feeLamports: "5000",
    createdAt: "2026-08-05T00:00:00.000Z",
  });
}

function accountingPaymentProposal(payeeId = "vendor-17", amountLamports = "42"): SolanaPaymentProposal {
  return buildSolanaPaymentTransaction({
    inspection: {
      chain: "sol:devnet",
      source: paymentSource.address,
      nonceAccount: paymentNonceAccount.address,
      nonceAuthority: paymentAuthority.address,
      feePayer: paymentFeePayer.address,
      sourceBalanceLamports: "100000",
      nonceBalanceLamports: "1500000",
      nonceRentMinimumLamports: "1447680",
      feePayerBalanceLamports: "100000",
      durableNonce: paymentNonce.address,
      slot: "100",
    },
    treasuryId: "sol-1",
    destination: paymentDestination.address,
    amountLamports,
    feeLamports: "5000",
    accounting: { payeeId, fiat: { currency: "USD", minor: "2500" } },
    createdAt: "2026-08-05T00:00:00.000Z",
  });
}

function paymentEnvelopes(proposal: SolanaPaymentProposal): SolanaSignatureEnvelope[] {
  const keys = new Map([paymentSource, paymentAuthority, paymentFeePayer].map((item) => [item.address, item]));
  return proposal.requiredSigners.map((signer) => {
    const key = keys.get(signer)!;
    const base = {
      chain: proposal.chain,
      treasuryId: proposal.treasuryId,
      reviewDigest: proposal.reviewDigest,
      signer,
      signature: bs58.encode(ed25519.sign(Buffer.from(proposal.messageBase64, "base64"), key.secret)),
    };
    return proposal.version === 2
      ? { ...base, format: "chainpay-solana-signature-v2", reviewSignature: bs58.encode(ed25519.sign(solanaReviewApprovalBytes(proposal.reviewDigest), key.secret)) }
      : { ...base, format: "chainpay-solana-signature-v1" };
  });
}

function accountResult(value: unknown): unknown {
  return { context: { slot: 100 }, value };
}
