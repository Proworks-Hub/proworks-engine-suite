// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { MethodRef } from "@proworks-hub/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// ProfitabilityIQ kernel — §16. The heart is the UNKNOWN-PROPAGATION ALGEBRA:
// a dimension whose cost basis has a hole reports a NAMED hole, never a zero
// margin. ProfitabilityIQ never recomputes a cost and never substitutes its
// own when CostIQ's is unavailable — cost facts arrive as ARGUMENTS with
// their MethodRef, through the single most tempting import in the taxonomy,
// which is forbidden.
// ─────────────────────────────────────────────────────────────────────────────

const method = (methodId: string): MethodRef => ({
  methodId,
  semanticVersion: "1.0.0",
  effectiveFrom: "2026-08-30",
});

export const PROFITABILITY_METHODS = {
  rollUpFold: method("profit.rollup.fold"),
  marginDefinitions: method("profit.margin.definitions"),
  unknownPropagation: method("profit.unknown.propagation"),
  incompletePolicy: method("profit.incomplete.policy"),
  ranking: method("profit.ranking"),
  concentration: method("profit.concentration.whale-curve"),
  reconciliation: method("profit.reconciliation.entity-total"),
  registry: method("profit.methods.registry"),
} as const satisfies Record<string, MethodRef>;

export const PROFITABILITY_REFUSAL_KINDS = [
  "COST_BASIS_INCOMPLETE",
  "RECONCILIATION_GAP",
  "MARGIN_UNDEFINED",
] as const;
export type ProfitabilityRefusalKind = (typeof PROFITABILITY_REFUSAL_KINDS)[number];

export interface ProfitabilityRefusal {
  readonly kind: ProfitabilityRefusalKind;
  readonly methodRef: MethodRef;
  readonly detail: string;
}
export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: ProfitabilityRefusal };
export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const refuse = <T = never>(
  kind: ProfitabilityRefusalKind,
  methodRef: MethodRef,
  detail: string,
): Result<T> => ({ ok: false, refusal: { kind, methodRef, detail } });

// ── M-7 · the unknown-propagation algebra ───────────────────────────────────

/**
 * A monetary quantity that admits ignorance: `known` carries an exact minor
 * amount; `unknown` carries the REASON. Adding unknown to known yields
 * partial — the known floor plus the named holes — never a silent zero.
 */
export type Amount =
  | { readonly state: "known"; readonly minor: bigint }
  | { readonly state: "unknown"; readonly reason: string };

export interface PartialSum {
  readonly knownFloorMinor: bigint;
  readonly holes: readonly string[];
}

export function sumAmounts(amounts: readonly Amount[]): { state: "known"; minor: bigint } | ({ state: "partial" } & PartialSum) {
  let minor = 0n;
  const holes: string[] = [];
  for (const amount of amounts) {
    if (amount.state === "known") minor += amount.minor;
    else holes.push(amount.reason);
  }
  return holes.length === 0
    ? { state: "known", minor }
    : { state: "partial", knownFloorMinor: minor, holes };
}

// ── M-3 · the four named margin definitions ─────────────────────────────────

export type MarginDefinition =
  | "contribution" // revenue − variable cost
  | "gross" // revenue − cost of goods
  | "operating" // gross − attributable operating cost
  | "fully-loaded"; // operating − allocated shared cost

export interface DimensionFacts {
  readonly memberRef: string;
  readonly revenue: Amount;
  readonly variableCost: Amount;
  readonly costOfGoods: Amount;
  readonly attributableOperating: Amount;
  readonly allocatedShared: Amount;
}

export type MarginResult =
  | { readonly state: "known"; readonly marginMinor: bigint; readonly definition: MarginDefinition }
  | {
      readonly state: "partial";
      readonly knownFloorMinor: bigint;
      readonly holes: readonly string[];
      readonly definition: MarginDefinition;
    };

