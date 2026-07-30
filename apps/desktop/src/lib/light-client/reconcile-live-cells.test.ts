import { describe, expect, it } from "vitest";
import { reconcileLiveCells } from "./reconcile-live-cells";

describe("reconcileLiveCells", () => {
  const staleOutPoint = {
    txHash: "0xa6f54358be2d02504cace85c9d4dc9386e4e17c6c815dbbb79ad441c1c4ef2d5",
    index: 1n,
  };
  const liveOutPoint = {
    txHash: "0xdbafdf6370054d813122e92b383618442ed51573f263dfce97fe447bb8afae2a",
    index: 1n,
  };

  it("removes a cell consumed by a later transaction in the same matched block", () => {
    const cells = [
      { outPoint: staleOutPoint, capacity: 9_553_699_080_619n },
      { outPoint: liveOutPoint, capacity: 14_299_625_642_281n },
    ];
    const transactions = [
      {
        inputs: [
          {
            previousOutput: {
              txHash: `0x${"00".repeat(32)}`,
              index: 0n,
            },
          },
        ],
      },
      { inputs: [{ previousOutput: staleOutPoint }] },
    ];

    expect(reconcileLiveCells(cells, transactions)).toEqual([cells[1]]);
  });

  it("keeps cells with no consuming input and normalizes hex indexes", () => {
    const cells = [{ outPoint: liveOutPoint }];
    const transactions = [
      {
        inputs: [
          {
            previousOutput: {
              txHash: `0x${staleOutPoint.txHash.slice(2).toUpperCase()}`,
              index: "0x1",
            },
          },
        ],
      },
    ];

    expect(reconcileLiveCells(cells, transactions)).toEqual(cells);
  });
});
