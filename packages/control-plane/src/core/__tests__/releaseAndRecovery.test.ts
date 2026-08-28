// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";

import { deriveEngineHealth, type EngineHeartbeat } from "../health.js";
import {
  assessReadiness,
  assessRollback,
  engineReleaseSchema,
  lastKnownGood,
  migrationSchema,
  verifyArtifact,
  type EngineRelease,
} from "../release.js";
import { decideRecovery, recoveryPolicySchema, verifyRecovery, type RecoveryPolicy } from "../recovery.js";

const NOW = Date.parse("2026-08-27T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const release = (over: Partial<EngineRelease> = {}): EngineRelease =>
  engineReleaseSchema.parse({
    engineId: "forgeiq",
    version: "2.1.4",
    artifact: "oci://registry/forgeiq:2.1.4",
    checksum: "sha256:aaa",
    releasedAt: ago(3_600_000),
    releasedBy: "steven",
    status: "production",
    validated: true,
    ...over,
  });

const policy = (over: Partial<RecoveryPolicy> = {}): RecoveryPolicy =>
  recoveryPolicySchema.parse({
    engineId: "forgeiq",
    enabled: true,
    allowedActions: ["pause_rollout", "rollback", "escalate"],
    ...over,
  });

const failing = (failureRate = 0.5) => {
  const heartbeat: EngineHeartbeat = {
    engineId: "forgeiq",
    version: "2.1.4",
    observedAt: ago(5_000),
    jobsProcessed: 1_000,
    jobsFailed: Math.round(1_000 * failureRate),
    openCircuits: [],
    maintenance: false,
  };
  return deriveEngineHealth("forgeiq", heartbeat, { now: NOW });
};

const healthy = () =>
  deriveEngineHealth(
    "forgeiq",
    {
      engineId: "forgeiq", version: "2.1.4", observedAt: ago(5_000),
      jobsProcessed: 1_000, jobsFailed: 0, openCircuits: [], maintenance: false,
    },
    { now: NOW },
  );

describe("migrations describe what they cost to reverse", () => {
  it("refuses an irreversible migration that does not say what is lost", () => {
    // One that does not say is one nobody thought about, and the thinking is
    // the point.
    expect(() =>
      migrationSchema.parse({ id: "m1", kind: "irreversible", description: "drops a column" }),
    ).toThrow();
  });

  it("accepts one that does", () => {
    expect(
      migrationSchema.parse({
        id: "m1",
        kind: "irreversible",
        description: "drops legacy_price",
        dataLossOnReverse: "Historic legacy_price values cannot be recovered.",
      }).kind,
    ).toBe("irreversible");
  });
});

describe("whether you can actually go back", () => {
  it("clears a rollback across additive changes", () => {
    const current = release({
      version: "2.1.4",
      migrations: [{ id: "m1", kind: "backward_compatible", description: "adds a column" }],
    });
    const target = release({ version: "2.1.3", releasedAt: ago(7_200_000) });

    const assessment = assessRollback(current, target);
    expect(assessment.verdict).toBe("safe");
    expect(assessment.to).toBe("2.1.3");
  });

  it("refuses a rollback across an irreversible migration", () => {
    // The refusal that matters most. Rolling back onto a schema the old binary
    // cannot read turns an incident into a data problem.
    const current = release({
      migrations: [
        {
          id: "m9",
          kind: "irreversible",
          description: "rewrites prices in place",
          dataLossOnReverse: "Pre-migration prices are gone.",
        },
      ],
    });
    const assessment = assessRollback(current, release({ version: "2.1.3" }));

    expect(assessment.verdict).toBe("unsafe");
    expect(assessment.blockingMigrations).toEqual(["2.1.4:m9"]);
    expect(assessment.reasons[0]).toContain("Pre-migration prices are gone");
  });

  it("looks at every release crossed, not only the latest", () => {
    // Rolling back two versions crosses two sets of migrations. An assessment
    // that only read the most recent would clear this.
    const current = release({ version: "2.1.5", migrations: [] });
    const skipped = release({
      version: "2.1.4",
      migrations: [
        { id: "m9", kind: "irreversible", description: "drops a table", dataLossOnReverse: "The table is gone." },
      ],
    });
    const target = release({ version: "2.1.3" });

    expect(assessRollback(current, target, [skipped]).verdict).toBe("unsafe");
  });

  it("refuses when there is nothing to roll back to", () => {
    expect(assessRollback(release(), undefined).verdict).toBe("unsafe");
  });

  it("warns rather than clearing when the target was never validated", () => {
    // Trading a known problem for an unknown one is a decision, not a default.
    const assessment = assessRollback(release(), release({ version: "2.1.3", validated: false }));
    expect(assessment.verdict).toBe("safe_with_warnings");
    expect(assessment.reasons[0]).toContain("never been validated");
  });

  it("skips an unvalidated or withdrawn version when choosing a target", () => {
    const releases = [
      release({ version: "2.1.4", releasedAt: ago(1_000) }),
      release({ version: "2.1.3", releasedAt: ago(2_000), validated: false }),
      release({ version: "2.1.2", releasedAt: ago(3_000), status: "withdrawn" }),
      release({ version: "2.1.1", releasedAt: ago(4_000) }),
    ];
    expect(lastKnownGood(releases, "2.1.4")?.version).toBe("2.1.1");
  });
});

describe("release readiness is not a percentage", () => {
  it("blocks on any failure", () => {
    const assessment = assessReadiness([
      { key: "tests", label: "Tests", state: "pass", detail: "" },
      { key: "contracts", label: "Contract compatibility", state: "fail", detail: "" },
    ]);
    expect(assessment.verdict).toBe("blocked");
    expect(assessment.summary).toContain("Contract compatibility");
  });

  it("holds when something was never assessed", () => {
    // The most common way an unsafe release ships is that nobody ran the check.
    const assessment = assessReadiness([
      { key: "tests", label: "Tests", state: "pass", detail: "" },
      { key: "evals", label: "Model evals", state: "unknown", detail: "" },
    ]);
    expect(assessment.verdict).toBe("hold");
    expect(assessment.summary).toContain("An unrun check is not a pass");
  });

  it("clears with warnings when only warnings remain", () => {
    expect(
      assessReadiness([
        { key: "tests", label: "Tests", state: "pass", detail: "" },
        { key: "perf", label: "Performance", state: "warn", detail: "" },
      ]).verdict,
    ).toBe("ready_with_warnings");
  });

  it("clears nothing when nothing was assessed", () => {
    expect(assessReadiness([]).verdict).toBe("blocked");
  });
});

describe("is the thing that is running the thing that was released", () => {
  it("accepts a matching version and checksum", () => {
    expect(verifyArtifact(release(), { version: "2.1.4", checksum: "sha256:aaa" }).ok).toBe(true);
  });

  it("rejects a checksum that does not match", () => {
    // A version string is what a process says about itself; a checksum is what
    // it is. Disagreement means the release records describe a system that is
    // not running.
    const check = verifyArtifact(release(), { version: "2.1.4", checksum: "sha256:zzz" });
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("does not match");
  });

  it("says so when identity is merely unconfirmed", () => {
    const check = verifyArtifact(release(), { version: "2.1.4" });
    expect(check.ok).toBe(true);
    expect(check.detail).toContain("unconfirmed");
  });
});

describe("automatic recovery mostly refuses", () => {
  const base = {
    current: release(),
    target: release({ version: "2.1.3", releasedAt: ago(7_200_000) }),
    deployedAt: ago(5 * 60_000),
    sampleSize: 500,
    errorRate: 0.5,
    attemptsMade: 0,
    now: NOW,
  };

  it("rolls back when every condition is genuinely met", () => {
    const decision = decideRecovery({ ...base, policy: policy(), health: failing() });
    expect(decision.action).toBe("rollback");
    expect(decision.requiresHuman).toBe(false);
  });

  it("does nothing when the policy is off", () => {
    const decision = decideRecovery({ ...base, policy: policy({ enabled: false }), health: failing() });
    expect(decision.action).toBe("escalate");
  });

  it("refuses when the fault does not correlate to a deployment", () => {
    // An engine degraded for a week is not evidence that this morning's release
    // broke it, and rolling back would remove a fix while leaving the fault.
    const decision = decideRecovery({
      ...base,
      deployedAt: ago(7 * 24 * 3_600_000),
      policy: policy(),
      health: failing(),
    });
    expect(decision.action).toBe("escalate");
    expect(decision.reason).toContain("does not correlate");
  });

  it("refuses on too few observations", () => {
    // Two failures out of three is 66%, and also nothing.
    const decision = decideRecovery({ ...base, sampleSize: 3, policy: policy(), health: failing() });
    expect(decision.action).toBe("escalate");
    expect(decision.reason).toContain("observations");
  });

  it("refuses to roll back across an irreversible migration", () => {
    // Doing this automatically, at whatever hour it fired, is the worst
    // outcome this whole file exists to prevent.
    const decision = decideRecovery({
      ...base,
      current: release({
        migrations: [
          { id: "m9", kind: "irreversible", description: "rewrite", dataLossOnReverse: "gone" },
        ],
      }),
      policy: policy(),
      health: failing(),
    });
    expect(decision.action).toBe("pause_rollout");
    expect(decision.requiresHuman).toBe(true);
    expect(decision.reason).toContain("unsafe");
  });

  it("escalates rather than rolling back onto an unvalidated version", () => {
    const decision = decideRecovery({
      ...base,
      target: release({ version: "2.1.3", validated: false }),
      policy: policy(),
      health: failing(),
    });
    expect(decision.action).toBe("escalate");
    expect(decision.requiresHuman).toBe(true);
  });

  it("stops after the attempt limit instead of looping", () => {
    // Repeating a recovery that did not work is how an incident becomes a loop,
    // and the loop hides the original fault.
    const decision = decideRecovery({ ...base, attemptsMade: 1, policy: policy({ maxAttempts: 1 }), health: failing() });
    expect(decision.action).toBe("escalate");
    expect(decision.reason).toContain("already been attempted");
  });

  it("respects the cooldown", () => {
    const decision = decideRecovery({
      ...base,
      lastAttemptAt: ago(60_000),
      policy: policy({ cooldownMs: 3_600_000 }),
      health: failing(),
    });
    expect(decision.action).toBe("escalate");
    expect(decision.reason).toContain("cooldown");
  });

  it("does not act during planned maintenance", () => {
    const maintenance = deriveEngineHealth(
      "forgeiq",
      {
        engineId: "forgeiq", version: "2.1.4", observedAt: ago(5_000),
        jobsProcessed: 100, jobsFailed: 90, openCircuits: [], maintenance: true,
      },
      { now: NOW },
    );
    const decision = decideRecovery({ ...base, policy: policy(), health: maintenance });
    expect(decision.action).toBe("escalate");
    expect(decision.reason).toContain("maintenance");
  });

  it("does nothing when the engine is fine", () => {
    const decision = decideRecovery({ ...base, policy: policy(), health: healthy() });
    expect(decision.action).toBe("escalate");
    expect(decision.requiresHuman).toBe(false);
  });

  it("pauses rather than rolling back when rollback is not permitted", () => {
    const decision = decideRecovery({
      ...base,
      policy: policy({ allowedActions: ["pause_rollout", "escalate"] }),
      health: failing(),
    });
    expect(decision.action).toBe("pause_rollout");
  });
});

describe("recovery is not trusted until it is proven", () => {
  const completedAt = ago(60_000);

  it("does not resolve on health alone", () => {
    // An engine goes healthy for ten seconds after almost any restart.
    const verification = verifyRecovery({
      health: healthy(),
      actionCompletedAt: completedAt,
      observationWindowMs: 10 * 60_000,
      now: NOW,
    });
    expect(verification.state).toBe("recovering");
    expect(verification.reason).toContain("no smoke check");
  });

  it("monitors once smoke checks pass but the window has not elapsed", () => {
    const verification = verifyRecovery({
      health: healthy(),
      actionCompletedAt: completedAt,
      observationWindowMs: 10 * 60_000,
      smokeChecksPassed: true,
      now: NOW,
    });
    expect(verification.state).toBe("monitoring");
    expect(verification.remainingMs).toBeGreaterThan(0);
  });

  it("resolves only after the window with checks passing", () => {
    const verification = verifyRecovery({
      health: healthy(),
      actionCompletedAt: ago(20 * 60_000),
      observationWindowMs: 10 * 60_000,
      smokeChecksPassed: true,
      now: NOW,
    });
    expect(verification.state).toBe("resolved");
  });

  it("fails when smoke checks fail however healthy it looks", () => {
    const verification = verifyRecovery({
      health: healthy(),
      actionCompletedAt: completedAt,
      observationWindowMs: 1_000,
      smokeChecksPassed: false,
      now: NOW,
    });
    expect(verification.state).toBe("failed");
  });

  it("fails when the engine is still unhealthy after the action", () => {
    const verification = verifyRecovery({
      health: failing(),
      actionCompletedAt: completedAt,
      observationWindowMs: 1_000,
      now: NOW,
    });
    expect(verification.state).toBe("failed");
    expect(verification.reason).toContain("still");
  });

  it("treats silence after the action as still recovering, not failed", () => {
    // A restarting engine reports nothing for a moment. Calling that a failed
    // rollback would escalate an incident that is in the middle of resolving.
    const verification = verifyRecovery({
      health: deriveEngineHealth("forgeiq", undefined, { now: NOW }),
      actionCompletedAt: completedAt,
      observationWindowMs: 1_000,
      now: NOW,
    });
    expect(verification.state).toBe("recovering");
  });
});
