// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { MemoryStorage } from "../../stores/test-utils/memory-storage";

const quitMock = vi.fn();
const networkSetMock = vi.fn();

beforeEach(() => {
  (globalThis as { localStorage?: Storage }).localStorage = new MemoryStorage();
  (globalThis as { chainpay?: object }).chainpay = {
    network: { get: vi.fn().mockResolvedValue("testnet"), set: networkSetMock },
    app: { quit: quitMock },
  };
  vi.resetModules();
});

afterEach(() => {
  cleanup();
  delete (globalThis as { localStorage?: Storage }).localStorage;
  delete (globalThis as { chainpay?: object }).chainpay;
  quitMock.mockReset();
  networkSetMock.mockReset();
});

describe("NetworkSection", () => {
  it("radio default reflects persisted network ('testnet')", async () => {
    const { NetworkSection } = await import("./NetworkSection");
    render(<NetworkSection />);
    expect(screen.getByRole("radio", { name: /testnet/i })).toBeChecked();
    expect(screen.getByRole("radio", { name: /mainnet/i })).not.toBeChecked();
  });

  it("Apply button disabled when selection matches persisted", async () => {
    const { NetworkSection } = await import("./NetworkSection");
    render(<NetworkSection />);
    expect(screen.getByRole("button", { name: /apply/i })).toBeDisabled();
  });

  it("selecting mainnet enables Apply", async () => {
    const { NetworkSection } = await import("./NetworkSection");
    render(<NetworkSection />);
    fireEvent.click(screen.getByRole("radio", { name: /mainnet/i }));
    expect(screen.getByRole("button", { name: /apply/i })).toBeEnabled();
  });

  it("Apply opens the restart modal", async () => {
    const { NetworkSection } = await import("./NetworkSection");
    render(<NetworkSection />);
    fireEvent.click(screen.getByRole("radio", { name: /mainnet/i }));
    fireEvent.click(screen.getByRole("button", { name: /apply/i }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText(/restart required/i)).toBeInTheDocument();
  });

  it("modal Cancel reverts radio to persisted value", async () => {
    const { NetworkSection } = await import("./NetworkSection");
    render(<NetworkSection />);
    fireEvent.click(screen.getByRole("radio", { name: /mainnet/i }));
    fireEvent.click(screen.getByRole("button", { name: /apply/i }));
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(screen.getByRole("radio", { name: /testnet/i })).toBeChecked();
    expect(quitMock).not.toHaveBeenCalled();
  });

  it("modal Confirm sets wipe flag, calls network:set IPC, and quits", async () => {
    const { NetworkSection } = await import("./NetworkSection");
    render(<NetworkSection />);
    fireEvent.click(screen.getByRole("radio", { name: /mainnet/i }));
    fireEvent.click(screen.getByRole("button", { name: /apply/i }));
    fireEvent.click(screen.getByRole("button", { name: /quit/i }));

    // Wait microtasks
    await new Promise((r) => setTimeout(r, 0));

    expect(globalThis.localStorage.getItem("chain-pay:wipe-lc-on-next-boot")).toBe("true");
    expect(networkSetMock).toHaveBeenCalledWith("mainnet");
    expect(quitMock).toHaveBeenCalledOnce();
  });

  it("broadcastRpcUrl field updates hot (no restart needed)", async () => {
    const { NetworkSection } = await import("./NetworkSection");
    const { useNetworkConfigStore } = await import("../../stores/network-config");
    render(<NetworkSection />);
    const input = screen.getByLabelText(/broadcast.*url/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "http://10.0.0.1:8114" } });
    fireEvent.blur(input);
    expect(useNetworkConfigStore.getState().broadcastRpcUrl).toBe("http://10.0.0.1:8114");
  });
});
