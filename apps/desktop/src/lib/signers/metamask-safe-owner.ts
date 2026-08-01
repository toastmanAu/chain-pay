import type { EvmMultisig, PendingTx } from "@chain-pay/shared";
import type { Signature, SignRequest, SignerTransport } from "./types";
import {
  approveSafePayment,
  type Eip1193Provider,
  type SafeSigningFactory,
} from "@/lib/chains/evm/injected-owner-signer";

export interface SafeOwnerSignContext {
  pending: PendingTx;
  multisig: EvmMultisig;
}

export class MetaMaskSafeOwnerSigner implements SignerTransport {
  readonly kind = "metamask" as const;
  readonly capabilities = {
    chains: ["evm:11155111" as const],
    interactive: true,
    typedData: true,
  };

  constructor(
    private readonly provider: Eip1193Provider | undefined = globalThis.window?.ethereum,
    private readonly signingFactory?: SafeSigningFactory,
  ) {}

  async isAvailable(): Promise<boolean> {
    return this.provider !== undefined;
  }

  async sign(request: SignRequest): Promise<Signature> {
    if (request.chain !== "evm:11155111") {
      throw new Error(`MetaMask Safe owner signer does not support ${request.chain}`);
    }
    const context = parseContext(request.context);
    if (context.pending.chain !== request.chain) throw new Error("sign request chain does not match pending transaction");
    if (context.pending.signingDigest.toLowerCase() !== request.digest.toLowerCase()) {
      throw new Error("sign request digest does not match pending transaction");
    }
    const partial = await approveSafePayment(
      context.pending,
      context.multisig,
      this.provider,
      this.signingFactory,
    );
    return { signerHash: partial.signerHash, bytes: partial.bytes };
  }
}

function parseContext(context: unknown): SafeOwnerSignContext {
  if (
    typeof context !== "object" ||
    context === null ||
    !("pending" in context) ||
    !("multisig" in context)
  ) {
    throw new Error("MetaMask Safe owner signer requires pending transaction context");
  }
  return context as SafeOwnerSignContext;
}
