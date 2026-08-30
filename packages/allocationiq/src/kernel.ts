// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import {
  rAdd,
  ratioFromDecimal,
  rDiv,
  rIsZero,
  rMul,
  rSub,
  R_ONE,
  R_ZERO,
  solveLinearSystem,
  type MethodRef,
  type Rational,
} from "@proworks-hub/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// AllocationIQ kernel — §16. The whole game is the residual: distributing a
// pool that will not divide evenly, with the leftover NAMED, never absorbed.
//
// - Reciprocal allocation solves (I − Aᵀ)x = b in exact rationals with
//   deterministic pivoting — never inversion, never iteration to a tolerance
//   (an answer that depends on an iteration count is not reproducible).
// - Singularity is detected STRUCTURALLY before the solve: a closed SCC —
//   departments that serve only each other — has no finite answer, and the
//   refusal names every member. Epsilon leaks, damped iteration and dropped
//   edges each silently invent a number.
// - Largest-remainder distribution: floor toward −∞ (one rule for credits
//   and debits), remainder rank with a recorded ref tie-break, quota held,
//   monotonicity surrendered AND disclosed.
// ─────────────────────────────────────────────────────────────────────────────

const method = (methodId: string): MethodRef => ({
  methodId,
  semanticVersion: "1.0.0",
  effectiveFrom: "2026-08-30",
});

export const ALLOCATION_METHODS = {
  direct: method("MTH-DIRECT"),
  stepDown: method("MTH-STEPDOWN"),
  reciprocal: method("MTH-RECIPROCAL"),
  reciprocalSelfExclusion: method("MTH-RECIP-SELF-EXCL"),
  residualLargestRemainder: method("MTH-RESIDUAL-LARGEST-REMAINDER"),
  registry: method("MTH-REGISTRY"),
} as const satisfies Record<string, MethodRef>;

export const ALLOCATION_REFUSAL_KINDS = [
  "NO_DRIVER_BASIS",
  "SELF_SERVICE_RATIO_INVALID",
  "RECIPROCAL_SYSTEM_CLOSED",
  "RECIPROCAL_SYSTEM_DEGENERATE",
  "RECONCILIATION_FAILED",
] as const;
export type AllocationRefusalKind = (typeof ALLOCATION_REFUSAL_KINDS)[number];

export interface AllocationRefusal {
  readonly kind: AllocationRefusalKind;
  readonly methodRef: MethodRef;
  readonly detail: string;
}
export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: AllocationRefusal };
export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const refuse = <T = never>(
  kind: AllocationRefusalKind,
  methodRef: MethodRef,
  detail: string,
): Result<T> => ({ ok: false, refusal: { kind, methodRef, detail } });

// ── Largest remainder: floor-first, id-tie-broken, quota held ───────────────

export interface DistributionRow {
  readonly recipientRef: string;
  readonly allocatedMinor: bigint;
}

export interface Distribution {
  readonly rows: readonly DistributionRow[];
  readonly tieBreaksApplied: readonly string[];
  /** Typed as literal true: the type system cannot represent an unreconciled run. */
  readonly identityHolds: true;
}

export function distributeLargestRemainder(
  poolMinor: bigint,
  drivers: readonly { recipientRef: string; driver: string }[],
): Result<Distribution> {
  const M = ALLOCATION_METHODS.residualLargestRemainder;
  const parsed = drivers.map((d) => ({ ref: d.recipientRef, driver: ratioFromDecimal(d.driver) }));
  let total = R_ZERO;
  for (const row of parsed) total = rAdd(total, row.driver);
  if (rIsZero(total)) {
    // An even split is a CHOSEN method an operator selects deliberately —
    // never a fallback.
    return refuse("NO_DRIVER_BASIS", M, "Every driver is zero; nothing can be allocated proportionately, and an even split is never a fallback.");
  }

  // s_i = P × driver_i / T exact; floor toward −∞ so credits and debits obey
  // ONE rule — no Math.abs, no sign branch, no separate credit path.
  const rows = parsed.map((row) => {
    const share = rDiv(rMul(ratioFromDecimal(poolMinor.toString()), row.driver), total);
    let floor = share.num / share.den;
    if (share.num < 0n && share.num % share.den !== 0n) floor -= 1n;
    const remainder = rSub(share, { num: floor, den: 1n });
    return { ref: row.ref, floor, remainder };
  });
  let residual = poolMinor - rows.reduce((a, r) => a + r.floor, 0n);

  const ranked = [...rows].sort((a, b) => {
    const cross = a.remainder.num * b.remainder.den - b.remainder.num * a.remainder.den;
    if (cross !== 0n) return cross > 0n ? -1 : 1; // remainder DESC
    return a.ref < b.ref ? -1 : 1; // ref ASC — a total order, recorded
  });
  const tieBreaksApplied: string[] = [];
  for (let i = 0; i + 1 < ranked.length; i++) {
    const a = ranked[i];
    const b = ranked[i + 1];
    if (a && b && a.remainder.num * b.remainder.den === b.remainder.num * a.remainder.den) {
      tieBreaksApplied.push(`${a.ref} over ${b.ref} at equal remainder (byte order)`);
    }
  }
  const bonus = new Set<string>();
  for (const row of ranked) {
    if (residual === 0n) break;
    bonus.add(row.ref);
    residual -= 1n;
  }
  const out = rows.map((r) => ({
    recipientRef: r.ref,
    allocatedMinor: r.floor + (bonus.has(r.ref) ? 1n : 0n),
  }));

  const allocatedTotal = out.reduce((a, r) => a + r.allocatedMinor, 0n);
  if (allocatedTotal !== poolMinor) {
    return refuse(
      "RECONCILIATION_FAILED",
      M,
      `poolTotal ${poolMinor} ≠ allocatedTotal ${allocatedTotal}. No tolerance: a tolerance is where a systematic error hides for eleven months.`,
    );
  }
  return ok({ rows: out, tieBreaksApplied, identityHolds: true });
}

