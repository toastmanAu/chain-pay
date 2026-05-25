import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CkbNetwork } from "@/lib/light-client/network-configs";

const FILE_NAME = "network-state.json";

function dir(): string {
  if (process.env.NETWORK_STATE_DIR) return process.env.NETWORK_STATE_DIR;
  // Lazy require so the file is importable in non-Electron contexts (vitest).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { app } = require("electron") as typeof import("electron");
  return app.getPath("userData");
}

function path(): string {
  return join(dir(), FILE_NAME);
}

function isCkbNetwork(value: unknown): value is CkbNetwork {
  return value === "testnet" || value === "mainnet";
}

export function loadNetworkState(): CkbNetwork {
  const file = path();
  if (!existsSync(file)) return "testnet";
  try {
    const raw = readFileSync(file, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      "network" in parsed &&
      isCkbNetwork((parsed as { network: unknown }).network)
    ) {
      return (parsed as { network: CkbNetwork }).network;
    }
  } catch {
    // malformed file → fall through to default
  }
  return "testnet";
}

export function saveNetworkState(network: CkbNetwork): void {
  writeFileSync(path(), JSON.stringify({ network }), "utf-8");
}
