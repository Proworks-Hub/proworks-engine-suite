/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — CostIQ
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED.
 *
 * File:     packages/costiq/src/ports/costIntegration.ts
 * Module:   cost-iq-engine / ports
 * Purpose:  The boundary, made enforceable rather than documented.
 */

import { z } from "zod";

import { COSTIQ_DOES_NOT_OWN, type ExcludedResponsibility } from "../charter.js";
import { COST_EVENT_TYPES, type CostEventType } from "./costPorts.js";

// ─────────────────────────────────────────────────────────────────────────────
// A CHARTER NOBODY CHECKS IS A DOCUMENT, NOT A BOUNDARY
//
// `COSTIQ_DOES_NOT_OWN` lists what this engine refuses to do and — more
// usefully — `arrivesAs`, the plausible-sounding request that would drag it in.
// Those requests are plausible because they are reasonable. "CostIQ compared
// three suppliers, so it may as well pick the cheapest" is not a bad idea; it
// is a good idea that belongs to a different engine, and the moment CostIQ
// acts on it, procurement decisions start being made by a costing engine that
// nobody audits for that.
//
// So the charter is wired into the inbound path. A request that falls outside
// scope is REFUSED, with the reason and the owning engine named, rather than
// quietly handled because it was easy.
//
// THE REFUSAL IS THE FEATURE
//
// It is tempting to make these warnings. A warning gets read once and then
// suppressed. A refusal forces the caller to route the request to whichever
// engine actually owns it, which is the outcome the boundary exists for.
// ─────────────────────────────────────────────────────────────────────────────

/** What a neighbouring engine may ask CostIQ to do. */
export const INBOUND_REQUEST_KINDS = [
  "COMPUTE_ESTIMATE",
  "RECOMPUTE_ESTIMATE",
  "RECORD_COST_BASIS",
  "EXPLAIN_ESTIMATE",
  "COMPARE_ALTERNATIVES",
  "COMPUTE_VARIANCE",
  "ASSESS_MODEL_HEALTH",
  "DERIVE_PRICE_FROM_COST",
] as const;
export type InboundRequestKind = (typeof INBOUND_REQUEST_KINDS)[number];

export const inboundRequestSchema = z
  .object({
    requestId: z.string().min(1),
    kind: z.enum(INBOUND_REQUEST_KINDS),
    tenantId: z.string().min(1),
    /** Which engine is asking. Named so a refusal can be routed back usefully. */
    requestedBy: z.string().min(1),
    subjectId: z.string().min(1),
    isTest: z.boolean(),
    /**
     * What the caller says it intends to do with the answer.
     *
     * Optional and free text, and it is NOT trusted — it is matched against the
     * charter's exclusions so an obviously out-of-scope intention is refused at
     * the door rather than served and then misused. A caller who omits it or
     * lies still cannot make CostIQ do anything it has no code for; this catches
     * the honest caller heading somewhere they should not.
     */
    statedIntent: z.string().max(500).optional(),
    parameters: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
export type InboundRequest = z.infer<typeof inboundRequestSchema>;

export type ScopeDecision =
  | { readonly inScope: true }
  | {
      readonly inScope: false;
      readonly excludedId: string;
      readonly ownedBy: string;
      readonly reason: string;
    };

/**
 * Phrases that signal a request has crossed into somebody else's territory.
 *
 * Keyed to the charter's exclusion ids, so adding an exclusion without adding
 * its signals is caught by the completeness test rather than discovered later
 * as a boundary that quietly does not hold.
 *
 * These are a coarse net on purpose. They catch a caller saying out loud what
 * they intend; they are not a security control, and the real boundary is that
 * CostIQ has no code to select a supplier or post a journal entry.
 */
export const OUT_OF_SCOPE_SIGNALS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  profitability: ["profitab", "is this customer worth", "contribution by customer", "product line profit"],
  budget: ["budget", "against plan", "forecast variance"],
  ledger: ["journal entry", "post to the ledger", "revalu", "general ledger", "accounts payable", "accounts receivable"],
  "procurement.decision": ["pick the cheapest", "select the supplier", "choose a supplier", "raise a purchase order", "issue a po", "commit spend"],
  "pricing.commercial": ["willingness to pay", "optimise the margin", "optimize the margin", "discount strategy", "what the market will bear", "competitive position"],
  "organizational.health": ["how is the business doing", "company health", "raise the alarm globally"],
  "decision.authority": ["approve it because", "authorise the", "authorize the", "go ahead if it is cheaper", "proceed automatically"],
  "geometry.recognition": ["read the cad", "from the cad file", "extract the features", "recognise the geometry", "recognize the geometry", "from the drawing"],
  "inventory.truth": ["stock on hand", "what stock exists", "track the quantities", "reserve the stock", "how much is in the warehouse"],
});

/**
 * Whether a request is CostIQ's to answer.
 *
 * Checks the stated intent against the charter. Case-insensitive substring
 * matching — crude, and deliberately so: a sophisticated classifier here would
 * be a second thing to be wrong, and this only needs to catch the caller who
 * says what they mean.
 */
