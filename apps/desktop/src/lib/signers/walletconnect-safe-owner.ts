import { getAddress, type Address, type Hex } from "viem";
import type { EvmMultisig } from "@chain-pay/shared";
import type { Signature, SignRequest, SignerTransport } from "./types";
import type { SafeOwnerSignContext } from "./metamask-safe-owner";
import { assertSafeReviewBinding } from "@/lib/chains/evm/injected-owner-signer";
import { canonicalSafeTxHash, parseSafePayment, safeTypedData } from "@/lib/chains/evm/safe";
import { verifySafeOwnerSignature } from "@/lib/chains/evm/safe-owner-signature";
import { readSafeSnapshot } from "@/lib/chains/evm/safe-reader";
import { getEvmRpcUrl } from "@/lib/chains/evm/public-client";

const CHAIN_ID = 11155111;
const CAIP_CHAIN = `eip155:${CHAIN_ID}`;

interface WalletConnectSession {
  expiry: number;
  namespaces: Record<string, { accounts: string[]; methods: string[]; events: string[]; chains?: string[] }>;
}

export interface WalletConnectProviderLike {
  session?: WalletConnectSession | undefined;
  connect(options: unknown): Promise<WalletConnectSession | undefined>;
  disconnect(): Promise<void>;
  request<T = unknown>(args: { method: string; params?: unknown[] | object }, chain?: string): Promise<T>;
  setDefaultChain(chain: string, rpcUrl?: string): void;
  on(event: string, listener: (...args: unknown[]) => void): void;
  off(event: string, listener: (...args: unknown[]) => void): void;
}

export type WalletConnectProviderFactory = (projectId: string) => Promise<WalletConnectProviderLike>;

export type WalletConnectStatus =
  | { state: "unconfigured" }
  | { state: "disconnected" }
  | { state: "connecting"; pairingUri?: string }
  | { state: "connected"; account: Address; expiresAt: number }
  | { state: "expired" }
  | { state: "error"; message: string };

export class WalletConnectSafeOwnerSigner implements SignerTransport {
  readonly kind = "walletconnect" as const;
  readonly capabilities = {
    chains: ["evm:11155111" as const],
    interactive: true,
    typedData: true,
  };

  private provider?: WalletConnectProviderLike;
  private status: WalletConnectStatus;
  private readonly listeners = new Set<(status: WalletConnectStatus) => void>();
  private readonly eventHandlers = new Map<string, (...args: unknown[]) => void>();

  constructor(
    private readonly projectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID?.trim() ?? "",
    private readonly providerFactory: WalletConnectProviderFactory = createWalletConnectProvider,
    private readonly now: () => number = Date.now,
  ) {
    this.status = projectId ? { state: "disconnected" } : { state: "unconfigured" };
  }

  async isAvailable(): Promise<boolean> {
    return this.projectId.length > 0;
  }

  snapshot(): WalletConnectStatus {
    return this.status;
  }

  subscribe(listener: (status: WalletConnectStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.status);
    return () => this.listeners.delete(listener);
  }

  async restore(): Promise<WalletConnectStatus> {
    if (!(await this.isAvailable())) return this.setStatus({ state: "unconfigured" });
    try {
      const provider = await this.ensureProvider();
      const status = this.adoptSession(provider.session);
      if (status.state === "connected") {
        provider.setDefaultChain(CAIP_CHAIN, getEvmRpcUrl(CHAIN_ID));
      }
      return status;
    } catch (error) {
      return this.setStatus({ state: "error", message: walletConnectError(error, "WalletConnect session recovery failed") });
    }
  }

