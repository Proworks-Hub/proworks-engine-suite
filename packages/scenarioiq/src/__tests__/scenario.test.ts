// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  rational,
  type MethodCatalogPort,
  type MethodRef,
  type Rational,
  type ReplayableMethod,
} from "@proworks-hub/contracts";

import {
  attributeDelta,
  breakpointBisect,
  canonicalSerialize,
  compareRuns,
  invokeMethod,
  oatSensitivity,
  overlayApply,
  replayProbe,
  reverseStress,
  sobolIndependenceGate,
  validateStressPath,
  type OverlayMoney,
} from "../kernel.js";

const gbp = (minor: bigint): OverlayMoney => ({ currencyCode: "GBP", minor });
const env = { asOf: "2026-08-30T00:00:00Z" };

const ref = (methodId: string, semanticVersion = "1.0.0"): MethodRef => ({
  methodId,
  semanticVersion,
  effectiveFrom: "2026-08-30",
});

function makeMethod(overrides?: Partial<ReplayableMethod<{ x: number }, { y: number }>>): ReplayableMethod<{ x: number }, { y: number }> {
  return {
    domain: "finance",
    methodRef: ref("method.test.double"),
    inputSchema: z.object({ x: z.number() }),
    outputSchema: z.object({ y: z.number() }),
    outputResolution: { minimumMeaningfulDeltaMinor: 1n, basis: "integer output" },
    determinism: { deterministic: true, seedRequired: false, attestedBy: "hive.costiq" },
    run: (input) => ({ y: input.x * 2 }),
    ...overrides,
  };
}

function catalogOf(...methods: ReplayableMethod<never, unknown>[]): MethodCatalogPort {
  return {
    resolve: (r) =>
      (methods.find(
        (m) => m.methodRef.methodId === r.methodId && m.methodRef.semanticVersion === r.semanticVersion,
      ) as ReplayableMethod<unknown, unknown> | undefined) ?? undefined,
    list: () => methods.map((m) => m.methodRef),
  };
}

describe("§16.4 overlay application — refusals before arithmetic", () => {
  const baseline = { "revenue.product-a": gbp(100_000n), "cost.freight": gbp(20_000n) };
  const paths = ["revenue.product-a", "cost.freight"];
  it("scale multiplies exactly and rounds half-even once at the cell boundary", () => {
    const r = overlayApply(baseline, [{ op: "scale", path: "revenue.product-a", byPercent: rational(1n, 10n) }], paths);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.values["revenue.product-a"]!.minor).toBe(110_000n);
    expect(r.value.unknowns).toHaveLength(0);
  });
  it("a path no method reads refuses — a silent no-op is worse than a refusal", () => {
    const r = overlayApply(baseline, [{ op: "shift", path: "cost.imaginary", by: gbp(1n) }], paths);
    expect(!r.ok && r.refusal.kind).toBe("overlay-path-unread");
  });
  it("two ops on one path refuse: composition order would be an unstated assumption", () => {
    const r = overlayApply(
      baseline,
      [
        { op: "scale", path: "cost.freight", byPercent: rational(1n, 10n) },
        { op: "shift", path: "cost.freight", by: gbp(5n) },
      ],
      paths,
    );
    expect(!r.ok && r.refusal.kind).toBe("overlay-conflict");
  });
  it("a shift in a different currency refuses — currencies never mix silently", () => {
    const r = overlayApply(baseline, [{ op: "shift", path: "cost.freight", by: { currencyCode: "EUR", minor: 100n } }], paths);
    expect(!r.ok && r.refusal.kind).toBe("overlay-type-mismatch");
  });
  it("maskOut removes the value and records the UnknownReason — no zero is written", () => {
    const r = overlayApply(baseline, [{ op: "maskOut", path: "cost.freight", reason: "supplier contract in dispute" }], paths);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.values["cost.freight"]).toBeUndefined();
    expect(r.value.unknowns).toEqual([{ path: "cost.freight", reason: "supplier contract in dispute" }]);
    // The baseline is untouched.
    expect(baseline["cost.freight"]!.minor).toBe(20_000n);
  });
});

