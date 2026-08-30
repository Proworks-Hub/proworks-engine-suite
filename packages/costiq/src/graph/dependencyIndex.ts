/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — CostIQ
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED.
 *
 * File:     packages/costiq/src/graph/dependencyIndex.ts
 * Module:   cost-iq-engine / graph
 * Purpose:  What depends on what, so a rate change can find exactly the
 *           estimates it affects — and no others.
 */

import { type Decimal, ZERO, add, compare, divide, fromInteger, fromString, multiply } from "../domain/decimal.js";
import { ageInDays, type Provenance } from "../domain/provenance.js";

// ─────────────────────────────────────────────────────────────────────────────
// "STEEL WENT UP. WHAT DOES THAT AFFECT?"
//
// Without an index the answer is "recompute everything and see", which for a
// catalogue of ten thousand estimates is both slow and wrong — slow because
// most of them do not use steel, and wrong because recomputing an APPROVED
// estimate destroys the record of what was actually quoted.
//
// So the index maps in the useful direction: from a basis to the estimates
// that depend on it. Answering "what does this affect" then costs a lookup
// rather than a sweep.
//
// FRESHNESS IS A STATE, NOT A BOOLEAN
//
// "Stale" collapses several genuinely different situations:
//
//   CURRENT      computed from evidence that is still within policy.
//   AGING        the evidence is old but still inside the window.
//   STALE        past the freshness window; the number is probably wrong.
//   SUPERSEDED   an input has actually changed since this was computed.
//   FROZEN       approved. It will never be recomputed, and that is correct.
//
// FROZEN is the important one. An approved estimate whose steel price has
// moved is not stale — it is a historical fact about what was quoted. Marking
// it stale invites somebody to "fix" it, and fixing it destroys the baseline
// every variance is measured against.
// ─────────────────────────────────────────────────────────────────────────────

export type FreshnessState = "CURRENT" | "AGING" | "STALE" | "SUPERSEDED" | "FROZEN";

/** One estimate's dependency footprint. */
export interface EstimateDependencies {
  readonly estimateId: string;
  readonly version: number;
  /** Immutable estimates are never recomputed. */
  readonly frozen: boolean;
  /** Every basis this estimate's components were priced by. */
  readonly basisIds: readonly string[];
  /** Every rate behind those bases. */
  readonly rateIds: readonly string[];
  /** The method and version it was computed with. */
  readonly methodId: string;
  readonly methodVersion: string;
  readonly policyId: string;
  /** When it was computed. */
  readonly computedAt: string;
}

export interface DependencyIndex {
  /** Estimates that used a basis. */
  dependentsOfBasis(basisId: string): readonly EstimateDependencies[];
  /** Estimates that used a rate. */
  dependentsOfRate(rateId: string): readonly EstimateDependencies[];
  /** Estimates computed with a method version. */
  dependentsOfMethod(methodId: string, methodVersion: string): readonly EstimateDependencies[];
  /** The full path from an estimate to the rates underneath it. */
  rootPath(estimateId: string, version: number): readonly string[];
  all(): readonly EstimateDependencies[];
}

export function buildDependencyIndex(estimates: readonly EstimateDependencies[]): DependencyIndex {
  const byBasis = new Map<string, EstimateDependencies[]>();
  const byRate = new Map<string, EstimateDependencies[]>();
  const byMethod = new Map<string, EstimateDependencies[]>();
  const byKey = new Map<string, EstimateDependencies>();

  const push = (map: Map<string, EstimateDependencies[]>, key: string, value: EstimateDependencies) => {
    const list = map.get(key) ?? [];
    list.push(value);
    map.set(key, list);
  };

  for (const e of estimates) {
    byKey.set(`${e.estimateId}@${e.version}`, e);
    for (const b of e.basisIds) push(byBasis, b, e);
    for (const r of e.rateIds) push(byRate, r, e);
    push(byMethod, `${e.methodId}@${e.methodVersion}`, e);
  }

  // Sorted so two calls return the same order — a recalculation queue built
  // from an unstable listing would process in a different order each run and
  // be impossible to reason about.
  const sorted = (list: readonly EstimateDependencies[]) =>
    [...list].sort((a, b) =>
      a.estimateId === b.estimateId ? a.version - b.version : a.estimateId < b.estimateId ? -1 : 1,
    );

  return {
    dependentsOfBasis: (id) => sorted(byBasis.get(id) ?? []),
    dependentsOfRate: (id) => sorted(byRate.get(id) ?? []),
    dependentsOfMethod: (m, v) => sorted(byMethod.get(`${m}@${v}`) ?? []),
    rootPath: (estimateId, version) => {
      const e = byKey.get(`${estimateId}@${version}`);
      if (!e) return [];
      // Estimate → bases → rates. Deduplicated and sorted so the path is the
      // same every time it is asked for.
      return [
        `estimate:${estimateId}@${version}`,
        ...[...new Set(e.basisIds)].sort().map((b) => `basis:${b}`),
        ...[...new Set(e.rateIds)].sort().map((r) => `rate:${r}`),
        `method:${e.methodId}@${e.methodVersion}`,
      ];
    },
    all: () => sorted(estimates),
  };
}

