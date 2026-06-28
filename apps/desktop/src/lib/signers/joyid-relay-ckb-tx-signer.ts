import { Transaction } from "@ckb-ccc/core";
import type { TransactionLike } from "@ckb-ccc/core";
import { calculateChallenge } from "@joyid/ckb";
import type { CKBTransaction } from "@joyid/ckb";
import type { CkbNetwork } from "@/lib/light-client/network-configs";
import type { CkbTxSigner } from "./ckb-tx-signer";
import { RelayClient } from "./joyid-relay/relay-client";
import { assembleSignedCkbTx } from "./joyid-relay/witness";
import { AuthResultSchema, SignResultSchema, parseDecoded, type SignPresenter } from "./joyid-relay/types";

export interface JoyIdRelaySignerOpts {
  network: CkbNetwork;
  presenter: SignPresenter;
  address?: string;
  client?: RelayClient;
}

export class JoyIdRelaySigner implements CkbTxSigner {
  readonly kind = "joyid" as const;
  private address: string;
  private readonly presenter: SignPresenter;
  private readonly client: RelayClient;

  constructor(opts: JoyIdRelaySignerOpts) {
    this.presenter = opts.presenter;
    this.address = opts.address ?? "";
    this.client = opts.client ?? new RelayClient({ network: opts.network });
  }

  async connect(): Promise<{ address: string; lockArgs: string }> {
    const { id, callbackUrl } = await this.client.createSession();
    this.presenter.showQr(this.client.buildAuthUrl(callbackUrl), "connect");
    this.presenter.updateStatus("awaiting-scan");
    try {
      const decoded = await this.client.pollSession(id);
      const auth = parseDecoded(AuthResultSchema, decoded);
      this.address = auth.address;
      this.presenter.updateStatus("done");
      return { address: auth.address, lockArgs: auth.pubkey };
    } catch (err) {
      this.presenter.updateStatus("error");
      throw err;
    } finally {
      this.presenter.dismiss();
    }
  }

  async signTransaction(unsigned: Transaction): Promise<Transaction> {
    if (!this.address) {
      throw new Error("JoyIdRelaySigner: address unknown — connect() or pass address first");
    }
    const ckbTx = JSON.parse(unsigned.stringify()) as { inputs: unknown[] };
    const witnessIndexes = ckbTx.inputs.map((_, i) => i); // single-source builder: all inputs are the JoyID lock
    const challenge = await calculateChallenge(ckbTx as unknown as CKBTransaction, witnessIndexes);

    const { id, callbackUrl } = await this.client.createSession();
    const joyidSignUrl = this.client.buildSignUrl({ callbackUrl, challenge, address: this.address });
    this.presenter.updateStatus("awaiting-confirm");
    try {
      const { launchUrl } = await this.client.createTxSession({ id, joyidSignUrl, preview: {} });
      if (!launchUrl.startsWith(this.client.relayOrigin + "/")) {
        throw new Error("Relay returned a launchUrl outside the configured relay origin");
      }
      this.presenter.showQr(launchUrl, "sign");
      const decoded = await this.client.pollSession(id);
      const raw = parseDecoded(SignResultSchema, decoded);
      this.presenter.updateStatus("assembling");
      const signedCkb = assembleSignedCkbTx(ckbTx, raw, witnessIndexes);
      this.presenter.updateStatus("done");
      return Transaction.from(signedCkb as unknown as TransactionLike);
    } catch (err) {
      this.presenter.updateStatus("error");
      throw err;
    } finally {
      this.presenter.dismiss();
    }
  }
}
