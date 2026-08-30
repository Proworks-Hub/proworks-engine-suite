// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { MethodRef } from "@proworks-hub/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// BudgetIQ kernel — §16. The consumable base is RELEASED, never authorized
// (F-2): "£96,000 authorized and £40,000 released" is a materially different
// statement from either number alone, so every result reports both. The
// availability figure is NULLABLE IN THE TYPE — a caller cannot obtain a
// number without handling the null, and an unknown channel never reads as
// zero. Encumbrance: a purchase order consumes budget the moment it is
// committed, weeks before an invoice exists; over-liquidation is recorded
// beside the commitment, never absorbed into it. Carry-forward has three
// defensible policies, so the policy is a required argument with a MethodRef.
// ─────────────────────────────────────────────────────────────────────────────

const method = (methodId: string): MethodRef => ({
  methodId,
  semanticVersion: "1.0.0",
  effectiveFrom: "2026-08-30",
});

export const BUDGET_METHODS = {
  availability: method("method.budget.availability"),
  liquidation: method("method.budget.commitment.liquidation"),
  allocation: method("method.budget.allocation.largest-remainder"),
  phasingEven: method("method.budget.phasing.even"),
  phasingSeasonal: method("method.budget.phasing.seasonal"),
  transfer: method("method.budget.transfer"),
  carryForward: method("method.budget.carry-forward"),
  registry: method("method.budget.registry"),
} as const satisfies Record<string, MethodRef>;

export const BUDGET_REFUSAL_KINDS = [
  "CARRY_FORWARD_POLICY_UNSELECTED",
  "PHASING_METHOD_UNSELECTED",
  "SEASONAL_INDEX_NOT_SUPPLIED",
  "NO_DRIVER_BASIS",
  "TRANSFER_CROSSES_PARENT_BOUNDARY",
  "LIQUIDATION_TARGET_INVALID",
] as const;
export type BudgetRefusalKind = (typeof BUDGET_REFUSAL_KINDS)[number];

export interface BudgetRefusal {
  readonly kind: BudgetRefusalKind;
  readonly methodRef: MethodRef;
  readonly detail: string;
}
export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: BudgetRefusal };
export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const refuse = <T = never>(
  kind: BudgetRefusalKind,
  methodRef: MethodRef,
  detail: string,
): Result<T> => ({ ok: false, refusal: { kind, methodRef, detail } });

// ── §16.3 · the availability equation, with unknown ≠ zero structural ───────

/**
 * A consumption or addition channel. `observed` carries a complete amount;
 * `partial` carries a known-incomplete amount (a lower bound on consumption)
 * with the reason for the cut-off; `unavailable` carries only the reason.
 * There is no constructor that turns an unavailable channel into a number.
 */
export type ChannelValue =
  | { readonly state: "observed"; readonly minor: bigint }
  | { readonly state: "partial"; readonly minor: bigint; readonly reason: string }
  | { readonly state: "unavailable"; readonly reason: string };

export type ChannelName =
  | "actualConsumption"
  | "outstandingCommitments"
  | "transfersNet"
  | "carryForwardIn";

export interface AvailabilityInputs {
  readonly scopeRef: string;
  readonly asOf: string;
  readonly authorizedMinor: bigint;
  /** The consumable base — RELEASED, never authorized (F-2). */
  readonly releasedMinor: bigint;
  readonly actualConsumption: ChannelValue;
  readonly outstandingCommitments: ChannelValue;
  readonly transfersNet: ChannelValue;
  readonly carryForwardIn: ChannelValue;
  /** Σ over ANTICIPATED commitments — reported separately, NEVER netted. */
  readonly pendingConsumption: ChannelValue;
}

export interface AvailabilityResult {
  readonly scopeRef: string;
  readonly asOf: string;
  readonly methodRef: MethodRef;
  readonly authorizedMinor: bigint;
  readonly consumableBaseMinor: bigint;
  readonly completeness: "complete" | "partial" | "undeterminable";
  readonly channelStates: Readonly<Record<ChannelName, ChannelValue["state"]>>;
  readonly channelReasons: readonly string[];
  /** Null unless every channel is observed. The type, not documentation,
   * enforces the honesty rule. */
  readonly availableMinor: bigint | null;
  /** Present only when consumption is known-incomplete but additions are
   * observed: observed consumption is a LOWER bound, so the availability
   * derived from it is an UPPER bound, and the field is NAMED one. */
  readonly availableUpperBoundMinor: bigint | null;
  /** Reported separately from every availability figure. A world where
   * "available" silently includes unconfirmed requisitions is a world where
   * two people are told there is room for the same money. */
  readonly pendingConsumption: ChannelValue;
}

