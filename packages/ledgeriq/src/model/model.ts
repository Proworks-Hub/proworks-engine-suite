// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

import {
  currencyCodeSchema,
  evidenceRefSchema,
  exactMoneySchema,
  exchangeRateRefSchema,
  fxRateTypeSchema,
  methodRefSchema,
  quantitySchema,
  roundingModeSchema,
  traceContextSchema,
} from "@proworks-hub/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// The canonical model — blueprint §14. Every field names the code path that
// reads it (the "Read by" column of the blueprint's tables); a field with no
// reader was cut before it was written down. Types the whole Finance program
// shares (ExactMoney, MethodRef, EvidenceRef, ExchangeRateRef, Quantity) come
// from `@proworks-hub/contracts` and are never redefined here.
// ─────────────────────────────────────────────────────────────────────────────

const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const isoInstantSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/);

/** ISO-4217 code + its minor-unit scale. A currency without its scale cannot hold a book. */
export const currencyDefSchema = z
  .object({
    code: currencyCodeSchema,
    scale: z.number().int().min(0).max(6),
  })
  .strict();
export type CurrencyDef = z.infer<typeof currencyDefSchema>;

export const periodRefSchema = z
  .object({
    fiscalYear: z.number().int(),
    periodNumber: z.number().int().min(1),
  })
  .strict();
export type PeriodRef = z.infer<typeof periodRefSchema>;

/** §13.5 — the period state machine's states. */
export const periodStateSchema = z.enum([
  "future",
  "open",
  "pending-close",
  "closed",
  "permanently-closed",
]);
export type PeriodState = z.infer<typeof periodStateSchema>;

/** One recorded transition. Read by L6 explanation, reopen validation and the audit export. */
export const periodStateTransitionSchema = z
  .object({
    from: periodStateSchema,
    to: periodStateSchema,
    at: isoInstantSchema,
    governanceDecisionRef: z.string().min(1),
    actor: z.string().min(1),
    /** Required on a reopen; a silent reopen is the failure P2 fears. */
    reason: z.string().min(1).optional(),
  })
  .strict();
export type PeriodStateTransition = z.infer<typeof periodStateTransitionSchema>;

export const periodSchema = z
  .object({
    /** Read by every posting (period gate), trial balance, close. */
    periodRef: periodRefSchema,
    /** Read by the EFFECTIVE_DATE_OUTSIDE_PERIOD gate. */
    startDate: isoDateSchema,
    endDate: isoDateSchema,
    /** Read by roll-forward, export projection and period ordering. */
    isAdjustmentPeriod: z.boolean(),
  })
  .strict();
export type Period = z.infer<typeof periodSchema>;

export const accountingCalendarSchema = z
  .object({
    /** Read by the period gate. */
    calendarRef: z.string().min(1),
    periods: z.array(periodSchema).min(1),
  })
  .strict();
export type AccountingCalendar = z.infer<typeof accountingCalendarSchema>;

export const accountClassSchema = z.enum([
  "asset",
  "liability",
  "equity",
  "income",
  "expense",
  "statistical",
]);
export type AccountClass = z.infer<typeof accountClassSchema>;

export const accountSchema = z
  .object({
    /** Read by every gate, the export and the balance fold. */
    accountCode: z.string().min(1),
    /** Read by the year-end roll-forward method and trial-balance grouping. */
    accountClass: accountClassSchema,
    /** Read by L2 sign presentation and roll-forward. */
    naturalSide: z.enum(["debit", "credit"]),
    /** Read by the ACCOUNT_NOT_POSTABLE gate. */
    postable: z.boolean(),
    /** Read by the control-account gate (ACCOUNT_CONTROL_RESERVED). Engine id. */
    controlledBySource: z.string().min(1).optional(),
    /** Read by the currency gate. "any" or an explicit list. */
    permittedCurrencies: z.union([z.literal("any"), z.array(currencyCodeSchema).min(1)]),
    /** Read by the dimension gate (DIMENSION_REQUIRED_MISSING). */
    requiredDimensions: z.array(z.string().min(1)),
    /** Read by the ACCOUNT_BLOCKED_AT_DATE gate. */
    blockedFrom: isoDateSchema.optional(),
    blockedTo: isoDateSchema.optional(),
    /** Read by the export projection and L1 summary. Opaque; never normalized. */
    labels: z.array(z.object({ lang: z.string().min(2), text: z.string().min(1) }).strict()),
  })
  .strict();
export type Account = z.infer<typeof accountSchema>;

