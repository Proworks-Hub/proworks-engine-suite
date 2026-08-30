// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";

import {
  componentMaySatisfyOwnApproval,
  engineOpinionSchema,
  opinionsCanOverrideBlock,
} from "@proworks-hub/contracts";
import { approvalDeploys, createProposalRegistry } from "@proworks-hub/governance-engine";

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 8 — constitutional proposal and human authorization.
//
// The six acceptance tests the directive names:
//
//   1. An engine can propose a new engine but cannot activate it.
//   2. Foundry can build and test in a sandbox before human approval.
//   3. All relevant engine opinions are attached before the decision gate.
//   4. A missing required Sentinel/Governance opinion prevents readiness.
//   5. A human approval authorizes only the stated version and scope.
//   6. Changing the approved artifact materially returns it to review.
//
// The split this file is defending: machines may prepare EVERYTHING and decide
// nothing that changes what they are allowed to do. Not because machines
// cannot be trusted to build — they can build, test, simulate and assemble the
// whole case unattended — but because being the last signature on a change to
// your own authority is the one thing that cannot be delegated to the thing
// whose authority it is.
// ─────────────────────────────────────────────────────────────────────────────

const NOW = () => new Date("2026-08-29T12:00:00.000Z");

const registry = (over: Record<string, unknown> = {}) =>
  createProposalRegistry({ now: NOW, requiredOpinionsFrom: ["costiq"], ...over });

const proposal = (over: Record<string, unknown> = {}) => ({
  proposalId: "prop.1",
  proposerId: "forgeiq",
  proposerKind: "engine",
  problem: "Nesting leaves usable offcut on every sheet above 30 inches.",
  proposedOutcome: "Descending-area placement before first fit.",
  changeClass: "minor",
  affectedDomains: ["forgeiq"],
  evidenceRefs: ["obs:nesting-utilisation"],
  estimatedValue: "high",
  estimatedRisk: "low",
  proposedAt: "2026-08-29T12:00:00.000Z",
  ...over,
});

const opinion = (over: Record<string, unknown> = {}) => ({
  engineId: "costiq",
  stance: "supports",
  confidence: "high",
  benefits: ["less material per job"],
  risks: [],
  dependencies: [],
  objections: [],
  evidenceRefs: [],
  ...over,
});

const sentinel = (over: Record<string, unknown> = {}) => ({
  safetyFindings: [],
  constitutionalFindings: [],
  requiredControls: [],
  assessedAt: "2026-08-29T12:00:00.000Z",
  ...over,
});

const foundry = (over: Record<string, unknown> = {}) => ({
  designSummary: "Sort by descending area before placement.",
  buildArtifactRefs: ["oci://registry/forgeiq:0.20.0"],
  testResults: ["unit 1420/1420", "integration 88/88"],
  rollbackPlan: "Redeploy 0.19.0; no migration to reverse.",
  readinessRecommendation: "ready",
  recommendationBasis: "All suites green; utilisation improved on every fixture.",
  artifactDigest: "sha256:aaa",
  ...over,
});

const decision = (over: Record<string, unknown> = {}) => ({
  proposalId: "prop.1",
  approverId: "user.steven",
  decision: "approved",
  scopeAuthorized: {
    engineId: "forgeiq",
    version: "0.20.0",
    changeClass: "minor",
    artifactDigest: "sha256:aaa",
  },
  conditions: [],
  reason: "Reviewed the evidence and the rollback plan.",
  decidedAt: "2026-08-29T12:00:00.000Z",
  ...over,
});

const HUMAN = { id: "user.steven", kind: "human" as const };