export function availability(inputs: AvailabilityInputs): AvailabilityResult {
  const channels: Record<ChannelName, ChannelValue> = {
    actualConsumption: inputs.actualConsumption,
    outstandingCommitments: inputs.outstandingCommitments,
    transfersNet: inputs.transfersNet,
    carryForwardIn: inputs.carryForwardIn,
  };
  const names = Object.keys(channels) as ChannelName[];
  const channelStates = Object.fromEntries(
    names.map((n) => [n, channels[n].state]),
  ) as Record<ChannelName, ChannelValue["state"]>;
  const channelReasons = names
    .map((n) => {
      const c = channels[n];
      return c.state === "observed" ? null : `${n}: ${c.reason}`;
    })
    .filter((r): r is string => r !== null);

  const base = {
    scopeRef: inputs.scopeRef,
    asOf: inputs.asOf,
    methodRef: BUDGET_METHODS.availability,
    authorizedMinor: inputs.authorizedMinor,
    consumableBaseMinor: inputs.releasedMinor,
    channelStates,
    channelReasons,
    pendingConsumption: inputs.pendingConsumption,
  };

  const anyUnavailable = names.some((n) => channels[n].state === "unavailable");
  if (anyUnavailable) {
    // Rule 3: the result is still returned — "here is what I know, and here is
    // precisely what I do not" — but there is NO number a caller can mistake.
    return { ...base, completeness: "undeterminable", availableMinor: null, availableUpperBoundMinor: null };
  }

  const amount = (c: ChannelValue): bigint => (c.state === "unavailable" ? 0n : c.minor);
  const equation =
    inputs.releasedMinor -
    amount(channels.actualConsumption) -
    amount(channels.outstandingCommitments) +
    amount(channels.transfersNet) +
    amount(channels.carryForwardIn);

  const anyPartial = names.some((n) => channels[n].state === "partial");
  if (!anyPartial) {
    return { ...base, completeness: "complete", availableMinor: equation, availableUpperBoundMinor: null };
  }

  // Rule 2, sharpened: a partial CONSUMPTION channel understates consumption,
  // so the equation is an upper bound on availability. A partial ADDITION
  // channel (transfers in, carry-forward in) understates additions, which
  // pushes the other way — the equation is then neither an upper nor a lower
  // bound, and publishing it as one would be the exact failure mode this
  // engine exists to prevent. So the bound is only offered when every partial
  // channel is on the consumption side.
  const partialAdditions = (["transfersNet", "carryForwardIn"] as const).some(
    (n) => channels[n].state === "partial",
  );
  return {
    ...base,
    completeness: "partial",
    availableMinor: null,
    availableUpperBoundMinor: partialAdditions ? null : equation,
  };
}

// ── §16.4 · the encumbrance lifecycle ───────────────────────────────────────

export type CommitmentState =
  | "ANTICIPATED"
  | "COMMITTED"
  | "PARTIALLY_LIQUIDATED"
  | "LIQUIDATED"
  | "RELEASED"
  | "CARRIED_FORWARD"
  | "LAPSED";

export interface Commitment {
  readonly commitmentRef: string;
  readonly effectivePeriod: string;
  readonly state: CommitmentState;
  readonly originalMinor: bigint;
  readonly liquidatedMinor: bigint;
  readonly releasedMinor: bigint;
  /** Invoice amount beyond the PO — recorded BESIDE the commitment, flagged,
   * never absorbed into it and never hidden. Read by the availability
   * equation's actuals channel and by the L5 explainer. */
  readonly unencumberedActualMinor: bigint;
  readonly overLiquidated: boolean;
  /** Lineage for CARRIED_FORWARD successors. */
  readonly carriedFrom?: string;
}

/** Outstanding = original − liquidated − released, for the states that
 * consume an envelope. ANTICIPATED consumes nothing — it is pending. */
