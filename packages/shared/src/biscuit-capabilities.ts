export const L1_CAPABILITIES = [
  'write("invoices")',
  'read("treasury")',
  'read("payment_batches")',
  'sign("approval_request")',
] as const;

export type L1Capability = (typeof L1_CAPABILITIES)[number];

export const CAPTURE_V1_CAPABILITIES: readonly L1Capability[] = ['write("invoices")'];

export interface ParsedBiscuitSource {
  capabilities: string[];
  deviceLabel: string | null;
  expiry: string | null;
}

/**
 * Builds a Biscuit Datalog **source** string (not a standalone token) intended for
 * further processing by a Biscuit library. The `deviceLabel` is sanitized against
 * Datalog injection, but callers should still pass a trustworthy value.
 */
export function buildBiscuitSource(
  capabilities: readonly L1Capability[],
  expiryRfc3339: string,
  deviceLabel: string,
): string {
  if (/[\n\r)\\]/.test(deviceLabel)) {
    throw new Error(
      "device label contains forbidden character — only printable, single-line strings are allowed",
    );
  }
  const lines: string[] = capabilities.map((c) => `${c};`);
  lines.push(`device_label("${deviceLabel.replace(/"/g, '\\"')}");`);
  lines.push(`check if time($time), $time <= ${expiryRfc3339};`);
  return lines.join("\n");
}

export function parseBiscuitSource(source: string): ParsedBiscuitSource {
  const lines = source
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const capabilities: string[] = [];
  let deviceLabel: string | null = null;
  let expiry: string | null = null;
  for (const line of lines) {
    const labelMatch = line.match(/^device_label\("(.+?)"\);?$/);
    if (labelMatch) {
      deviceLabel = labelMatch[1]!.replace(/\\"/g, '"');
      continue;
    }
    const expiryMatch = line.match(/^check if time\(\$time\), \$time <= (.+);?$/);
    if (expiryMatch) {
      expiry = expiryMatch[1]!.replace(/;$/, "");
      continue;
    }
    const capMatch = line.match(/^((?:read|write|sign)\(".+?"\));?$/);
    if (capMatch) {
      capabilities.push(capMatch[1]!);
    }
  }
  return { capabilities, deviceLabel, expiry };
}
