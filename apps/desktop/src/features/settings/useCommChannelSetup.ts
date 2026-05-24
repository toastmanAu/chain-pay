import { useCommIdentityStore, type CommIdentityState } from "../../stores/comm-identity";
import { IdentityGenerationError } from "../../lib/comm/errors";

export type CommSetupState =
  | { kind: "not-configured" }
  | { kind: "funding"; address: string; addrHash: string }
  | { kind: "ready"; address: string; publishedAt: number };

export interface CommChannelSetupApi {
  state: CommSetupState;
  generate: () => Promise<void>;
  deleteIdentity: () => Promise<void>;
}

/**
 * Derives a setup-flow state from the comm-identity store + exposes the
 * setup actions. The transient "publishing" state lives in the container
 * component (CommChannelSection) — not derivable from store alone.
 */
export function useCommChannelSetup(): CommChannelSetupApi {
  const identity = useCommIdentityStore((s) => s.identity);

  const state = deriveState(identity);

  async function generate(): Promise<void> {
    try {
      const generated = await window.chainpay.commIdentity.generate();
      useCommIdentityStore.getState().setIdentity({
        mlDsaPub: generated.mlDsaPub,
        mlKemPub: generated.mlKemPub,
        address: generated.address,
        addrHash: generated.addrHash,
        createdAt: generated.createdAt,
        fundedAt: null,
        profileTxHash: null,
        profilePublishedAt: null,
      });
    } catch (cause) {
      throw new IdentityGenerationError(
        cause instanceof Error ? cause.message : "comm identity generation failed",
        { cause },
      );
    }
  }

  async function deleteIdentity(): Promise<void> {
    await window.chainpay.commIdentity.delete();
    useCommIdentityStore.getState().clear();
  }

  return { state, generate, deleteIdentity };
}

function deriveState(identity: CommIdentityState | null): CommSetupState {
  if (!identity) return { kind: "not-configured" };
  if (identity.profileTxHash && identity.profilePublishedAt) {
    return {
      kind: "ready",
      address: identity.address,
      publishedAt: identity.profilePublishedAt,
    };
  }
  return { kind: "funding", address: identity.address, addrHash: identity.addrHash };
}