export function outstandingMinor(c: Commitment): bigint {
  if (c.state === "COMMITTED" || c.state === "PARTIALLY_LIQUIDATED") {
    return c.originalMinor - c.liquidatedMinor - c.releasedMinor;
  }
  return 0n;
}

/**
 * §16.4 over-liquidation: an invoice larger than the PO is a real occurrence.
 * The liquidation is applied up to `outstanding`; the excess is recorded as a
 * separate unencumbered-actual contribution with a flag. Nothing is blocked,
 * nothing is adjusted, nothing is hidden. Net availability effect of a legal
 * liquidation is ZERO (invariant I-4): outstanding falls by exactly what
 * actuals rise by.
 */
export function applyLiquidation(c: Commitment, invoiceMinor: bigint): Result<Commitment> {
  const M = BUDGET_METHODS.liquidation;
  if (c.state !== "COMMITTED" && c.state !== "PARTIALLY_LIQUIDATED") {
    return refuse(
      "LIQUIDATION_TARGET_INVALID",
      M,
      `Commitment ${c.commitmentRef} is ${c.state}; only COMMITTED or PARTIALLY_LIQUIDATED commitments liquidate.`,
    );
  }
  if (invoiceMinor <= 0n) {
    return refuse("LIQUIDATION_TARGET_INVALID", M, "A liquidation must be a positive amount.");
  }
  const outstanding = outstandingMinor(c);
  const applied = invoiceMinor <= outstanding ? invoiceMinor : outstanding;
  const excess = invoiceMinor - applied;
  const liquidated = c.liquidatedMinor + applied;
  const remaining = c.originalMinor - liquidated - c.releasedMinor;
  return ok({
    ...c,
    state: remaining === 0n ? "LIQUIDATED" : "PARTIALLY_LIQUIDATED",
    liquidatedMinor: liquidated,
    unencumberedActualMinor: c.unencumberedActualMinor + excess,
    overLiquidated: c.overLiquidated || excess > 0n,
  });
}

/** PO cancelled with money outstanding: the outstanding portion is restored
 * to the envelope. The liquidated portion stays liquidated — history. */
export function releaseCommitment(c: Commitment): Result<Commitment> {
  const M = BUDGET_METHODS.liquidation;
  if (c.state !== "COMMITTED" && c.state !== "PARTIALLY_LIQUIDATED") {
    return refuse(
      "LIQUIDATION_TARGET_INVALID",
      M,
      `Commitment ${c.commitmentRef} is ${c.state}; only an open commitment releases.`,
    );
  }
  return ok({ ...c, state: "RELEASED", releasedMinor: c.releasedMinor + outstandingMinor(c) });
}

// ── §16.8 · carry-forward: a derivation subject to approval, never an edit ──

/** Three defensible period-end policies. Picking one silently is how a budget
 * engine becomes wrong for half its users, so the policy is a REQUIRED
 * argument and every run records its MethodRef. */
export type CarryForwardPolicy = "encumbrance-only" | "full-appropriation" | "lapse-all";

export interface CarryForwardRun {
  readonly policy: CarryForwardPolicy;
  readonly methodRef: MethodRef;
  readonly fromPeriod: string;
  readonly toPeriod: string;
  /** Successor commitments in the TARGET period, each with lineage. The
   * closing period's commitments are never mutated — callers receive new
   * closing-state records alongside. */
  readonly successors: readonly Commitment[];
  /** The closing period's commitments in their period-end states. */
  readonly closingStates: readonly Commitment[];
  /** Restored to the closing envelope under lapse-all. */
  readonly lapsedMinor: bigint;
  /** Unreleased budget carried under full-appropriation, supplied by caller. */
  readonly appropriationCarriedMinor: bigint;
}

