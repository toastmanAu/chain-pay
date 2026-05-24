import { useMemo, useState } from "react";
import type { Hex20 } from "@chain-pay/shared";
import {
  decodeTransferPacket,
  type DecodedTransferPacket,
} from "@/lib/chains/ckb/transfer-packet";
import {
  pubkeyHashFromPrivateKey,
  signDigest,
  verifyDigestSignature,
  compressedPubkeyFromPrivateKey,
} from "@/lib/signers/ckb-secp256k1";
import { decryptCkbCliKeystore } from "@/lib/signers/ckb-cli-keystore";
import { SignInbox } from "./SignInbox";
import {
  useIncomingPacketsStore,
  type IncomingPacketEntry,
} from "@/stores/incoming-packets";

const SHANNONS_PER_CKB = 100_000_000n;

interface SignResult {
  signature: string;
  signerPubkeyHash: Hex20;
  slotIndex: number;
}

export function SignPanel() {
  const [packetJson, setPacketJson] = useState("");
  const [keystoreJson, setKeystoreJson] = useState("");
  const [password, setPassword] = useState("");
  const [decrypting, setDecrypting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SignResult | null>(null);

  const packet = useMemo<DecodedTransferPacket | null>(() => {
    if (!packetJson.trim()) return null;
    try {
      return decodeTransferPacket(packetJson);
    } catch {
      return null;
    }
  }, [packetJson]);

  const packetError = packetJson.trim() && !packet ? safeDecodeError(packetJson) : null;

  const handleClaim = (entry: IncomingPacketEntry) => {
    // entry.packet.packet is the same TransferPacket JSON string the paste
    // textarea accepts — replay it through the same state path.
    setPacketJson(entry.packet.packet);
    setError(null);
    setResult(null);
    useIncomingPacketsStore.getState().dismiss(entry.sighashDigest);
  };

  const handleSign = async () => {
    if (!packet) return;
    setError(null);
    setResult(null);
    setDecrypting(true);

    try {
      const privKey = await decryptCkbCliKeystore(keystoreJson, password);
      const privKeyHex = "0x" + bytesToHex(privKey);
      const signerHash = pubkeyHashFromPrivateKey(privKeyHex);
      const slotIndex = packet.treasuryConfig.pubkeyHashes.findIndex(
        (h) => h.toLowerCase() === signerHash.toLowerCase(),
      );
      if (slotIndex === -1) {
        throw new Error(
          `signer pubkey hash ${signerHash} is not a co-signer of this treasury (expected one of ${packet.treasuryConfig.pubkeyHashes.join(", ")})`,
        );
      }
      const signature = signDigest(packet.sighashDigest, privKeyHex);
      const pubkey = compressedPubkeyFromPrivateKey(privKeyHex);
      if (!verifyDigestSignature(packet.sighashDigest, signature, pubkey)) {
        throw new Error("internal: sig failed self-verify against derived pubkey");
      }
      setResult({ signature, signerPubkeyHash: signerHash, slotIndex });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDecrypting(false);
    }
  };

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Sign a treasury transaction</h1>
        <p className="text-sm text-fg-muted">
          Paste a transfer packet from the treasury operator, then your ckb-cli keystore. Your
          password and key never leave this app.
        </p>
      </header>

      <SignInbox onClaim={handleClaim} />

      <section className="space-y-2">
        <label className="text-sm font-medium">1. Transfer packet (JSON)</label>
        <textarea
          value={packetJson}
          onChange={(e) => setPacketJson(e.target.value)}
          placeholder='{"version":1,"network":"testnet",...}'
          spellCheck={false}
          rows={6}
          className="w-full rounded-md border border-surface-hi bg-bg px-3 py-2 font-mono text-xs text-fg placeholder:text-fg-muted focus:border-accent focus:outline-none"
        />
        {packetError ? <p className="text-xs text-danger">{packetError}</p> : null}
        {packet ? <PacketSummary packet={packet} /> : null}
      </section>

      {packet ? (
        <section className="space-y-2">
          <label className="text-sm font-medium">2. ckb-cli keystore (JSON)</label>
          <textarea
            value={keystoreJson}
            onChange={(e) => setKeystoreJson(e.target.value)}
            placeholder='{"version":3,"crypto":{...}}'
            spellCheck={false}
            rows={6}
            className="w-full rounded-md border border-surface-hi bg-bg px-3 py-2 font-mono text-xs text-fg placeholder:text-fg-muted focus:border-accent focus:outline-none"
          />
          <label className="block text-sm font-medium">3. Keystore password</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            className="w-full rounded-md border border-surface-hi bg-bg px-3 py-2 text-sm text-fg placeholder:text-fg-muted focus:border-accent focus:outline-none"
          />
          <div className="flex justify-end pt-2">
            <button
              type="button"
              onClick={handleSign}
              disabled={!keystoreJson.trim() || !password || decrypting}
              className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {decrypting ? "decrypting + signing…" : "Sign packet"}
            </button>
          </div>
        </section>
      ) : null}

      {error ? (
        <div className="rounded-lg border border-danger/40 bg-danger/5 p-4 text-sm text-danger">
          {error}
        </div>
      ) : null}

      {result ? <SignResultPanel result={result} /> : null}
    </div>
  );
}

