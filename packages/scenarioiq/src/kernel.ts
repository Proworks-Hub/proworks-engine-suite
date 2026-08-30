// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import {
  rAdd,
  rMul,
  rSub,
  rational,
  type MethodCatalogPort,
  type MethodEnv,
  type MethodRef,
  type Rational,
  type ReplayableMethod,
} from "@proworks-hub/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// ScenarioIQ kernel — §16. The design question the whole engine turns on: how
// does ScenarioIQ re-run another engine's calculation without importing it
// (LOCK-5)? Answer: the ReplayableMethod port in contracts (E-SC-2). The
// engine owns the COMPOSITION and none of the ARITHMETIC. A scenario over a
// method you cannot re-run is not a scenario — it is a guess with a
// presentation layer — so every failure mode of a supplied method is a named
// refusal, never a substitution, an average, or a nearest version.
//
// Purity is CONTAINED, not proven: MethodEnv carries no channel, the replay
// probe checks the cheap common failures, and every run record says
// determinismBasis "probe-2-runs" so no reader mistakes the probe for a proof.
// ─────────────────────────────────────────────────────────────────────────────

const method = (methodId: string): MethodRef => ({
  methodId,
  semanticVersion: "1.0.0",
  effectiveFrom: "2026-08-30",
});

export const SCENARIO_METHODS = {
  overlayApply: method("method.scenario.overlayApply"),
  replayProbe: method("method.scenario.replayProbe"),
  invoke: method("method.scenario.methodPort"),
  oat: method("method.scenario.sensitivity.oat"),
  bisect: method("method.scenario.breakpoint.bisect"),
  compare: method("method.scenario.compare"),
  attribute: method("method.scenario.attribute"),
  stressPath: method("method.scenario.stress.path"),
  reverseStress: method("method.scenario.stress.reverse"),
  sobolGate: method("method.scenario.sensitivity.sobol.independence-gate"),
} as const satisfies Record<string, MethodRef>;

export const SCENARIO_REFUSAL_KINDS = [
  "overlay-path-unread",
  "overlay-conflict",
  "overlay-type-mismatch",
  "method-non-deterministic",
  "method-determinism-attestation-false",
  "method-unavailable",
  "method-version-unavailable",
  "method-threw",
  "method-output-invalid",
  "method-resolution-undeclared",
  "breakpoint-below-method-resolution",
  "breakpoint-tolerance-unselected",
  "comparison-incomparable",
  "stress-path-incomplete",
  "reverse-stress-no-path-found",
  "sobol-independence-unevidenced",
  "sobol-inputs-dependent",
  "attribution-order-ambiguous",
] as const;
export type ScenarioRefusalKind = (typeof SCENARIO_REFUSAL_KINDS)[number];

export interface ScenarioRefusal {
  readonly kind: ScenarioRefusalKind;
  readonly methodRef: MethodRef;
  readonly detail: string;
}
export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: ScenarioRefusal };
export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const refuse = <T = never>(
  kind: ScenarioRefusalKind,
  methodRef: MethodRef,
  detail: string,
): Result<T> => ({ ok: false, refusal: { kind, methodRef, detail } });

/** Every composed result carries this literal: side effects in a supplied
 * method are NOT detectable in general; containment is structural only, and
 * the engine does not print a green check it cannot back. */
export const SIDE_EFFECT_CONTAINMENT = "structural-only" as const;

// ── Canonical serialization for byte-comparison of outputs ──────────────────

/** Stable JSON: sorted keys, bigint → tagged string. For probe comparison and
 * fingerprints, never for presentation. */