export function carryForward(
  commitments: readonly Commitment[],
  fromPeriod: string,
  toPeriod: string,
  policy: CarryForwardPolicy | undefined,
  unconsumedAppropriationMinor: bigint,
): Result<CarryForwardRun> {
  const M = BUDGET_METHODS.carryForward;
  if (policy === undefined) {
    return refuse(
      "CARRY_FORWARD_POLICY_UNSELECTED",
      M,
      "Three defensible policies exist: encumbrance-only, full-appropriation, lapse-all. Carrying encumbrances into a new fiscal year is an appropriations decision, and the engine does not make it silently.",
    );
  }
  const open = commitments.filter(
    (c) => c.effectivePeriod === fromPeriod && (c.state === "COMMITTED" || c.state === "PARTIALLY_LIQUIDATED"),
  );
  if (policy === "lapse-all") {
    const closingStates = open.map((c): Commitment => ({ ...c, state: "LAPSED" }));
    const lapsed = open.reduce((a, c) => a + outstandingMinor(c), 0n);
    return ok({
      policy,
      methodRef: M,
      fromPeriod,
      toPeriod,
      successors: [],
      closingStates,
      lapsedMinor: lapsed,
      appropriationCarriedMinor: 0n,
    });
  }
  const successors = open.map(
    (c): Commitment => ({
      commitmentRef: `${c.commitmentRef}#cf-${toPeriod}`,
      effectivePeriod: toPeriod,
      state: "COMMITTED",
      originalMinor: outstandingMinor(c),
      liquidatedMinor: 0n,
      releasedMinor: 0n,
      unencumberedActualMinor: 0n,
      overLiquidated: false,
      carriedFrom: c.commitmentRef,
    }),
  );
  const closingStates = open.map((c): Commitment => ({ ...c, state: "CARRIED_FORWARD" }));
  return ok({
    policy,
    methodRef: M,
    fromPeriod,
    toPeriod,
    successors,
    closingStates,
    lapsedMinor: 0n,
    appropriationCarriedMinor: policy === "full-appropriation" ? unconsumedAppropriationMinor : 0n,
  });
}

// ── §16.5 · allocation with the exact-sum invariant I-3 ─────────────────────

export interface AllocationRow {
  readonly childRef: string;
  readonly driver: string; // decimal string weight, exact
}

/**
 * Largest-remainder distribution: floor every quota toward −∞, hand the
 * residual minor units to the largest fractional remainders, tie-break by
 * childRef byte order — the rule is NAMED, never "whatever rounding
 * produced". Invariant I-3: Σ children == parent EXACTLY.
 */
export function allocateExact(
  parentMinor: bigint,
  rows: readonly AllocationRow[],
): Result<readonly { childRef: string; allocatedMinor: bigint }[]> {
  const M = BUDGET_METHODS.allocation;
  const weights = rows.map((r) => {
    const [whole = "0", fraction = ""] = (r.driver.startsWith("-") ? r.driver.slice(1) : r.driver).split(".");
    const scale = 10n ** BigInt(fraction.length);
    const magnitude = BigInt(whole + fraction);
    return { childRef: r.childRef, num: r.driver.startsWith("-") ? -magnitude : magnitude, den: scale };
  });
  if (weights.some((w) => w.num < 0n)) {
    return refuse("NO_DRIVER_BASIS", M, "A negative allocation driver has no meaning.");
  }
  const commonDen = weights.reduce((a, w) => a * w.den, 1n);
  const scaled = weights.map((w) => ({ childRef: w.childRef, weight: (w.num * commonDen) / w.den }));
  const totalWeight = scaled.reduce((a, w) => a + w.weight, 0n);
  if (totalWeight === 0n) {
    return refuse("NO_DRIVER_BASIS", M, "All drivers are zero. An even split is a chosen method, never a fallback.");
  }
  const floorDiv = (n: bigint, d: bigint): bigint => {
    const q = n / d;
    return n % d !== 0n && (n < 0n) !== (d < 0n) ? q - 1n : q;
  };
  const quotas = scaled.map((w) => {
    const numerator = parentMinor * w.weight;
    const floor = floorDiv(numerator, totalWeight);
    return { childRef: w.childRef, floor, remainder: numerator - floor * totalWeight };
  });
  let residual = parentMinor - quotas.reduce((a, q) => a + q.floor, 0n);
  const order = [...quotas].sort((a, b) =>
    a.remainder !== b.remainder ? (a.remainder > b.remainder ? -1 : 1) : a.childRef < b.childRef ? -1 : 1,
  );
  const bump = new Set<string>();
  for (const q of order) {
    if (residual <= 0n) break;
    bump.add(q.childRef);
    residual -= 1n;
  }
  const out = quotas.map((q) => ({
    childRef: q.childRef,
    allocatedMinor: q.floor + (bump.has(q.childRef) ? 1n : 0n),
  }));
  // I-3 tripwire: with floor-then-largest-remainder the identity holds by
  // construction; the assertion exists so any future edit that breaks the
  // construction fails loudly instead of shipping a plug.
  const sum = out.reduce((a, r) => a + r.allocatedMinor, 0n);
  if (sum !== parentMinor) {
    return refuse("NO_DRIVER_BASIS", M, `Exact-sum invariant I-3 violated: ${sum} != ${parentMinor}.`);
  }
  return ok(out);
}

