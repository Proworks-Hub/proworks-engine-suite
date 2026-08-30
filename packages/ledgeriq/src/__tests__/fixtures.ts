// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import {
  authorityEnvelopeSchema,
  type AuthorityEnvelope,
  type ExchangeRateRef,
  type GovernanceDecision,
  type RiskClass,
} from "@proworks-hub/contracts";

import type { SuppliedAuthorization } from "../kernel/validation.js";
import type {
  Account,
  AccountingCalendar,
  Book,
  ChartOfAccountsVersion,
  DimensionSchema,
  PeriodState,
} from "../model/model.js";
import {
  createInMemoryLedgerStore,
  type InMemoryLedgerFixtures,
} from "../memory/inMemoryLedgerStore.js";

export const CURRENCY_REGISTRY: Record<string, number> = { USD: 2, EUR: 2, JPY: 0, KWD: 3 };

const account = (partial: Partial<Account> & Pick<Account, "accountCode" | "accountClass">): Account => ({
  naturalSide: "debit",
  postable: true,
  permittedCurrencies: "any",
  requiredDimensions: [],
  labels: [{ lang: "en", text: partial.accountCode }],
  ...partial,
});

export const CHART: ChartOfAccountsVersion = {
  chartVersionRef: "chart-1@v1",
  effectiveFrom: "2026-01-01",
  accounts: [
    account({ accountCode: "1000", accountClass: "asset" }),
    account({
      accountCode: "1100",
      accountClass: "asset",
      controlledBySource: "hive.receivablesiq",
    }),
    account({ accountCode: "1900", accountClass: "asset" }),
    account({ accountCode: "1901", accountClass: "asset" }),
    account({ accountCode: "2000", accountClass: "liability", naturalSide: "credit" }),
    account({ accountCode: "3000", accountClass: "equity", naturalSide: "credit" }),
    account({
      accountCode: "4000",
      accountClass: "income",
      naturalSide: "credit",
      requiredDimensions: ["dept"],
    }),
    account({ accountCode: "5000", accountClass: "expense" }),
    account({ accountCode: "5099", accountClass: "expense" }),
    account({ accountCode: "6000", accountClass: "asset", postable: false }),
    account({ accountCode: "7000", accountClass: "asset", permittedCurrencies: ["USD"] }),
    account({ accountCode: "8000", accountClass: "asset", blockedFrom: "2026-06-01" }),
    account({ accountCode: "9000", accountClass: "statistical" }),
  ],
};

const month = (n: number): { start: string; end: string } => {
  const mm = String(n).padStart(2, "0");
  const lastDay = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][n - 1];
  return { start: `2026-${mm}-01`, end: `2026-${mm}-${lastDay}` };
};

export const CALENDAR: AccountingCalendar = {
  calendarRef: "cal-2026",
  periods: [
    ...Array.from({ length: 12 }, (_, i) => ({
      periodRef: { fiscalYear: 2026, periodNumber: i + 1 },
      startDate: month(i + 1).start,
      endDate: month(i + 1).end,
      isAdjustmentPeriod: false,
    })),
    {
      periodRef: { fiscalYear: 2026, periodNumber: 13 },
      startDate: "2026-12-31",
      endDate: "2026-12-31",
      isAdjustmentPeriod: true,
    },
  ],
};

export const DIMENSIONS: DimensionSchema = {
  schemaRef: "dims-1",
  dimensions: [
    {
      code: "dept",
      values: [
        { valueCode: "D1" },
        { valueCode: "D2", effectiveTo: "2026-06-30" },
      ],
    },
    { code: "region", values: [{ valueCode: "E1" }, { valueCode: "W1" }] },
    { code: "entity", values: [{ valueCode: "A" }, { valueCode: "B" }] },
  ],
  crossValidationRules: [
    {
      ruleId: "no-east-d1",
      when: { dimensionCode: "dept", valueCode: "D1" },
      forbid: { dimensionCode: "region", valueCode: "E1" },
    },
  ],
};

export const BOOK_USD: Book = {
  bookId: "book-usd",
  entityRef: "entity-a",
  accountingFramework: "us-gaap",
  bookRole: "primary",
  functionalCurrency: { code: "USD", scale: 2 },
  calendarRef: "cal-2026",
  chartRef: "chart-1",
  dimensionSchemaRef: "dims-1",
  balancingDimensions: [],
  roundingResidueAccount: "5099",
  fxRoundingMode: "half-even",
  reversalMethod: "switch-side",
  retainedEarningsAccount: "3000",
  status: "active",
};

