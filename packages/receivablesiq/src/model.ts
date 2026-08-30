// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

import {
  currencyCodeSchema,
  evidenceRefSchema,
  exactMoneySchema,
  exchangeRateRefSchema,
  freshnessStateSchema,
  methodRefSchema,
  traceContextSchema,
} from "@proworks-hub/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// Canonical model — blueprint §14. THE JOURNAL IS THE TRUTH: an append-only
// log of facts, reached only through the store port. Open items, receipts,
// balances and aging are PROJECTIONS — rebuildable, disposable, never an
// authority (I-2: if a stored projection disagrees with a replay, the replay
// wins). This journal is NOT the general ledger: it holds no accounts, no
// debits/credits and no period state — confusing it with LedgerIQ's journal
// is a LOCK-1 violation.
// ─────────────────────────────────────────────────────────────────────────────

const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const journalKindSchema = z.enum([
  "receivable.recorded",
  "receivable.amended",
  "cash.received",
  "cash.identified",
  "cash.placed-on-account",
  "application.made",
  "application.reversed",
  "shortpay.classified",
  "adjustment.recorded",
  "writeoff.recorded",
]);
export type JournalKind = z.infer<typeof journalKindSchema>;

/** Journal kinds that reduce a balance and therefore REQUIRE an authorization reference. */
export const MATERIAL_KINDS: readonly JournalKind[] = [
  "writeoff.recorded",
  "adjustment.recorded",
];

export const receivableJournalEntrySchema = z
  .object({
    entryId: z.string().min(1),
    /** Read by store partitioning and the §38 isolation tests. */
    tenantRef: z.string().min(1),
    /** Monotonic per tenant. Read by replayTo(asOf). */
    sequence: z.number().int().min(1),
    /** Host-supplied. Read by freshness; NOT used for aging. */
    recordedAt: z.string().min(1),
    /** Read by replayTo's cut-off comparison. */
    effectiveAt: isoDateSchema,
    kind: journalKindSchema,
    /** Per-kind payload; the projection reducer's switch reads it. */
    payload: z.record(z.string(), z.unknown()),
    methodRef: methodRefSchema,
    evidence: z.array(evidenceRefSchema),
    trace: traceContextSchema,
    /** REQUIRED — the reader E2E-03 lacked: store.hasIdempotencyKey dedup. */
    idempotencyKey: z.string().min(1),
    /** human. / system. / engine. — read by L6 and authorization tests. */
    principal: z.string().min(1),
    /** Required for MATERIAL_KINDS; refused if absent. */
    authorizationRef: z.string().min(1).optional(),
  })
  .strict();
export type ReceivableJournalEntry = z.infer<typeof receivableJournalEntrySchema>;

export const openItemKindSchema = z.enum([
  "invoice",
  "credit-note",
  "debit-memo",
  "chargeback",
  "on-account-credit",
  "adjustment",
]);
export type OpenItemKind = z.infer<typeof openItemKindSchema>;

export const openItemStateSchema = z.enum([
  "open",
  "partially-applied",
  "cleared",
  "written-off",
  "assigned",
  "superseded",
]);
export type OpenItemState = z.infer<typeof openItemStateSchema>;

export const discountTermSchema = z
  .object({
    days: z.number().int().min(0),
    /** Percent units, exact decimal string. */
    percentage: z.string().regex(/^\d+(\.\d+)?$/),
  })
  .strict();
export type DiscountTerm = z.infer<typeof discountTermSchema>;

export const componentSchema = z
  .object({
    componentId: z.string().min(1),
    componentKind: z.enum(["line", "tax", "freight", "financeCharge"]),
    amount: exactMoneySchema,
  })
  .strict();
export type ItemComponent = z.infer<typeof componentSchema>;

/** A projection. Never an authority (I-2). */
export interface OpenItem {
  readonly openItemId: string;
  readonly customerRef: string;
  readonly documentRef: string;
  readonly itemKind: z.infer<typeof openItemKindSchema>;
  readonly sign: "debit" | "credit";
  readonly originalAmount: { amount: string; currency: string; scale: number };
  /** DERIVED ONLY — invariant I-1. */
  readonly openAmount: { amount: string; currency: string; scale: number };
  readonly documentDate: string;
  /** Optional: absent ⇒ the `unknown` aging bucket, never "current". */
  readonly dueDate?: string;
  readonly discountTerms: readonly DiscountTerm[];
  readonly state: OpenItemState;
  /** Set from CollectionsIQ events; NEVER changes openAmount. */
  readonly disputePresence: boolean;
  readonly originalFxRate?: z.infer<typeof exchangeRateRefSchema>;
  readonly components: readonly ItemComponent[];
  readonly sourceEntryIds: readonly string[];
  readonly freshness: z.infer<typeof freshnessStateSchema>;
}

export const receiptStateSchema = z.enum([
  "unidentified",
  "identified-unapplied",
  "on-account",
  "partially-applied",
  "fully-applied",
  "returned",
]);
export type ReceiptState = z.infer<typeof receiptStateSchema>;

