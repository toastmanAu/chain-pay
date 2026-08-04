import { describe, expect, it } from "vitest";
import { getAdapter, listEnabledAdapters } from "./registry";

describe("Solana adapter registration", () => {
  it("registers ready watch-only adapters for mainnet and devnet", () => {
    expect(getAdapter("sol:mainnet")).toMatchObject({ chain: "sol:mainnet", status: "ready" });
    expect(getAdapter("sol:devnet")).toMatchObject({ chain: "sol:devnet", status: "ready" });
    expect(listEnabledAdapters().map((adapter) => adapter.chain)).toEqual(expect.arrayContaining(["sol:mainnet", "sol:devnet"]));
  });
});