export interface FreshnessInput {
  readonly estimate: EstimateDependencies;
  /** The provenance behind each basis the estimate used. */
  readonly evidence: ReadonlyMap<string, Provenance>;
  /** Bases whose underlying rate has been replaced since. */
  readonly supersededBasisIds: ReadonlySet<string>;
  readonly freshnessWindowDays: number;
  readonly asOf: Date;
}

export interface FreshnessAssessment {
  readonly state: FreshnessState;
  readonly reason: string;
  /** Which bases caused the assessment, so a fix has a target. */
  readonly implicatedBasisIds: readonly string[];
  /** Age of the oldest evidence, in days. */
  readonly oldestEvidenceDays: number | null;
}

/**
 * How current an estimate's evidence is.
 *
 * FROZEN is checked FIRST and short-circuits everything. An approved estimate
 * is a historical fact, and assessing its freshness at all invites somebody to
 * act on the answer.
 */
export function assessFreshness(input: FreshnessInput): FreshnessAssessment {
  if (input.estimate.frozen) {
    return {
      state: "FROZEN",
      reason:
        "This estimate is approved and will not be recomputed. Its evidence being old is not staleness — it is a record of what was quoted, and every variance is measured against it.",
      implicatedBasisIds: [],
      oldestEvidenceDays: null,
    };
  }

  const superseded = input.estimate.basisIds.filter((b) => input.supersededBasisIds.has(b));
  if (superseded.length > 0) {
    // A changed input beats an old one. "Superseded" says something happened;
    // "stale" only says time passed.
    return {
      state: "SUPERSEDED",
      reason: `${superseded.length} of this estimate's bases have been replaced since it was computed. The inputs have actually changed, not merely aged.`,
      implicatedBasisIds: superseded.sort(),
      oldestEvidenceDays: null,
    };
  }

  let oldest = 0;
  const stale: string[] = [];
  for (const basisId of input.estimate.basisIds) {
    const provenance = input.evidence.get(basisId);
    if (provenance === undefined) continue;
    const age = ageInDays(provenance, input.asOf);
    if (age > oldest) oldest = age;
    if (age > input.freshnessWindowDays) stale.push(basisId);
  }

  if (stale.length > 0) {
    return {
      state: "STALE",
      reason: `${stale.length} basis/bases are past the ${input.freshnessWindowDays}-day freshness window; the oldest evidence is ${oldest} days old.`,
      implicatedBasisIds: stale.sort(),
      oldestEvidenceDays: oldest,
    };
  }

  // Aging at three quarters of the window: far enough through that somebody
  // planning a refresh should know, not so far that the number is suspect.
  const agingThreshold = Math.floor((input.freshnessWindowDays * 3) / 4);
  if (oldest >= agingThreshold && input.estimate.basisIds.length > 0) {
    return {
      state: "AGING",
      reason: `The oldest evidence is ${oldest} days old, past three quarters of the ${input.freshnessWindowDays}-day window. Still usable, worth refreshing.`,
      implicatedBasisIds: [],
      oldestEvidenceDays: oldest,
    };
  }

  return {
    state: "CURRENT",
    reason: `All evidence is within the ${input.freshnessWindowDays}-day window.`,
    implicatedBasisIds: [],
    oldestEvidenceDays: input.estimate.basisIds.length === 0 ? null : oldest,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// RECALCULATION POLICY (R3)
//
// An event says a rate changed. What should happen?
//
// NOT "recompute everything that used it". Approved estimates must never be
// recomputed — that is the rule the whole engine rests on. Draft estimates
// probably should be. And the same rate changing forty times in a minute
// should produce ONE recalculation, not forty.
// ─────────────────────────────────────────────────────────────────────────────

export type RecalculationAction =
  /** Recompute now. */
  | "RECALCULATE"
  /** Mark it superseded and let somebody decide. */
  | "FLAG_ONLY"
  /** Do nothing; the estimate is immutable. */
  | "IGNORE_FROZEN"
  /** Do nothing; already queued for this input. */
  | "COALESCED";

export interface RecalculationDecision {
  readonly estimateId: string;
  readonly version: number;
  readonly action: RecalculationAction;
  readonly reason: string;
}

export interface RateChangeEvent {
  /** Idempotency key, so a redelivered event does not queue twice. */
  readonly eventId: string;
  readonly basisId: string;
  readonly observedAt: string;
}

export interface RecalculationPolicy {
  /** Whether draft estimates recompute automatically. */
  readonly recalculateDrafts: boolean;
}

/**
 * What to do about a set of rate changes.
 *
 * COALESCES by estimate: forty changes to rates one estimate uses produce one
 * decision, not forty. Without that, a supplier price-list import becomes a
 * recalculation storm.
 *
 * IDEMPOTENT on `eventId`: a redelivered event contributes nothing new. Event
 * transports redeliver, and an engine that queued work per delivery would do
 * the same work twice for reasons entirely outside its control.
 */
export function planRecalculation(
  events: readonly RateChangeEvent[],
  index: DependencyIndex,
  policy: RecalculationPolicy,
  alreadySeenEventIds: ReadonlySet<string> = new Set(),
): readonly RecalculationDecision[] {
  const newEvents = events.filter((e) => !alreadySeenEventIds.has(e.eventId));

  // Estimate key → the bases that changed under it.
  const affected = new Map<string, { estimate: EstimateDependencies; bases: Set<string> }>();
  for (const event of newEvents) {
    for (const estimate of index.dependentsOfBasis(event.basisId)) {
      const key = `${estimate.estimateId}@${estimate.version}`;
      const entry = affected.get(key) ?? { estimate, bases: new Set<string>() };
      entry.bases.add(event.basisId);
      affected.set(key, entry);
    }
  }

  const decisions: RecalculationDecision[] = [];
  for (const [, { estimate, bases }] of affected) {
    const basisList = [...bases].sort().join(", ");

    if (estimate.frozen) {
      decisions.push({
        estimateId: estimate.estimateId,
        version: estimate.version,
        action: "IGNORE_FROZEN",
        reason: `${basisList} changed, but this estimate is approved. Recomputing it would rewrite what was quoted; a new version supersedes instead.`,
      });
      continue;
    }

    decisions.push({
      estimateId: estimate.estimateId,
      version: estimate.version,
      action: policy.recalculateDrafts ? "RECALCULATE" : "FLAG_ONLY",
      reason: policy.recalculateDrafts
        ? `${basisList} changed and this estimate is a draft, so it is recomputed.`
        : `${basisList} changed. Flagged rather than recomputed, because this policy leaves the decision to a person.`,
    });
  }

  // Sorted so the queue is deterministic — two runs over the same events must
  // produce the same order, or a failure is impossible to reproduce.
  return decisions.sort((a, b) =>
    a.estimateId === b.estimateId ? a.version - b.version : a.estimateId < b.estimateId ? -1 : 1,
  );
}

/**
 * How much of a catalogue an input change touches.
 *
 * The number that decides whether a rate change is routine or an event: one
 * estimate is a Tuesday, four thousand is a conversation before anybody
 * presses anything.
 */
export function changeImpact(
  basisId: string,
  index: DependencyIndex,
  scale: number,
): { readonly affected: number; readonly frozen: number; readonly ofCatalogue: Decimal } {
  const dependents = index.dependentsOfBasis(basisId);
  const total = index.all().length;
  return {
    affected: dependents.length,
    frozen: dependents.filter((d) => d.frozen).length,
    ofCatalogue:
      total === 0
        ? ZERO
        : divide(multiply(fromInteger(dependents.length), fromInteger(100)), fromInteger(total), scale, "HALF_EVEN"),
  };
}

/** Sums a list of decimals. Small helper so callers need not import arithmetic. */
export function sumDecimals(values: readonly string[]): Decimal {
  return values.reduce<Decimal>((acc, v) => add(acc, fromString(v)), ZERO);
}

/** Whether two decimals differ by more than a tolerance. */
export function differsBeyond(a: Decimal, b: Decimal, tolerance: Decimal): boolean {
  const diff = compare(a, b) >= 0 ? add(a, multiply(b, fromInteger(-1))) : add(b, multiply(a, fromInteger(-1)));
  return compare(diff, tolerance) > 0;
}
