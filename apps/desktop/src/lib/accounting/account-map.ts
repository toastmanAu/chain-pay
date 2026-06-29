/** Default ERPNext account names — match the four accounts created by seed.py. */
export interface AccountMap {
  salary: string;
  treasury: string;
  networkFeeExpense: string;
  fxGainLoss: string;
}

export const DEFAULT_ACCOUNT_MAP: AccountMap = {
  salary: "Salary or Wage Expense",
  treasury: "Crypto Treasury Asset",
  networkFeeExpense: "Network Fee Expense",
  fxGainLoss: "FX Gain/Loss",
};
