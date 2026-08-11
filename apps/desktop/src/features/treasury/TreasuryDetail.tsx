import { useNavigate, useParams } from "react-router-dom";
import {
  isBitcoinWatchTreasury,
  isMultisigTreasury,
  isSolanaWatchTreasury,
} from "@chain-pay/shared";
import { useTreasuryStore } from "@/stores/treasury";
import { BitcoinWatchDetail } from "./BitcoinWatchDetail";
import { CkbTreasuryDetail } from "./CkbTreasuryDetail";
import { EvmTreasuryDetail } from "./EvmTreasuryDetail";
import { SolanaWatchDetail } from "./SolanaWatchDetail";

export function TreasuryDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const treasury = useTreasuryStore((s) => s.treasuries.find((t) => t.id === id));

  if (!treasury) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">Treasury not found</h1>
        <button
          type="button"
          onClick={() => navigate("/treasury")}
          className="rounded-md border border-surface-hi bg-surface px-4 py-2 text-sm hover:text-fg"
        >
          Back to treasury list
        </button>
      </div>
    );
  }

  if (isBitcoinWatchTreasury(treasury)) return <BitcoinWatchDetail treasury={treasury} />;
  if (isSolanaWatchTreasury(treasury)) return <SolanaWatchDetail treasury={treasury} />;
  if (!isMultisigTreasury(treasury)) return null;
  if (treasury.multisig.chain.startsWith("evm:")) return <EvmTreasuryDetail treasury={treasury} />;

  return <CkbTreasuryDetail treasury={treasury} />;
}
