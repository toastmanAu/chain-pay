export class CommError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = this.constructor.name;
  }
}

export class CommNotConfiguredError extends CommError {}
export class CommNotFundedError extends CommError {
  constructor(public readonly address: string, public readonly balanceShannons: bigint) {
    super(`Comm wallet ${address} unfunded (balance: ${balanceShannons} shannons)`);
  }
}
export class ProfileNotFoundError extends CommError {
  constructor(public readonly address: string, options?: { cause?: unknown }) {
    super(`No Profile Cell found for ${address}`, options);
  }
}
export class ProfileStaleError extends CommError {}
export class RefusalInvariantError extends CommError {
  constructor(public readonly pubkeyHash: string, public readonly conflict: string) {
    super(`Refusal invariant violated: pubkey hash ${pubkeyHash} conflicts with ${conflict}`);
  }
}
export class DecryptionFailedError extends CommError {}
export class EnvelopeMalformedError extends CommError {}
export class CellGoneError extends CommError {
  constructor(public readonly outPoint: { txHash: string; index: number }) {
    super(`Message Cell at ${outPoint.txHash}:${outPoint.index} has been consumed`);
  }
}
