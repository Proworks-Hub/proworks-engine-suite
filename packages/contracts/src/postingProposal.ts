// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

import {
  evidenceRefSchema,
  exactMoneySchema,
  fxRateTypeSchema,
  methodRefSchema,
  quantitySchema,
} from "./financePrimitives.js";
import { traceContextSchema } from "./trace.js";

// ─────────────────────────────────────────────────────────────────────────────
// PostingProposal — the mechanism of LOCK-1, the posting monopoly.
//
// Authorized by DEC-025, closing escalation A-3. Produced by the proposing
// Finance engines (a roster that is deliberately OPEN — thirteen candidates
// today and the Ownership Lock owns the list); consumed ONLY by LedgerIQ,
// which validates it against the chart of accounts, posting rules, period
// status and debit/credit integrity, and posts or refuses.
//
// It lives here because ten-plus engines produce it and one consumes it. In
// LedgerIQ it would force every producer to import a specialist, which
// `checkDependency()` refuses; in any producer it would invert LOCK-1.
//
// A PostingProposal is a PROPOSAL. It carries no authority. An originating
// engine that treats a proposal as posted is defective; a refusal is typed
// and explains which rule refused.
// ─────────────────────────────────────────────────────────────────────────────

/** ISO calendar date. The accounting date is a date, never a timestamp. */
const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** The accounting period a proposal targets, within the book's calendar. */
export const postingPeriodRefSchema = z
  .object({
    fiscalYear: z.number().int(),
    /** 1-based. Adjustment periods number past the last regular period. */
    periodNumber: z.number().int().min(1),
    /** The calendar version, where the proposer pins one. */
    calendarRef: z.string().min(1).optional(),
  })
  .strict();
export type PostingPeriodRef = z.infer<typeof postingPeriodRefSchema>;

/**
 * One proposed line. Exactly one of `amount` (monetary) or
 * `statisticalQuantity` (non-monetary) — a line that is both is two lines,
 * and a line that is neither is nothing.
 */
export const postingProposalLineSchema = z
  .object({
    /** Dense from 1 within the proposal. LedgerIQ validates the numbering. */
    lineNo: z.number().int().min(1),
    /** Account code, resolved against the chart version effective at the entry's date. */
    accountCode: z.string().min(1),
    side: z.enum(["debit", "credit"]),
    /** Monetary amount in the TRANSACTION currency. */
    amount: exactMoneySchema.optional(),
    /** Non-monetary amount for statistical accounts. */
    statisticalQuantity: quantitySchema.optional(),
    /** Dimension tags: cost centre, project, entity, segment… */
    dimensions: z.record(z.string(), z.string()).default({}),
    /** Sub-ledger open-item reference. Opaque to LedgerIQ; returned, never interpreted. */
    openItemRef: z.string().min(1).optional(),
    /** Line memo with its language tag. Opaque text; never normalized or truncated. */
    memo: z.object({ lang: z.string().min(2), text: z.string().min(1) }).strict().optional(),
  })
  .strict()
  .refine((l) => (l.amount === undefined) !== (l.statisticalQuantity === undefined), {
    message: "Exactly one of amount or statisticalQuantity. A line that is both is two lines.",
    path: ["amount"],
  });
export type PostingProposalLine = z.infer<typeof postingProposalLineSchema>;

/**
 * What kind of entry this proposes. Absent means `standard` — a semantic
 * default (the common case has a name), not an unknown presented as a value.
 */
export const proposalEntryTypeSchema = z.enum([
  "standard",
  "adjusting",
  "reversal",
  "opening",
  "closing",
  "statistical",
]);
export type ProposalEntryType = z.infer<typeof proposalEntryTypeSchema>;

export const postingProposalSchema = z
  .object({
    /**
     * Stable identity, deterministic where the same facts must produce the
     * same proposal.
     */
    proposalId: z.string().min(1),
    /** Canonical engine id of the originator. Recorded for attribution; NEVER an authorization input. */
    proposedBy: z.string().min(1),
    /** The one book this proposal targets. Multi-book postings are multiple proposals. */
    bookId: z.string().min(1),
    /** The journal this entry belongs to. Absent means the book's general journal ("GEN"). */
    journalCode: z.string().min(1).optional(),
    entryType: proposalEntryTypeSchema.optional(),
    /**
     * Who originated it: an automated engine or a human. Absent means
     * `automated`. A `manual` entry requires a resolvable human principal.
     */
    entrySource: z.enum(["automated", "manual"]).optional(),
    /** The human or service principal behind the proposal, where known. Required for manual entries. */
    principal: z.string().min(1).optional(),
    lines: z.array(postingProposalLineSchema),
    /** The accounting date requested — never "now". */
    effectiveDate: isoDateSchema,
    periodRef: postingPeriodRefSchema,
    /** The versioned rule that produced this proposal. */
    methodRef: methodRefSchema,
    /** Supporting facts with per-dimension quality. May be empty; emptiness is visible. */
    evidence: z.array(evidenceRefSchema),
    trace: traceContextSchema,
    /**
     * REQUIRED for posting — but optional in this schema, deliberately: a
     * proposal missing its key must reach LedgerIQ's gate 4 and be refused
     * with the precise `IDEMPOTENCY_KEY_MISSING`, not die in a generic parse
     * error. The repository already shipped one absent idempotency key
     * (E2E-03); the refusal exists so that absence is loud.
     */
    idempotencyKey: z.string().optional(),
    /** The FX rate-type convention, where the proposer (rather than the book) declares it. */
    fxRateType: fxRateTypeSchema.optional(),
    /** When this proposes a reversal: the entry being reversed. Never an in-place edit. */
    reversalOf: z.string().min(1).optional(),
  })
  .strict();
export type PostingProposal = z.infer<typeof postingProposalSchema>;
