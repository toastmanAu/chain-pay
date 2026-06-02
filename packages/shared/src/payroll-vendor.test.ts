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

  it("VendorPaymentBatch has a lines array (one per invoice)", () => {
    expectTypeOf<VendorPaymentBatch>().toHaveProperty("lines").toEqualTypeOf<VendorPaymentLine[]>();
  });

  it("VendorPaymentBatch backlinks an invoiceIds array", () => {
    expectTypeOf<VendorPaymentBatch>().toHaveProperty("invoiceIds").toEqualTypeOf<string[]>();
  });
});
