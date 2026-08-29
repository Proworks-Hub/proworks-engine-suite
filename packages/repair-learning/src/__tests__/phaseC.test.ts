// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";

import {
  FORBIDDEN_ACTIONS,
  NEVER_LEASABLE,
  V1_DEFAULT_ACTIONS,
  agentLeaseSchema,
  changeWithinScope,
  checkForbiddenShortcuts,
  createCandidateWorkspace,
  createInMemoryWorkspaceProvider,
  leasePermits,
  repairCandidateSchema,
  scenarioForbiddenActionsToReview,
  v1RepairLease,
  type AgentLease,
  type ProposedAction,
  type RepairCandidate,
} from "../index.js";

// ─────────────────────────────────────────────────────────────────────────────
// Phase C — Repair.
//
// Directive doctrine: "Passing a test by weakening the Hive is failure, not
// success."
// ─────────────────────────────────────────────────────────────────────────────

const action = (over: Partial<ProposedAction> = {}): ProposedAction => ({
  verb: "add",
  target: "code",
  subject: "workorderiq/src/intake.ts",
  rationale: "Add an idempotency key check before persisting.",
  ...over,
});

const candidate = (over: Record<string, unknown> = {}): RepairCandidate =>
  repairCandidateSchema.parse({
    repairCandidateId: "rc_1",
    diagnosisId: "dx_1",
    repairClass: "IDEMPOTENCY",
    description: "Make the work-order consumer idempotent on the delivery key.",
    targetComponents: ["hive.specialized.workorderiq"],
    affectedResources: ["workorderiq/src/intake.ts"],
    proposedActions: [action()],
    expectedEffect: "A duplicate delivery no longer creates a second work order.",
    risk: "LOW",
    blastRadius: "WORK_ORDER",
    reversibility: "REVERSIBLE",
    requiredAuthority: ["foundry.repair.simulation"],
    requiredValidators: ["unit", "scenario-replay"],
    rollbackPlan: "Revert the intake change; no data migration was performed.",
    forbiddenShortcutsChecked: true,
    authoredBy: "bot_repair_1",
    authoredAt: "2026-08-29T10:00:00.000Z",
    ...over,
  });

const lease = (over: Record<string, unknown> = {}): AgentLease =>
  agentLeaseSchema.parse({
    agentId: "agent_1",
    agentType: "REPAIR_BOT",
    mission: "Restore idempotent work-order intake.",
    targetComponents: ["hive.specialized.workorderiq"],
    targetRepository: "proworks-engine-suite",
    targetEnvironment: "SIMULATION",
    allowedActions: V1_DEFAULT_ACTIONS,
    prohibitedActions: [],
    toolScope: ["editor", "test-runner"],
    dataScope: ["ksix-synthetic"],
    startedAt: "2026-08-29T10:00:00.000Z",
    expiresAt: "2026-08-29T14:00:00.000Z",
    maxChangeScope: { maxFiles: 3, maxComponents: 1 },
    deploymentAuthority: false,
    governanceReference: "gd-4471",
    sentinelSession: "sen-991",
    requiredValidators: ["unit", "scenario-replay"],
    terminationConditions: ["lease expiry", "Sentinel finding"],
    ...over,
  });

describe("a candidate must declare what it does", () => {
  it("refuses a candidate with no actions", () => {
    // "It does not say it does anything bad" is not the same as "it does
    // nothing bad". An uncheckable candidate is rejected, not trusted.
    expect(repairCandidateSchema.safeParse({ ...candidate(), proposedActions: [] }).success).toBe(false);
  });

  it("requires a rollback plan unless reversal is not applicable", () => {
    // A repair with no way back is a decision, not a repair.
    const { rollbackPlan: _dropped, ...without } = candidate();
    expect(repairCandidateSchema.safeParse(without).success).toBe(false);
    expect(
      repairCandidateSchema.safeParse({ ...without, reversibility: "NOT_APPLICABLE" }).success,
    ).toBe(true);
  });

  it("requires two validators on a severe repair", () => {
    // One validator on a severe change is a single point of judgement.
    expect(
      repairCandidateSchema.safeParse({ ...candidate(), risk: "SEVERE", requiredValidators: ["unit"] })
        .success,
    ).toBe(false);
  });
});

