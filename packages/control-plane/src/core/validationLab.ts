// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

import type { ReadinessDimension } from "./release.js";

// ─────────────────────────────────────────────────────────────────────────────
// The Validation Lab: running a candidate before anybody depends on it.
//
// The single property everything here is arranged around is that a lab run
// CANNOT TOUCH PRODUCTION. Not "should not" — the environment is part of every
// type, the production path requires a permission the sandbox path does not,
// and a run that cannot prove its isolation refuses to start.
//
// The reason for that severity: the whole point of a lab is to try things that
// might be wrong. A test harness that can reach production is a loaded weapon
// pointed at the thing it exists to protect, and it will be fired by somebody
// who thought they were in the sandbox.
//
// The second property is about DATA. Replaying real orders through a candidate
// is the most useful test available and the easiest way to copy customer data
// into a place it does not belong. So fixtures are explicit artefacts with a
// stated provenance, and a fixture that claims to be sanitised has to say who
// sanitised it.
// ─────────────────────────────────────────────────────────────────────────────

export const labEnvironmentSchema = z.enum(["sandbox", "production"]);
export type LabEnvironment = z.infer<typeof labEnvironmentSchema>;

/**
 * Where a fixture's data came from.
 *
 * `production_raw` exists so it can be REFUSED, not so it can be used. Naming
 * the thing you will not accept is what stops somebody inventing an unlabelled
 * category for it later.
 */
export const fixtureProvenanceSchema = z.enum([
  /** Made up entirely. Always safe. */
  "synthetic",
  /** Derived from a real case with identifying data removed by a named person. */
  "sanitised",
  /** A real case retained deliberately, with approval, for regression testing. */
  "approved_retained",
  /** Copied from production untouched. Never runnable. */
  "production_raw",
]);
export type FixtureProvenance = z.infer<typeof fixtureProvenanceSchema>;

export const labFixtureSchema = z
  .object({
    id: z.string().min(1),
    description: z.string().min(1),
    engineId: z.string().min(1),
    provenance: fixtureProvenanceSchema,
    /** Who sanitised or approved it. Required for anything not synthetic. */
    clearedBy: z.string().min(1).optional(),
    clearedAt: z.string().optional(),
    /** The input, whatever shape the engine takes. */
    input: z.unknown(),
    /** What a correct run produced last time, for comparison. */
    baselineOutput: z.unknown().optional(),
    tags: z.array(z.string()).default([]),
  })
  .strict()
  .refine(
    (fixture) => fixture.provenance === "synthetic" || Boolean(fixture.clearedBy),
    {
      // Anything touching a real case must name the person who decided it was
      // safe. "Somebody sanitised it" is not a provenance.
      message: "A fixture derived from real data must name who cleared it.",
      path: ["clearedBy"],
    },
  );
export type LabFixture = z.infer<typeof labFixtureSchema>;

export interface LabRunRequest {
  readonly runId: string;
  readonly environment: LabEnvironment;
  readonly engineId: string;
  /** The build being exercised. */
  readonly candidateVersion: string;
  readonly fixtures: readonly LabFixture[];
  readonly requestedBy: string;
  /** Permissions the caller holds, checked here rather than assumed. */
  readonly permissions: readonly string[];
}

export type LabRefusal =
  | "production_not_permitted"
  | "raw_production_data"
  | "no_fixtures"
  | "environment_unconfirmed";

export interface LabAuthorization {
  readonly allowed: boolean;
  readonly refusal?: LabRefusal;
  readonly reason: string;
  /** Shown as a banner. Loud for production, calm for sandbox. */
  readonly banner: string;
}

/** The permission a production lab run requires. Sandbox does not need it. */
export const PRODUCTION_TEST_PERMISSION = "engine.test.production";
export const SANDBOX_TEST_PERMISSION = "engine.test.sandbox";

/**
 * Decides whether a lab run may proceed.
 *
 * Refuses before anything executes, and states which rule stopped it.
 */
export function authorizeLabRun(request: LabRunRequest): LabAuthorization {
  if (request.fixtures.length === 0) {
    return {
      allowed: false,
      refusal: "no_fixtures",
      reason: "A run with no fixtures proves nothing and would report success.",
      banner: "",
    };
  }

  const raw = request.fixtures.filter((fixture) => fixture.provenance === "production_raw");
  if (raw.length > 0) {
    // Refused in BOTH environments. Raw production data does not become
    // acceptable because the run is a sandbox one — the copy has already
    // happened by the time it reaches here.
    return {
      allowed: false,
      refusal: "raw_production_data",
      reason: `${raw.length} fixture(s) hold raw production data: ${raw.map((f) => f.id).join(", ")}. Sanitise or retain them with approval first.`,
      banner: "",
    };
  }

  if (request.environment === "production") {
    if (!request.permissions.includes(PRODUCTION_TEST_PERMISSION)) {
      return {
        allowed: false,
        refusal: "production_not_permitted",
        reason: `Running against production requires ${PRODUCTION_TEST_PERMISSION}, which this caller does not hold.`,
        banner: "",
      };
    }
    return {
      allowed: true,
      reason: "Permitted, against production.",
      // Deliberately alarming. Somebody who did not mean to be here should
      // notice before they press anything.
      banner: "PRODUCTION — this run touches live systems and real data",
    };
  }

  if (!request.permissions.includes(SANDBOX_TEST_PERMISSION)) {
    return {
      allowed: false,
      refusal: "production_not_permitted",
      reason: `Running in the lab requires ${SANDBOX_TEST_PERMISSION}.`,
      banner: "",
    };
  }

  return {
    allowed: true,
    reason: "Permitted, in the sandbox.",
    banner: "SANDBOX — isolated; nothing here reaches production",
  };
}

