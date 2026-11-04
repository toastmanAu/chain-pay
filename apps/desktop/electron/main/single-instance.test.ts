import { describe, expect, it, vi } from "vitest";
import { keepSingleInstance } from "./single-instance";

describe("keepSingleInstance", () => {
  it("quits a secondary process without registering a focus handler", () => {
    const app = {
      requestSingleInstanceLock: vi.fn(() => false),
      on: vi.fn(),
      quit: vi.fn(),
    };

    expect(keepSingleInstance(app, () => null)).toBe(false);
    expect(app.quit).toHaveBeenCalledOnce();
    expect(app.on).not.toHaveBeenCalled();
  });

  it("restores and focuses the primary window when another instance starts", () => {
    let onSecondInstance: (() => void) | undefined;
    const app = {
      requestSingleInstanceLock: vi.fn(() => true),
      on: vi.fn((_event: string, listener: () => void) => { onSecondInstance = listener; }),
      quit: vi.fn(),
    };
    const window = {
      isMinimized: vi.fn(() => true),
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
    };

    expect(keepSingleInstance(app, () => window)).toBe(true);
    expect(app.on).toHaveBeenCalledWith("second-instance", expect.any(Function));
    onSecondInstance?.();
    expect(window.restore).toHaveBeenCalledOnce();
    expect(window.show).toHaveBeenCalledOnce();
    expect(window.focus).toHaveBeenCalledOnce();
    expect(app.quit).not.toHaveBeenCalled();
  });

  it("does not try to focus a window before it exists", () => {
    let onSecondInstance: (() => void) | undefined;
    const app = {
      requestSingleInstanceLock: vi.fn(() => true),
      on: vi.fn((_event: string, listener: () => void) => { onSecondInstance = listener; }),
      quit: vi.fn(),
    };

    expect(keepSingleInstance(app, () => null)).toBe(true);
    expect(() => onSecondInstance?.()).not.toThrow();
  });
});