/** A book that balances by `entity` and repairs via due-to/due-from. */
export const BOOK_IC: Book = {
  ...BOOK_USD,
  bookId: "book-ic",
  balancingDimensions: ["entity"],
  intercompanyRule: { dueToAccount: "1900", dueFromAccount: "1901" },
};

/** A book with NO residue account and NO intercompany rule — the refusal paths. */
export const BOOK_BARE: Book = (() => {
  const { roundingResidueAccount: _r, intercompanyRule: _i, ...rest } = {
    ...BOOK_USD,
    bookId: "book-bare",
    balancingDimensions: ["entity"],
  };
  return rest as Book;
})();

export const OPEN_PERIODS: Record<string, PeriodState> = {
  "book-usd:2026-6": "closed",
  "book-usd:2026-7": "closed",
  "book-usd:2026-8": "open",
  "book-usd:2026-9": "future",
  "book-usd:2026-12": "open",
  "book-usd:2026-13": "pending-close",
  "book-ic:2026-8": "open",
  "book-bare:2026-8": "open",
};

export function makeStore(overrides?: Partial<InMemoryLedgerFixtures>) {
  return createInMemoryLedgerStore({
    books: [BOOK_USD, BOOK_IC, BOOK_BARE],
    chartVersions: { "chart-1": [CHART] },
    calendars: [CALENDAR],
    dimensionSchemas: [DIMENSIONS],
    periodStates: OPEN_PERIODS,
    ...overrides,
  });
}

export const usd = (amount: string) => ({ amount, currency: "USD", scale: 2 });
export const eur = (amount: string) => ({ amount, currency: "EUR", scale: 2 });

export interface ProposalLineInput {
  lineNo: number;
  accountCode: string;
  side: "debit" | "credit";
  amount?: { amount: string; currency: string; scale: number };
  statisticalQuantity?: { amount: string; unit: string };
  dimensions?: Record<string, string>;
  openItemRef?: string;
}

export function proposal(overrides?: {
  lines?: ProposalLineInput[];
  [key: string]: unknown;
}): Record<string, unknown> {
  const { lines, ...rest } = overrides ?? {};
  return {
    proposalId: "prop-1",
    proposedBy: "hive.payablesiq",
    bookId: "book-usd",
    lines: (
      lines ?? [
        { lineNo: 1, accountCode: "5000", side: "debit", amount: usd("100.00") },
        { lineNo: 2, accountCode: "2000", side: "credit", amount: usd("100.00") },
      ]
    ).map((l) => ({ dimensions: {}, ...l })),
    effectiveDate: "2026-08-15",
    periodRef: { fiscalYear: 2026, periodNumber: 8 },
    methodRef: { methodId: "AP-LIABILITY-RECOGNITION", semanticVersion: "1.0.0" },
    evidence: [],
    trace: { correlationId: "corr-1" },
    idempotencyKey: "key-1",
    ...rest,
  };
}

export const SPOT_EUR_USD: ExchangeRateRef = {
  base: "EUR",
  quote: "USD",
  rate: "1.0850",
  source: "fixture",
  effectiveDate: "2026-08-15",
  rateType: "spot-at-transaction-date",
};

export function envelope(
  purpose: string,
  riskClass: RiskClass,
  expiresAt?: string,
): AuthorityEnvelope {
  return authorityEnvelopeSchema.parse({
    requestId: "req-1",
    actorId: "steven",
    tenant: { organizationId: "org-1" },
    purpose,
    requestedAction: purpose,
    riskClass,
    issuedAt: "2026-08-15T00:00:00Z",
    ...(expiresAt ? { expiresAt } : {}),
  });
}

export function permitted(decisionId = "dec-1"): GovernanceDecision {
  return {
    decision: "PERMITTED",
    reason: "fixture grant",
    conditions: [],
    decisionId,
    decidedAt: "2026-08-15T00:00:00Z",
  };
}

export function auth(
  purpose: string,
  riskClass: RiskClass,
  options?: { expiresAt?: string; decision?: GovernanceDecision },
): SuppliedAuthorization {
  return {
    decision: options?.decision ?? permitted(),
    envelope: envelope(purpose, riskClass, options?.expiresAt),
  };
}