// ── Results and regression comparison ────────────────────────────────────────

export interface FixtureResult {
  readonly fixtureId: string;
  readonly ok: boolean;
  readonly output: unknown;
  readonly latencyMs: number;
  readonly error?: string;
}

export interface LabRun {
  readonly runId: string;
  readonly environment: LabEnvironment;
  readonly engineId: string;
  readonly candidateVersion: string;
  readonly ranAt: string;
  readonly requestedBy: string;
  readonly results: readonly FixtureResult[];
  readonly passed: number;
  readonly failed: number;
}

export interface RegressionFinding {
  readonly fixtureId: string;
  readonly kind: "output_changed" | "now_failing" | "now_passing" | "no_baseline";
  readonly detail: string;
  readonly before?: unknown;
  readonly after?: unknown;
}

/**
 * Compares a lab run against each fixture's recorded baseline.
 *
 * Reports `no_baseline` rather than treating an unknown as a pass. A fixture
 * with nothing to compare against has not been validated by this run, and
 * counting it as green is how a suite reports confidence it has not earned.
 */
export function findRegressions(run: LabRun, fixtures: readonly LabFixture[]): RegressionFinding[] {
  const byId = new Map(fixtures.map((fixture) => [fixture.id, fixture]));
  const findings: RegressionFinding[] = [];

  for (const result of run.results) {
    const fixture = byId.get(result.fixtureId);
    if (!fixture) continue;

    if (fixture.baselineOutput === undefined) {
      findings.push({
        fixtureId: result.fixtureId,
        kind: "no_baseline",
        detail: "No recorded baseline, so this run neither confirms nor contradicts anything.",
      });
      continue;
    }

    const baselineOk = fixture.baselineOutput !== null;

    if (!result.ok && baselineOk) {
      findings.push({
        fixtureId: result.fixtureId,
        kind: "now_failing",
        detail: result.error ?? "The candidate failed a fixture that previously passed.",
      });
      continue;
    }

    if (result.ok && !baselineOk) {
      findings.push({ fixtureId: result.fixtureId, kind: "now_passing", detail: "Previously failing, now passes." });
      continue;
    }

    if (result.ok && JSON.stringify(result.output) !== JSON.stringify(fixture.baselineOutput)) {
      // A changed output is a FINDING, not a failure. It may be the
      // improvement the release was for — but it must be looked at, because
      // "the numbers moved and nobody noticed" is how a pricing change ships
      // as a bug fix.
      findings.push({
        fixtureId: result.fixtureId,
        kind: "output_changed",
        detail: "The candidate produced a different result for this fixture.",
        before: fixture.baselineOutput,
        after: result.output,
      });
    }
  }

  return findings;
}

/**
 * Turns a lab run into a release-readiness dimension.
 *
 * A run that found changed outputs is a `warn`, not a `fail`: changes are often
 * the point. A run with unbaselined fixtures is `unknown`, because it did not
 * establish anything about them.
 */
export function readinessFromLab(run: LabRun, findings: readonly RegressionFinding[]): ReadinessDimension {
  const failing = findings.filter((finding) => finding.kind === "now_failing");
  const changed = findings.filter((finding) => finding.kind === "output_changed");
  const unbaselined = findings.filter((finding) => finding.kind === "no_baseline");

  if (run.environment === "production") {
    // A production run cannot certify a candidate: it exercised the version
    // already deployed, not the one being assessed.
    return {
      key: "lab",
      label: "Validation Lab",
      state: "unknown",
      detail: "The recorded run was against production, so it says nothing about the candidate.",
    };
  }

  if (failing.length > 0) {
    return {
      key: "lab",
      label: "Validation Lab",
      state: "fail",
      detail: `${failing.length} fixture(s) that previously passed now fail.`,
    };
  }

  if (unbaselined.length > 0) {
    return {
      key: "lab",
      label: "Validation Lab",
      state: "unknown",
      detail: `${unbaselined.length} fixture(s) have no baseline, so this run did not establish anything about them.`,
    };
  }

  if (changed.length > 0) {
    return {
      key: "lab",
      label: "Validation Lab",
      state: "warn",
      detail: `${changed.length} fixture(s) produced different output. Confirm the change was intended.`,
    };
  }

  return {
    key: "lab",
    label: "Validation Lab",
    state: "pass",
    detail: `${run.passed} fixture(s) matched their baseline.`,
  };
}