/** A package assembled to the point where a person could decide. */
function ready(reg = registry()) {
  reg.propose(proposal());
  reg.addOpinion("prop.1", opinion());
  reg.addSentinelOpinion("prop.1", sentinel());
  reg.addFoundryReport("prop.1", foundry());
  return reg;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2 & 3. MACHINES PREPARE
// ─────────────────────────────────────────────────────────────────────────────

describe("everything up to the decision is automatable", () => {
  it("lets an engine propose, and assembles the whole package without a person", () => {
    // Deliberate: a system that made humans do the preparation would get
    // skipped under deadline.
    const reg = ready();
    const pkg = reg.get("prop.1");
    expect(pkg?.proposal.proposerKind).toBe("engine");
    expect(pkg?.engineOpinions).toHaveLength(1);
    expect(pkg?.sentinelOpinion).not.toBeNull();
    expect(pkg?.foundryReport?.readinessRecommendation).toBe("ready");
    expect(pkg?.state).toBe("VALIDATED");
    expect(pkg?.decision).toBeNull();
  });

  it("reports ready only when every required opinion is in", () => {
    const reg = registry();
    reg.propose(proposal());

    // Every gap named, including the build. A mutation removing the Foundry
    // report from the missing list survived an earlier version of this test:
    // approval was still refused, but by the digest check and with a reason
    // that pointed somewhere else entirely.
    const nothingYet = reg.readiness("prop.1");
    expect(nothingYet.ready).toBe(false);
    expect(nothingYet.missing).toContain("a Foundry report");
    expect(nothingYet.missing).toContain("a Sentinel assessment");
    expect(nothingYet.missing).toContain("an opinion from costiq");

    reg.addFoundryReport("prop.1", foundry());
    expect(reg.readiness("prop.1").missing).not.toContain("a Foundry report");
    const missingTwo = reg.readiness("prop.1");
    expect(missingTwo.ready).toBe(false);
    // Everything missing at once. A gate that reports one gap at a time turns
    // preparation into a guessing game.
    expect(missingTwo.missing).toContain("a Sentinel assessment");
    expect(missingTwo.missing).toContain("an opinion from costiq");

    reg.addSentinelOpinion("prop.1", sentinel());
    reg.addOpinion("prop.1", opinion());
    expect(reg.readiness("prop.1").ready).toBe(true);
  });

  it("takes one opinion per engine, not two votes", () => {
    const reg = ready();
    reg.addOpinion("prop.1", opinion({ stance: "objects", objections: ["changes cost basis"] }));
    const pkg = reg.get("prop.1");
    expect(pkg?.engineOpinions).toHaveLength(1);
    expect(pkg?.engineOpinions[0]?.stance).toBe("objects");
  });

  it("refuses an objection with nothing behind it", () => {
    // An objection with no stated reason cannot be answered, which makes it a
    // veto rather than an opinion.
    expect(engineOpinionSchema.safeParse(opinion({ stance: "objects" })).success).toBe(false);
  });

  it("refuses confident abstention", () => {
    // High confidence in not knowing is a contradiction, and it would let an
    // abstention be read as weight.
    expect(
      engineOpinionSchema.safeParse(opinion({ stance: "abstains", confidence: "high" })).success,
    ).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. SENTINEL
// ─────────────────────────────────────────────────────────────────────────────

describe("a Sentinel block is not an opinion to be weighed", () => {
  it("prevents readiness however supportive the engines are", () => {
    // Three supportive engines do not outvote a constitutional finding. That
    // would be a majority overturning a prohibition.
    const reg = registry();
    reg.propose(proposal());
    reg.addFoundryReport("prop.1", foundry());
    reg.addOpinion("prop.1", opinion());
    reg.addSentinelOpinion(
      "prop.1",
      sentinel({
        constitutionalFindings: ["widens the tenant boundary"],
        blockReason: "This would let one tenant's configuration reach another.",
      }),
    );

    const verdict = reg.readiness("prop.1");
    expect(verdict.ready).toBe(false);
    expect(verdict.blocked).toBe(true);
    expect(opinionsCanOverrideBlock()).toBe(false);
  });

  it("refuses an approval taken over a block", () => {
    const reg = registry();
    reg.propose(proposal());
    reg.addFoundryReport("prop.1", foundry());
    reg.addOpinion("prop.1", opinion());
    reg.addSentinelOpinion("prop.1", sentinel({ blockReason: "unsafe" }));

    const result = reg.decide("prop.1", decision(), HUMAN);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/Sentinel has blocked/);
  });

  it("cannot have the Sentinel opinion configured away", () => {
    // Required, and not on the configurable list. A deployment that could
    // switch off the safety opinion would be one that could switch off safety.
    const reg = createProposalRegistry({ now: NOW, requiredOpinionsFrom: [] });
    reg.propose(proposal());
    reg.addFoundryReport("prop.1", foundry());
    expect(reg.readiness("prop.1").missing).toContain("a Sentinel assessment");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 1 & SELF-APPROVAL
// ─────────────────────────────────────────────────────────────────────────────

describe("no component satisfies its own required approval", () => {
  it("refuses a machine taking the decision at all", () => {
    const reg = ready();
    const result = reg.decide("prop.1", decision({ approverId: "forgeiq" }), {
      id: "forgeiq",
      kind: "engine",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/Machines prepare; people decide/);
  });

  it("refuses the proposer approving their own proposal, even a human one", () => {
    // The rule does not stop applying because the proposer is a person.
    const reg = registry();
    reg.propose(proposal({ proposerId: "user.steven", proposerKind: "human" }));
    reg.addOpinion("prop.1", opinion());
    reg.addSentinelOpinion("prop.1", sentinel());
    reg.addFoundryReport("prop.1", foundry());

    const result = reg.decide("prop.1", decision(), HUMAN);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/may not approve their own proposal/);
    expect(componentMaySatisfyOwnApproval()).toBe(false);
  });

  it("refuses an engine approving a change to itself", () => {
    // The PROPOSER is deliberately somebody else here. My first version had
    // forgeiq proposing and forgeiq approving, so the proposer check fired
    // first and this one was never reached — a mutation deleting it survived.
    // The case that isolates it is a change to forgeiq proposed by Foundry and
    // approved by forgeiq.
    const reg = registry();
    reg.propose(proposal({ proposerId: "foundry", proposerKind: "foundry" }));
    reg.addOpinion("prop.1", opinion());
    reg.addSentinelOpinion("prop.1", sentinel());
    reg.addFoundryReport("prop.1", foundry());

    const result = reg.decide(
      "prop.1",
      decision({ approverId: "forgeiq" }),
      { id: "forgeiq", kind: "human" },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/may not approve the change to itself/);
  });

  it("refuses a decision recorded on somebody else's behalf", () => {
    // Unattributable. The whole value of a named approval is that a person can
    // be asked about it.
    const reg = ready();
    const result = reg.decide("prop.1", decision(), { id: "user.someone-else", kind: "human" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/do not match/);
  });

  it("permits a different, real person", () => {
    // Non-vacuity for all four refusals above.
    const reg = ready();
    const result = reg.decide("prop.1", decision(), HUMAN);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state).toBe("APPROVED");
  });

  it("lets an engine propose a new engine and not activate it", () => {
    // The directive's first acceptance test. Proposing is open to anything;
    // the decision is not, and nothing here activates anything regardless.
    const reg = registry();
    const proposed = reg.propose(
      proposal({ changeClass: "new_engine", proposerId: "foundry", proposerKind: "foundry" }),
    );
    expect(proposed.ok).toBe(true);
    expect(
      reg.decide("prop.1", decision(), { id: "foundry", kind: "engine" }).ok,
    ).toBe(false);
    expect(approvalDeploys()).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5 & 6. SCOPE
// ─────────────────────────────────────────────────────────────────────────────

describe("an approval authorizes exactly what it names", () => {
  it("refuses an approval bound to a digest nobody built", () => {
    // An approval naming an artifact nobody produced is an approval for
    // nothing.
    const reg = ready();
    const result = reg.decide(
      "prop.1",
      decision({
        scopeAuthorized: {
          engineId: "forgeiq",
          version: "0.20.0",
          changeClass: "minor",
          artifactDigest: "sha256:something-else",
        },
      }),
      HUMAN,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/names an artifact, not an intention/);
  });

  it("refuses an approval scoped smaller than the proposal", () => {
    // Approving a smaller thing than was proposed is how scope quietly widens.
    const reg = registry();
    reg.propose(proposal({ changeClass: "major" }));
    reg.addOpinion("prop.1", opinion());
    reg.addSentinelOpinion("prop.1", sentinel());
    reg.addFoundryReport("prop.1", foundry());

    const result = reg.decide(
      "prop.1",
      decision({
        scopeAuthorized: {
          engineId: "forgeiq",
          version: "0.20.0",
          changeClass: "minor",
          artifactDigest: "sha256:aaa",
        },
      }),
      HUMAN,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/how scope quietly widens/);
  });

  it("covers the artifact it named", () => {
    const reg = ready();
    reg.decide("prop.1", decision(), HUMAN);
    expect(reg.approvalCovers("prop.1", "sha256:aaa").covers).toBe(true);
  });

  it("does NOT cover a rebuilt artifact, and reopens the proposal", () => {
    // The one people forget. A person who approved a build approved that
    // build; rebuilding it and shipping the result under the same approval is
    // the quiet version of shipping something nobody agreed to.
    const reg = ready();
    reg.decide("prop.1", decision(), HUMAN);
    expect(reg.get("prop.1")?.state).toBe("APPROVED");

    const verdict = reg.approvalCovers("prop.1", "sha256:rebuilt");
    expect(verdict.covers).toBe(false);
    expect(verdict.reason).toMatch(/reopened rather than carried across/);
    // Reopened, not merely refused: leaving it APPROVED would let a later
    // reader believe the current artifact was agreed to.
    expect(reg.get("prop.1")?.state).toBe("AWAITING_HUMAN_AUTHORIZATION");
  });

  it("refuses to approve a package that is not ready", () => {
    const reg = registry();
    reg.propose(proposal());
    const result = reg.decide("prop.1", decision(), HUMAN);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/not ready/);
  });

  it("refuses a second decision on the same proposal", () => {
    const reg = ready();
    reg.decide("prop.1", decision(), HUMAN);
    expect(reg.decide("prop.1", decision(), HUMAN).ok).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// REJECTION AND REVISION
// ─────────────────────────────────────────────────────────────────────────────

describe("a rejected proposal is revised, not quietly reintroduced", () => {
  it("keeps the rejection queryable with its reason", () => {
    const reg = ready();
    const result = reg.decide(
      "prop.1",
      decision({ decision: "rejected", reason: "The rollback plan does not cover the migration." }),
      HUMAN,
    );
    expect(result.ok).toBe(true);
    const pkg = reg.get("prop.1");
    expect(pkg?.state).toBe("REJECTED");
    expect(pkg?.decision?.reason).toMatch(/rollback plan/);
  });

  it("requires a revision to name what it revises", () => {
    const reg = ready();
    reg.decide("prop.1", decision({ decision: "rejected", reason: "no" }), HUMAN);

    const orphan = reg.propose(proposal({ proposalId: "prop.2" }));
    expect(orphan.ok).toBe(true); // a genuinely new proposal is fine

    const revision = reg.propose(proposal({ proposalId: "prop.3", revises: "prop.1" }));
    expect(revision.ok).toBe(true);
    expect(reg.get("prop.3")?.proposal.revises).toBe("prop.1");
  });

  it("refuses a revision of something that was not rejected", () => {
    // A revision replaces something that was turned down. Anything else is a
    // second proposal wearing the word.
    const reg = ready();
    expect(reg.propose(proposal({ proposalId: "prop.9", revises: "prop.1" })).ok).toBe(false);
  });

  it("refuses a revision of a proposal that does not exist", () => {
    const reg = registry();
    expect(reg.propose(proposal({ proposalId: "prop.9", revises: "nowhere" })).ok).toBe(false);
  });

  it("refuses an opinion arriving after the decision", () => {
    // A reason to reopen, not a field to append to.
    const reg = ready();
    reg.decide("prop.1", decision(), HUMAN);
    const late = reg.addOpinion("prop.1", opinion({ engineId: "inventoryiq", stance: "objects", objections: ["stock churn"] }));
    expect(late.ok).toBe(false);
    if (late.ok) return;
    expect(late.reason).toMatch(/reason to reopen it/);
  });
});
