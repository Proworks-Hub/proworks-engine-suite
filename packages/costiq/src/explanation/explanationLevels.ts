/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — CostIQ
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED.
 *
 * File:     packages/costiq/src/explanation/explanationLevels.ts
 * Module:   cost-iq-engine / explanation
 * Purpose:  Answering "why does this cost that" at whatever depth the asker
 *           actually needs.
 */

import {
  type Decimal,
  ZERO,
  add,
  compare,
  divide,
  fromInteger,
  fromString,
  multiply,
  subtract,
  toString as decToString,
} from "../domain/decimal.js";
import type { CostComponent, CostComponentKind } from "../domain/costModel.js";
import type { CostAssumption, CostEvidenceQuality } from "../domain/provenance.js";
import { type CostGraph, rollup } from "../core/costGraph.js";

// ─────────────────────────────────────────────────────────────────────────────
// SEVEN DEPTHS, BECAUSE "WHY" MEANS SEVEN DIFFERENT QUESTIONS
//
// A salesperson asking why a quote is £4,200 wants one sentence. A production
// manager wants the three things driving it. A cost engineer wants every
// component. An auditor wants the rate ids, the effective dates and the
// fingerprint. Serving all of them the same answer fails all of them.
//
//   L0  THE ANSWER          £4,200.
//   L1  THE SHAPE           Where the money is, by kind.
//   L2  THE DRIVERS         The few components that dominate.
//   L3  THE LINES           Every component, with quantity and rate.
//   L4  THE EVIDENCE        Which basis priced each, and how good it is.
//   L5  THE ALTERNATIVES    What was rejected, and what would change it.
//   L6  THE AUDIT           Fingerprint, method version, policy, provenance.
//
// L0 TO L4 ARE DETERMINISTIC AND ARE THE CANONICAL ANSWER
//
// The directive is explicit: AI may NARRATE an explanation but may not invent
// or re-derive the maths. So every number in every level here is computed from
// the graph, and the structure is machine-readable. A narrator receives this
// and turns it into prose; it cannot reach past it to the arithmetic.
//
// That matters because a re-derivation is a second implementation. Two
// implementations of the same sum disagree eventually, and when they do, the
// one the customer read is the wrong one.
//
// EVERY LEVEL RECONCILES
//
// The parts at each depth sum to the total at the depth above. An explanation
// whose parts do not add up is not an explanation — it is a set of numbers
// near each other.
// ─────────────────────────────────────────────────────────────────────────────

export type ExplanationLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface KindShare {
  readonly kind: CostComponentKind;
  readonly amount: Decimal;
  /** Percentage of the total, to two places. */
  readonly percentOfTotal: Decimal;
}

export interface DriverLine {
  readonly componentId: string;
  readonly label: string;
  readonly kind: CostComponentKind;
  readonly amount: Decimal;
  readonly percentOfTotal: Decimal;
  /** Rank by contribution, 1 being the largest. */
  readonly rank: number;
}

export interface ComponentDetail {
  readonly componentId: string;
  readonly label: string;
  readonly kind: CostComponentKind;
  readonly amount: Decimal;
  readonly quantity: string | null;
  readonly quantityUnit: string | null;
  /** The implied rate — amount divided by quantity — when both are present. */
  readonly impliedRate: Decimal | null;
  readonly parentId: string | null;
}

export interface EvidenceDetail {
  readonly componentId: string;
  readonly basisId: string | null;
  readonly sourceKind: string | null;
  readonly observedAt: string | null;
  readonly wasFallback: boolean;
  readonly caveats: readonly string[];
}

export interface AuditDetail {
  readonly fingerprint: string;
  readonly methodId: string;
  readonly methodVersion: string;
  readonly policyId: string;
  readonly policyVersion: string;
  readonly computedAt: string;
  readonly rateIds: readonly string[];
}

/** The complete explanation. Levels above the requested depth are absent. */
export interface Explanation {
  readonly level: ExplanationLevel;

  /** L0 */
  readonly total: Decimal;
  readonly currency: string;
  readonly unitCost: Decimal | null;
  readonly quantity: Decimal;

  /** L1 */
  readonly byKind?: readonly KindShare[];
  readonly unpricedShare?: Decimal;

  /** L2 */
  readonly drivers?: readonly DriverLine[];
  /** How much of the total the listed drivers account for. */
  readonly driversCover?: Decimal;

  /** L3 */
  readonly components?: readonly ComponentDetail[];

