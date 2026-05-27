// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { useVendorsStore } from "@/stores/vendors";
import { VendorPicker } from "./VendorPicker";

beforeEach(() => {
  useVendorsStore.setState({ vendors: [] });
  globalThis.localStorage?.clear();
});

afterEach(() => {
  cleanup();
});

describe("VendorPicker", () => {
  it("lists existing vendors filtered by typed query", async () => {
    const user = userEvent.setup();
    useVendorsStore.getState().addVendor({ id: "v1", displayName: "Acme Pty", preferredChain: "ckb:testnet", active: true, createdAt: "", updatedAt: "" });
    useVendorsStore.getState().addVendor({ id: "v2", displayName: "Beta Co", preferredChain: "ckb:testnet", active: true, createdAt: "", updatedAt: "" });
    render(<VendorPicker onSelect={vi.fn()} />);
    await user.type(screen.getByPlaceholderText(/search vendors/i), "Acm");
    expect(screen.getByRole("button", { name: /Acme Pty/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Beta Co/ })).not.toBeInTheDocument();
  });

  it("selecting an existing vendor calls onSelect with that vendor", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    useVendorsStore.getState().addVendor({ id: "v1", displayName: "Acme Pty", preferredChain: "ckb:testnet", active: true, createdAt: "", updatedAt: "" });
    render(<VendorPicker onSelect={onSelect} />);
    await user.click(screen.getByRole("button", { name: /Acme Pty/ }));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "v1" }));
  });

  it("clicking '+ New vendor' opens the inline create form", async () => {
    const user = userEvent.setup();
    render(<VendorPicker onSelect={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: /\+ new vendor/i }));
    expect(screen.getByLabelText(/display name/i)).toBeInTheDocument();
  });

  it("submitting the inline form adds a vendor and calls onSelect", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<VendorPicker onSelect={onSelect} />);
    await user.click(screen.getByRole("button", { name: /\+ new vendor/i }));
    await user.type(screen.getByLabelText(/display name/i), "New Vendor Inc");
    await user.click(screen.getByRole("button", { name: /^create$/i }));
    expect(useVendorsStore.getState().vendors).toHaveLength(1);
    expect(useVendorsStore.getState().vendors[0]?.displayName).toBe("New Vendor Inc");
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ displayName: "New Vendor Inc" }));
  });
});
