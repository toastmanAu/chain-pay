import { describe, it, expect } from "vitest";
import { createFiberConnectUri, parseFiberConnectUri } from "@chain-pay/shared";

describe("shared package resolves from mobile", () => {
  it("round-trips", () => {
    const uri = createFiberConnectUri({ rpc_url: "https://x:1", auth_token: "t" });
    expect(parseFiberConnectUri(uri).auth_token).toBe("t");
  });
});
