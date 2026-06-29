import { describe, it, expect } from "vitest";
import { canTransition, assertCanTransition, isTerminal, nextStates } from "./state-machine";

describe("send state machine", () => {
  it("allows the happy path forward edges", () => {
    expect(canTransition("draft", "built")).toBe(true);
    expect(canTransition("built", "signing")).toBe(true);
    expect(canTransition("signing", "broadcasted")).toBe(true);
    expect(canTransition("broadcasted", "confirmed")).toBe(true);
    expect(canTransition("confirmed", "posting")).toBe(true);
    expect(canTransition("posting", "posted")).toBe(true);
    expect(canTransition("posting", "post_failed")).toBe(true);
    expect(canTransition("post_failed", "posting")).toBe(true);
  });

  it("returns signing/broadcast failures to built", () => {
    expect(canTransition("signing", "built")).toBe(true);
    expect(canTransition("broadcasted", "built")).toBe(false); // in flight, chain decides
  });

  it("forbids same-state and post-terminal transitions", () => {
    expect(canTransition("built", "built")).toBe(false);
    expect(canTransition("posted", "posting")).toBe(false);
    expect(isTerminal("posted")).toBe(true);
    expect(isTerminal("confirmed")).toBe(false);
  });

  it("assertCanTransition throws on an illegal edge", () => {
    expect(() => assertCanTransition("draft", "confirmed")).toThrow(/invalid send transition/);
  });

  it("nextStates lists forward edges", () => {
    expect(nextStates("confirmed")).toEqual(["posting"]);
  });
});