export function assessScope(request: InboundRequest): ScopeDecision {
  const intent = (request.statedIntent ?? "").toLowerCase();
  // A fast path, not a guard: an empty intent already matches no signal, since
  // every signal is required to be non-empty and `findContractGaps` checks it.
  // Recorded as such because a mutation removing this line changes nothing, and
  // the honest answer to that is "it is an optimisation", not a fabricated test.
  if (intent.length === 0) return { inScope: true };

  for (const excluded of COSTIQ_DOES_NOT_OWN) {
    const signals = OUT_OF_SCOPE_SIGNALS[excluded.id] ?? [];
    const hit = signals.find((signal) => intent.includes(signal));
    if (hit !== undefined) {
      return {
        inScope: false,
        excludedId: excluded.id,
        ownedBy: excluded.ownedBy,
        reason: `This is ${excluded.ownedBy}'s to answer, not CostIQ's: ${excluded.summary} The request reads as "${hit}". CostIQ will supply the cost figures that ${excluded.ownedBy} needs, but the decision is not one it can make on your behalf.`,
      };
    }
  }
  return { inScope: true };
}

export type InboundOutcome =
  | { readonly accepted: true; readonly request: InboundRequest }
  | { readonly accepted: false; readonly refusal: string; readonly refusedBecause: "MALFORMED" | "OUT_OF_SCOPE" };

/**
 * The single door.
 *
 * Every inbound integration goes through here: parsed, then scope-checked. A
 * second door would be a second place the boundary could be forgotten, which
 * is exactly how the interconnect handoff ended up hardcoding `isTest: false`.
 */
export function acceptInbound(raw: unknown): InboundOutcome {
  const parsed = inboundRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      accepted: false,
      refusedBecause: "MALFORMED",
      refusal: `The request is not a valid CostIQ request: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ")}`,
    };
  }

  const scope = assessScope(parsed.data);
  if (!scope.inScope) {
    return { accepted: false, refusedBecause: "OUT_OF_SCOPE", refusal: scope.reason };
  }

  return { accepted: true, request: parsed.data };
}

// ─────────────────────────────────────────────────────────────────────────────
// WHAT COSTIQ OFFERS OUTWARD
// ─────────────────────────────────────────────────────────────────────────────

export interface OutboundCapability {
  readonly kind: InboundRequestKind;
  readonly summary: string;
  /** What a consumer gets back, in terms it can plan against. */
  readonly returns: string;
  /** The events this capability may cause. */
  readonly mayEmit: readonly CostEventType[];
  /** Named so the reader is told before they build on it, not after. */
  readonly caveat: string;
}

export const COSTIQ_OFFERS: readonly OutboundCapability[] = Object.freeze([
  {
    kind: "COMPUTE_ESTIMATE",
    summary: "Computes a cost estimate from a named, versioned method.",
    returns: "A cost breakdown with provenance for every component and an evidence grade for the whole.",
    mayEmit: ["costiq.estimate.computed"],
    caveat: "A computed estimate is not an approved one, and neither is a price.",
  },
  {
    kind: "RECOMPUTE_ESTIMATE",
    summary: "Recomputes estimates affected by a changed basis.",
    returns: "A plan naming what will be recomputed and what will be skipped, then the results.",
    mayEmit: ["costiq.estimate.computed", "costiq.estimate.superseded"],
    caveat: "Frozen and approved estimates are never recomputed. That is the point of freezing them.",
  },
  {
    kind: "RECORD_COST_BASIS",
    summary: "Records a cost basis with its provenance and effective interval.",
    returns: "The stored basis, or a refusal naming what was missing.",
    mayEmit: ["costiq.basis.recorded"],
    caveat: "A basis with no provenance is refused. Evidence is not optional here.",
  },
  {
    kind: "EXPLAIN_ESTIMATE",
    summary: "Explains an estimate at a requested depth, L0 to L6.",
    returns: "Pre-formatted strings. An AI narrating them cannot recompute anything.",
    mayEmit: [],
    caveat: "The explanation is generated from the stored computation, never re-derived — so it cannot disagree with the number it explains.",
  },
  {
    kind: "COMPARE_ALTERNATIVES",
    summary: "Ranks alternatives at a quantity, with break-even and decision margin.",
    returns: "A ranking, a why-not for every rejection, and how close the decision was.",
    mayEmit: [],
    caveat: "Ranking is not choosing. A ranking inside the materiality threshold is reported as too close to call.",
  },
  {
    kind: "COMPUTE_VARIANCE",
    summary: "Splits an estimate-versus-actual difference into rate and quantity.",
    returns: "Rate, quantity and total variance that sum exactly.",
    mayEmit: ["costiq.variance.detected"],
    caveat: "A variance says where to look. It does not say who is at fault.",
  },
  {
    kind: "ASSESS_MODEL_HEALTH",
    summary: "Reports whether a model's inputs still deserve to be believed.",
    returns: "Ordered findings and a weighted score.",
    mayEmit: ["costiq.model_health.degraded"],
    caveat: "Reported, never enforced. Whether to proceed on aging evidence is a person's judgement.",
  },
  {
    kind: "DERIVE_PRICE_FROM_COST",
    summary: "Derives a price from a cost by markup or margin, against stated floors.",
    returns: "A price, the realised margin and markup, and any floor that moved it.",
    mayEmit: [],
    caveat: "A cost-derived price is a floor and a reference. What to charge is a commercial decision CostIQ does not own.",
  },
]);