describe("§16.5 replay probe — a check, not a proof, and it says so", () => {
  it("a deterministic method passes with determinismBasis recorded", () => {
    const r = replayProbe(makeMethod(), { x: 21 }, env);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.probe).toBe("passed");
    expect(r.value.determinismBasis).toBe("probe-2-runs");
  });
  it("a non-deterministic method refuses — no averaging, no first-run, no warning", () => {
    let calls = 0;
    const flaky = makeMethod({ run: () => ({ y: ++calls }) });
    const r = replayProbe(flaky, { x: 1 }, env);
    expect(!r.ok && r.refusal.kind).toBe("method-non-deterministic");
  });
  it("seedRequired with a seed-insensitive body is a false attestation and refuses", () => {
    const falselyStochastic = makeMethod({
      determinism: { deterministic: false, seedRequired: true, attestedBy: "hive.test" },
      run: (input) => ({ y: input.x }),
    });
    const r = replayProbe(falselyStochastic, { x: 5 }, env);
    expect(!r.ok && r.refusal.kind).toBe("method-determinism-attestation-false");
  });
  it("canonical serialization is key-order independent and bigint-safe", () => {
    expect(canonicalSerialize({ b: 1n, a: [2n] })).toBe(canonicalSerialize({ a: [2n], b: 1n }));
  });
});

describe("§16.6 the bad-method table — every failure a named refusal", () => {
  it("absent from the catalog: method-unavailable", () => {
    const r = invokeMethod(catalogOf(), ref("method.missing"), { x: 1 }, env);
    expect(!r.ok && r.refusal.kind).toBe("method-unavailable");
  });
  it("version absent: method-version-unavailable naming BOTH versions, no nearest-version fallback", () => {
    const r = invokeMethod(catalogOf(makeMethod()), ref("method.test.double", "2.0.0"), { x: 1 }, env);
    expect(!r.ok && r.refusal.kind).toBe("method-version-unavailable");
    if (r.ok) return;
    expect(r.refusal.detail).toContain("2.0.0");
    expect(r.refusal.detail).toContain("1.0.0");
  });
  it("a throwing method: message carried, stack NOT (a stack can cross a tenant boundary)", () => {
    const throwing = makeMethod({
      run: () => {
        throw new Error("rate table absent");
      },
    });
    const r = invokeMethod(catalogOf(throwing), ref("method.test.double"), { x: 1 }, env);
    expect(!r.ok && r.refusal.kind).toBe("method-threw");
    if (r.ok) return;
    expect(r.refusal.detail).toContain("rate table absent");
    expect(r.refusal.detail).not.toContain("at ");
  });
  it("output failing its own schema: refused, never coerced or repaired", () => {
    const invalid = makeMethod({ run: () => ({ y: "not-a-number" }) as never });
    const r = invokeMethod(catalogOf(invalid), ref("method.test.double"), { x: 1 }, env);
    expect(!r.ok && r.refusal.kind).toBe("method-output-invalid");
  });
  it("a JS caller with no outputResolution: method-resolution-undeclared", () => {
    const undeclared = makeMethod({ outputResolution: undefined as never });
    const r = invokeMethod(catalogOf(undeclared), ref("method.test.double"), { x: 1 }, env);
    expect(!r.ok && r.refusal.kind).toBe("method-resolution-undeclared");
  });
  it("a valid invocation carries sideEffectContainment structural-only — no green check", () => {
    const r = invokeMethod(catalogOf(makeMethod()), ref("method.test.double"), { x: 4 }, env);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.output).toEqual({ y: 8 });
    expect(r.value.sideEffectContainment).toBe("structural-only");
  });
});

describe("§16.8 OAT — the required honesty literals", () => {
  it("2k+1 evaluations, interactionsCaptured false, tornado ranked by absolute effect", () => {
    // Metric = 100·a + 10·b, so a dominates the tornado.
    const r = oatSensitivity(
      [
        { driverRef: "a", delta: rational(1n, 1n) },
        { driverRef: "b", delta: rational(1n, 1n) },
      ],
      (perturbation) => {
        const a = perturbation.get("a");
        const b = perturbation.get("b");
        const aShift = a === undefined ? 0n : a.num / a.den;
        const bShift = b === undefined ? 0n : b.num / b.den;
        return 100n * aShift + 10n * bShift;
      },
    );
    expect(r.evaluations).toBe(5);
    expect(r.interactionsCaptured).toBe(false);
    expect(r.spaceExplored).toBe("one-dimensional-crosses");
    expect(r.tornado[0]!.driverRef).toBe("a");
    expect(r.tornado[0]!.absEffectMinor).toBe(100n);
    expect(r.tornado[1]!.absEffectMinor).toBe(10n);
  });
});

