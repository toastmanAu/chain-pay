import { ipcMain } from "electron";
import {
  BITCOIN_CHANNELS,
  type BitcoinChain,
  type BitcoinScanRequest,
  type BitcoinScanResponse,
  type BitcoinProviderStatus,
  type BitcoinTransactionStatusRequest,
  type BitcoinTransactionStatusResponse,
} from "@chain-pay/shared";
import {
  BitcoinProviderError,
  providerConfigFromEnvironment,
  scanBitcoinAddresses,
  getBitcoinTransactionStatus,
} from "./bitcoin-provider";

export function registerBitcoinIpc(): void {
  ipcMain.handle(
    BITCOIN_CHANNELS.status,
    (_event, chain: BitcoinChain): BitcoinProviderStatus => ({
      configured: validChain(chain) && providerConfigFromEnvironment(chain) !== null,
    }),
  );
  ipcMain.handle(
    BITCOIN_CHANNELS.scan,
    async (_event, request: BitcoinScanRequest): Promise<BitcoinScanResponse> => {
      if (!request || !validChain(request.chain)) {
        throw new BitcoinProviderError("invalid_request", "Bitcoin network is invalid");
      }
      const config = providerConfigFromEnvironment(request.chain);
      if (!config) {
        throw new BitcoinProviderError("not_configured", "Bitcoin provider is not configured");
      }
      return scanBitcoinAddresses({ chain: request.chain, addresses: request.addresses, config });
    },
  );
  ipcMain.handle(
    BITCOIN_CHANNELS.transactionStatus,
    async (_event, request: BitcoinTransactionStatusRequest): Promise<BitcoinTransactionStatusResponse> => {
      if (!request || !validChain(request.chain)) {
        throw new BitcoinProviderError("invalid_request", "Bitcoin network is invalid");
      }
      const config = providerConfigFromEnvironment(request.chain);
      if (!config) throw new BitcoinProviderError("not_configured", "Bitcoin provider is not configured");
      return getBitcoinTransactionStatus({ txid: request.txid, config });
    },
  );
}

function validChain(value: unknown): value is BitcoinChain {
  return value === "btc:mainnet" || value === "btc:testnet";
}