describe("forbidden repair shortcuts are structurally rejected", () => {
  it("catches disabling Governance", () => {
    const check = checkForbiddenShortcuts(
      candidate({
        proposedActions: [action({ verb: "disable", target: "governance", subject: "governance hook" })],
      }),
    );
    expect(check.clean).toBe(false);
    expect(check.violations[0]!.reason).toContain("removing the thing that decides");
    expect(check.violations[0]!.detectedBy).toBe("structural");
  });

  it("catches every named shortcut from the directive", () => {
    // §13's list, one by one. A test per rule would let one rot unnoticed.
    const shortcuts: { verb: ProposedAction["verb"]; target: ProposedAction["target"] }[] = [
      { verb: "disable", target: "governance" },
      { verb: "disable", target: "sentinel" },
      { verb: "remove", target: "tenant_check" },
      { verb: "widen", target: "authority_grant" },
      { verb: "remove", target: "test" },
      { verb: "remove", target: "invariant" },
      { verb: "modify", target: "source_of_truth_owner" },
      { verb: "remove", target: "error_handling" },
      { verb: "disable", target: "audit" },
      { verb: "disable", target: "idempotency_check" },
    ];

    for (const shortcut of shortcuts) {
      const check = checkForbiddenShortcuts(
        candidate({ proposedActions: [action({ ...shortcut, subject: "x" })] }),
      );
      expect(check.clean, `${shortcut.verb} ${shortcut.target}`).toBe(false);
    }
  });

  it("forbids touching Governance policy with any verb at all", () => {
    // A repair that edits policy has authorized itself.
    for (const verb of ["add", "modify", "remove", "narrow"] as const) {
      const check = checkForbiddenShortcuts(
        candidate({ proposedActions: [action({ verb, target: "governance_policy", subject: "p" })] }),
      );
      expect(check.clean, verb).toBe(false);
    }
  });

  it("ignores the candidate's own self-declaration", () => {
    // A self-declaration from the author of the change is the one piece of
    // evidence that cannot be trusted here.
    const check = checkForbiddenShortcuts(
      candidate({
        forbiddenShortcutsChecked: true,
        proposedActions: [action({ verb: "remove", target: "test", subject: "the failing one" })],
      }),
    );
    expect(check.clean).toBe(false);
  });

  it("is not defeated by an innocent description", () => {
    // The reason the check is structural. A keyword scan over prose is
    // defeated by rewording, and worse, produces false confidence.
    const check = checkForbiddenShortcuts(
      candidate({
        description: "Improve reliability of the intake path.",
        expectedEffect: "Cleaner separation of concerns.",
        proposedActions: [
          action({
            verb: "remove",
            target: "tenant_check",
            subject: "intake guard",
            rationale: "Simplify the code path.",
          }),
        ],
      }),
    );
    expect(check.clean).toBe(false);
  });

  it("passes an honest repair", () => {
    const check = checkForbiddenShortcuts(candidate());
    expect(check.clean).toBe(true);
    expect(check.violations).toEqual([]);
  });

  it("reports suspicious prose as advisory only", () => {
    // Advisory, never a gate. Treating a keyword scan as the gate produces
    // exactly the false confidence §13 exists to prevent.
    const check = checkForbiddenShortcuts(
      candidate({ description: "Temporarily bypass the check to make the test pass." }),
    );
    expect(check.clean).toBe(true);
    expect(check.textualConcerns.length).toBeGreaterThan(0);
    expect(check.textualConcerns.join()).toContain("temporary");
  });

  it("hands the scenario's own prose prohibitions to a reviewer", () => {
    // Scenario-specific prohibitions are prose and cannot be structurally
    // matched. Returned for a human to rule on rather than pretend-decided.
    const items = scenarioForbiddenActionsToReview(candidate(), [
      "let Prime persist domain work-order state",
      "use host price as authoritative cost",
    ]);
    expect(items).toHaveLength(2);
    expect(items[0]).toContain("Reviewer must confirm");
  });

  it("keeps the forbidden list non-empty and reasoned", () => {
    expect(FORBIDDEN_ACTIONS.length).toBeGreaterThan(10);
    expect(FORBIDDEN_ACTIONS.every((f) => f.reason.length > 20)).toBe(true);
  });
});