  async connect(): Promise<WalletConnectStatus> {
    if (!(await this.isAvailable())) {
      throw new Error("WalletConnect is unavailable: VITE_WALLETCONNECT_PROJECT_ID is not configured");
    }
    const provider = await this.ensureProvider();
    const restored = this.adoptSession(provider.session);
    if (restored.state === "connected") return restored;
    if (provider.session) {
      await provider.disconnect().catch(() => undefined);
    }

    this.setStatus({ state: "connecting" });
    try {
      const session = await provider.connect({
        namespaces: {
          eip155: {
            chains: [CAIP_CHAIN],
            methods: ["eth_signTypedData_v4"],
            events: ["accountsChanged", "chainChanged"],
            rpcMap: { [CHAIN_ID]: getEvmRpcUrl(CHAIN_ID) },
          },
        },
      });
      provider.setDefaultChain(CAIP_CHAIN, getEvmRpcUrl(CHAIN_ID));
      const adopted = this.adoptSession(session ?? provider.session);
      if (adopted.state !== "connected") {
        throw new Error("WalletConnect pairing completed without a usable Sepolia account");
      }
      return adopted;
    } catch (error) {
      const message = walletConnectError(error, "WalletConnect pairing failed");
      this.setStatus({ state: "error", message });
      throw new Error(message, { cause: error });
    }
  }

  async disconnect(): Promise<void> {
    try {
      if (this.provider?.session) await this.provider.disconnect();
      this.setStatus({ state: "disconnected" });
    } catch {
      throw new Error("WalletConnect disconnect failed");
    }
  }

  async sign(request: SignRequest): Promise<Signature> {
    if (request.chain !== "evm:11155111") {
      throw new Error(`WalletConnect Safe owner signer does not support ${request.chain}`);
    }
    const context = parseContext(request.context);
    if (context.pending.chain !== request.chain) throw new Error("sign request chain does not match pending transaction");
    if (context.pending.signingDigest.toLowerCase() !== request.digest.toLowerCase()) {
      throw new Error("sign request digest does not match pending transaction");
    }

    const status = await this.restore();
    if (status.state === "expired") throw new Error("WalletConnect session expired; pair the wallet again");
    if (status.state === "unconfigured") {
      throw new Error("WalletConnect is unavailable: VITE_WALLETCONNECT_PROJECT_ID is not configured");
    }
    if (status.state === "error") throw new Error(status.message);
    if (status.state !== "connected") throw new Error("WalletConnect wallet is not connected");
    const provider = this.provider!;
    const payload = parseSafePayment(context.pending.payloadJson);
    assertSafeReviewBinding(context.pending, context.multisig, payload);
    const digest = canonicalSafeTxHash(payload);
    if (digest.toLowerCase() !== request.digest.toLowerCase()) {
      throw new Error("Stored SafeTx hash does not match the reviewed transaction payload");
    }

    const live = await readSafeSnapshot(CHAIN_ID, payload.safeAddress);
    assertLiveSafeConfiguration(context.multisig, live);
    if (!live.owners.some((owner) => owner.toLowerCase() === status.account.toLowerCase())) {
      throw new Error(`WalletConnect account ${status.account} is not a live owner of this Safe`);
    }

    let raw: unknown;
    try {
      raw = await provider.request(
        {
          method: "eth_signTypedData_v4",
          params: [status.account, JSON.stringify(safeTypedData(payload))],
        },
        CAIP_CHAIN,
      );
    } catch (error) {
      throw new Error(walletConnectError(error, "WalletConnect signature request failed"), { cause: error });
    }
    if (typeof raw !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(raw)) {
      throw new Error("WalletConnect wallet returned a malformed Safe owner signature");
    }
    const verified = await verifySafeOwnerSignature({
      digest,
      signer: status.account,
      signature: raw as Hex,
    });
    return { signerHash: verified.signer, bytes: verified.bytes };
  }

  private async ensureProvider(): Promise<WalletConnectProviderLike> {
    if (this.provider) return this.provider;
    const provider = await this.providerFactory(this.projectId);
    this.provider = provider;
    this.bindProviderEvents(provider);
    return provider;
  }

  private bindProviderEvents(provider: WalletConnectProviderLike): void {
    const handlers: Record<string, (...args: unknown[]) => void> = {
      display_uri: (uri) => {
        if (typeof uri === "string") this.setStatus({ state: "connecting", pairingUri: uri });
      },
      session_delete: () => this.setStatus({ state: "disconnected" }),
      session_update: () => this.adoptSession(provider.session),
      accountsChanged: () => this.adoptSession(provider.session),
      chainChanged: (chain) => {
        const id = typeof chain === "string" && chain.startsWith("0x")
          ? Number.parseInt(chain.slice(2), 16)
          : Number(chain);
        if (id !== CHAIN_ID) {
          this.setStatus({ state: "error", message: `WalletConnect chain mismatch: expected ${CHAIN_ID}, received ${String(chain)}` });
        }
      },
    };
    for (const [event, handler] of Object.entries(handlers)) {
      provider.on(event, handler);
      this.eventHandlers.set(event, handler);
    }
  }

