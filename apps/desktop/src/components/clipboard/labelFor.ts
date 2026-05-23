/**
 * Best-effort label for a copied value, so the clipboard bin shows what's in
 * it without the user having to rename anything. Pure — safe to call cheaply
 * on every copy.
 */
export function labelFor(value: string): string {
  const v = value.trim();
  if (!v) return "empty";
  if (/^ck[bt]1[0-9a-z]{40,}$/.test(v)) return "address";
  if (/^0x[0-9a-fA-F]{260,}$/.test(v)) return "signature";
  if (/^0x[0-9a-fA-F]{64}$/.test(v)) return "sighash";
  if (/^0x[0-9a-fA-F]{40}$/.test(v)) return "blake160";
  if (v.startsWith("{") && tryParseJson(v)) return "packet";
  return "snippet";
}

function tryParseJson(s: string): boolean {
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
}

export function truncate(value: string, max = 64): string {
  if (value.length <= max) return value;
  const head = Math.floor(max * 0.55);
  const tail = max - head - 1;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}