describe("a lease is scoped, expiring and non-self-widening", () => {
  const now = new Date("2026-08-29T11:00:00.000Z");

  it("requires an expiry after its start", () => {
    expect(agentLeaseSchema.safeParse({ ...lease(), expiresAt: "2026-08-29T09:00:00.000Z" }).success).toBe(
      false,
    );
  });

  it("can never grant authority-granting or policy edits", () => {
    // Foundry Charter §18. An agent that can widen its own authority has
    // become the thing that decides what it may do.
    for (const forbidden of NEVER_LEASABLE) {
      expect(
        agentLeaseSchema.safeParse({ ...lease(), allowedActions: [...V1_DEFAULT_ACTIONS, forbidden] })
          .success,
        forbidden,
      ).toBe(false);
    }
  });

  it("refuses an expired lease with a useful sentence", () => {
    // "Denied" tells an operator nothing.
    const verdict = leasePermits(lease(), {
      action: "run_tests",
      environment: "SIMULATION",
      now: new Date("2026-08-29T15:00:00.000Z"),
    });
    expect(verdict.permitted).toBe(false);
    if (!verdict.permitted) expect(verdict.reason).toContain("Expired authority is absent authority");
  });

  it("lets a prohibition outrank an allowance", () => {
    // A prohibition that an allowance can override is not a prohibition.
    const conflicted = lease({
      allowedActions: [...V1_DEFAULT_ACTIONS, "apply_in_sandbox"],
      prohibitedActions: ["apply_in_sandbox"],
    });
    const verdict = leasePermits(conflicted, {
      action: "apply_in_sandbox",
      environment: "SIMULATION",
      now,
    });
    expect(verdict.permitted).toBe(false);
    if (!verdict.permitted) expect(verdict.reason).toContain("outranks any allowance");
  });

  it("refuses an action in an environment the lease does not target", () => {
    expect(
      leasePermits(lease(), { action: "run_tests", environment: "VALIDATION", now }).permitted,
    ).toBe(false);
  });

  it("refuses production without explicit deployment authority", () => {
    const prod = lease({ targetEnvironment: "PRODUCTION" });
    const verdict = leasePermits(prod, { action: "inspect", environment: "PRODUCTION", now });
    expect(verdict.permitted).toBe(false);
    if (!verdict.permitted) {
      expect(verdict.reason).toContain("Development authority does not automatically authorize deployment");
    }
  });

  it("refuses a lease claiming production deployment while denying deployment authority", () => {
    // One of the two fields is wrong, and guessing which would be the wrong
    // way to resolve it.
    expect(
      agentLeaseSchema.safeParse({
        ...lease(),
        allowedActions: [...V1_DEFAULT_ACTIONS, "deploy_to_production"],
        deploymentAuthority: false,
      }).success,
    ).toBe(false);
  });

  it("requires two validators for production deployment authority", () => {
    expect(
      agentLeaseSchema.safeParse({
        ...lease(),
        targetEnvironment: "PRODUCTION",
        deploymentAuthority: true,
        requiredValidators: ["unit"],
      }).success,
    ).toBe(false);
  });

  it("permits the V1 default actions in simulation", () => {
    for (const allowed of V1_DEFAULT_ACTIONS) {
      expect(
        leasePermits(lease(), { action: allowed, environment: "SIMULATION", now }).permitted,
        allowed,
      ).toBe(true);
    }
  });

  it("builds a V1 lease that refuses production by construction", () => {
    const l = v1RepairLease({
      agentId: "agent_v1",
      mission: "Restore idempotency",
      targetComponents: ["hive.specialized.workorderiq"],
      targetRepository: "proworks-engine-suite",
      startedAt: "2026-08-29T10:00:00.000Z",
      expiresAt: "2026-08-29T12:00:00.000Z",
      governanceReference: "gd-1",
      sentinelSession: "sen-1",
      requiredValidators: ["unit"],
    });

    expect(l.deploymentAuthority).toBe(false);
    expect(l.targetEnvironment).toBe("SIMULATION");
    // Named explicitly rather than left implicit: a reader should see that
    // production deployment was refused, not infer it from an absence.
    expect(l.prohibitedActions).toContain("deploy_to_production");
    expect(
      leasePermits(l, { action: "deploy_to_production", environment: "PRODUCTION", now }).permitted,
    ).toBe(false);
  });

  it("catches a repair that outgrew its authorization", () => {
    // A one-line fix that ends as a refactor, each step individually
    // reasonable.
    const verdict = changeWithinScope(lease(), { filesChanged: 40, componentsTouched: 1 });
    expect(verdict.permitted).toBe(false);
    if (!verdict.permitted) expect(verdict.reason).toContain("needs a new one, not a bigger diff");
  });
});

