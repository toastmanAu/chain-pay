import { describe, it, expect } from "vitest";
import { KeyvaultRateLimiter } from "./keyvault-rate-limit";

/** A controllable clock so backoff windows are deterministic in tests. */
function fakeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("KeyvaultRateLimiter", () => {
  it("allows attempts up to the threshold without locking", () => {
    const clock = fakeClock();
    const rl = new KeyvaultRateLimiter({
      maxAttempts: 5,
      baseDelayMs: 30_000,
      now: clock.now,
    });
    // 4 failures (below threshold) — check() must not throw.
    for (let i = 0; i < 4; i++) {
      expect(() => rl.check("main")).not.toThrow();
      rl.recordFailure("main");
    }
    expect(() => rl.check("main")).not.toThrow();
  });

  it("locks out after the threshold is reached", () => {
    const clock = fakeClock();
    const rl = new KeyvaultRateLimiter({
      maxAttempts: 5,
      baseDelayMs: 30_000,
      now: clock.now,
    });
    for (let i = 0; i < 5; i++) rl.recordFailure("main");
    expect(() => rl.check("main")).toThrow(/too many/i);
  });

  it("unlocks after the backoff window elapses", () => {
    const clock = fakeClock();
    const rl = new KeyvaultRateLimiter({
      maxAttempts: 5,
      baseDelayMs: 30_000,
      now: clock.now,
    });
    for (let i = 0; i < 5; i++) rl.recordFailure("main");
    expect(() => rl.check("main")).toThrow(/too many/i);

    clock.advance(29_999);
    expect(() => rl.check("main")).toThrow(/too many/i); // still inside window

    clock.advance(2); // now past the 30s window
    expect(() => rl.check("main")).not.toThrow();
  });

  it("doubles the backoff window for each failure past the threshold", () => {
    const clock = fakeClock();
    const rl = new KeyvaultRateLimiter({
      maxAttempts: 5,
      baseDelayMs: 30_000,
      now: clock.now,
    });
    for (let i = 0; i < 6; i++) rl.recordFailure("main"); // 6th failure → 60s window
    clock.advance(30_000);
    expect(() => rl.check("main")).toThrow(/too many/i); // 30s < 60s, still locked
    clock.advance(30_001);
    expect(() => rl.check("main")).not.toThrow();
  });

  it("caps the backoff window at maxDelayMs", () => {
    const clock = fakeClock();
    const rl = new KeyvaultRateLimiter({
      maxAttempts: 5,
      baseDelayMs: 30_000,
      maxDelayMs: 120_000,
      now: clock.now,
    });
    for (let i = 0; i < 50; i++) rl.recordFailure("main"); // way past threshold
    clock.advance(120_001);
    expect(() => rl.check("main")).not.toThrow(); // capped, not exponentially huge
  });

  it("resets the counter on a successful attempt", () => {
    const clock = fakeClock();
    const rl = new KeyvaultRateLimiter({
      maxAttempts: 5,
      baseDelayMs: 30_000,
      now: clock.now,
    });
    for (let i = 0; i < 4; i++) rl.recordFailure("main");
    rl.recordSuccess("main");
    // After success, the next 4 failures must not lock (counter was reset).
    for (let i = 0; i < 4; i++) rl.recordFailure("main");
    expect(() => rl.check("main")).not.toThrow();
  });

  it("tracks vaults independently", () => {
    const clock = fakeClock();
    const rl = new KeyvaultRateLimiter({
      maxAttempts: 5,
      baseDelayMs: 30_000,
      now: clock.now,
    });
    for (let i = 0; i < 5; i++) rl.recordFailure("main");
    expect(() => rl.check("main")).toThrow(/too many/i);
    expect(() => rl.check("other")).not.toThrow();
  });
});
