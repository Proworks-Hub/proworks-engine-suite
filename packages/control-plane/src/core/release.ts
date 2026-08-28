// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// Releases, and whether you can go back.
//
// The dangerous belief this file exists to prevent is that rollback always
// works. It does not. A release that added a column is reversible; a release
// that dropped one, backfilled it destructively, or rewrote rows in place is
// not, and rolling back onto it puts an older binary in front of a schema it
// cannot read.
//
// So `assessRollback` can return "unsafe", and says why. A console that offers
// a rollback button in that state is worse than one with no button, because the
// button will be pressed during an incident by somebody who has no time to
// check.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How a schema change relates to the code on either side of it.
 *
 * The distinction that matters is not "big or small" but "can the previous
 * version still run against it".
 */
export const migrationKindSchema = z.enum([
  /** Old code still works against the new schema. Additive columns, new tables. */
  "backward_compatible",
  /** New code still works against the old schema. Required for staged rollout. */
  "forward_compatible",
  /** Undoable without data loss. */
  "reversible",
  /** Cannot be undone: data was dropped, coerced, or rewritten in place. */
  "irreversible",
]);
export type MigrationKind = z.infer<typeof migrationKindSchema>;

export const migrationSchema = z
  .object({
    id: z.string().min(1),
    kind: migrationKindSchema,
    description: z.string().min(1),
    /** What is lost if this is reversed. Required for irreversible ones. */
    dataLossOnReverse: z.string().optional(),
  })
  .strict()
  .refine(
    (migration) => migration.kind !== "irreversible" || Boolean(migration.dataLossOnReverse),
    {
      // An irreversible migration with no stated consequence is one nobody
      // thought about, and the thinking is the point.
      message: "An irreversible migration must state what is lost when reversed.",
      path: ["dataLossOnReverse"],
    },
  );
export type Migration = z.infer<typeof migrationSchema>;

export const releaseStatusSchema = z.enum([
  "candidate",
  "validating",
  "internal",
  "canary",
  "production",
  "superseded",
  "withdrawn",
]);
export type ReleaseStatus = z.infer<typeof releaseStatusSchema>;

export const engineReleaseSchema = z
  .object({
    engineId: z.string().min(1),
    version: z.string().min(1),
    /** Where the built artifact lives. A reference, never the bytes. */
    artifact: z.string().min(1),
    /** Content hash, so what is deployed can be checked against what was built. */
    checksum: z.string().min(1),
    releasedAt: z.string().min(1),
    releasedBy: z.string().min(1),
    status: releaseStatusSchema,
    previousVersion: z.string().optional(),
    migrations: z.array(migrationSchema).default([]),
    /** Commit or tag, for "what changed immediately before this failure". */
    sourceRef: z.string().optional(),
    notes: z.string().optional(),
    /** Whether this build passed its own validation. */
    validated: z.boolean().default(false),
  })
  .strict();
export type EngineRelease = z.infer<typeof engineReleaseSchema>;

// ── Rollback safety ──────────────────────────────────────────────────────────

export type RollbackVerdict = "safe" | "safe_with_warnings" | "unsafe";

export interface RollbackAssessment {
  readonly verdict: RollbackVerdict;
  readonly from: string;
  readonly to?: string;
  /** Each reason, in the words an operator needs during an incident. */
  readonly reasons: readonly string[];
  /** Migrations that block or complicate the reversal. */
  readonly blockingMigrations: readonly string[];
}

/**
 * Decides whether rolling back is safe, and refuses to guess.
 *
 * Assesses every release BETWEEN the current version and the target, not just
 * the current one. Rolling back two versions crosses two sets of migrations,
 * and an assessment that only looked at the most recent would clear a rollback
 * across an irreversible change one release further down.
 */
export function assessRollback(
  current: EngineRelease,
  target: EngineRelease | undefined,
  between: readonly EngineRelease[] = [],
): RollbackAssessment {
  const reasons: string[] = [];
  const blocking: string[] = [];

  if (!target) {
    return {
      verdict: "unsafe",
      from: current.version,
      reasons: ["No previous known-good version is recorded, so there is nothing to roll back to."],
      blockingMigrations: [],
    };
  }

  if (!target.validated) {
    reasons.push(
      `${target.version} has never been validated, so rolling back trades a known problem for an unknown one.`,
    );
  }

  // Everything from the target forward, current included.
  const crossed = [current, ...between].filter(
    (release) => release.version !== target.version,
  );

  for (const release of crossed) {
    for (const migration of release.migrations) {
      if (migration.kind === "irreversible") {
        blocking.push(`${release.version}:${migration.id}`);
        reasons.push(
          `${release.version} ran an irreversible migration (${migration.id}): ${migration.dataLossOnReverse}`,
        );
        continue;
      }
      if (migration.kind !== "backward_compatible" && migration.kind !== "reversible") {
        blocking.push(`${release.version}:${migration.id}`);
        reasons.push(
          `${release.version} ran a migration (${migration.id}) that ${target.version} may not be able to read.`,
        );
      }
    }
  }

  if (blocking.length > 0) {
    return { verdict: "unsafe", from: current.version, to: target.version, reasons, blockingMigrations: blocking };
  }

  if (reasons.length > 0) {
    return { verdict: "safe_with_warnings", from: current.version, to: target.version, reasons, blockingMigrations: [] };
  }

  return {
    verdict: "safe",
    from: current.version,
    to: target.version,
    reasons: [`${target.version} is validated and no crossed migration prevents reversal.`],
    blockingMigrations: [],
  };
}