describe("the candidate workspace never touches the baseline", () => {
  const workspace = (l: AgentLease = lease()) =>
    createCandidateWorkspace({
      workspaceId: "ws_1",
      repairCandidateId: "rc_1",
      baseRevision: "abc123",
      lease: l,
      provider: createInMemoryWorkspaceProvider(),
    });

  const change = (over: Record<string, unknown> = {}) => ({
    path: "packages/workorderiq/src/intake.ts",
    kind: "modified",
    componentId: "hive.specialized.workorderiq",
    linesAdded: 12,
    linesRemoved: 2,
    ...over,
  });

  it("records where it started", () => {
    // A workspace that does not know its base cannot be reviewed, rolled back,
    // or revalidated later.
    return workspace().then((ws) => {
      expect(ws.baseRevision).toBe("abc123");
      expect(ws.rollbackPath).toContain("abc123");
    });
  });

  it("stages an in-scope change", async () => {
    const ws = await workspace();
    expect(ws.stage(change()).staged).toBe(true);
    expect(ws.changeSet().filesChanged).toBe(1);
  });

  it("refuses a change to a component outside the lease", async () => {
    const ws = await workspace();
    const result = ws.stage(change({ componentId: "hive.specialized.costiq" }));
    expect(result.staged).toBe(false);
    if (!result.staged) expect(result.reason).toContain("a repair that needs a new lease");
  });

  it("refuses the change that would exceed scope, before recording it", async () => {
    // Checked before recording, against what the change set WOULD become.
    // "We recorded it but flagged it" is how out-of-scope edits get reviewed
    // into existence.
    const ws = await workspace();
    for (let i = 0; i < 3; i += 1) {
      expect(ws.stage(change({ path: `file_${i}.ts` })).staged).toBe(true);
    }
    expect(ws.stage(change({ path: "file_4.ts" })).staged).toBe(false);
    expect(ws.changeSet().filesChanged).toBe(3);
  });

  it("surfaces a removed test in the summary a reviewer reads first", async () => {
    // Deleting a failing test is §13's named shortcut. It should be visible in
    // the summary, not discoverable by scanning paths.
    const ws = await workspace();
    ws.stage(change({ path: "packages/workorderiq/src/__tests__/intake.test.ts", kind: "removed" }));
    expect(ws.changeSet().testsRemoved).toEqual([
      "packages/workorderiq/src/__tests__/intake.test.ts",
    ]);
  });

  it("surfaces contract and dependency changes separately", async () => {
    const ws = await workspace({ ...lease(), maxChangeScope: { maxFiles: 10, maxComponents: 2 } } as AgentLease);
    ws.stage(change({ path: "packages/workorderiq/src/contracts/intake.schema.ts" }));
    ws.stage(change({ path: "packages/workorderiq/package.json" }));
    const set = ws.changeSet();
    expect(set.contractsTouched).toHaveLength(1);
    expect(set.dependenciesTouched).toHaveLength(1);
  });

  it("requires a rename to say what it renamed from", async () => {
    const ws = await workspace();
    expect(ws.stage(change({ kind: "renamed" })).staged).toBe(false);
    expect(ws.stage(change({ kind: "renamed", fromPath: "old.ts" })).staged).toBe(true);
  });

  it("can be discarded", async () => {
    const ws = await workspace();
    ws.stage(change());
    await ws.discard();
    expect(await ws.diff()).toBe("");
  });

  it("names no repository host", async () => {
    // §41 portability: the default path must not require anybody's cloud.
    const ws = await workspace();
    const diff = await ws.diff();
    for (const vendor of ["github", "gitlab", "bitbucket", "git@"]) {
      expect(diff.toLowerCase().includes(vendor), vendor).toBe(false);
    }
  });
});