  private adoptSession(session: WalletConnectSession | undefined): WalletConnectStatus {
    if (!session) return this.setStatus({ state: "disconnected" });
    if (session.expiry * 1_000 <= this.now()) return this.setStatus({ state: "expired" });
    const namespace = session.namespaces.eip155;
    if (!namespace?.methods.includes("eth_signTypedData_v4")) {
      return this.setStatus({ state: "error", message: "WalletConnect session does not authorize EIP-712 typed-data signing" });
    }
    const accountEntry = namespace?.accounts.find((entry) => entry.startsWith(`${CAIP_CHAIN}:`));
    if (!accountEntry) {
      return this.setStatus({ state: "error", message: `WalletConnect session does not authorize Sepolia (${CAIP_CHAIN})` });
    }
    const address = accountEntry.slice(`${CAIP_CHAIN}:`.length);
    try {
      return this.setStatus({ state: "connected", account: getAddress(address), expiresAt: session.expiry * 1_000 });
    } catch {
      return this.setStatus({ state: "error", message: "WalletConnect session contains an invalid account" });
    }
  }

  private setStatus(status: WalletConnectStatus): WalletConnectStatus {
    this.status = status;
    for (const listener of this.listeners) listener(status);
    return status;
  }
}

async function createWalletConnectProvider(projectId: string): Promise<WalletConnectProviderLike> {
  const { default: UniversalProvider } = await import("@walletconnect/universal-provider");
  return UniversalProvider.init({
    projectId,
    // Passing a logger object bypasses WalletConnect's in-memory chunk logger;
    // session topics and pairing data are never mirrored into an app log.
    logger: silentWalletConnectLogger() as never,
    metadata: {
      name: "ChainPay",
      description: "Self-custodied Safe treasury approvals",
      url: "https://chainpay.local",
      icons: [],
    },
  }) as Promise<WalletConnectProviderLike>;
}

function silentWalletConnectLogger(): object {
  const noop = () => undefined;
  const logger: object = new Proxy(
    {},
    {
      get: (_target, property) => {
        if (typeof property === "symbol") return undefined;
        if (property === "level") return "silent";
        if (property === "child") return () => logger;
        if (property === "bindings") return () => ({});
        if (property === "isLevelEnabled") return () => false;
        return noop;
      },
    },
  );
  return logger;
}

function parseContext(context: unknown): SafeOwnerSignContext {
  if (typeof context !== "object" || context === null || !("pending" in context) || !("multisig" in context)) {
    throw new Error("WalletConnect Safe owner signer requires pending transaction context");
  }
  return context as SafeOwnerSignContext;
}

function assertLiveSafeConfiguration(
  expected: EvmMultisig,
  live: { owners: readonly string[]; threshold: number; version: string },
): void {
  const owners = (values: readonly string[]) => values.map((value) => value.toLowerCase()).sort().join(",");
  if (
    live.version !== expected.version ||
    live.threshold !== expected.threshold ||
    owners(live.owners) !== owners(expected.owners)
  ) {
    throw new Error("Safe owner configuration changed since this payment was created");
  }
}

function walletConnectError(error: unknown, fallback: string): string {
  const candidate = error as { code?: unknown; message?: unknown } | null;
  if (candidate?.code === 4001 || candidate?.code === 5000) return "WalletConnect request was rejected by the wallet";
  const message = typeof candidate?.message === "string" ? candidate.message.toLowerCase() : "";
  if (message.includes("reject")) return "WalletConnect request was rejected by the wallet";
  if (message.includes("expir")) return "WalletConnect session expired; pair the wallet again";
  if (message.includes("unauthor") || message.includes("not approved")) {
    return "WalletConnect session did not authorize the requested Sepolia typed-data method";
  }
  return fallback;
}

let singleton: WalletConnectSafeOwnerSigner | undefined;

export function walletConnectSafeOwnerSigner(): WalletConnectSafeOwnerSigner {
  singleton ??= new WalletConnectSafeOwnerSigner();
  return singleton;
}