// ── §16.6 · phasing — even or seasonal with a SUPPLIED index ────────────────

export function phase(
  annualMinor: bigint,
  periodRefs: readonly string[],
  phasingMethod: "even" | "seasonal" | undefined,
  seasonalIndex?: readonly string[],
): Result<readonly { periodRef: string; phasedMinor: bigint }[]> {
  if (phasingMethod === undefined) {
    return refuse(
      "PHASING_METHOD_UNSELECTED",
      BUDGET_METHODS.registry,
      "Even and seasonal phasing are different claims about the year; the caller names one.",
    );
  }
  if (phasingMethod === "seasonal") {
    // BudgetIQ does not derive a seasonal index — deriving one from history is
    // forecasting, and that is ForecastIQ's. Small boundary; erodes first.
    if (seasonalIndex === undefined || seasonalIndex.length !== periodRefs.length) {
      return refuse(
        "SEASONAL_INDEX_NOT_SUPPLIED",
        BUDGET_METHODS.phasingSeasonal,
        "Seasonal phasing takes a supplied index vector, one entry per period. BudgetIQ does not derive one.",
      );
    }
    const allocation = allocateExact(
      annualMinor,
      periodRefs.map((periodRef, i) => ({ childRef: periodRef, driver: seasonalIndex[i]! })),
    );
    if (!allocation.ok) return allocation;
    const byRef = new Map(allocation.value.map((r) => [r.childRef, r.allocatedMinor]));
    // I-5: Σ periods == annual, exactly — inherited from I-3.
    return ok(periodRefs.map((periodRef) => ({ periodRef, phasedMinor: byRef.get(periodRef) ?? 0n })));
  }
  const even = allocateExact(
    annualMinor,
    periodRefs.map((periodRef) => ({ childRef: periodRef, driver: "1" })),
  );
  if (!even.ok) return even;
  const byRef = new Map(even.value.map((r) => [r.childRef, r.allocatedMinor]));
  return ok(periodRefs.map((periodRef) => ({ periodRef, phasedMinor: byRef.get(periodRef) ?? 0n })));
}

// ── §16.7 · transfers: a VersionDerivation, never an edit ───────────────────

export interface TransferRequest {
  readonly fromLineRef: string;
  readonly toLineRef: string;
  readonly amountMinor: bigint;
  readonly fromParentRef: string;
  readonly toParentRef: string;
  /** Whether transfers may cross an approved parent boundary is a policy
   * choice with two defensible answers — a method parameter, not a constant. */
  readonly allowCrossParent: boolean;
}

export interface VersionDerivation {
  readonly kind: "transfer";
  readonly methodRef: MethodRef;
  readonly fromLineRef: string;
  readonly toLineRef: string;
  readonly amountMinor: bigint;
  readonly crossesParentBoundary: boolean;
  /** The derivation produces a NEW draft version; the source version is
   * untouched. Approval is the host's human workflow. */
  readonly producesDraftVersion: true;
}

export function deriveTransfer(request: TransferRequest): Result<VersionDerivation> {
  const crosses = request.fromParentRef !== request.toParentRef;
  if (crosses && !request.allowCrossParent) {
    return refuse(
      "TRANSFER_CROSSES_PARENT_BOUNDARY",
      BUDGET_METHODS.transfer,
      `Transfer ${request.fromLineRef} → ${request.toLineRef} crosses parents ${request.fromParentRef} → ${request.toParentRef} and the policy in force does not permit it.`,
    );
  }
  return ok({
    kind: "transfer",
    methodRef: BUDGET_METHODS.transfer,
    fromLineRef: request.fromLineRef,
    toLineRef: request.toLineRef,
    amountMinor: request.amountMinor,
    crossesParentBoundary: crosses,
    producesDraftVersion: true,
  });
}
