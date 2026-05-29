// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("AutoBroadcastCountdown", () => {
  it("renders 5→1 ticks and fires onElapsed at 0", async () => {
    const onElapsed = vi.fn();
    const { AutoBroadcastCountdown } = await import("./AutoBroadcastCountdown");
    render(<AutoBroadcastCountdown onElapsed={onElapsed} onCancel={() => {}} />);
    expect(screen.getByText(/broadcasting in 5/i)).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.getByText(/broadcasting in 4/i)).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.getByText(/broadcasting in 3/i)).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.getByText(/broadcasting in 2/i)).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.getByText(/broadcasting in 1/i)).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(1000); });
    expect(onElapsed).toHaveBeenCalledOnce();
  });

  it("Cancel button fires onCancel and stops the timer", async () => {
    const onElapsed = vi.fn();
    const onCancel = vi.fn();
    const { AutoBroadcastCountdown } = await import("./AutoBroadcastCountdown");
    render(<AutoBroadcastCountdown onElapsed={onElapsed} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalledOnce();
    act(() => { vi.advanceTimersByTime(10000); });
    expect(onElapsed).not.toHaveBeenCalled();
  });

  it("unmount clears the timer (no late onElapsed)", async () => {
    const onElapsed = vi.fn();
    const { AutoBroadcastCountdown } = await import("./AutoBroadcastCountdown");
    const { unmount } = render(
      <AutoBroadcastCountdown onElapsed={onElapsed} onCancel={() => {}} />,
    );
    unmount();
    act(() => { vi.advanceTimersByTime(10000); });
    expect(onElapsed).not.toHaveBeenCalled();
  });

  it("initialSeconds prop overrides the default 5", async () => {
    const onElapsed = vi.fn();
    const { AutoBroadcastCountdown } = await import("./AutoBroadcastCountdown");
    render(
      <AutoBroadcastCountdown onElapsed={onElapsed} onCancel={() => {}} initialSeconds={2} />,
    );
    expect(screen.getByText(/broadcasting in 2/i)).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.getByText(/broadcasting in 1/i)).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(1000); });
    expect(onElapsed).toHaveBeenCalledOnce();
  });
});