  /** L4 */
  readonly evidence?: readonly EvidenceDetail[];
  readonly evidenceQuality?: CostEvidenceQuality;
  readonly assumptions?: readonly CostAssumption[];

  /** L5 */
  readonly rejectedAlternatives?: readonly { readonly basisId: string; readonly reason: string }[];
  readonly sensitivities?: readonly { readonly componentId: string; readonly label: string; readonly swing: Decimal }[];

  /** L6 */
  readonly audit?: AuditDetail;

  /**
   * Whether every level's parts sum to the total.
   *
   * Computed, not asserted. An explanation that claims to reconcile and does
   * not is worse than one that admits a gap.
   */
  readonly reconciles: boolean;
  readonly reconciliationGap: Decimal;
}

export interface ExplainInput {
  readonly graph: CostGraph;
  readonly components: readonly CostComponent[];
  readonly currency: string;
  readonly quantity: Decimal;
  readonly level: ExplanationLevel;
  readonly scale: number;
  readonly mode: Parameters<typeof divide>[3];

  /** L2: how many drivers to list. */
  readonly driverCount?: number;
  /** L4 */
  readonly evidence?: readonly EvidenceDetail[];
  readonly evidenceQuality?: CostEvidenceQuality;
  readonly assumptions?: readonly CostAssumption[];
  /** L5 */
  readonly rejectedAlternatives?: readonly { readonly basisId: string; readonly reason: string }[];
  readonly sensitivities?: readonly { readonly componentId: string; readonly label: string; readonly swing: Decimal }[];
  /** L6 */
  readonly audit?: AuditDetail;
}

const magnitude = (d: Decimal): Decimal => (compare(d, ZERO) < 0 ? subtract(ZERO, d) : d);

function percentOf(part: Decimal, whole: Decimal, scale: number, mode: Parameters<typeof divide>[3]): Decimal {
  if (compare(whole, ZERO) === 0) return ZERO;
  return divide(multiply(part, fromInteger(100)), whole, scale, mode);
}

/**
 * Builds an explanation to the requested depth.
 *
 * Deterministic and pure. The same estimate explained twice produces
 * byte-identical output, which is what lets an explanation be fingerprinted
 * alongside the estimate it explains.
 */
