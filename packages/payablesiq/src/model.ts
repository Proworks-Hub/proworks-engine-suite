// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

import {
  currencyCodeSchema,
  evidenceQualitySchema,
  exactMoneySchema,
  freshnessStateSchema,
  methodRefSchema,
  roundingModeSchema,
  traceContextSchema,
} from "@proworks-hub/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// Canonical model — blueprint §14. Everything PayablesIQ persists is
// `tenant-private`, stated explicitly on every record because ownership has
// no default. Every field here appears in the §14.4 field→reader map; a field
// with no reader was cut (the blueprint itself cut `disputeSlaBreached`).
//
// `disputed-hold` and `disputeCaseRef` are DELIBERATELY ABSENT from this
// implementation: B-3 (the AP dispute workflow) was ratified under DEC-025
// with the load-bearing condition that a platform `case-kit` exist BEFORE the
// case, and it does not. A state with no producer is the repository's
// eight-times-shipped defect shape; the state arrives with case-kit, not
// before it.
// ─────────────────────────────────────────────────────────────────────────────

const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const obligationStatusSchema = z.enum([
  "open",
  "partially-settled",
  "settled",
  "held",
  "written-off",
  "reversed",
  "escheat-candidate",
]);
export type ObligationStatus = z.infer<typeof obligationStatusSchema>;

export const termsResolutionSchema = z.enum([
  "derived",
  "supplied",
  "candidate-pending",
  "unresolved",
]);
export type TermsResolution = z.infer<typeof termsResolutionSchema>;

export const originKindSchema = z.enum([
  "invoice-asserted",
  "accrued-uninvoiced",
  "host-asserted",
  "withholding-counterparty",
  "credit-memo",
]);
export type OriginKind = z.infer<typeof originKindSchema>;

/** Ordered, strictly monotonic: ascending days, strictly descending percentages (I-2). */
export const discountTierSchema = z
  .object({
    days: z.number().int().min(0),
    /** Percent units as an exact decimal string, e.g. "2" for 2%. Never a bare float. */
    percentage: z.string().regex(/^\d+(\.\d+)?$/),
  })
  .strict();
export type DiscountTier = z.infer<typeof discountTierSchema>;

export const termsDateBasisSchema = z.enum([
  "document-date",
  "posting-date",
  "received-date",
  "entry-date",
  "legal-effective",
  "explicit",
]);
export type TermsDateBasis = z.infer<typeof termsDateBasisSchema>;

export const businessDayAdjustmentSchema = z.enum([
  "none",
  "following",
  "preceding",
  "modified-following",
]);
export type BusinessDayAdjustment = z.infer<typeof businessDayAdjustmentSchema>;

export const dueDateRuleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("days"), days: z.number().int().min(0) }).strict(),
  z
    .object({
      kind: z.literal("day-of-month"),
      /** The day after which the schedule advances a month. */
      cutoffDay: z.number().int().min(1).max(31),
      monthsAhead: z.number().int().min(0),
      /** Day 31 means last-day-of-month, stated explicitly (§13.5). */
      dayOfMonth: z.number().int().min(1).max(31),
    })
    .strict(),
  z.object({ kind: z.literal("fixed-date"), date: isoDateSchema }).strict(),
]);
export type DueDateRule = z.infer<typeof dueDateRuleSchema>;

export const installmentShareSchema = z
  .object({
    /** Percent units, exact decimal string. All shares must sum to exactly 100 (I-1). */
    percentage: z.string().regex(/^\d+(\.\d+)?$/),
    /** This installment's own due-date rule. */
    rule: dueDateRuleSchema,
  })
  .strict();
export type InstallmentShare = z.infer<typeof installmentShareSchema>;

/**
 * A versioned payment-terms definition. Owned as DATA: hosts supply
 * definitions, PayablesIQ versions, validates at registration and applies.
 */
export const paymentTermsDefinitionSchema = z
  .object({
    methodRef: methodRefSchema,
    termsDateBasis: termsDateBasisSchema,
    /** Required iff termsDateBasis is "explicit". */
    explicitTermsDate: isoDateSchema.optional(),
    rule: dueDateRuleSchema,
    /** Absent means single payment. Present means one obligation per installment. */
    installments: z.array(installmentShareSchema).optional(),
    discountSchedule: z.array(discountTierSchema).default([]),
    /** Gross vs net-of-tax: both real, neither default (§16.4). */
    discountBase: z.enum(["gross-including-tax", "net-of-tax"]),
    dueDateAdjustment: businessDayAdjustmentSchema,
    /** The named rounding mode of boundaries B-1 and B-2. */
    roundingMode: roundingModeSchema,
  })
  .strict();
export type PaymentTermsDefinition = z.infer<typeof paymentTermsDefinitionSchema>;

/** A business calendar supplied BY the host. Without one, only `none` adjustment is legal. */
export const businessCalendarSchema = z
  .object({
    calendarRef: z.string().min(1),
    /** 0=Sunday..6=Saturday. Days of week that are non-business. */
    weekendDays: z.array(z.number().int().min(0).max(6)),
    holidays: z.array(isoDateSchema),
  })
  .strict();
export type BusinessCalendar = z.infer<typeof businessCalendarSchema>;

export const settlementKindSchema = z.enum([
  "settlement",
  "credit-memo",
  "discount-taken",
  "write-off",
  "reversal",
]);
export type SettlementKind = z.infer<typeof settlementKindSchema>;