export function canonicalSerialize(value: unknown): string {
  const normalize = (v: unknown): unknown => {
    if (typeof v === "bigint") return `bigint:${v.toString()}`;
    if (Array.isArray(v)) return v.map(normalize);
    if (v !== null && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(v as Record<string, unknown>).sort()) {
        out[key] = normalize((v as Record<string, unknown>)[key]);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(normalize(value));
}

// ── §16.4 · overlay application on a sealed frame ───────────────────────────

/** Money for overlay arithmetic: exact minor units with an explicit currency.
 * A shift in a different currency is refused — never converted, never
 * ignored. */
export interface OverlayMoney {
  readonly currencyCode: string;
  readonly minor: bigint;
}

export type OverlayOp =
  | { readonly op: "scale"; readonly path: string; readonly byPercent: Rational }
  | { readonly op: "shift"; readonly path: string; readonly by: OverlayMoney }
  | { readonly op: "maskOut"; readonly path: string; readonly reason: string };

export interface UnknownReason {
  readonly path: string;
  readonly reason: string;
}

export interface ScenarioFrame {
  readonly values: Readonly<Record<string, OverlayMoney>>;
  /** A masked or uncomputable contribution does NOT appear in values with a
   * zero — it appears here. There is no code path that writes a zero for a
   * missing value. */
  readonly unknowns: readonly UnknownReason[];
  readonly sideEffectContainment: typeof SIDE_EFFECT_CONTAINMENT;
}

/**
 * Applies overlay ops to a flat frame of monetary values. Paths validate
 * against the OVERLAYABLE surface (the union of the method chain's input
 * schemas, supplied by the host as a path set): an op against a path no
 * method reads would silently do nothing, which is worse than refusing.
 */
export function overlayApply(
  baseline: Readonly<Record<string, OverlayMoney>>,
  ops: readonly OverlayOp[],
  overlayablePaths: readonly string[],
): Result<ScenarioFrame> {
  const M = SCENARIO_METHODS.overlayApply;
  const allowed = new Set(overlayablePaths);
  const seen = new Set<string>();
  for (const op of ops) {
    if (!allowed.has(op.path)) {
      return refuse("overlay-path-unread", M, `Path ${op.path} is not read by any method in the chain; an overlay there would silently change nothing.`);
    }
    if (seen.has(op.path)) {
      return refuse("overlay-conflict", M, `Two ops target ${op.path}; their composition order would be an unstated assumption.`);
    }
    seen.add(op.path);
  }
  const values: Record<string, OverlayMoney> = { ...baseline };
  const unknowns: UnknownReason[] = [];
  for (const op of ops) {
    const target = values[op.path];
    if (target === undefined) {
      return refuse("overlay-type-mismatch", M, `Path ${op.path} has no value in the sealed baseline.`);
    }
    if (op.op === "scale") {
      // Multiply at native precision; round HALF-EVEN once at the minor-unit
      // boundary of this value (the presentation boundary for a frame cell).
      const scaled = rMul(rational(target.minor, 1n), rAdd(rational(1n, 1n), op.byPercent));
      values[op.path] = { currencyCode: target.currencyCode, minor: roundRationalHalfEven(scaled) };
    } else if (op.op === "shift") {
      if (op.by.currencyCode !== target.currencyCode) {
        return refuse(
          "overlay-type-mismatch",
          M,
          `Shift at ${op.path} is ${op.by.currencyCode}; the target is ${target.currencyCode}. Currencies never mix silently.`,
        );
      }
      values[op.path] = { currencyCode: target.currencyCode, minor: target.minor + op.by.minor };
    } else {
      delete values[op.path];
      unknowns.push({ path: op.path, reason: op.reason });
    }
  }
  return ok({ values, unknowns, sideEffectContainment: SIDE_EFFECT_CONTAINMENT });
}

function roundRationalHalfEven(r: Rational): bigint {
  const floor = ((): bigint => {
    const q = r.num / r.den;
    return r.num % r.den !== 0n && r.num < 0n ? q - 1n : q;
  })();
  const frac = rSub(r, rational(floor, 1n));
  const twice = rSub(rMul(rational(2n, 1n), frac), rational(1n, 1n)); // 2f − 1
  if (twice.num < 0n) return floor;
  if (twice.num > 0n) return floor + 1n;
  return floor % 2n === 0n ? floor : floor + 1n;
}

// ── §16.5 · the replay probe ────────────────────────────────────────────────

export interface ProbeRecord {
  readonly methodRef: MethodRef;
  readonly probe: "passed";
  readonly runs: number;
  /** Two identical runs prove nothing about a method non-deterministic only
   * on the third call or under another input. This field exists so no reader
   * mistakes the probe for a proof (KL-2). */
  readonly determinismBasis: "probe-2-runs";
}

export function replayProbe<I, O>(
  m: ReplayableMethod<I, O>,
  canonicalInput: Readonly<I>,
  env: MethodEnv,
): Result<ProbeRecord> {
  const M = SCENARIO_METHODS.replayProbe;
  const first = canonicalSerialize(m.run(canonicalInput, env));
  const second = canonicalSerialize(m.run(canonicalInput, env));
  if (first !== second) {
    // No result is produced. The engine does not average, does not take the
    // first, does not warn and continue.
    return refuse(
      "method-non-deterministic",
      M,
      `${m.methodRef.methodId}@${m.methodRef.semanticVersion} produced different outputs on identical input.`,
    );
  }
  if (m.determinism.seedRequired) {
    const otherSeed = env.seed === "probe-alternate" ? "probe-alternate-2" : "probe-alternate";
    const third = canonicalSerialize(m.run(canonicalInput, { asOf: env.asOf, seed: otherSeed }));
    if (third === first) {
      // Declared stochastic and is not: an attestation that cannot be wrong
      // is a false validator.
      return refuse(
        "method-determinism-attestation-false",
        M,
        `${m.methodRef.methodId} declares seedRequired but a different seed produced an identical output.`,
      );
    }
  }
  return ok({ methodRef: m.methodRef, probe: "passed", runs: 2, determinismBasis: "probe-2-runs" });
}

// ── §16.6 · invoking a supplied method: every failure is a named refusal ────

export function invokeMethod(
  catalog: MethodCatalogPort,
  ref: MethodRef,
  input: unknown,
  env: MethodEnv,
): Result<{ output: unknown; methodRef: MethodRef; sideEffectContainment: typeof SIDE_EFFECT_CONTAINMENT }> {
  const M = SCENARIO_METHODS.invoke;
  const resolved = catalog.resolve(ref);
  if (resolved === undefined) {
    const sibling = catalog.list().find((r) => r.methodId === ref.methodId);
    if (sibling !== undefined) {
      // Falling back to the nearest version silently changes what the
      // scenario means. Both versions are named instead.
      return refuse(
        "method-version-unavailable",
        M,
        `${ref.methodId}@${ref.semanticVersion} is absent; the catalog holds ${sibling.semanticVersion}. No nearest-version fallback exists.`,
      );
    }
    return refuse("method-unavailable", M, `${ref.methodId}@${ref.semanticVersion} is not in the catalog and no port supplies it.`);
  }
  // The type requires outputResolution; this runtime check catches a JS
  // caller. A defaulted resolution would make breakpoint honesty impossible.
  if ((resolved.outputResolution as unknown) === undefined) {
    return refuse("method-resolution-undeclared", M, `${ref.methodId} declares no outputResolution.`);
  }
  let raw: unknown;
  try {
    raw = resolved.run(input as Readonly<Record<string, unknown>>, env);
  } catch (error) {
    // Message only, never the stack — a stack can carry host paths across a
    // tenant boundary.
    const message = error instanceof Error ? error.message : String(error);
    return refuse("method-threw", M, `${ref.methodId} threw: ${message}`);
  }
  const parsed = resolved.outputSchema.safeParse(raw);
  if (!parsed.success) {
    // Not coerced, not repaired, not accepted with a warning.
    return refuse("method-output-invalid", M, `${ref.methodId} output failed its own schema: ${parsed.error.issues[0]?.message ?? "invalid"}.`);
  }
  return ok({ output: parsed.data, methodRef: resolved.methodRef, sideEffectContainment: SIDE_EFFECT_CONTAINMENT });
}

// ── §16.8 · OAT sensitivity: honest about what it cannot see ────────────────

export interface OatDriver {
  readonly driverRef: string;
  /** Perturbation, REQUIRED, in the driver's own units — no default. */
  readonly delta: Rational;
}

export interface OatResult {
  readonly method: "oat";
  /** Required literal, not a docs footnote: OAT samples one-dimensional
   * crosses — under 1% of a five-input space — and a tornado chart is the
   * most-shown, least-caveated artefact in FP&A. */
  readonly interactionsCaptured: false;
  readonly spaceExplored: "one-dimensional-crosses";
  readonly perturbationBasis: "caller-supplied-absolute";
  readonly driverCount: number;
  readonly evaluations: number;
  readonly tornado: readonly { driverRef: string; effectMinor: bigint; absEffectMinor: bigint }[];
  readonly sideEffectContainment: typeof SIDE_EFFECT_CONTAINMENT;
}

export function oatSensitivity(
  drivers: readonly OatDriver[],
  evaluateAt: (perturbation: ReadonlyMap<string, Rational>) => bigint,
): OatResult {
  const baselineMetric = evaluateAt(new Map());
  let evaluations = 1;
  const tornado = drivers
    .map((d) => {
      const up = evaluateAt(new Map([[d.driverRef, d.delta]]));
      const down = evaluateAt(new Map([[d.driverRef, rational(-d.delta.num, d.delta.den)]]));
      evaluations += 2;
      const upEffect = up - baselineMetric;
      const downEffect = down - baselineMetric;
      const effect = (upEffect < 0n ? -upEffect : upEffect) >= (downEffect < 0n ? -downEffect : downEffect) ? upEffect : downEffect;
      return { driverRef: d.driverRef, effectMinor: effect, absEffectMinor: effect < 0n ? -effect : effect };
    })
    .sort((a, b) =>
      a.absEffectMinor !== b.absEffectMinor ? (b.absEffectMinor > a.absEffectMinor ? 1 : -1) : a.driverRef < b.driverRef ? -1 : 1,
    );
  return {
    method: "oat",
    interactionsCaptured: false,
    spaceExplored: "one-dimensional-crosses",
    perturbationBasis: "caller-supplied-absolute",
    driverCount: drivers.length,
    evaluations,
    tornado,
    sideEffectContainment: SIDE_EFFECT_CONTAINMENT,
  };
}

// ── §16.9 · breakpoint bisection with the resolution guard ──────────────────

const rCmp = (a: Rational, b: Rational): -1 | 0 | 1 => {
  const left = a.num * b.den;
  const right = b.num * a.den;
  return left < right ? -1 : left > right ? 1 : 0;
};

export interface BreakpointResult {
  /** The achieved bracket [lo, hi] in the driver's units — never a bare point. */
  readonly bracketLo: Rational;
  readonly bracketHi: Rational;
  readonly thresholdConfidence: "interpolated" | "bracketed";
  readonly monotonicityResult: "monotone-on-grid" | "non-monotone";
  /** Monotone ON A GRID is not monotone; the grid's size is reported. */
  readonly gridPoints: number;
  readonly signChangesObserved: number;
  readonly otherCrossingsMayExist: boolean;
  readonly evaluations: number;
  readonly sideEffectContainment: typeof SIDE_EFFECT_CONTAINMENT;
}

/**
 * Finds where `evaluate` crosses `thresholdMinor` over a caller-supplied
 * coarse grid. Tolerance is REQUIRED, in the driver's units — never an
 * epsilon on the output. If the bracket's outputs come to differ by less than
 * the method's declared output resolution, the search stops and refuses: a
 * bisection driven past the resolution converges onto numeric noise and
 * reports a confident, meaningless threshold.
 */
export function breakpointBisect(
  evaluate: (driverValue: Rational) => bigint,
  grid: readonly Rational[],
  thresholdMinor: bigint,
  tolerance: Rational | undefined,
  outputResolutionMinor: bigint,
): Result<BreakpointResult> {
  const M = SCENARIO_METHODS.bisect;
  if (tolerance === undefined || tolerance.num <= 0n) {
    return refuse("breakpoint-tolerance-unselected", M, "Tolerance is a required argument in the driver's units.");
  }
  if (grid.length < 3) {
    return refuse("breakpoint-below-method-resolution", M, "The monotonicity probe needs a grid of at least three points.");
  }
  let evaluations = 0;
  const samples = grid.map((g) => {
    evaluations += 1;
    return { at: g, value: evaluate(g) - thresholdMinor };
  });
  let signChanges = 0;
  let firstBracket: { lo: Rational; hi: Rational; loValue: bigint; hiValue: bigint } | null = null;
  for (let i = 1; i < samples.length; i++) {
    const previous = samples[i - 1]!;
    const current = samples[i]!;
    if ((previous.value < 0n && current.value >= 0n) || (previous.value >= 0n && current.value < 0n)) {
      signChanges += 1;
      if (firstBracket === null) {
        firstBracket = { lo: previous.at, hi: current.at, loValue: previous.value, hiValue: current.value };
      }
    }
  }
  if (firstBracket === null) {
    return refuse(
      "breakpoint-below-method-resolution",
      M,
      `No crossing of the threshold on the ${grid.length}-point grid. Not finding a crossing and there being none are different facts.`,
    );
  }
  let { lo, hi, loValue, hiValue } = firstBracket;
  while (rCmp(rSub(hi, lo), tolerance) > 0) {
    const spanLow = loValue < 0n ? -loValue : loValue;
    const spanHigh = hiValue < 0n ? -hiValue : hiValue;
    if (spanLow < outputResolutionMinor && spanHigh < outputResolutionMinor) {
      return refuse(
        "breakpoint-below-method-resolution",
        M,
        `Both bracket outputs are within the method's declared output resolution (${outputResolutionMinor} minor); further bisection would converge onto numeric noise. Achieved bracket: [${lo.num}/${lo.den}, ${hi.num}/${hi.den}].`,
      );
    }
    const mid = rational(lo.num * hi.den + hi.num * lo.den, 2n * lo.den * hi.den);
    const midValue = evaluate(mid) - thresholdMinor;
    evaluations += 1;
    const crossesLower = (loValue < 0n && midValue >= 0n) || (loValue >= 0n && midValue < 0n);
    if (crossesLower) {
      hi = mid;
      hiValue = midValue;
    } else {
      lo = mid;
      loValue = midValue;
    }
  }
  return ok({
    bracketLo: lo,
    bracketHi: hi,
    thresholdConfidence: signChanges > 1 ? "bracketed" : "interpolated",
    monotonicityResult: signChanges > 1 ? "non-monotone" : "monotone-on-grid",
    gridPoints: grid.length,
    signChangesObserved: signChanges,
    // The result never claims to be THE breakeven when other crossings were
    // observed — the honest treatment of the case every goal-seek gets wrong.
    otherCrossingsMayExist: signChanges > 1,
    evaluations,
    sideEffectContainment: SIDE_EFFECT_CONTAINMENT,
  });
}

// ── §16.12 · comparison — refuses to compare the incomparable ───────────────

export interface RunFingerprint {
  readonly runRef: string;
  readonly snapshotFingerprint: string;
  readonly methodVersionVector: string;
  readonly asOf: string;
  readonly horizon: string;
}

export function compareRuns(runs: readonly RunFingerprint[]): Result<{ comparable: true; runRefs: readonly string[] }> {
  const M = SCENARIO_METHODS.compare;
  if (runs.length < 2) {
    return refuse("comparison-incomparable", M, "A comparison needs at least two runs.");
  }
  const first = runs[0]!;
  for (const field of ["snapshotFingerprint", "methodVersionVector", "asOf", "horizon"] as const) {
    const differing = runs.find((r) => r[field] !== first[field]);
    if (differing !== undefined) {
      // The most common way a comparison chart lies is comparing runs
      // computed on different baselines or method versions. Named, refused.
      return refuse(
        "comparison-incomparable",
        M,
        `Runs ${first.runRef} and ${differing.runRef} differ in ${field}: "${first[field]}" vs "${differing[field]}".`,
      );
    }
  }
  return ok({ comparable: true, runRefs: runs.map((r) => r.runRef) });
}

// ── §16.13 · stress paths: fully specified or refused ───────────────────────

export type StressSeverity = "baseline" | "adverse" | "severely-adverse" | "reverse" | "custom";

export interface StressPath {
  readonly pathRef: string;
  /** A LABEL, not a probability. The type has no probability field and there
   * is no way to attach one. */
  readonly severity: StressSeverity;
  /** cells[driverRef][periodRef] — every (driver, period) must be present. */
  readonly cells: Readonly<Record<string, Readonly<Record<string, Rational>>>>;
}

export function validateStressPath(
  path: StressPath,
  driverRefs: readonly string[],
  periodRefs: readonly string[],
): Result<StressPath> {
  const M = SCENARIO_METHODS.stressPath;
  const missing: string[] = [];
  for (const driver of driverRefs) {
    for (const period of periodRefs) {
      if (path.cells[driver]?.[period] === undefined) missing.push(`(${driver}, ${period})`);
    }
  }
  if (missing.length > 0) {
    // No interpolation, no carry-forward, no hold-last-value: a hidden fill
    // rule is an unstated assumption at the centre of a stress result.
    return refuse("stress-path-incomplete", M, `Missing cells: ${missing.join(", ")}.`);
  }
  return ok(path);
}

// ── §16.14 · reverse stress: found paths, never "no path exists" ────────────

export interface ReverseStressResult {
  readonly searchMethod: string;
  readonly searchBudget: number;
  /** Fraction of the admissible space actually sampled, as a rational. */
  readonly coverage: Rational;
  readonly nearestMetric: string;
  /** ALWAYS false, because it never is. */
  readonly exhaustive: false;
  readonly sufficientPaths: readonly string[];
  readonly sideEffectContainment: typeof SIDE_EFFECT_CONTAINMENT;
}

export function reverseStress(
  candidatePathRefs: readonly string[],
  failsUnder: (pathRef: string) => boolean,
  searchBudget: number,
  admissibleSpaceSize: number,
  nearestMetric: string | undefined,
): Result<ReverseStressResult> {
  const M = SCENARIO_METHODS.reverseStress;
  if (nearestMetric === undefined || nearestMetric.trim() === "") {
    return refuse("reverse-stress-no-path-found", M, "nearestMetric is a required caller-supplied definition — there is no canonical 'nearest'.");
  }
  const budget = Math.min(searchBudget, candidatePathRefs.length);
  const found: string[] = [];
  for (let i = 0; i < budget; i++) {
    const ref = candidatePathRefs[i]!;
    if (failsUnder(ref)) found.push(ref);
  }
  const coverage = rational(BigInt(budget), BigInt(Math.max(admissibleSpaceSize, 1)));
  if (found.length === 0) {
    // Never "no path exists": not finding one and there not being one are
    // different facts, and conflating them is the most dangerous possible
    // output of a reverse stress test.
    return refuse(
      "reverse-stress-no-path-found",
      M,
      `Budget of ${budget} evaluations exhausted without a hit at coverage ${coverage.num}/${coverage.den} of the admissible space. This is NOT a claim that no path exists.`,
    );
  }
  return ok({
    searchMethod: "enumerated-candidates",
    searchBudget: budget,
    coverage,
    nearestMetric,
    exhaustive: false,
    sufficientPaths: found,
    sideEffectContainment: SIDE_EFFECT_CONTAINMENT,
  });
}

// ── §16.10 · the Sobol independence gate ────────────────────────────────────

export type CorrelationEvidence =
  | { readonly kind: "unknown" }
  | {
      readonly kind: "measured";
      readonly n: number;
      readonly offDiagonal: readonly { pair: readonly [string, string]; rhoAbsPermille: number }[];
    }
  | { readonly kind: "structural"; readonly sharedDriverRef: string; readonly dependentInputs: readonly string[] }
  | { readonly kind: "declared-independent"; readonly declaredBy: string; readonly justification: string };

export type SobolGateVerdict =
  | { readonly admitted: true; readonly treatment: "as-declared" | "shared-driver-as-single-factor"; readonly caveat: string | null }
  | { readonly admitted: false; readonly refusal: ScenarioRefusal };

/** The variance decomposition assumes independently distributed inputs; under
 * dependence the indices no longer mean what their names say. Morris
 * screening makes no such assumption and is offered instead. */
export function sobolIndependenceGate(
  evidence: CorrelationEvidence,
  rhoAbsPermilleThreshold: number,
): SobolGateVerdict {
  const M = SCENARIO_METHODS.sobolGate;
  if (evidence.kind === "unknown") {
    return {
      admitted: false,
      refusal: {
        kind: "sobol-independence-unevidenced",
        methodRef: M,
        detail: "Sobol requires correlation evidence; 'unknown' is not evidence of independence. Morris screening makes no independence assumption.",
      },
    };
  }
  if (evidence.kind === "measured") {
    const offending = evidence.offDiagonal.filter((o) => o.rhoAbsPermille > rhoAbsPermilleThreshold);
    if (offending.length > 0) {
      return {
        admitted: false,
        refusal: {
          kind: "sobol-inputs-dependent",
          methodRef: M,
          detail: `Dependent pairs above |rho| ${rhoAbsPermilleThreshold}/1000: ${offending.map((o) => o.pair.join("~")).join(", ")}. Under dependence the indices no longer mean what their names say; Morris screening is offered instead.`,
        },
      };
    }
    return { admitted: true, treatment: "as-declared", caveat: null };
  }
  if (evidence.kind === "structural") {
    // The correct treatment, and also cheaper: model the shared driver once
    // as a single factor rather than as two correlated factors.
    return {
      admitted: true,
      treatment: "shared-driver-as-single-factor",
      caveat: `Inputs ${evidence.dependentInputs.join(", ")} share driver ${evidence.sharedDriverRef}; modelled as one factor.`,
    };
  }
  return {
    admitted: true,
    treatment: "as-declared",
    caveat: `Independence DECLARED by ${evidence.declaredBy} (${evidence.justification}) — recorded permanently and surfaced in every L1 caveat on the result.`,
  };
}

// ── §16.12 · attribution: order-dependent and it says so ────────────────────

export type AttributionResult =
  | {
      readonly attributionBasis: "sequential-cumulative";
      /** With interacting ops the decomposition depends on the order;
       * pretending otherwise is the mix/volume attribution error in another
       * hat. */
      readonly orderDependent: true;
      readonly contributions: readonly { opRef: string; deltaMinor: bigint }[];
      readonly sideEffectContainment: typeof SIDE_EFFECT_CONTAINMENT;
    }
  | {
      readonly attributionBasis: "shapley-symmetric";
      readonly orderDependent: false;
      readonly subsetsEvaluated: number;
      readonly contributions: readonly { opRef: string; delta: Rational }[];
      readonly sideEffectContainment: typeof SIDE_EFFECT_CONTAINMENT;
    };

export function attributeDelta(
  opRefs: readonly string[],
  declaredOrder: readonly string[] | undefined,
  evaluateWithOps: (applied: readonly string[]) => bigint,
): Result<AttributionResult> {
  const M = SCENARIO_METHODS.attribute;
  if (declaredOrder === undefined) {
    // No order preference → the Shapley-style symmetric attribution over the
    // 2^n subsets, budgeted to n <= 8; beyond that the engine refuses rather
    // than silently choosing an order.
    if (opRefs.length > 8) {
      return refuse(
        "attribution-order-ambiguous",
        M,
        `${opRefs.length} ops with no declared order: the symmetric attribution over 2^n subsets is budgeted to n <= 8. The engine does not silently choose an order.`,
      );
    }
    const n = opRefs.length;
    const cache = new Map<string, bigint>();
    const valueOf = (subset: readonly string[]): bigint => {
      const key = [...subset].sort().join("|");
      const hit = cache.get(key);
      if (hit !== undefined) return hit;
      const v = evaluateWithOps(subset);
      cache.set(key, v);
      return v;
    };
    const factorial = (k: number): bigint => {
      let f = 1n;
      for (let i = 2; i <= k; i++) f *= BigInt(i);
      return f;
    };
    const nFactorial = factorial(n);
    const contributions = opRefs.map((opRef) => {
      const others = opRefs.filter((o) => o !== opRef);
      let weighted: Rational = rational(0n, 1n);
      for (let mask = 0; mask < 1 << others.length; mask++) {
        const subset = others.filter((_, i) => (mask & (1 << i)) !== 0);
        const marginal = valueOf([...subset, opRef]) - valueOf(subset);
        const weight = rational(factorial(subset.length) * factorial(n - subset.length - 1), nFactorial);
        weighted = rAdd(weighted, rMul(weight, rational(marginal, 1n)));
      }
      return { opRef, delta: weighted };
    });
    return ok({
      attributionBasis: "shapley-symmetric",
      orderDependent: false,
      subsetsEvaluated: cache.size,
      contributions,
      sideEffectContainment: SIDE_EFFECT_CONTAINMENT,
    });
  }
  if ([...declaredOrder].sort().join(" ") !== [...opRefs].sort().join(" ")) {
    return refuse("attribution-order-ambiguous", M, "declaredOrder must cover exactly the op set.");
  }
  let previous = evaluateWithOps([]);
  const applied: string[] = [];
  const contributions = declaredOrder.map((opRef) => {
    applied.push(opRef);
    const next = evaluateWithOps([...applied]);
    const delta = next - previous;
    previous = next;
    return { opRef, deltaMinor: delta };
  });
  return ok({
    attributionBasis: "sequential-cumulative",
    orderDependent: true,
    contributions,
    sideEffectContainment: SIDE_EFFECT_CONTAINMENT,
  });
}