function PacketSummary({ packet }: { packet: DecodedTransferPacket }) {
  const cfg = packet.treasuryConfig;
  return (
    <div className="space-y-3 rounded-lg border border-surface-hi bg-surface p-4 text-sm">
      <div className="flex items-center gap-2">
        <span className="rounded-md bg-surface-hi px-2 py-0.5 text-xs text-fg-muted">
          {packet.network === "mainnet" ? "CKB mainnet" : "CKB testnet"}
        </span>
        <span className="text-xs text-fg-muted">
          {cfg.m}-of-{cfg.n} multisig
        </span>
        {packet.label ? <span className="text-fg-muted">·</span> : null}
        {packet.label ? <span className="text-fg">{packet.label}</span> : null}
      </div>

      <div>
        <div className="text-xs uppercase tracking-wide text-fg-muted">Outputs</div>
        <ul className="mt-1 space-y-1">
          {packet.tx.outputs.map((o, i) => (
            <li key={i} className="flex justify-between gap-3 font-mono text-xs">
              <span className="break-all text-fg-muted">{o.lock.args}</span>
              <span className="shrink-0 text-fg tabular-nums">{formatCkb(o.capacity)} CKB</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="grid grid-cols-3 gap-3 text-xs">
        <KV label="Inputs" value={`${packet.tx.inputs.length}`} />
        <KV label="Fee" value={`${formatCkb(packet.meta.fee)} CKB`} />
        <KV
          label="Change → treasury"
          value={packet.meta.change > 0n ? `${formatCkb(packet.meta.change)} CKB` : "—"}
        />
      </div>

      <div>
        <div className="text-xs uppercase tracking-wide text-fg-muted">Sighash digest</div>
        <div className="mt-1 break-all font-mono text-xs text-accent">{packet.sighashDigest}</div>
      </div>
    </div>
  );
}

function SignResultPanel({ result }: { result: SignResult }) {
  return (
    <div className="space-y-3 rounded-lg border border-accent/40 bg-accent/5 p-5">
      <div className="text-sm font-medium text-accent">Signature ready</div>
      <p className="text-xs text-fg-muted">
        Filled slot <strong className="text-fg">{result.slotIndex + 1}</strong> with pubkey hash{" "}
        <code className="break-all font-mono text-fg">{result.signerPubkeyHash}</code>. Send the
        signature below back to the treasury operator.
      </p>
      <div>
        <div className="text-xs uppercase tracking-wide text-fg-muted">Signature (65 bytes)</div>
        <div className="mt-1 flex items-start gap-2">
          <code className="break-all rounded-md border border-surface-hi bg-bg px-3 py-2 font-mono text-xs text-fg">
            {result.signature}
          </code>
          <button
            type="button"
            onClick={() => void navigator.clipboard.writeText(result.signature)}
            className="shrink-0 rounded-md border border-surface-hi bg-surface px-3 py-2 text-xs hover:text-fg"
          >
            Copy
          </button>
        </div>
      </div>
    </div>
  );
}

function KV({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-bg/40 p-2">
      <div className="text-xs uppercase tracking-wide text-fg-muted">{label}</div>
      <div className="mt-1 text-sm tabular-nums">{value}</div>
    </div>
  );
}

function formatCkb(shannons: bigint): string {
  const whole = shannons / SHANNONS_PER_CKB;
  const fractional = shannons % SHANNONS_PER_CKB;
  const wholeFmt = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  if (fractional === 0n) return wholeFmt;
  const fracStr = fractional.toString().padStart(8, "0").replace(/0+$/, "");
  return `${wholeFmt}.${fracStr}`;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function safeDecodeError(json: string): string {
  try {
    decodeTransferPacket(json);
    return "";
  } catch (e: unknown) {
    return e instanceof Error ? e.message : String(e);
  }
}
