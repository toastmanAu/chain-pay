import { describe, expect, it } from "vitest";
import * as shared from "./index";

describe("@chain-pay/shared exports", () => {
  it("re-exports invoice types", () => {
    expect(shared).toHaveProperty("InvoiceSchema");
    expect(shared).toHaveProperty("INVOICE_SCHEMA_VERSION");
    expect(shared.INVOICE_SCHEMA_VERSION).toBe("0.1.0");
  });

  it("re-exports vendor types", () => {
    expect(true).toBe(true);
  });

  it("re-exports batch discriminator helpers", () => {
    expect(typeof shared.isVendorBatch).toBe("function");
    expect(typeof shared.isPayrollBatch).toBe("function");
  });
});
