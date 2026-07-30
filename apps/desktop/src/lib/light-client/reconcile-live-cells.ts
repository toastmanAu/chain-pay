import { hexFrom, numFrom, type BytesLike, type NumLike } from "@ckb-ccc/core";

interface OutPointLike {
  txHash: BytesLike;
  index: NumLike;
}

interface CellLike {
  outPoint: OutPointLike;
}

interface TransactionLike {
  inputs: readonly {
    previousOutput: OutPointLike;
  }[];
}

export function outPointKey(outPoint: OutPointLike): string {
  return `${hexFrom(outPoint.txHash).toLowerCase()}:${numFrom(outPoint.index).toString()}`;
}

/**
 * Remove cells that the light client's own transaction history proves spent.
 *
 * Upstream's browser database commits batched deletes before puts. If one
 * transaction creates a watched cell and a later transaction spends it in the
 * same block, the final put can resurrect that spent cell. Transaction history
 * still contains the consuming input, so it is the authoritative local
 * reconciliation source.
 */
export function reconcileLiveCells<T extends CellLike>(
  cells: readonly T[],
  transactions: readonly TransactionLike[],
): T[] {
  const spent = new Set<string>();
  for (const transaction of transactions) {
    for (const input of transaction.inputs) {
      spent.add(outPointKey(input.previousOutput));
    }
  }
  return cells.filter((cell) => !spent.has(outPointKey(cell.outPoint)));
}
