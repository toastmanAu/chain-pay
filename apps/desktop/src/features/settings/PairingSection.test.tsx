// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";

// jsdom doesn't implement HTMLCanvasElement.getContext, which the qrcode lib needs.
// Mock the qrcode module so PairingSection just renders the canvas element without
// trying to draw on it.
vi.mock("qrcode", () => ({
  default: { toCanvas: vi.fn().mockResolvedValue(undefined) },
}));

import { PairingSection } from "./PairingSection";

const listMock = vi.fn();
const issueMock = vi.fn();
const revokeMock = vi.fn();

beforeEach(() => {
  listMock.mockReset();
  issueMock.mockReset();
  revokeMock.mockReset();
  // Mock window.chainpay.pair surface (T8 wired the namespace under window.chainpay)
  (window as unknown as { chainpay: { pair: unknown } }).chainpay = {
    pair: {
      list: listMock,
      issue: issueMock,
      revoke: revokeMock,
      setCommPubkey: vi.fn(),
      info: vi.fn(),
      onInvoiceReceived: vi.fn(() => () => undefined),
    },
  };
});

afterEach(() => {
  cleanup();
});

describe("PairingSection", () => {
  it("lists paired devices on mount", async () => {
    listMock.mockResolvedValue([
      {
        tokenId: "tok-1",
        deviceLabel: "phone-1",
        expiresAt: Date.now() + 86400000,
        capabilities: ['write("invoices")'],
        commPubkey: "0x00",
        issuedAt: 0,
      },
    ]);
    render(<PairingSection rpcHost="127.0.0.1" rpcPort={8233} certFingerprint="AB:CD" />);
    expect(await screen.findByText("phone-1")).toBeInTheDocument();
  });

  it("issues a token and shows the QR after submit", async () => {
    listMock.mockResolvedValue([]);
    issueMock.mockResolvedValue({ token: "EsQCBb...", tokenId: "tok-new" });
    render(<PairingSection rpcHost="127.0.0.1" rpcPort={8233} certFingerprint="AB:CD" />);
    await userEvent.type(screen.getByLabelText(/device label/i), "phill-pixel-8");
    await userEvent.click(screen.getByRole("button", { name: /generate qr/i }));
    await waitFor(() => expect(issueMock).toHaveBeenCalledWith("phill-pixel-8"));
    expect(await screen.findByTestId("pair-qr-canvas")).toBeInTheDocument();
    const copyLink = await screen.findByTestId<HTMLInputElement>("pair-copy-link");
    expect(copyLink.value).toMatch(/^fiberconnect:\/\//);
  });

  it("shows an error message when issue fails", async () => {
    listMock.mockResolvedValue([]);
    issueMock.mockRejectedValue(new Error("boom"));
    render(<PairingSection rpcHost="127.0.0.1" rpcPort={8233} certFingerprint="AB:CD" />);
    await userEvent.type(screen.getByLabelText(/device label/i), "phill-pixel-8");
    await userEvent.click(screen.getByRole("button", { name: /generate qr/i }));
    expect(await screen.findByTestId("pair-error")).toHaveTextContent(/boom/);
  });

  it("revokes a device when the revoke button is clicked", async () => {
    listMock
      .mockResolvedValueOnce([
        {
          tokenId: "tok-1",
          deviceLabel: "phone-1",
          expiresAt: Date.now() + 86400000,
          capabilities: ['write("invoices")'],
          commPubkey: "0x00",
          issuedAt: 0,
        },
      ])
      .mockResolvedValueOnce([]);
    render(<PairingSection rpcHost="127.0.0.1" rpcPort={8233} certFingerprint="AB:CD" />);
    await userEvent.click(await screen.findByRole("button", { name: /revoke phone-1/i }));
    expect(revokeMock).toHaveBeenCalledWith("tok-1");
  });
});
