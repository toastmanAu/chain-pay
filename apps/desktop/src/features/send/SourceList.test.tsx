// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { MemoryRouter } from "react-router-dom";
import { SourceList } from "./SourceList";
import { useSourcesStore } from "@/stores/sources";

afterEach(cleanup);

beforeEach(() => {
  const mem = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
    clear: () => mem.clear(), key: () => null, length: 0,
  } as Storage;
  useSourcesStore.setState({ sources: [], activeSourceId: null });
});

describe("SourceList", () => {
  it("renders an empty state when there are no sources", () => {
    render(<MemoryRouter><SourceList /></MemoryRouter>);
    expect(screen.getByText(/no source wallets/i)).toBeInTheDocument();
  });

  it("offers a link to set up a local keystore wallet", () => {
    render(<MemoryRouter><SourceList /></MemoryRouter>);
    const link = screen.getByRole("link", { name: /set up local wallet/i });
    expect(link).toHaveAttribute("href", "/send/sources/keystore");
  });

  it("renders a persisted source's label", () => {
    useSourcesStore.getState().addSource({
      id: "a", label: "Ops wallet", chain: "ckb:testnet",
      address: "ckt1qsource", joyidLockArgs: ("0x" + "11".repeat(20)) as `0x${string}`,
      createdAt: "2026-06-25T00:00:00Z", updatedAt: "2026-06-25T00:00:00Z",
    });
    render(<MemoryRouter><SourceList /></MemoryRouter>);
    expect(screen.getByText("Ops wallet")).toBeInTheDocument();
  });
});
