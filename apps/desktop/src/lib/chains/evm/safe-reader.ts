import { getAddress, type Address, type PublicClient } from "viem";
import { getEvmPublicClient } from "./public-client";

const SAFE_READ_ABI = [
  {
    type: "function",
    name: "getOwners",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address[]" }],
  },
  {
    type: "function",
    name: "getThreshold",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "VERSION",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
] as const;

export interface SafeSnapshot {
  chainId: number;
  address: Address;
  owners: Address[];
  threshold: number;
  version: string;
  balanceWei: bigint;
  blockNumber: bigint;
}

export interface SafeReadOperations {
  getChainId(): Promise<number>;
  getBytecode(address: Address): Promise<`0x${string}` | undefined>;
  getOwners(address: Address): Promise<readonly Address[]>;
  getThreshold(address: Address): Promise<bigint>;
  getVersion(address: Address): Promise<string>;
  getBalance(address: Address): Promise<bigint>;
  getBlockNumber(): Promise<bigint>;
}

export async function readSafeSnapshot(
  chainId: number,
  rawAddress: string,
  operations: SafeReadOperations = operationsFor(getEvmPublicClient(chainId)),
): Promise<SafeSnapshot> {
  let address: Address;
  try {
    address = getAddress(rawAddress);
  } catch {
    throw new Error("Enter a valid 0x-prefixed EVM address");
  }

  const connectedChainId = await operations.getChainId();
  if (connectedChainId !== chainId) {
    throw new Error(`RPC chain mismatch: expected ${chainId}, received ${connectedChainId}`);
  }

  const bytecode = await operations.getBytecode(address);
  if (!bytecode || bytecode === "0x") {
    throw new Error("No contract is deployed at this address on Sepolia");
  }

  try {
    const [owners, thresholdRaw, version, balanceWei, blockNumber] = await Promise.all([
      operations.getOwners(address),
      operations.getThreshold(address),
      operations.getVersion(address),
      operations.getBalance(address),
      operations.getBlockNumber(),
    ]);
    const threshold = Number(thresholdRaw);
    if (!Number.isSafeInteger(threshold) || threshold < 1 || threshold > owners.length) {
      throw new Error("Safe returned an invalid owner threshold");
    }
    if (owners.length === 0) throw new Error("Safe returned no owners");

    return {
      chainId,
      address,
      owners: owners.map((owner) => getAddress(owner)),
      threshold,
      version,
      balanceWei,
      blockNumber,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("Safe returned")) throw error;
    throw new Error(`Contract is not a readable Safe: ${message}`);
  }
}

function operationsFor(client: PublicClient): SafeReadOperations {
  return {
    getChainId: () => client.getChainId(),
    getBytecode: (address) => client.getBytecode({ address }),
    getOwners: (address) => client.readContract({ address, abi: SAFE_READ_ABI, functionName: "getOwners" }),
    getThreshold: (address) =>
      client.readContract({ address, abi: SAFE_READ_ABI, functionName: "getThreshold" }),
    getVersion: (address) => client.readContract({ address, abi: SAFE_READ_ABI, functionName: "VERSION" }),
    getBalance: (address) => client.getBalance({ address }),
    getBlockNumber: () => client.getBlockNumber(),
  };
}
