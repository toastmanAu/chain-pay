import { useState } from "react";
import { ccc } from "@ckb-ccc/core";
import { useCommChannelSetup } from "./useCommChannelSetup";
import { useCommIdentityStore } from "../../stores/comm-identity";
import { lightClient } from "../../lib/light-client/client";
import { ProfilePublishError } from "../../lib/comm/errors";
import { NotConfiguredStep } from "./steps/NotConfiguredStep";
import { FundingStep } from "./steps/FundingStep";
import { PublishingStep } from "./steps/PublishingStep";
import { ReadyStep } from "./steps/ReadyStep";

function hexToBytes(hex: string): Uint8Array {
  const s = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function CommChannelSection() {
  const { state, generate, deleteIdentity } = useCommChannelSetup();
  const [generationError, setGenerationError] = useState<Error | null>(null);
  const [isPublishing, setIsPublishing] = useState(false);
  const [publishError, setPublishError] = useState<Error | null>(null);

  async function handleSetup(): Promise<void> {
    setGenerationError(null);
    try {
      await generate();
    } catch (err) {
      setGenerationError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  async function runPublish(): Promise<void> {
    setPublishError(null);
    try {
      const { txHash, txBytes } = await window.chainpay.commTransport.publishProfile({});
      const txBytesU8 = hexToBytes(txBytes);
      const tx = ccc.Transaction.fromBytes(txBytesU8);
      await lightClient().broadcastTransaction(tx);
      useCommIdentityStore.getState().recordProfilePublished(txHash, Date.now());
      setIsPublishing(false);
    } catch (err) {
      setPublishError(
        new ProfilePublishError(
          null,
          err instanceof Error ? err.message : "publish failed",
          { cause: err },
        ),
      );
      // Stay in publishing state so the retry UI is shown.
    }
  }

  async function handleFunded(): Promise<void> {
    setIsPublishing(true);
    await runPublish();
  }

  async function handleDelete(): Promise<void> {
    setIsPublishing(false);
    setPublishError(null);
    await deleteIdentity();
  }

  const wrapper = (children: React.ReactNode) => (
    <section className="rounded-lg border border-surface-hi bg-surface p-5">
      <h2 className="mb-3 text-lg font-semibold">Comm channel</h2>
      {children}
    </section>
  );

  if (state.kind === "not-configured") {
    return wrapper(<NotConfiguredStep onSetup={handleSetup} error={generationError} />);
  }

  if (state.kind === "funding" && !isPublishing) {
    return wrapper(
      <FundingStep address={state.address} onFunded={handleFunded} onCancel={handleDelete} />,
    );
  }

  if (state.kind === "funding" && isPublishing) {
    return wrapper(
      <PublishingStep address={state.address} error={publishError} onRetry={runPublish} />,
    );
  }

  if (state.kind === "ready") {
    return wrapper(
      <ReadyStep
        address={state.address}
        publishedAt={state.publishedAt}
        onDelete={handleDelete}
      />,
    );
  }

  return null;
}
