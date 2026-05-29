import { useMemo, useState } from "react";
import type { VendorProfile } from "@chain-pay/shared";
import { useVendorsStore } from "@/stores/vendors";

interface Props {
  onSelect: (vendor: VendorProfile) => void;
}

export function VendorPicker({ onSelect }: Props) {
  const vendors = useVendorsStore((s) => s.vendors);
  const addVendor = useVendorsStore((s) => s.addVendor);
  const findByName = useVendorsStore((s) => s.findByDisplayNameAndTaxId);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftTaxId, setDraftTaxId] = useState("");

  const filtered = useMemo(
    () => vendors.filter((v) => v.displayName.toLowerCase().includes(query.toLowerCase())),
    [vendors, query],
  );

  function submitNew() {
    if (!draftName.trim()) return;
    const existing = findByName(draftName.trim(), draftTaxId.trim() || undefined);
    if (existing) {
      onSelect(existing);
      setCreating(false);
      return;
    }
    const now = new Date().toISOString();
    const taxId = draftTaxId.trim();
    const created: VendorProfile = {
      id: `vendor_${crypto.randomUUID()}`,
      displayName: draftName.trim(),
      ...(taxId ? { taxId } : {}),
      preferredChain: "ckb:testnet",
      active: true,
      createdAt: now,
      updatedAt: now,
    };
    addVendor(created);
    onSelect(created);
    setCreating(false);
    setDraftName("");
    setDraftTaxId("");
  }

  if (creating) {
    return (
      <div className="vendor-picker-form">
        <label>
          Display name
          <input value={draftName} onChange={(e) => setDraftName(e.target.value)} />
        </label>
        <label>
          Tax ID (optional)
          <input value={draftTaxId} onChange={(e) => setDraftTaxId(e.target.value)} />
        </label>
        <button type="button" onClick={submitNew}>Create</button>
        <button type="button" onClick={() => setCreating(false)}>Cancel</button>
      </div>
    );
  }

  return (
    <div className="vendor-picker">
      <input
        placeholder="Search vendors…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <ul>
        {filtered.map((v) => (
          <li key={v.id}>
            <button type="button" onClick={() => onSelect(v)}>
              {v.displayName}
              {v.taxId && <span className="vendor-tax-id"> ({v.taxId})</span>}
            </button>
          </li>
        ))}
      </ul>
      <button type="button" onClick={() => setCreating(true)}>+ New vendor</button>
    </div>
  );
}
