import { describe, it, expect, vi, beforeEach } from "vitest";
import { Transaction } from "@ckb-ccc/core";
import { JoyIdRelaySigner } from "./joyid-relay-ckb-tx-signer";

// calculateChallenge requires non-empty witnesses; mock it so the poll-failure
// test can reach pollSession without an empty-witnesses throw from @joyid/ckb.
vi.mock("@joyid/ckb", () => ({
  calculateChallenge: vi.fn().mockResolvedValue("0xdeadbeef"),
  buildSignedTx: vi.fn().mockReturnValue({}),
}));

const presenter = { showQr: vi.fn(), updateStatus: vi.fn(), dismiss: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
});

function fakeClient(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    relayOrigin: "https://relay.test",
    createSession: vi.fn().mockResolvedValue({ id: "s1", callbackUrl: "https://relay.test/session/s1/callback" }),
    buildAuthUrl: vi.fn().mockReturnValue("https://testnet.joyid.dev/auth?x"),
    buildSignUrl: vi.fn().mockReturnValue("https://testnet.joyid.dev/sign-message?x"),
    createTxSession: vi.fn().mockResolvedValue({ launchUrl: "https://relay.test/tx-launch/s1" }),
    pollSession: vi.fn(),
    ...overrides,
  } as unknown as import("./joyid-relay/relay-client").RelayClient;
}

describe("JoyIdRelaySigner", () => {
  it("connect renders the auth QR and returns the address from the phone result", async () => {
    const client = fakeClient({
      pollSession: vi.fn().mockResolvedValue({ data: { address: "ckt1qrelay", pubkey: "0xpub", keyType: "main_session_key" } }),
    });
    const signer = new JoyIdRelaySigner({ network: "testnet", presenter, client });
    const res = await signer.connect();
    expect((client as unknown as { createSession: ReturnType<typeof vi.fn> }).createSession).toHaveBeenCalled();
    expect(presenter.showQr).toHaveBeenCalledWith("https://testnet.joyid.dev/auth?x", "connect");
    expect(res.address).toBe("ckt1qrelay");
    expect(res.lockArgs).toBe("0xpub");
    expect(presenter.dismiss).toHaveBeenCalled();
  });

  it("signTransaction throws if no address is known", async () => {
    const signer = new JoyIdRelaySigner({ network: "testnet", presenter, client: fakeClient() });
    await expect(signer.signTransaction(Transaction.from({}))).rejects.toThrow(/address unknown/i);
  });

  it("signTransaction dismisses the modal and rethrows on poll failure", async () => {
    const client = fakeClient({ pollSession: vi.fn().mockRejectedValue(new Error("timed out")) });
    const signer = new JoyIdRelaySigner({ network: "testnet", address: "ckt1qsrc", presenter, client });
    await expect(signer.signTransaction(Transaction.from({ inputs: [], outputs: [], outputsData: [], witnesses: [] }))).rejects.toThrow(/timed out/);
    expect(presenter.dismiss).toHaveBeenCalled();
  });

  it("signTransaction rejects and calls dismiss when launchUrl is outside relay origin", async () => {
    const client = fakeClient({
      relayOrigin: "https://relay.test",
      createTxSession: vi.fn().mockResolvedValue({ launchUrl: "https://evil.test/x" }),
    });
    const signer = new JoyIdRelaySigner({ network: "testnet", address: "ckt1qsrc", presenter, client });
    await expect(
      signer.signTransaction(Transaction.from({ inputs: [], outputs: [], outputsData: [], witnesses: [] })),
    ).rejects.toThrow(/outside the configured relay origin/i);
    expect(presenter.dismiss).toHaveBeenCalled();
  });
});