export function explain(input: ExplainInput): Explanation {
  const { graph, components, level, scale, mode } = input;
  const rolled = rollup(graph);
  const total = rolled.total;

  const included = components.filter((c) => c.included);
  const componentSum = included.reduce<Decimal>((acc, c) => add(acc, fromString(c.amount)), ZERO);
  const gap = subtract(total, componentSum);

  const explanation: {
    -readonly [K in keyof Explanation]: Explanation[K];
  } = {
    level,
    total,
    currency: input.currency,
    quantity: input.quantity,
    unitCost:
      compare(input.quantity, ZERO) === 0 ? null : divide(total, input.quantity, scale, mode),
    reconciles: compare(gap, ZERO) === 0,
    reconciliationGap: gap,
  };

  // ── L1: where the money is ────────────────────────────────────────────
  if (level >= 1) {
    const byKind = new Map<CostComponentKind, Decimal>();
    for (const c of included) {
      byKind.set(c.kind, add(byKind.get(c.kind) ?? ZERO, fromString(c.amount)));
    }
    explanation.byKind = [...byKind.entries()]
      .map(([kind, amount]) => ({ kind, amount, percentOfTotal: percentOf(amount, total, 2, mode) }))
      // Largest first, ties by kind name so the order is deterministic.
      .sort((a, b) => compare(b.amount, a.amount) || (a.kind < b.kind ? -1 : 1));

    explanation.unpricedShare = percentOf(
      components.filter((c) => c.kind === "UNPRICED").reduce<Decimal>((acc, c) => add(acc, fromString(c.amount)), ZERO),
      total,
      2,
      mode,
    );
  }

  // ── L2: what drives it ────────────────────────────────────────────────
  if (level >= 2) {
    const count = input.driverCount ?? 5;
    const ranked = [...included]
      .sort((a, b) => {
        const byAmount = compare(magnitude(fromString(b.amount)), magnitude(fromString(a.amount)));
        return byAmount !== 0 ? byAmount : a.componentId < b.componentId ? -1 : 1;
      })
      .slice(0, count);

    explanation.drivers = ranked.map((c, index) => ({
      componentId: c.componentId,
      label: c.label,
      kind: c.kind,
      amount: fromString(c.amount),
      percentOfTotal: percentOf(fromString(c.amount), total, 2, mode),
      rank: index + 1,
    }));

    // How much the listed drivers actually account for. Without this a reader
    // sees "the top three are X, Y, Z" and cannot tell whether that is most of
    // the cost or a fifth of it.
    explanation.driversCover = percentOf(
      ranked.reduce<Decimal>((acc, c) => add(acc, fromString(c.amount)), ZERO),
      total,
      2,
      mode,
    );
  }

  // ── L3: every line ────────────────────────────────────────────────────
  if (level >= 3) {
    explanation.components = [...components]
      .sort((a, b) => (a.componentId < b.componentId ? -1 : a.componentId > b.componentId ? 1 : 0))
      .map((c) => {
        const quantity = c.quantity === undefined ? null : fromString(c.quantity);
        return {
          componentId: c.componentId,
          label: c.label,
          kind: c.kind,
          amount: fromString(c.amount),
          quantity: c.quantity ?? null,
          quantityUnit: c.quantityUnit ?? null,
          // Derived rather than stored: a rolled-up estimate may no longer
          // carry the rate, and dividing back out is the honest reconstruction.
          impliedRate:
            quantity === null || compare(quantity, ZERO) === 0
              ? null
              : divide(fromString(c.amount), quantity, scale, mode),
          parentId: c.parentId ?? null,
        };
      });
  }

  // ── L4: the evidence ──────────────────────────────────────────────────
  if (level >= 4) {
    if (input.evidence !== undefined) explanation.evidence = input.evidence;
    if (input.evidenceQuality !== undefined) explanation.evidenceQuality = input.evidenceQuality;
    if (input.assumptions !== undefined) explanation.assumptions = input.assumptions;
  }

  // ── L5: what else was possible ────────────────────────────────────────
  if (level >= 5) {
    if (input.rejectedAlternatives !== undefined) explanation.rejectedAlternatives = input.rejectedAlternatives;
    if (input.sensitivities !== undefined) explanation.sensitivities = input.sensitivities;
  }

  // ── L6: the audit trail ───────────────────────────────────────────────
  if (level >= 6 && input.audit !== undefined) {
    explanation.audit = input.audit;
  }

  return explanation as Explanation;
}

/**
 * A one-line summary for L0, in plain words.
 *
 * The ONLY prose this module generates, and it is a template rather than a
 * narrative. Anything richer belongs to a narrator that receives the
 * structured explanation — and a narrator must not compute, only describe.
 */
export function summarise(explanation: Explanation): string {
  const total = `${decToString(explanation.total)} ${explanation.currency}`;
  if (explanation.level === 0 || explanation.drivers === undefined || explanation.drivers.length === 0) {
    return `${total}.`;
  }
  const top = explanation.drivers[0]!;
  return `${total}, of which the largest single contributor is ${top.label} at ${decToString(top.percentOfTotal)}%.`;
}

/**
 * What a narrator — AI or otherwise — is allowed to receive.
 *
 * Deliberately a projection rather than the whole explanation. It carries the
 * numbers as STRINGS already formatted, so a narrator has nothing to compute
 * with: there is no arithmetic it could perform that would produce a different
 * answer from the one that was computed.
 *
 * That is the structural version of "AI may narrate but not re-derive". A
 * model handed raw quantities and rates will eventually multiply them, and
 * eventually get a different number.
 */
export interface NarrationBrief {
  readonly total: string;
  readonly currency: string;
  readonly unitCost: string | null;
  readonly topDrivers: readonly { readonly label: string; readonly amount: string; readonly share: string }[];
  readonly caveats: readonly string[];
  readonly assumptions: readonly string[];
  /** Present so a narrator can cite it, never so it can recompute anything. */
  readonly fingerprint: string | null;
}

export function narrationBrief(explanation: Explanation): NarrationBrief {
  return {
    total: decToString(explanation.total),
    currency: explanation.currency,
    unitCost: explanation.unitCost === null ? null : decToString(explanation.unitCost),
    topDrivers: (explanation.drivers ?? []).map((d) => ({
      label: d.label,
      amount: decToString(d.amount),
      share: `${decToString(d.percentOfTotal)}%`,
    })),
    caveats: (explanation.evidence ?? []).flatMap((e) => e.caveats),
    assumptions: (explanation.assumptions ?? []).map((a) => a.statement),
    fingerprint: explanation.audit?.fingerprint ?? null,
  };
}