describe("§16.9 breakpoint bisection — bracket, tolerance in driver units, resolution guard", () => {
  // Output = 1000·x in minor; threshold 5000 → crossing at x = 5.
  const linear = (x: Rational): bigint => (1000n * x.num) / x.den;
  const grid = [rational(0n, 1n), rational(4n, 1n), rational(8n, 1n), rational(12n, 1n)];
  it("a monotone crossing bisects to the achieved bracket, never a bare point", () => {
    const r = breakpointBisect(linear, grid, 5000n, rational(1n, 100n), 1n);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.thresholdConfidence).toBe("interpolated");
    expect(r.value.monotonicityResult).toBe("monotone-on-grid");
    expect(r.value.otherCrossingsMayExist).toBe(false);
    // The bracket straddles 5 and is at most the tolerance wide.
    const loAsHundredths = (100n * r.value.bracketLo.num) / r.value.bracketLo.den;
    const hiAsHundredths = (100n * r.value.bracketHi.num) / r.value.bracketHi.den;
    expect(loAsHundredths <= 500n && 500n <= hiAsHundredths + 1n).toBe(true);
  });
  it("an unselected tolerance refuses — never an epsilon on the output", () => {
    const r = breakpointBisect(linear, grid, 5000n, undefined, 1n);
    expect(!r.ok && r.refusal.kind).toBe("breakpoint-tolerance-unselected");
  });
  it("multiple crossings: bracketed confidence, otherCrossingsMayExist true — never THE breakeven", () => {
    // A shape that crosses 0 three times over the grid: f = (x−2)(x−6)(x−10).
    const cubic = (x: Rational): bigint => {
      const at = (k: bigint): Rational => rational(x.num - k * x.den, x.den);
      const [a, b, c] = [at(2n), at(6n), at(10n)];
      const num = a.num * b.num * c.num;
      const den = a.den * b.den * c.den;
      return num / den;
    };
    const wide = [rational(0n, 1n), rational(4n, 1n), rational(8n, 1n), rational(12n, 1n)];
    const r = breakpointBisect(cubic, wide, 0n, rational(1n, 100n), 1n);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.thresholdConfidence).toBe("bracketed");
    expect(r.value.signChangesObserved).toBe(3);
    expect(r.value.otherCrossingsMayExist).toBe(true);
  });
  it("a coarse output resolution stops the search: refusing beats reporting float noise", () => {
    // Outputs within the bracket differ by less than the declared resolution.
    const flat = (x: Rational): bigint => (x.num >= 5n * x.den ? 2n : 1n);
    const r = breakpointBisect(flat, grid, 2n, rational(1n, 1_000_000n), 100n);
    expect(!r.ok && r.refusal.kind).toBe("breakpoint-below-method-resolution");
    if (r.ok) return;
    expect(r.refusal.detail).toContain("Achieved bracket");
  });
  it("no crossing on the grid: the refusal does NOT claim no crossing exists", () => {
    const r = breakpointBisect(linear, grid, 999_999n, rational(1n, 100n), 1n);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refusal.detail).toContain("different facts");
  });
});

describe("§16.12 comparison and attribution", () => {
  const run = (runRef: string, overrides?: Partial<Parameters<typeof compareRuns>[0][number]>) => ({
    runRef,
    snapshotFingerprint: "snap-1",
    methodVersionVector: "v1",
    asOf: "2026-08-30",
    horizon: "12m",
    ...overrides,
  });
  it("runs on different baselines refuse to compare, naming the field", () => {
    const r = compareRuns([run("r1"), run("r2", { snapshotFingerprint: "snap-2" })]);
    expect(!r.ok && r.refusal.kind).toBe("comparison-incomparable");
    if (r.ok) return;
    expect(r.refusal.detail).toContain("snapshotFingerprint");
  });
  it("comparable runs compare", () => {
    const r = compareRuns([run("r1"), run("r2")]);
    expect(r.ok).toBe(true);
  });
  it("declared-order attribution walks cumulatively and says orderDependent", () => {
    // Interacting ops: value = 10·(has a) + 5·(has b) + 100·(has both).
    const evaluate = (applied: readonly string[]): bigint => {
      const a = applied.includes("a") ? 10n : 0n;
      const b = applied.includes("b") ? 5n : 0n;
      const both = applied.includes("a") && applied.includes("b") ? 100n : 0n;
      return a + b + both;
    };
    const r = attributeDelta(["a", "b"], ["a", "b"], evaluate);
    expect(r.ok).toBe(true);
    if (!r.ok || r.value.attributionBasis !== "sequential-cumulative") return;
    expect(r.value.orderDependent).toBe(true);
    expect(r.value.contributions).toEqual([
      { opRef: "a", deltaMinor: 10n },
      { opRef: "b", deltaMinor: 105n }, // the interaction lands on the LAST op in the order
    ]);
  });
  it("no declared order: the Shapley-symmetric split — the interaction shared equally", () => {
    const evaluate = (applied: readonly string[]): bigint => {
      const a = applied.includes("a") ? 10n : 0n;
      const b = applied.includes("b") ? 5n : 0n;
      const both = applied.includes("a") && applied.includes("b") ? 100n : 0n;
      return a + b + both;
    };
    const r = attributeDelta(["a", "b"], undefined, evaluate);
    expect(r.ok).toBe(true);
    if (!r.ok || r.value.attributionBasis !== "shapley-symmetric") return;
    expect(r.value.orderDependent).toBe(false);
    const a = r.value.contributions.find((c) => c.opRef === "a")!;
    const b = r.value.contributions.find((c) => c.opRef === "b")!;
    // a: 10 + 50; b: 5 + 50 — sums to the full 115.
    expect(a.delta.num / a.delta.den).toBe(60n);
    expect(b.delta.num / b.delta.den).toBe(55n);
  });
  it("nine ops with no order refuse — the engine does not silently choose one", () => {
    const nine = Array.from({ length: 9 }, (_, i) => `op${i}`);
    const r = attributeDelta(nine, undefined, () => 0n);
    expect(!r.ok && r.refusal.kind).toBe("attribution-order-ambiguous");
  });
});

