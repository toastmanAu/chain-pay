import { beforeEach, describe, expect, it, vi } from "vitest";
import { SOLANA_CHANNELS } from "@chain-pay/shared";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  scan: vi.fn(),
  status: vi.fn(),
}));

vi.mock("electron", () => ({ ipcMain: { handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => mocks.handlers.set(channel, handler)) } }));
vi.mock("./solana-provider", () => ({
  SolanaProviderError: class SolanaProviderError extends Error { constructor(readonly code: string, message: string) { super(message); } },
  solanaProviderConfigFromEnvironment: vi.fn(() => ({ rpcUrl: "https://private.example", bearerToken: "top-secret" })),
  scanSolanaAddress: mocks.scan,
  getSolanaTransactionStatus: mocks.status,
}));

import { registerSolanaIpc } from "./solana-host";

describe("Solana IPC boundary", () => {
  beforeEach(() => { mocks.handlers.clear(); mocks.scan.mockReset(); mocks.status.mockReset(); registerSolanaIpc(); });

  it.each(["seed", "privateKey", "keypair", "secretKey", "mnemonic", "rpcUrl", "bearerToken"])(
    "rejects an out-of-contract %s field before provider access",
    async (field) => {
      const handler = mocks.handlers.get(SOLANA_CHANNELS.scan)!;
      await expect(handler({}, { chain: "sol:devnet", address: "public", [field]: "must-not-cross" }))
        .rejects.toMatchObject({ code: "invalid_request", message: "Solana scan request is invalid" });
      expect(mocks.scan).not.toHaveBeenCalled();
    },
  );

  it("passes only the exact public scan contract to the main-process provider", async () => {
    mocks.scan.mockResolvedValue({ snapshot: { balanceLamports: "0" } });
    const request = { chain: "sol:devnet", address: "public-address" };
    await mocks.handlers.get(SOLANA_CHANNELS.scan)!({}, request);
    expect(mocks.scan).toHaveBeenCalledWith({
      chain: "sol:devnet",
      address: "public-address",
      config: { rpcUrl: "https://private.example", bearerToken: "top-secret" },
    });
  });
});
