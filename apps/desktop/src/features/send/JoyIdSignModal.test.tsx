// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { useJoyIdSignStore, makePresenter } from "@/stores/joyid-sign";
import { JoyIdSignModal } from "./JoyIdSignModal";

describe("JoyIdSignModal", () => {
  beforeEach(() => {
    cleanup();
    useJoyIdSignStore.getState().dismiss();
  });

  it("renders nothing when closed", () => {
    const { container } = render(<JoyIdSignModal />);
    expect(container.children.length).toBe(0);
  });

  it("shows scan instructions when a presenter opens a connect QR", async () => {
    const presenter = makePresenter();
    presenter.showQr("https://testnet.joyid.dev/auth?x", "connect");
    presenter.updateStatus("awaiting-scan");
    render(<JoyIdSignModal />);
    expect(await screen.findByText(/Waiting for you to scan/)).toBeTruthy();
  });
});