// ── Reciprocal allocation ───────────────────────────────────────────────────

export interface ServiceCentre {
  readonly centreRef: string;
  /** Primary cost pool, minor units. */
  readonly primaryMinor: bigint;
  /** Shares of THIS centre's output consumed by others (service or production). */
  readonly consumers: readonly { consumerRef: string; share: string }[];
}

export interface ReciprocalSolution {
  /** Total cost x_i per service centre after reciprocal services, exact rationals. */
  readonly totals: ReadonlyMap<string, Rational>;
  /** Amount received by each terminal (production) recipient, exact rationals. */
  readonly toProduction: ReadonlyMap<string, Rational>;
  readonly circulationRatio: Rational;
  readonly review: boolean;
}

export function solveReciprocal(
  centres: readonly ServiceCentre[],
  /** The model-sanity ceiling, a versioned parameter — not a magic constant. */
  degenerateRatioCeiling = 100,
): Result<ReciprocalSolution> {
  const M = ALLOCATION_METHODS.reciprocal;
  const refs = centres.map((c) => c.centreRef).sort();
  const index = new Map(refs.map((r, i) => [r, i] as const));
  const serviceSet = new Set(refs);

  // Self-service renormalization (MTH-RECIP-SELF-EXCL): a_jj ≥ 1 refuses.
  const normalized = centres.map((c) => {
    const self = c.consumers.find((x) => x.consumerRef === c.centreRef);
    const selfShare = self ? ratioFromDecimal(self.share) : R_ZERO;
    if (selfShare.num >= selfShare.den) {
      return refuse<never>(
        "SELF_SERVICE_RATIO_INVALID",
        M,
        `${c.centreRef} consumes ${self?.share} of its own output; a self-share ≥ 1 is not a share.`,
      );
    }
    const keep = rSub(R_ONE, selfShare);
    return ok({
      centreRef: c.centreRef,
      primaryMinor: c.primaryMinor,
      consumers: c.consumers
        .filter((x) => x.consumerRef !== c.centreRef)
        .map((x) => ({ consumerRef: x.consumerRef, share: rDiv(ratioFromDecimal(x.share), keep) })),
    });
  });
  for (const n of normalized) if (!n.ok) return n;
  const clean = normalized.map((n) => (n.ok ? n.value : (undefined as never)));

  // Structural singularity: Tarjan SCCs over service-centre edges, exact
  // leakage per SCC. L(C) == 0 is DECIDABLE in rationals — no threshold.
  const adjacency = new Map<string, string[]>();
  for (const c of clean) {
    adjacency.set(
      c.centreRef,
      c.consumers.filter((x) => serviceSet.has(x.consumerRef)).map((x) => x.consumerRef),
    );
  }
  const sccs = tarjan(refs, adjacency);
  for (const component of sccs) {
    const members = new Set(component);
    let leakage = R_ZERO;
    for (const memberRef of component) {
      const centre = clean.find((c) => c.centreRef === memberRef);
      if (!centre) continue;
      let insideShare = R_ZERO;
      for (const consumer of centre.consumers) {
        if (members.has(consumer.consumerRef)) insideShare = rAdd(insideShare, consumer.share);
      }
      leakage = rAdd(leakage, rSub(R_ONE, insideShare));
    }
    if (rIsZero(leakage)) {
      return refuse(
        "RECIPROCAL_SYSTEM_CLOSED",
        M,
        `Centres {${component.join(", ")}} consume 100% of their collective output — the costs have nowhere to go, and there is no finite answer. Epsilon leaks and damped iteration each silently invent one. Fixing the model is a human act (SR-5).`,
      );
    }
  }

  // (I − Aᵀ)x = b over exact rationals, deterministic first-nonzero pivot.
  const n = refs.length;
  const aT: Rational[][] = Array.from({ length: n }, () => Array.from({ length: n }, () => R_ZERO));
  for (const c of clean) {
    const j = index.get(c.centreRef) as number;
    for (const consumer of c.consumers) {
      const i = index.get(consumer.consumerRef);
      if (i === undefined) continue; // production recipient
      (aT[j] as Rational[])[i] = consumer.share; // A[j][i]: j's output to i
    }
  }
  const b = clean
    .slice()
    .sort((x, y) => (x.centreRef < y.centreRef ? -1 : 1))
    .map((c) => ratioFromDecimal(c.primaryMinor.toString()));
  const solution = solveLinearSystem(
    aT.map((row, j) => row.map((cell, i) => (j === i ? cell : cell))),
    b,
  );
  // solveLinearSystem solves x(I − A) = b i.e. (I − Aᵀ)xᵀ = bᵀ — the shape we built.
  if (!solution) {
    return refuse("RECIPROCAL_SYSTEM_CLOSED", M, "The system is singular despite positive leakage — refused, not plugged.");
  }

  const totals = new Map<string, Rational>();
  refs.forEach((ref, i) => totals.set(ref, solution[i] as Rational));

  // Model-sanity: circulationRatio = Σx / Σb.
  let sumX = R_ZERO;
  let sumB = R_ZERO;
  for (const [i, ref] of refs.entries()) {
    sumX = rAdd(sumX, solution[i] as Rational);
    sumB = rAdd(sumB, b[i] as Rational);
  }
  const circulationRatio = rIsZero(sumB) ? R_ONE : rDiv(sumX, sumB);
  const ratioOverCeiling =
    circulationRatio.num > circulationRatio.den * BigInt(degenerateRatioCeiling);
  if (ratioOverCeiling) {
    return refuse(
      "RECIPROCAL_SYSTEM_DEGENERATE",
      M,
      `circulationRatio exceeds ${degenerateRatioCeiling}: the arithmetic is exactly right and the model is economically pathological. A model-sanity guard, not a stability guard.`,
    );
  }
  const review = circulationRatio.num > circulationRatio.den * 2n;

  // Distribute x_i to production recipients.
  const toProduction = new Map<string, Rational>();
  for (const c of clean) {
    const xi = totals.get(c.centreRef) as Rational;
    for (const consumer of c.consumers) {
      if (serviceSet.has(consumer.consumerRef)) continue;
      const current = toProduction.get(consumer.consumerRef) ?? R_ZERO;
      toProduction.set(consumer.consumerRef, rAdd(current, rMul(xi, consumer.share)));
    }
  }
  return ok({ totals, toProduction, circulationRatio, review });
}