/**
 * The most recent version that is safe to fall back to.
 *
 * Not simply `previousVersion`: the version immediately before may itself be
 * unvalidated or withdrawn, and during an incident is the worst moment to
 * discover that.
 */
export function lastKnownGood(
  releases: readonly EngineRelease[],
  currentVersion: string,
): EngineRelease | undefined {
  return releases
    .filter(
      (release) =>
        release.version !== currentVersion &&
        release.validated &&
        release.status !== "withdrawn",
    )
    .sort((a, b) => Date.parse(b.releasedAt) - Date.parse(a.releasedAt))[0];
}

// ── Release readiness ────────────────────────────────────────────────────────

export type ReadinessVerdict = "ready" | "ready_with_warnings" | "hold" | "blocked";

export interface ReadinessDimension {
  readonly key: string;
  readonly label: string;
  readonly state: "pass" | "warn" | "fail" | "unknown";
  readonly detail: string;
}

export interface ReadinessAssessment {
  readonly verdict: ReadinessVerdict;
  readonly dimensions: readonly ReadinessDimension[];
  /** Why, in one line, for the headline. */
  readonly summary: string;
}

/**
 * Assesses whether a release should go out.
 *
 * Deliberately NOT a percentage. A single number invites "87% is probably
 * fine", and the whole question is which 13% — a failing contract test and a
 * slightly slower p95 are not interchangeable, however similar their weights.
 *
 * `unknown` is not `pass`. A dimension nobody measured holds the verdict at
 * `hold` rather than clearing it, because the most common way an unsafe
 * release ships is that nobody ran the check.
 */
export function assessReadiness(dimensions: readonly ReadinessDimension[]): ReadinessAssessment {
  if (dimensions.length === 0) {
    return {
      verdict: "blocked",
      dimensions,
      summary: "Nothing was assessed, so nothing can be cleared.",
    };
  }

  const failed = dimensions.filter((dimension) => dimension.state === "fail");
  const unknown = dimensions.filter((dimension) => dimension.state === "unknown");
  const warned = dimensions.filter((dimension) => dimension.state === "warn");

  if (failed.length > 0) {
    return {
      verdict: "blocked",
      dimensions,
      summary: `${failed.length} check${failed.length === 1 ? "" : "s"} failed: ${failed.map((d) => d.label).join(", ")}.`,
    };
  }

  if (unknown.length > 0) {
    return {
      verdict: "hold",
      dimensions,
      summary: `Not assessed: ${unknown.map((d) => d.label).join(", ")}. An unrun check is not a pass.`,
    };
  }

  if (warned.length > 0) {
    return {
      verdict: "ready_with_warnings",
      dimensions,
      summary: `Clear, with warnings on ${warned.map((d) => d.label).join(", ")}.`,
    };
  }

  return { verdict: "ready", dimensions, summary: "Every assessed dimension passed." };
}

/**
 * Whether the deployed artifact is the one that was released.
 *
 * A version string is what a process says about itself; a checksum is what it
 * actually is. When they disagree, something was deployed out of band, and that
 * is worth interrupting somebody over — it means the release records describe a
 * system that is not running.
 */
export function verifyArtifact(
  release: EngineRelease,
  observed: { version: string; checksum?: string },
): { ok: boolean; detail: string } {
  if (observed.version !== release.version) {
    return {
      ok: false,
      detail: `Expected ${release.version} but the engine reports ${observed.version}.`,
    };
  }
  if (observed.checksum === undefined) {
    return { ok: true, detail: `Version matches. No checksum was reported, so identity is unconfirmed.` };
  }
  if (observed.checksum !== release.checksum) {
    return {
      ok: false,
      detail: `${release.version} is running an artifact that does not match the released build.`,
    };
  }
  return { ok: true, detail: "Version and checksum both match the release record." };
}
