import type { SendState } from "@chain-pay/shared";

/**
 * draft → built → signing → broadcasted → confirmed → posting → posted
 * signing failure → built (re-build/re-sign). broadcast in flight is irreversible.
 * confirmed → posting → posted (terminal) | post_failed → posting (retry).
 */
const TRANSITIONS: Record<SendState, SendState[]> = {
  draft: ["built"],
  built: ["signing"],
  signing: ["broadcasted", "built"],
  broadcasted: ["confirmed"],
  confirmed: ["posting"],
  posting: ["posted", "post_failed"],
  post_failed: ["posting"],
  posted: [],
};

const terminalStates: readonly SendState[] = ["posted"];

export function canTransition(from: SendState, to: SendState): boolean {
  if (from === to) return false;
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertCanTransition(from: SendState, to: SendState): void {
  if (!canTransition(from, to)) {
    throw new Error(
      `invalid send transition: ${from} → ${to} (allowed from '${from}': ${TRANSITIONS[from]?.join(", ") || "none"})`,
    );
  }
}

export function isTerminal(state: SendState): boolean {
  return terminalStates.includes(state);
}

export function nextStates(from: SendState): SendState[] {
  return TRANSITIONS[from] ?? [];
}
