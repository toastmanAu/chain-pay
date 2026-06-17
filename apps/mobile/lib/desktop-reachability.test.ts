import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/transport/ip-client", () => ({ healthCheck: vi.fn() }));
import { healthCheck } from "@/lib/transport/ip-client";
import { checkReachability } from "./desktop-reachability";

const pairing = {
  rpc_url: "https://192.168.68.102:8233",
  auth_token: "t",
  cert_fingerprint: "f",
  desktop_comm_pubkey: "k",
};

describe("checkReachability", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns null and skips healthCheck when unpaired", async () => {
    expect(await checkReachability(null)).toBe(null);
    expect(healthCheck).not.toHaveBeenCalled();
  });

  it("returns true when healthCheck resolves true", async () => {
    vi.mocked(healthCheck).mockResolvedValue(true);
    expect(await checkReachability(pairing)).toBe(true);
  });

  it("returns false when healthCheck resolves false", async () => {
    vi.mocked(healthCheck).mockResolvedValue(false);
    expect(await checkReachability(pairing)).toBe(false);
  });

  it("returns false (not a throw) when healthCheck rejects", async () => {
    vi.mocked(healthCheck).mockRejectedValue(new Error("network"));
    expect(await checkReachability(pairing)).toBe(false);
  });
});