export const chartOfAccountsVersionSchema = z
  .object({
    /** Read by the account gate and historical account resolution for replay. */
    chartVersionRef: z.string().min(1),
    /** Read by the account gate at the entry's effectiveDate. */
    effectiveFrom: isoDateSchema,
    effectiveTo: isoDateSchema.optional(),
    /** Read by L6 explanation and chart version history. */
    governanceDecisionRef: z.string().min(1).optional(),
    accounts: z.array(accountSchema).min(1),
  })
  .strict();
export type ChartOfAccountsVersion = z.infer<typeof chartOfAccountsVersionSchema>;

/** One dimension's declared value set. Read by gates 19–21 and the sliced trial balance. */
export const dimensionSchemaSchema = z
  .object({
    schemaRef: z.string().min(1),
    dimensions: z.array(
      z
        .object({
          code: z.string().min(1),
          values: z.array(
            z
              .object({
                valueCode: z.string().min(1),
                effectiveFrom: isoDateSchema.optional(),
                effectiveTo: isoDateSchema.optional(),
              })
              .strict(),
          ),
        })
        .strict(),
    ),
    /**
     * Cross-validation rules (gate 21): when a line carries `when`, it must
     * not also carry `forbid`. Deliberately simple pairs — a rule language
     * would be a second engine.
     */
    crossValidationRules: z.array(
      z
        .object({
          ruleId: z.string().min(1),
          when: z.object({ dimensionCode: z.string().min(1), valueCode: z.string().min(1) }).strict(),
          forbid: z.object({ dimensionCode: z.string().min(1), valueCode: z.string().min(1) }).strict(),
        })
        .strict(),
    ),
  })
  .strict();
export type DimensionSchema = z.infer<typeof dimensionSchemaSchema>;

/** How a reversal is constructed. Result-changing; declared per book (§16.7). */
export const reversalMethodSchema = z.enum(["switch-side", "change-sign"]);
export type ReversalMethod = z.infer<typeof reversalMethodSchema>;

export const intercompanyRuleSchema = z
  .object({
    /** The due-to/due-from pair the generated lines post to. Read by LEDGER-INTERCOMPANY-BALANCING. */
    dueToAccount: z.string().min(1),
    dueFromAccount: z.string().min(1),
  })
  .strict();
export type IntercompanyRule = z.infer<typeof intercompanyRuleSchema>;

export const bookSchema = z
  .object({
    /** Read by every gate and store partitioning. */
    bookId: z.string().min(1),
    /** Read by the export projection and multi-entity trial balance. */
    entityRef: z.string().min(1),
    /** Read by the parallel-book projection and export projection. */
    accountingFramework: z.enum(["ifrs", "us-gaap", "local-statutory", "tax", "management"]),
    /** Read by the projection method: an adjustment-only book stores only deltas. */
    bookRole: z.enum(["primary", "parallel", "adjustment-only"]),
    /**
     * The base book an adjustment-only book adjusts. Read by the balance fold,
     * which folds base + delta. Required exactly when bookRole is
     * adjustment-only — the refine below enforces both directions.
     */
    baseBookRef: z.string().min(1).optional(),
    /** Read by the conversion method, balance invariant and trial balance. */
    functionalCurrency: currencyDefSchema,
    /** Read by third-amount computation (C-06). Refuses if declared and no rate. */
    reportingCurrency: currencyDefSchema.optional(),
    /** Read by the period gate. */
    calendarRef: z.string().min(1),
    /** Read by the account gate. */
    chartRef: z.string().min(1),
    /** Read by the dimension gate. */
    dimensionSchemaRef: z.string().min(1).optional(),
    /** Read by the dimension-balance method (C-04). */
    balancingDimensions: z.array(z.string().min(1)),
    /** Read by the intercompany balancing method (C-05). Absent = imbalance refuses, never auto-fixes. */
    intercompanyRule: intercompanyRuleSchema.optional(),
    /** Read by the residue-assignment method. Absent = a residue refuses the entry. */
    roundingResidueAccount: z.string().min(1).optional(),
    /** Read by ROUNDING_RESIDUE_EXCEEDS_TOLERANCE. Absent = lineCount minor units (§16.5). */
    residueToleranceMinorUnits: z.number().int().min(0).optional(),
    /** The book's FX rate-type convention, when it declares one. Read by gate 22. NO default. */
    fxRateType: fxRateTypeSchema.optional(),
    /** The named rounding mode of the ONE rounding boundary (§16.4). Read by the conversion method. */
    fxRoundingMode: roundingModeSchema,
    /** Days after which the newest rate is FX_RATE_STALE. Read by gate 22a. Absent = no staleness check. */
    fxStalenessDays: z.number().int().min(0).optional(),
    /** Read by reversal construction (§16.7). */
    reversalMethod: reversalMethodSchema,
    /** Read by the year-end roll-forward (income/expense close here). */
    retainedEarningsAccount: z.string().min(1).optional(),
    /** Read by the book gate. */
    status: z.enum(["active", "suspended"]),
  })
  .strict()
  .refine((b) => (b.bookRole === "adjustment-only") === (b.baseBookRef !== undefined), {
    message: "An adjustment-only book names its base book; any other role must not.",
    path: ["baseBookRef"],
  });
