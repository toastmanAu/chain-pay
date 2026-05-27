import { describe, it, expectTypeOf } from "vitest";
import type {
  PayrollBatch,
  VendorPaymentBatch,
  VendorPaymentLine,
  PayrollBatchState,
} from "./payroll";

describe("kind discriminator + VendorPaymentBatch", () => {
  it("PayrollBatch.kind is 'payroll'", () => {
    expectTypeOf<PayrollBatch>().toHaveProperty("kind").toEqualTypeOf<"payroll">();
  });

  it("VendorPaymentBatch.kind is 'vendor'", () => {
    expectTypeOf<VendorPaymentBatch>().toHaveProperty("kind").toEqualTypeOf<"vendor">();
  });

  it("VendorPaymentBatch shares state enum with PayrollBatch", () => {
    expectTypeOf<VendorPaymentBatch["state"]>().toEqualTypeOf<PayrollBatchState>();
  });

  it("VendorPaymentBatch has a single line, not an array", () => {
    expectTypeOf<VendorPaymentBatch>().toHaveProperty("line").toEqualTypeOf<VendorPaymentLine>();
  });

  it("VendorPaymentBatch backlinks an invoiceId", () => {
    expectTypeOf<VendorPaymentBatch>().toHaveProperty("invoiceId").toEqualTypeOf<string>();
  });
});