/** The capability description for one request kind. */
export function capabilityFor(kind: InboundRequestKind): OutboundCapability {
  const found = COSTIQ_OFFERS.find((c) => c.kind === kind);
  if (found === undefined) {
    throw new Error(
      `No capability is declared for "${kind}". Every request kind must be declared in COSTIQ_OFFERS, so a consumer can find out what it gets back without reading the implementation.`,
    );
  }
  return found;
}

// ─────────────────────────────────────────────────────────────────────────────
// CONTRACT COMPLETENESS (R12)
//
// These are checks rather than prose because the failure they guard against is
// drift: somebody adds an event type and forgets its consequence contract, or
// adds a charter exclusion with no signals behind it. Nothing breaks at the
// time. The gap is discovered months later, by a consumer who inferred the
// wrong thing from an event nobody had documented.
// ─────────────────────────────────────────────────────────────────────────────

export interface CompletenessGap {
  readonly what: string;
  readonly missing: string;
  readonly consequence: string;
}

/**
 * Every place a contract could be incomplete, checked at once.
 *
 * Returns gaps rather than throwing, so a test can print all of them instead of
 * failing on the first — fixing five gaps one build at a time is how people
 * stop running the check.
 */
export function findContractGaps(
  consequenceContracts: Readonly<Record<string, unknown>>,
  /**
   * The signal table and capability list to check.
   *
   * Default to the shipped ones. They are arguments at all so a test can inject
   * a deliberately incomplete set — every branch below is unreachable from the
   * real contracts, which is exactly the state this function exists to keep
   * them in, and a check nothing can exercise is a check nobody can trust.
   */
  outOfScopeSignals: Readonly<Record<string, readonly string[]>> = OUT_OF_SCOPE_SIGNALS,
  offers: readonly OutboundCapability[] = COSTIQ_OFFERS,
): readonly CompletenessGap[] {
  const gaps: CompletenessGap[] = [];

  for (const type of COST_EVENT_TYPES) {
    if (!(type in consequenceContracts)) {
      gaps.push({
        what: `Event "${type}"`,
        missing: "a consequence contract",
        consequence:
          "A consumer has nothing telling it what the event does NOT entitle it to conclude, which is the half that gets inferred wrongly.",
      });
    }
  }

  for (const excluded of COSTIQ_DOES_NOT_OWN) {
    const signals = outOfScopeSignals[excluded.id] ?? [];
    if (signals.length === 0) {
      gaps.push({
        what: `Charter exclusion "${excluded.id}"`,
        missing: "out-of-scope signals",
        consequence:
          "The exclusion is documented but not enforced at the door, so a request heading there is accepted and served.",
      });
    }
    if (signals.some((signal) => signal.trim().length === 0)) {
      gaps.push({
        what: `Charter exclusion "${excluded.id}"`,
        missing: "non-empty signals — one of them is blank",
        consequence:
          "A blank signal is a substring of every intent, so every request would be refused as out of scope. The engine would stop answering anything.",
      });
    }
    if (excluded.arrivesAs.trim().length === 0) {
      gaps.push({
        what: `Charter exclusion "${excluded.id}"`,
        missing: "the plausible request that would drag CostIQ in",
        consequence: "The exclusion says what is out of scope but not how it gets crossed, which is the part a reviewer needs.",
      });
    }
  }

  for (const kind of INBOUND_REQUEST_KINDS) {
    if (!offers.some((c) => c.kind === kind)) {
      gaps.push({
        what: `Request kind "${kind}"`,
        missing: "a declared capability",
        consequence: "A consumer can send it but cannot find out what comes back without reading the implementation.",
      });
    }
  }

  for (const offer of offers) {
    for (const event of offer.mayEmit) {
      if (!(COST_EVENT_TYPES as readonly string[]).includes(event)) {
        gaps.push({
          what: `Capability "${offer.kind}"`,
          missing: `a real event type — it claims to emit "${event}"`,
          consequence: "A consumer subscribes to an event that will never arrive.",
        });
      }
    }
    if (offer.caveat.trim().length === 0) {
      gaps.push({
        what: `Capability "${offer.kind}"`,
        missing: "a caveat",
        consequence: "Every capability here has a limit worth stating before somebody builds on it, not after.",
      });
    }
  }

  return gaps;
}

/** The charter exclusion behind a refusal, for a host that wants to render it. */
export function exclusionById(id: string): ExcludedResponsibility | null {
  return COSTIQ_DOES_NOT_OWN.find((e) => e.id === id) ?? null;
}
