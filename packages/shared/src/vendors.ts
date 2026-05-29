import type { Identified, PayeeAddress, Timestamped } from "./types";
import type { ChainId } from "./chainIds";

export interface VendorProfile extends Identified, Timestamped {
  displayName: string;
  /** ABN, VAT, EIN, etc. Format validation deferred to UI. */
  taxId?: string;
  /** ISO 3166-1 alpha-2 (AU, US, GB, …). */
  taxIdCountry?: string;
  preferredChain: ChainId;
  walletAddress?: PayeeAddress;
  bankDetails?: VendorBankDetails;
  notes?: string;
  active: boolean;
}

export interface VendorBankDetails {
  bsb?: string;
  accountNumber?: string;
  iban?: string;
  swift?: string;
  accountName?: string;
}