/** The definition is NAMED on every result — "our margin" computed on different definitions is the disagreement. */
export function margin(facts: DimensionFacts, definition: MarginDefinition): MarginResult {
  const costs: Amount[] = (() => {
    switch (definition) {
      case "contribution":
        return [facts.variableCost];
      case "gross":
        return [facts.costOfGoods];
      case "operating":
        return [facts.costOfGoods, facts.attributableOperating];
      case "fully-loaded":
        return [facts.costOfGoods, facts.attributableOperating, facts.allocatedShared];
    }
  })();
  const negated = costs.map(
    (c): Amount => (c.state === "known" ? { state: "known", minor: -c.minor } : c),
  );
  const total = sumAmounts([facts.revenue, ...negated]);
  return total.state === "known"
    ? { state: "known", marginMinor: total.minor, definition }
    : { state: "partial", knownFloorMinor: total.knownFloorMinor, holes: total.holes, definition };
}

// ── M-8 · IncompletePolicy: the only two honest answers over a hole ─────────

export type IncompletePolicy = "refuse" | "partial-with-coverage";

export function applyIncompletePolicy(
  result: MarginResult,
  policy: IncompletePolicy,
): Result<MarginResult> {
  const M = PROFITABILITY_METHODS.incompletePolicy;
  if (result.state === "known") return ok(result);
  if (policy === "refuse") {
    return refuse(
      "COST_BASIS_INCOMPLETE",
      M,
      `The basis has holes: ${result.holes.join("; ")}. Under the 'refuse' policy an incomplete margin is not a margin.`,
    );
  }
  // partial-with-coverage: the KNOWN floor with the holes named — the second
  // honest answer. A zero over a hole is neither.
  return ok(result);
}

// ── M-9 · ranking with an EXCLUDED set ──────────────────────────────────────

export function rankByMargin(
  results: readonly { memberRef: string; result: MarginResult }[],
): { ranked: readonly { memberRef: string; marginMinor: bigint }[]; excluded: readonly { memberRef: string; holes: readonly string[] }[] } {
  const ranked = results
    .filter((r): r is { memberRef: string; result: Extract<MarginResult, { state: "known" }> } => r.result.state === "known")
    .map((r) => ({ memberRef: r.memberRef, marginMinor: r.result.marginMinor }))
    .sort((a, b) => (b.marginMinor > a.marginMinor ? 1 : b.marginMinor < a.marginMinor ? -1 : a.memberRef < b.memberRef ? -1 : 1));
  // A partial margin does NOT rank — ranking a floor against a total lies in
  // both directions. The excluded set is a first-class output.
  const excluded = results
    .filter((r) => r.result.state === "partial")
    .map((r) => ({
      memberRef: r.memberRef,
      holes: r.result.state === "partial" ? r.result.holes : [],
    }));
  return { ranked, excluded };
}

// ── M-10 · concentration: the whale curve ───────────────────────────────────

export function whaleCurve(
  ranked: readonly { memberRef: string; marginMinor: bigint }[],
): readonly { memberRef: string; cumulativeMinor: bigint; cumulativeBpsOfTotal: number }[] {
  const total = ranked.reduce((a, r) => a + r.marginMinor, 0n);
  let cumulative = 0n;
  return ranked.map((r) => {
    cumulative += r.marginMinor;
    return {
      memberRef: r.memberRef,
      cumulativeMinor: cumulative,
      cumulativeBpsOfTotal: total === 0n ? 0 : Number((cumulative * 10000n) / total),
    };
  });
}

// ── M-14 · reconciliation to a SUPPLIED entity total (IFRS 8.28) ────────────

export function reconcileToEntityTotal(
  results: readonly { memberRef: string; result: MarginResult }[],
  suppliedEntityTotalMinor: bigint,
): Result<{ dimensionalTotalMinor: bigint; unexplainedMinor: bigint }> {
  const M = PROFITABILITY_METHODS.reconciliation;
  const partials = results.filter((r) => r.result.state === "partial");
  if (partials.length > 0) {
    return refuse(
      "COST_BASIS_INCOMPLETE",
      M,
      `A reconciliation over partial members would compare a floor to a total. Partial: ${partials.map((p) => p.memberRef).join(", ")}.`,
    );
  }
  const dimensionalTotal = results.reduce(
    (a, r) => a + (r.result.state === "known" ? r.result.marginMinor : 0n),
    0n,
  );
  const unexplained = suppliedEntityTotalMinor - dimensionalTotal;
  // The gap is NAMED and returned — never spread across members to force a tie.
  return ok({ dimensionalTotalMinor: dimensionalTotal, unexplainedMinor: unexplained });
}