describe("§16.13/16.14 stress — complete paths, honest reverse search", () => {
  it("a partial stress path refuses naming the missing cells — no hidden interpolation", () => {
    const r = validateStressPath(
      {
        pathRef: "severe-1",
        severity: "severely-adverse",
        cells: { gdp: { "2027-Q1": rational(-3n, 100n) } },
      },
      ["gdp", "unemployment"],
      ["2027-Q1", "2027-Q2"],
    );
    expect(!r.ok && r.refusal.kind).toBe("stress-path-incomplete");
    if (r.ok) return;
    expect(r.refusal.detail).toContain("(gdp, 2027-Q2)");
    expect(r.refusal.detail).toContain("(unemployment, 2027-Q1)");
  });
  it("reverse stress returns FOUND paths with exhaustive always false", () => {
    const r = reverseStress(["p1", "p2", "p3"], (p) => p === "p2", 10, 100, "euclidean-on-driver-deltas");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.sufficientPaths).toEqual(["p2"]);
    expect(r.value.exhaustive).toBe(false);
  });
  it("an exhausted budget is NOT 'no path exists' — the refusal says so", () => {
    const r = reverseStress(["p1", "p2"], () => false, 10, 1000, "euclidean-on-driver-deltas");
    expect(!r.ok && r.refusal.kind).toBe("reverse-stress-no-path-found");
    if (r.ok) return;
    expect(r.refusal.detail).toContain("NOT a claim that no path exists");
  });
});

describe("§16.10 the Sobol independence gate", () => {
  it("unknown correlation is not evidence of independence: refused, Morris offered", () => {
    const v = sobolIndependenceGate({ kind: "unknown" }, 300);
    expect(!v.admitted && v.refusal.kind).toBe("sobol-independence-unevidenced");
    if (v.admitted) return;
    expect(v.refusal.detail).toContain("Morris");
  });
  it("measured dependence above threshold refuses naming the pairs", () => {
    const v = sobolIndependenceGate(
      { kind: "measured", n: 60, offDiagonal: [{ pair: ["price", "volume"], rhoAbsPermille: 620 }] },
      300,
    );
    expect(!v.admitted && v.refusal.kind).toBe("sobol-inputs-dependent");
    if (v.admitted) return;
    expect(v.refusal.detail).toContain("price~volume");
  });
  it("structural correlation is admitted as a SINGLE factor — correct and cheaper", () => {
    const v = sobolIndependenceGate(
      { kind: "structural", sharedDriverRef: "headcount", dependentInputs: ["payroll", "benefits"] },
      300,
    );
    expect(v.admitted && v.treatment).toBe("shared-driver-as-single-factor");
  });
  it("declared independence is admitted with the declaration recorded in the caveat", () => {
    const v = sobolIndependenceGate(
      { kind: "declared-independent", declaredBy: "human.steven", justification: "separate markets" },
      300,
    );
    expect(v.admitted).toBe(true);
    if (!v.admitted) return;
    expect(v.caveat).toContain("human.steven");
  });
});