export interface CashReceipt {
  readonly cashReceiptId: string;
  /** Absent ⇒ `unidentified`. The engine NEVER guesses the customer. */
  readonly customerRef?: string;
  readonly amount: { amount: string; currency: string; scale: number };
  readonly valueDate: string;
  readonly receivedDate: string;
  readonly instrument: string;
  /** Opaque match evidence. Never resolved to an identity. */
  readonly payerReference?: string;
  readonly sourceMessageRef: string;
  readonly state: ReceiptState;
  /** Derived, never stored as authority. */
  readonly unappliedAmount: { amount: string; currency: string; scale: number };
  readonly remittanceRefs: readonly string[];
}

export interface Application {
  readonly applicationId: string;
  readonly cashReceiptId: string;
  readonly openItemId: string;
  readonly appliedAmount: { amount: string; currency: string; scale: number };
  readonly strategy: "partial" | "residual";
  readonly matcherRef: z.infer<typeof methodRefSchema>;
  readonly reversedBy?: string;
}

// ── State machines — §15. Every state has at least one exit; walked by test.
// `disputed` is deliberately NOT a state: dispute state is CollectionsIQ's,
// and a state here would be a second copy that could disagree.

export const OPEN_ITEM_TRANSITIONS: readonly { from: OpenItemState; to: OpenItemState }[] = [
  { from: "open", to: "partially-applied" },
  { from: "open", to: "cleared" },
  { from: "open", to: "written-off" },
  { from: "open", to: "assigned" },
  { from: "open", to: "superseded" },
  { from: "partially-applied", to: "open" },
  { from: "partially-applied", to: "cleared" },
  { from: "partially-applied", to: "written-off" },
  { from: "partially-applied", to: "assigned" },
  { from: "cleared", to: "partially-applied" },
  { from: "cleared", to: "open" },
  { from: "written-off", to: "open" },
  { from: "assigned", to: "cleared" },
  { from: "assigned", to: "open" },
];
/** Terminal by design, stated: superseded (the residual child carries the balance). */
export const TERMINAL_OPEN_ITEM_STATES: readonly OpenItemState[] = ["superseded"];

export const RECEIPT_TRANSITIONS: readonly { from: ReceiptState; to: ReceiptState }[] = [
  { from: "unidentified", to: "identified-unapplied" },
  { from: "unidentified", to: "returned" },
  { from: "identified-unapplied", to: "partially-applied" },
  { from: "identified-unapplied", to: "fully-applied" },
  { from: "identified-unapplied", to: "on-account" },
  { from: "identified-unapplied", to: "unidentified" },
  { from: "identified-unapplied", to: "returned" },
  { from: "on-account", to: "partially-applied" },
  { from: "on-account", to: "fully-applied" },
  { from: "on-account", to: "identified-unapplied" },
  { from: "on-account", to: "returned" },
  { from: "partially-applied", to: "fully-applied" },
  { from: "partially-applied", to: "identified-unapplied" },
  { from: "fully-applied", to: "partially-applied" },
  { from: "fully-applied", to: "identified-unapplied" },
];
/** A re-presented payment is a NEW receipt, never a resurrection. */
export const TERMINAL_RECEIPT_STATES: readonly ReceiptState[] = ["returned"];

// ── Policies (versioned data, validated on load) ─────────────────────────────

export const tolerancePolicySchema = z
  .object({
    methodRef: methodRefSchema,
    /** Absolute tolerance in minor units of the item currency. */
    absoluteMinor: z.string().regex(/^\d+$/),
    /** Percent units, exact decimal string. Evaluated as the SMALLER of the two. */
    percent: z.string().regex(/^\d+(\.\d+)?$/),
    allowUnearnedDiscount: z.boolean(),
    /** The standing authorization covering tolerance write-offs. */
    toleranceAuthorizationRef: z.string().min(1),
  })
  .strict();
export type TolerancePolicy = z.infer<typeof tolerancePolicySchema>;

export const agingPolicySchema = z
  .object({
    methodRef: methodRefSchema,
    basis: z.enum(["dueDate", "documentDate"]),
    /** Ordered, half-open [from, to) day ranges: contiguous, no gaps/overlaps. */
    buckets: z.array(
      z.object({ name: z.string().min(1), fromDays: z.number().int(), toDays: z.number().int() }).strict(),
    ),
    graceDays: z.number().int().min(0),
    creditTreatment: z.enum(["net-into-current", "separate-credits-line", "age-credits-by-own-date"]),
  })
  .strict();
export type AgingPolicy = z.infer<typeof agingPolicySchema>;

export const matchPolicySchema = z
  .object({
    methodRef: methodRefSchema,
    /** M4.5's bound. Exceeding it is a refusal, not a truncated search. */
    maxCandidates: z.number().int().min(1).max(64),
    /** M4.6 runs ONLY when explicitly authorized — a guess dressed as a rule. */
    policyOrderedAuthorized: z.boolean(),
  })
  .strict();
export type MatchPolicy = z.infer<typeof matchPolicySchema>;