export type Book = z.infer<typeof bookSchema>;

export const entryTypeSchema = z.enum([
  "standard",
  "adjusting",
  "reversal",
  "opening",
  "closing",
  "statistical",
]);
export type EntryType = z.infer<typeof entryTypeSchema>;

/** §14.5 — one immutable line of a posted entry. */
export const journalLineSchema = z
  .object({
    /** Read by export ordering and line-level explanation. Dense from 1. */
    lineNo: z.number().int().min(1),
    /** Read by the account gate and balance fold. */
    accountCode: z.string().min(1),
    /** The chart version the account was resolved against. Read by replay. */
    chartVersionRef: z.string().min(1),
    /** Read by the balance invariant and export (FEC has separate Debit/Credit columns). */
    side: z.enum(["debit", "credit"]),
    /** Transaction-currency amount. Read by conversion audit and export Montantdevise/Idevise. */
    transactionAmount: exactMoneySchema.optional(),
    /** THE amount: functional currency. Read by the balance invariant, fold and trial balance. */
    functionalAmount: exactMoneySchema.optional(),
    /** The rate captured by value. Read by L3 evidence, replay and conversion audit. */
    rateRef: exchangeRateRefSchema.optional(),
    /** Read by dimension gates, sliced trial balance and the balancing-dimension invariant. */
    dimensions: z.record(z.string(), z.string()),
    /** Returned to the sub-ledger engine. NEVER interpreted here. */
    openItemRef: z.string().min(1).optional(),
    /** Read by export EcritureLib and L2. */
    lineMemo: z.object({ lang: z.string().min(2), text: z.string().min(1) }).strict().optional(),
    /** Read by the statistical trial balance; excluded from the money invariant. */
    statisticalQuantity: quantitySchema.optional(),
    /** Present on lines LedgerIQ generated (residue, intercompany). Visibly generated. */
    generatedBy: methodRefSchema.optional(),
  })
  .strict();
export type JournalLine = z.infer<typeof journalLineSchema>;

/** §14.4 — the immutable journal entry. */
export const journalEntrySchema = z
  .object({
    /** Deterministic from (bookId, idempotencyKey). Read by replay lookup and reversal reference. */
    entryId: z.string().min(1),
    bookId: z.string().min(1),
    periodRef: periodRefSchema,
    journalCode: z.string().min(1),
    /** Gapless per journal per year. Read by FEC/SAF-T ordering and the gap-detection test. */
    journalSequence: z.number().int().min(1),
    /** The accounting date. Read by the period gate, trial balance as-of, FX selection. */
    effectiveDate: isoDateSchema,
    /** When the system recorded it. Supplied by the host, never a clock read. */
    recordedAt: isoInstantSchema,
    /** Read by the balance-invariant carve-out, roll-forward and audit attributes. */
    entryType: entryTypeSchema,
    /** Read by the AS 2401 attribute set and the identity requirement gate. */
    entrySource: z.enum(["automated", "manual"]),
    /** Read by L3/L4 explanation, the control-account gate and audit export. NEVER by authorization. */
    proposedBy: z.string().min(1),
    /** Read by trace back to the originator's record. */
    proposalId: z.string().min(1),
    /** Read by replay detection (gate 5). */
    idempotencyKey: z.string().min(1),
    /** Canonical hash of the proposal's semantic content. Read by IDEMPOTENCY_KEY_CONFLICT detection. */
    contentHash: z.string().min(1),
    /** The originating rule. Read by L4, replay and historical reproducibility. */
    methodRef: methodRefSchema,
    /** Every LedgerIQ method applied. Read by L4 and replay after a LedgerIQ rule change. */
    postingMethodRefs: z.array(methodRefSchema),
    /** Read by L3. Stored as given; never laundered, never scored. */
    evidence: z.array(evidenceRefSchema),
    /** Read for correlation across engines. */
    trace: traceContextSchema,
    /** Read by AS 2401 and the audit export. */
    postedByPrincipal: z.string().min(1),
    /** Present ONLY where an operation consulted one. Read by L6. */
    governanceDecisionRef: z.string().min(1).optional(),
    /** Read by reversal integrity and L5. */
    reversalOf: z.string().min(1).optional(),
    reversedBy: z.string().min(1).optional(),
    lines: z.array(journalLineSchema).min(1),
  })
  .strict();
export type JournalEntry = z.infer<typeof journalEntrySchema>;