export const settlementApplicationSchema = z
  .object({
    applicationId: z.string().min(1),
    obligationId: z.string().min(1),
    appliedAmount: exactMoneySchema,
    applicationDate: isoDateSchema,
    kind: settlementKindSchema,
    /** Opaque: a payment instruction ref, a credit-memo document key. Never parsed. */
    sourceRef: z.string().min(1),
    /** REQUIRED for write-off; its absence is the refusal gate. */
    authorizationRef: z.string().min(1).optional(),
    /** Read by the settlement idempotency scope (§23.3-2). Required. */
    idempotencyKey: z.string().min(1),
  })
  .strict();
export type SettlementApplication = z.infer<typeof settlementApplicationSchema>;

export const payableObligationSchema = z
  .object({
    obligationId: z.string().min(1),
    /** Explicit, no default. */
    ownership: z.literal("tenant-private"),
    ownerRef: z.string().min(1),
    /** Monotonic; a new version, never an edit (LOCK-3). */
    version: z.number().int().min(1),
    supersedes: z.string().min(1).optional(),
    /** Opaque scoped reference. NOT a name, address, bank detail or tax id (§32). */
    vendorRef: z.string().min(1),
    /** Read by computeVendorBalance's merge refusal. */
    vendorIdentityResolution: z.enum(["resolved", "unresolved"]),
    originKind: originKindSchema,
    /** Opaque; never parsed here. */
    sourceDocumentKey: z.string().min(1).optional(),
    /** Clearance-mandate date, distinct from document date. Read by resolveTermsDate. */
    legalEffectiveDate: isoDateSchema.optional(),
    originalAmount: exactMoneySchema,
    currency: currencyCodeSchema,
    /** 1..n; one obligation per installment. Read by the fingerprint and residual logic. */
    installmentSequence: z.number().int().min(1),
    termsRef: methodRefSchema.optional(),
    termsResolution: termsResolutionSchema,
    /** The basis date terms were computed from. */
    termsDate: isoDateSchema.optional(),
    /** Absent iff termsResolution is not derived|supplied. */
    dueDate: isoDateSchema.optional(),
    discountSchedule: z.array(discountTierSchema).default([]),
    status: obligationStatusSchema,
    /** Derived, stored for query, VERIFIED on every read (reconcileOpenAmount). */
    openAmount: exactMoneySchema,
    /** Ordered, append-only application ids. */
    applications: z.array(z.string().min(1)),
    /** Captured BY VALUE where it set a discount base. */
    taxDeterminationRef: z.string().min(1).optional(),
    taxAmount: exactMoneySchema.optional(),
    /** Links vendor-net and authority obligations. */
    withholdingLink: z.string().min(1).optional(),
    /** IAS 7 / IFRS 7 disclosure input; read by prioritization exclusion. */
    fundingRoute: z.enum(["direct", "supplier-finance", "unknown"]),
    /** B-5: InvoiceIQ's reconciliation, BY VALUE. The ONLY reader is measureAccruedUninvoiced. */
    quantityEvidenceRef: z.string().min(1).optional(),
    /** TD-11 successor: the scale actually used, recorded not assumed. Read by reconcileOpenAmount and export. */
    assumedMoneyScale: z.number().int().min(0).max(6),
    /** unknown | posted | refused — refuses "accounted for" while unknown (§19.5). */
    ledgerAcknowledgement: z.enum(["unknown", "posted", "refused"]),
    evidence: evidenceQualitySchema,
    freshness: freshnessStateSchema,
    trace: traceContextSchema,
  })
  .strict();
export type PayableObligation = z.infer<typeof payableObligationSchema>;

/**
 * The duplicate-suppression identity: a COMPOSITE KEY, not a hash — a hash
 * cannot be read when a duplicate turns out to be wrong; this can be printed
 * in a log and understood.
 */
export function obligationFingerprint(o: {
  vendorRef: string;
  originKind: string;
  sourceDocumentKey?: string;
  currency: string;
  originalAmount: { amount: string };
  termsDate?: string;
  installmentSequence: number;
}): string {
  return [
    o.vendorRef,
    o.originKind,
    o.sourceDocumentKey ?? "",
    o.currency,
    o.originalAmount.amount,
    o.termsDate ?? "",
    String(o.installmentSequence),
  ].join("|");
}

/** Ordered half-open buckets covering (−∞, +∞); validated at registration. */
export const agingSchemeSchema = z
  .object({
    methodRef: methodRefSchema,
    basis: z.enum(["due-date", "document-date", "terms-date"]),
    /** [lowerDays, upperDays) — contiguous, non-overlapping. */
    buckets: z.array(
      z
        .object({
          name: z.string().min(1),
          lowerDays: z.number().int(),
          upperDays: z.number().int(),
        })
        .strict(),
    ),
    futureBucket: z.string().min(1),
    termsUnknownBucket: z.string().min(1),
  })
  .strict();
export type AgingScheme = z.infer<typeof agingSchemeSchema>;

export const agingSnapshotSchema = z
  .object({
    agingRunId: z.string().min(1),
    asOf: isoDateSchema,
    schemeRef: methodRefSchema,
    methodRef: methodRefSchema,
    buckets: z.array(
      z
        .object({
          name: z.string().min(1),
          currency: currencyCodeSchema,
          total: exactMoneySchema,
          obligationIds: z.array(z.string().min(1)),
        })
        .strict(),
    ),
    resultFingerprint: z.string().min(1),
    generatedFrom: z.array(z.string().min(1)),
  })
  .strict();
export type AgingSnapshot = z.infer<typeof agingSnapshotSchema>;
