import { describe, expect, it } from "vitest";
import {
  L1_CAPABILITIES,
  CAPTURE_V1_CAPABILITIES,
  buildBiscuitSource,
  parseBiscuitSource,
} from "./biscuit-capabilities";

describe("L1 Biscuit capability vocabulary", () => {
  it("exposes the four L1 capabilities", () => {
    expect(L1_CAPABILITIES).toEqual([
      'write("invoices")',
      'read("treasury")',
      'read("payment_batches")',
      'sign("approval_request")',
    ]);
  });

  it("CAPTURE_V1 grants only write(invoices)", () => {
    expect(CAPTURE_V1_CAPABILITIES).toEqual(['write("invoices")']);
  });

  it("buildBiscuitSource produces deterministic source with expiry check", () => {
    const src = buildBiscuitSource(CAPTURE_V1_CAPABILITIES, "2026-07-02T00:00:00Z", "phone-1");
    expect(src).toBe(
      'write("invoices");\ndevice_label("phone-1");\ncheck if time($time), $time <= 2026-07-02T00:00:00Z;',
    );
  });

  it("parseBiscuitSource extracts capabilities and label", () => {
    const src = buildBiscuitSource(CAPTURE_V1_CAPABILITIES, "2026-07-02T00:00:00Z", "phone-1");
    const parsed = parseBiscuitSource(src);
    expect(parsed.capabilities).toEqual(['write("invoices")']);
    expect(parsed.deviceLabel).toBe("phone-1");
    expect(parsed.expiry).toBe("2026-07-02T00:00:00Z");
  });

  it("rejects device labels with newline injection", () => {
    expect(() =>
      buildBiscuitSource(CAPTURE_V1_CAPABILITIES, "2099-01-01T00:00:00Z", 'evil");\ncheck if false'),
    ).toThrow(/forbidden character/);
  });

  it("rejects device labels with carriage return", () => {
    expect(() =>
      buildBiscuitSource(CAPTURE_V1_CAPABILITIES, "2099-01-01T00:00:00Z", "evil\rinject"),
    ).toThrow(/forbidden character/);
  });

  it("rejects device labels with closing paren", () => {
    expect(() =>
      buildBiscuitSource(CAPTURE_V1_CAPABILITIES, "2099-01-01T00:00:00Z", "evil)"),
    ).toThrow(/forbidden character/);
  });

  it("rejects device labels with backslash", () => {
    expect(() =>
      buildBiscuitSource(CAPTURE_V1_CAPABILITIES, "2099-01-01T00:00:00Z", "evil\\foo"),
    ).toThrow(/forbidden character/);
  });

  it("round-trips all four L1 capabilities", () => {
    const src = buildBiscuitSource(L1_CAPABILITIES, "2099-01-01T00:00:00Z", "all-caps");
    const parsed = parseBiscuitSource(src);
    expect(parsed.capabilities).toEqual([...L1_CAPABILITIES]);
    expect(parsed.deviceLabel).toBe("all-caps");
    expect(parsed.expiry).toBe("2099-01-01T00:00:00Z");
  });
});