function tarjan(nodes: readonly string[], adjacency: ReadonlyMap<string, string[]>): string[][] {
  const indexOf = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  let counter = 0;
  const strongConnect = (v: string): void => {
    indexOf.set(v, counter);
    lowlink.set(v, counter);
    counter++;
    stack.push(v);
    onStack.add(v);
    for (const w of adjacency.get(v) ?? []) {
      if (!indexOf.has(w)) {
        strongConnect(w);
        lowlink.set(v, Math.min(lowlink.get(v) as number, lowlink.get(w) as number));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v) as number, indexOf.get(w) as number));
      }
    }
    if (lowlink.get(v) === indexOf.get(v)) {
      const component: string[] = [];
      let w: string | undefined;
      do {
        w = stack.pop();
        if (w !== undefined) {
          onStack.delete(w);
          component.push(w);
        }
      } while (w !== undefined && w !== v);
      components.push(component.sort());
    }
  };
  for (const node of nodes) if (!indexOf.has(node)) strongConnect(node);
  return components;
}

// ── Step-down: order recorded, no return flows ──────────────────────────────

export function stepDownOrderKey(
  centres: readonly { centreRef: string; serviceToServiceShare: string }[],
): readonly string[] {
  // Descending share of output rendered to other service centres, ref
  // tie-break — the order is part of the method version and is RECORDED.
  return [...centres]
    .sort((a, b) => {
      const ra = ratioFromDecimal(a.serviceToServiceShare);
      const rb = ratioFromDecimal(b.serviceToServiceShare);
      const cross = rb.num * ra.den - ra.num * rb.den;
      if (cross !== 0n) return cross > 0n ? 1 : -1;
      return a.centreRef < b.centreRef ? -1 : 1;
    })
    .map((c) => c.centreRef);
}
