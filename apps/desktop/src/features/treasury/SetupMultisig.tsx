export function SetupMultisig() {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">New multisig treasury</h1>
      <p className="text-sm text-fg-muted">
        Wizard: pick chain (CKB or EVM), set M-of-N threshold, paste co-signer public keys / Safe owner addresses,
        derive treasury address.
      </p>
      <div className="rounded-lg border border-warn/40 bg-warn/5 p-4 text-sm">
        Phase 2 implementation. CKB will use <code>secp256k1_blake160_multisig_all</code> with lock args ={" "}
        <code>blake160(S|R|M|N|pubkey_hashes...)</code>. EVM will use Safe v1.4 contracts.
      </div>
    </div>
  );
}
